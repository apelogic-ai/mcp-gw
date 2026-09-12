import type { AuditSink } from "../audit/audit";
import type { Hop1Identity } from "../identity/hop1";
import { ConnectionLifecycle } from "./connection-lifecycle";
import { ProviderLifecycleError } from "./connection-types";
import { GitHubConnectionAdapter } from "./provider-adapters";
import { generateOAuthState, hashState } from "./state";
import type { OAuthFetch } from "./google";
import type { OAuthStateStore, OAuthTokenStore } from "./store";

export type GitHubOAuthErrorCode =
  | "email_mismatch"
  | "invalid_state"
  | "missing_access_token"
  | "token_exchange_failed"
  | "token_revocation_failed"
  | "token_revocation_persist_failed"
  | "userinfo_failed"
  | "reauth_required";

export class GitHubOAuthError extends Error {
  constructor(
    message: string,
    public readonly code: GitHubOAuthErrorCode,
  ) {
    super(message);
    this.name = "GitHubOAuthError";
  }
}

export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenEncryptionKey: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userEmailsUrl?: string;
  tokenRevocationUrl?: string;
}

export interface StartGitHubOAuthOptions {
  identity: Hop1Identity;
  scopes: string[];
  config: GitHubOAuthConfig;
  stateStore: OAuthStateStore;
  tokenStore?: OAuthTokenStore;
  redirectAfter?: string;
}

export interface StartedGitHubOAuth {
  authorizationUrl: string;
  state: string;
}

export interface CompleteGitHubOAuthOptions {
  identity?: Hop1Identity;
  code: string;
  state: string;
  config: GitHubOAuthConfig;
  stateStore: OAuthStateStore;
  tokenStore: OAuthTokenStore;
  fetch?: OAuthFetch;
}

export interface CompleteGitHubOAuthResult {
  identity: Hop1Identity;
  redirectAfter?: string;
}

export interface CancelGitHubOAuthOptions {
  state: string;
  stateStore: OAuthStateStore;
  tokenStore?: OAuthTokenStore;
}

export interface GitHubTokenBrokerOptions {
  config: GitHubOAuthConfig;
  tokenStore: OAuthTokenStore;
  fetch?: OAuthFetch;
  audit?: AuditSink;
}

export interface RevokeGitHubOAuthOptions {
  identity: Hop1Identity;
  config: GitHubOAuthConfig;
  tokenStore: OAuthTokenStore;
  fetch?: OAuthFetch;
}

export const DEFAULT_GITHUB_AUTHORIZATION_URL = "https://github.com/login/oauth/authorize";
export const DEFAULT_GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const STATE_TTL_MS = 10 * 60 * 1000;

export async function startGithubOAuth(
  options: StartGitHubOAuthOptions,
): Promise<StartedGitHubOAuth> {
  const state = generateOAuthState();
  const expiresAt = new Date(Date.now() + STATE_TTL_MS);
  const observed = options.tokenStore
    ? await options.tokenStore.getConnection(
        "github",
        options.identity.issuer,
        options.identity.subject,
      )
    : null;
  await options.stateStore.save({
    stateHash: hashState(state),
    hop1Issuer: options.identity.issuer,
    hop1Subject: options.identity.subject,
    email: options.identity.email,
    requestedScopes: options.scopes,
    redirectAfter: options.redirectAfter,
    expiresAt,
    connectionGeneration: options.tokenStore ? (observed?.generation ?? 0) : undefined,
    connectionLocallyDisabled: options.tokenStore ? Boolean(observed?.localDisabledAt) : undefined,
    connectionUpdatedAt: observed?.updatedAt,
  });

  if (options.tokenStore) {
    await new ConnectionLifecycle({
      adapter: new GitHubConnectionAdapter(options.config),
      store: options.tokenStore,
      credentialEncryptionKey: options.config.tokenEncryptionKey,
    }).markAuthorizationStarted(options.identity, options.scopes, expiresAt);
  }

  const continuation = await new GitHubConnectionAdapter(options.config).startAuthorization({
    identity: options.identity,
    scopes: options.scopes,
    state,
  });
  return { ...continuation, state };
}

