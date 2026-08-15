import type { Hop1Identity } from "../identity/hop1";
import { decryptSecret, encryptSecret } from "./crypto";
import { generateOAuthState, hashState } from "./state";
import type { OAuthFetch } from "./google";
import type { OAuthStateStore, OAuthTokenStore } from "./store";

export type GitHubOAuthErrorCode =
  | "email_mismatch"
  | "invalid_state"
  | "missing_access_token"
  | "token_exchange_failed"
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

export interface GitHubTokenBrokerOptions {
  config: GitHubOAuthConfig;
  tokenStore: OAuthTokenStore;
}

interface GitHubTokenResponse {
  access_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface GitHubEmailResponse {
  email?: string;
  primary?: boolean;
  verified?: boolean;
}

export const DEFAULT_GITHUB_AUTHORIZATION_URL = "https://github.com/login/oauth/authorize";
export const DEFAULT_GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEFAULT_GITHUB_USER_EMAILS_URL = "https://api.github.com/user/emails";
const DEFAULT_GITHUB_APPLICATIONS_URL = "https://api.github.com/applications";
const STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_REVOCATION_TIMEOUT_MS = 5_000;

export async function startGithubOAuth(
  options: StartGitHubOAuthOptions,
): Promise<StartedGitHubOAuth> {
  const state = generateOAuthState();
  await options.stateStore.save({
    stateHash: hashState(state),
    hop1Issuer: options.identity.issuer,
    hop1Subject: options.identity.subject,
    email: options.identity.email,
    requestedScopes: options.scopes,
    redirectAfter: options.redirectAfter,
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });

  const url = new URL(options.config.authorizationUrl ?? DEFAULT_GITHUB_AUTHORIZATION_URL);
  url.searchParams.set("client_id", options.config.clientId);
  url.searchParams.set("redirect_uri", options.config.redirectUri);
  url.searchParams.set("scope", options.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("login", options.identity.email);

  return {
    authorizationUrl: url.toString(),
    state,
  };
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
    throw new GitHubOAuthError("OAuth state does not match authenticated user", "email_mismatch");
  }

  const fetchImpl = options.fetch ?? fetch;
  const token = await exchangeCode(options, fetchImpl);
  const verifiedEmails = await fetchVerifiedEmails(options.config, token.accessToken, fetchImpl);
  const hasMatchingVerifiedEmail = verifiedEmails.some(
    (email) => emailsEqual(email, identity.email) && emailsEqual(email, stateRecord.email),
  );
  if (!hasMatchingVerifiedEmail) {
    await bestEffortRevokeAccessToken(options.config, token.accessToken, fetchImpl);
    throw new GitHubOAuthError(
      "GitHub account identity does not match authenticated user",
      "email_mismatch",
    );
  }

  const now = new Date();
  await options.tokenStore.saveAccount({
    provider: "github",
    hop1Issuer: identity.issuer,
    hop1Subject: identity.subject,
    email: stateRecord.email,
    scopesGranted: token.scopes,
    encryptedRefreshToken: encryptSecret(token.accessToken, options.config.tokenEncryptionKey),
    createdAt: now,
    updatedAt: now,
  });

  return {
    identity,
    redirectAfter: stateRecord.redirectAfter,
  };
}

export class GitHubTokenBroker {
  constructor(private readonly options: GitHubTokenBrokerOptions) {}

  async getAccessToken(identity: Hop1Identity, requiredScopes: string[]): Promise<string> {
    const account = await this.options.tokenStore.getAccount(
      identity.issuer,
      identity.subject,
      "github",
    );
    if (!account || account.revokedAt) {
      throw new GitHubOAuthError("GitHub account must be connected", "reauth_required");
    }

    if (!hasScopes(account.scopesGranted, requiredScopes)) {
      throw new GitHubOAuthError(
        "GitHub account must be reconnected for additional scopes",
        "reauth_required",
      );
    }

    return decryptSecret(account.encryptedRefreshToken, this.options.config.tokenEncryptionKey);
  }
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

async function exchangeCode(
  options: CompleteGitHubOAuthOptions,
  fetchImpl: OAuthFetch,
): Promise<{ accessToken: string; scopes: string[] }> {
  const response = await fetchImpl(options.config.tokenUrl ?? DEFAULT_GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code: options.code,
      client_id: options.config.clientId,
      client_secret: options.config.clientSecret,
      redirect_uri: options.config.redirectUri,
    }),
  });

  const body = (await response.json()) as GitHubTokenResponse;
  if (!response.ok || !body.access_token) {
    throw new GitHubOAuthError(
      `GitHub token exchange failed: ${body.error_description ?? body.error ?? response.statusText}`,
      "token_exchange_failed",
    );
  }

  return {
    accessToken: body.access_token,
    scopes: scopeStringToArray(body.scope),
  };
}

async function fetchVerifiedEmails(
  config: GitHubOAuthConfig,
  accessToken: string,
  fetchImpl: OAuthFetch,
): Promise<string[]> {
  const response = await fetchImpl(config.userEmailsUrl ?? DEFAULT_GITHUB_USER_EMAILS_URL, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
    },
  });

  const body = (await response.json()) as GitHubEmailResponse[];
  if (!response.ok || !Array.isArray(body)) {
    throw new GitHubOAuthError("GitHub email lookup failed", "userinfo_failed");
  }

  const verifiedEmails: string[] = [];
  for (const entry of body) {
    if (entry.verified === true && typeof entry.email === "string") {
      verifiedEmails.push(entry.email);
    }
  }
  return verifiedEmails;
}

async function bestEffortRevokeAccessToken(
  config: GitHubOAuthConfig,
  accessToken: string,
  fetchImpl: OAuthFetch,
): Promise<void> {
  const url =
    config.tokenRevocationUrl ??
    `${DEFAULT_GITHUB_APPLICATIONS_URL}/${encodeURIComponent(config.clientId)}/token`;

  try {
    await fetchImpl(url, {
      method: "DELETE",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ access_token: accessToken }),
      signal: AbortSignal.timeout(TOKEN_REVOCATION_TIMEOUT_MS),
    });
  } catch {
    // The identity mismatch still fails closed when GitHub revocation is unavailable.
  }
}

function scopeStringToArray(scope: string | undefined): string[] {
  return (scope ?? "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function emailsEqual(left: string, right: string): boolean {
  return asciiLowercase(left) === asciiLowercase(right);
}

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 32));
}

function hasScopes(granted: string[], required: string[]): boolean {
  const grantedSet = new Set(granted);
  return required.every((scope) => grantedSet.has(scope));
}
