import type { Hop1Identity } from "../identity/hop1";
import {
  ConnectionLifecycle,
  isCompleteAuthorizationActivationGuard,
  snapshotAuthorizationGuard,
} from "./connection-lifecycle";
import { ProviderLifecycleError } from "./connection-types";
import { GoogleConnectionAdapter } from "./provider-adapters";
import { generateOAuthState, hashState } from "./state";
import type { OAuthStateStore, OAuthTokenStore } from "./store";

export type GoogleOAuthErrorCode =
  | "email_mismatch"
  | "invalid_state"
  | "missing_refresh_token"
  | "token_exchange_failed"
  | "userinfo_failed"
  | "reauth_required";

export class GoogleOAuthError extends Error {
  constructor(
    message: string,
    public readonly code: GoogleOAuthErrorCode,
  ) {
    super(message);
    this.name = "GoogleOAuthError";
  }
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenEncryptionKey: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userInfoUrl?: string;
  googleJwksUrl?: string;
  revocationUrl?: string;
}

export type OAuthFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface StartGoogleOAuthOptions {
  identity: Hop1Identity;
  scopes: string[];
  config: GoogleOAuthConfig;
  stateStore: OAuthStateStore;
  tokenStore: OAuthTokenStore;
  redirectAfter?: string;
}

export interface StartedGoogleOAuth {
  authorizationUrl: string;
  state: string;
}

export interface CompleteGoogleOAuthOptions {
  identity?: Hop1Identity;
  code: string;
  state: string;
  config: GoogleOAuthConfig;
  stateStore: OAuthStateStore;
  tokenStore: OAuthTokenStore;
  fetch?: OAuthFetch;
}

export interface CompleteGoogleOAuthResult {
  identity: Hop1Identity;
  redirectAfter?: string;
}

export interface CancelGoogleOAuthOptions {
  state: string;
  stateStore: OAuthStateStore;
  tokenStore?: OAuthTokenStore;
}

export const DEFAULT_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const DEFAULT_GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const STATE_TTL_MS = 10 * 60 * 1000;

export async function startGoogleOAuth(
  options: StartGoogleOAuthOptions,
): Promise<StartedGoogleOAuth> {
  const state = generateOAuthState();
  const expiresAt = new Date(Date.now() + STATE_TTL_MS);
  const observed = await options.tokenStore.getConnection(
    "google",
    options.identity.issuer,
    options.identity.subject,
  );
  const guard = snapshotAuthorizationGuard(observed);
  await options.stateStore.save({
    provider: "google",
    stateHash: hashState(state),
    hop1Issuer: options.identity.issuer,
    hop1Subject: options.identity.subject,
    email: options.identity.email,
    requestedScopes: options.scopes,
    redirectAfter: options.redirectAfter,
    expiresAt,
    connectionGeneration: guard.generation,
    connectionLocallyDisabled: guard.locallyDisabled,
    connectionUpdatedAt: guard.updatedAt,
  });

  await new ConnectionLifecycle({
    adapter: new GoogleConnectionAdapter(options.config),
    store: options.tokenStore,
    credentialEncryptionKey: options.config.tokenEncryptionKey,
  }).markAuthorizationStarted(options.identity, options.scopes, expiresAt);

  const continuation = await new GoogleConnectionAdapter(options.config).startAuthorization({
    identity: options.identity,
    scopes: options.scopes,
    state,
  });
  return { ...continuation, state };
}

export async function completeGoogleOAuth(
  options: CompleteGoogleOAuthOptions,
): Promise<CompleteGoogleOAuthResult> {
  const stateRecord = await options.stateStore.consume("google", options.state);
  if (!stateRecord) {
    throw new GoogleOAuthError("OAuth state is invalid or expired", "invalid_state");
  }
  const identity = options.identity ?? identityFromStateRecord(stateRecord);
  if (
    identity.issuer !== stateRecord.hop1Issuer ||
    identity.subject !== stateRecord.hop1Subject ||
    identity.email !== stateRecord.email
  ) {
    await options.tokenStore.clearAuthorizing(
      "google",
      stateRecord.hop1Issuer,
      stateRecord.hop1Subject,
    );
    throw new GoogleOAuthError("OAuth state does not match authenticated user", "email_mismatch");
  }
  if (
    stateRecord.provider !== "google" ||
    !isCompleteAuthorizationActivationGuard({
      generation: stateRecord.connectionGeneration,
      locallyDisabled: stateRecord.connectionLocallyDisabled,
      updatedAt: stateRecord.connectionUpdatedAt,
    })
  ) {
    await options.tokenStore.clearAuthorizing(
      "google",
      stateRecord.hop1Issuer,
      stateRecord.hop1Subject,
    );
    throw new GoogleOAuthError("OAuth state is stale", "invalid_state");
  }

  const fetchImpl = options.fetch ?? fetch;
  let issued;
  try {
    issued = await new GoogleConnectionAdapter(options.config, fetchImpl).completeAuthorization({
      code: options.code,
      expectedPrincipal: identity,
      requestedScopes: stateRecord.requestedScopes,
    });
  } catch (error) {
    await options.tokenStore.clearAuthorizing(
      "google",
      stateRecord.hop1Issuer,
      stateRecord.hop1Subject,
    );
    if (error instanceof ProviderLifecycleError && error.category === "identity_mismatch") {
      throw new GoogleOAuthError(
        "Connected Google account does not match authenticated user",
        "email_mismatch",
      );
    }
    throw new GoogleOAuthError(
      "Google OAuth callback could not be completed",
      "token_exchange_failed",
    );
  }
  try {
    await new ConnectionLifecycle({
      adapter: new GoogleConnectionAdapter(options.config, fetchImpl),
      store: options.tokenStore,
      credentialEncryptionKey: options.config.tokenEncryptionKey,
    }).activateAuthorizedGeneration(identity, stateRecord.requestedScopes, issued, {
      generation: stateRecord.connectionGeneration,
      locallyDisabled: stateRecord.connectionLocallyDisabled,
      updatedAt: stateRecord.connectionUpdatedAt,
    });
  } catch (error) {
    await options.tokenStore.clearAuthorizing(
      "google",
      stateRecord.hop1Issuer,
      stateRecord.hop1Subject,
    );
    if (error instanceof ProviderLifecycleError && error.category === "generation_conflict") {
      throw new GoogleOAuthError("OAuth state is stale", "invalid_state");
    }
    throw error;
  }

  return {
    identity,
    redirectAfter: stateRecord.redirectAfter,
  };
}

export async function cancelGoogleOAuth(options: CancelGoogleOAuthOptions): Promise<Hop1Identity> {
  const stateRecord = await options.stateStore.consume("google", options.state);
  if (!stateRecord) {
    throw new GoogleOAuthError("OAuth state is invalid or expired", "invalid_state");
  }
  const identity = identityFromStateRecord(stateRecord);
  await options.tokenStore?.clearAuthorizing("google", identity.issuer, identity.subject);
  return identity;
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