export async function completeGithubOAuth(
  options: CompleteGitHubOAuthOptions,
): Promise<CompleteGitHubOAuthResult> {
  const stateRecord = await options.stateStore.consume(options.state);
  if (!stateRecord) {
    throw new GitHubOAuthError("OAuth state is invalid or expired", "invalid_state");
  }
  const identity = options.identity ?? identityFromStateRecord(stateRecord);
  if (
    identity.issuer !== stateRecord.hop1Issuer ||
    identity.subject !== stateRecord.hop1Subject ||
    !emailsEqual(identity.email, stateRecord.email)
  ) {
    await options.tokenStore.clearAuthorizing(
      "github",
      stateRecord.hop1Issuer,
      stateRecord.hop1Subject,
    );
    throw new GitHubOAuthError("OAuth state does not match authenticated user", "email_mismatch");
  }

  const fetchImpl = options.fetch ?? fetch;
  let issued;
  try {
    issued = await new GitHubConnectionAdapter(options.config, fetchImpl).completeAuthorization({
      code: options.code,
      expectedPrincipal: identity,
      requestedScopes: stateRecord.requestedScopes,
    });
  } catch (error) {
    await options.tokenStore.clearAuthorizing(
      "github",
      stateRecord.hop1Issuer,
      stateRecord.hop1Subject,
    );
    if (error instanceof ProviderLifecycleError && error.category === "identity_mismatch") {
      throw new GitHubOAuthError(
        "GitHub account identity does not match authenticated user",
        "email_mismatch",
      );
    }
    throw new GitHubOAuthError(
      "GitHub OAuth callback could not be completed",
      "token_exchange_failed",
    );
  }
  try {
    await new ConnectionLifecycle({
      adapter: new GitHubConnectionAdapter(options.config, fetchImpl),
      store: options.tokenStore,
      credentialEncryptionKey: options.config.tokenEncryptionKey,
    }).activateAuthorizedGeneration(identity, stateRecord.requestedScopes, issued, {
      generation: stateRecord.connectionGeneration,
      locallyDisabled: stateRecord.connectionLocallyDisabled,
      updatedAt: stateRecord.connectionUpdatedAt,
    });
  } catch (error) {
    await options.tokenStore.clearAuthorizing(
      "github",
      stateRecord.hop1Issuer,
      stateRecord.hop1Subject,
    );
    if (error instanceof ProviderLifecycleError && error.category === "generation_conflict") {
      throw new GitHubOAuthError("OAuth state is stale", "invalid_state");
    }
    throw error;
  }

  return {
    identity,
    redirectAfter: stateRecord.redirectAfter,
  };
}

/**
 * Consume an authorization transaction when GitHub returns an OAuth error.
 * A provider denial has no bearer header to authenticate, so the opaque,
 * one-time state record is the sole principal binding just as it is on the
 * successful browser callback path.
 */
export async function cancelGithubOAuth(options: CancelGitHubOAuthOptions): Promise<Hop1Identity> {
  const stateRecord = await options.stateStore.consume(options.state);
  if (!stateRecord) {
    throw new GitHubOAuthError("OAuth state is invalid or expired", "invalid_state");
  }

  const identity = identityFromStateRecord(stateRecord);
  await options.tokenStore?.clearAuthorizing("github", identity.issuer, identity.subject);
  return identity;
}

export class GitHubTokenBroker {
  constructor(private readonly options: GitHubTokenBrokerOptions) {}

  async getAccessToken(identity: Hop1Identity, requiredScopes: string[]): Promise<string> {
    try {
      return await new ConnectionLifecycle({
        adapter: new GitHubConnectionAdapter(this.options.config, this.options.fetch),
        store: this.options.tokenStore,
        credentialEncryptionKey: this.options.config.tokenEncryptionKey,
        audit: this.options.audit,
      }).getActiveCredential(identity, requiredScopes);
    } catch {
      throw new GitHubOAuthError("GitHub account must be connected", "reauth_required");
    }
  }
}

/** Compatibility entry point backed by immediate local disconnect and asynchronous cleanup. */
export async function revokeGithubOAuth(options: RevokeGitHubOAuthOptions): Promise<void> {
  await new ConnectionLifecycle({
    adapter: new GitHubConnectionAdapter(options.config, options.fetch),
    store: options.tokenStore,
    credentialEncryptionKey: options.config.tokenEncryptionKey,
  }).disconnect(options.identity, []);
}

function identityFromStateRecord(stateRecord: {
  hop1Issuer: string;
  hop1Subject: string;
  email: string;
}): Hop1Identity {
  return {
    profile: "oauth-state",
    issuer: stateRecord.hop1Issuer,
    subject: stateRecord.hop1Subject,
    email: stateRecord.email,
    claims: {},
  };
}

function emailsEqual(left: string, right: string): boolean {
  return asciiLowercase(left) === asciiLowercase(right);
}

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 32));
}
