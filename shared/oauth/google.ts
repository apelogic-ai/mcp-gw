import type { Hop1Identity } from "../identity/hop1";
import { encryptSecret } from "./crypto";
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
}

export type OAuthFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface StartGoogleOAuthOptions {
  identity: Hop1Identity;
  scopes: string[];
  config: GoogleOAuthConfig;
  stateStore: OAuthStateStore;
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

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
}

interface GoogleUserInfoResponse {
  email?: string;
}

export const DEFAULT_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const DEFAULT_GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_USER_INFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const STATE_TTL_MS = 10 * 60 * 1000;

export async function startGoogleOAuth(
  options: StartGoogleOAuthOptions,
): Promise<StartedGoogleOAuth> {
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

  const url = new URL(options.config.authorizationUrl ?? DEFAULT_AUTHORIZATION_URL);
  url.searchParams.set("client_id", options.config.clientId);
  url.searchParams.set("redirect_uri", options.config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", options.scopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  url.searchParams.set("login_hint", options.identity.email);

  return {
    authorizationUrl: url.toString(),
    state,
  };
}

export async function completeGoogleOAuth(
  options: CompleteGoogleOAuthOptions,
): Promise<CompleteGoogleOAuthResult> {
  const stateRecord = await options.stateStore.consume(options.state);
  if (!stateRecord) {
    throw new GoogleOAuthError("OAuth state is invalid or expired", "invalid_state");
  }
  const identity = options.identity ?? identityFromStateRecord(stateRecord);
  if (
    identity.issuer !== stateRecord.hop1Issuer ||
    identity.subject !== stateRecord.hop1Subject ||
    identity.email !== stateRecord.email
  ) {
    throw new GoogleOAuthError("OAuth state does not match authenticated user", "email_mismatch");
  }

  const fetchImpl = options.fetch ?? fetch;
  const token = await exchangeCode(options, fetchImpl);
  const email = await fetchGoogleEmail(options.config, token.accessToken, fetchImpl);

  if (email !== identity.email || email !== stateRecord.email) {
    throw new GoogleOAuthError(
      "Connected Google account does not match authenticated user",
      "email_mismatch",
    );
  }

  const now = new Date();
  await options.tokenStore.saveAccount({
    provider: "google",
    hop1Issuer: identity.issuer,
    hop1Subject: identity.subject,
    email,
    scopesGranted: token.scopes,
    encryptedRefreshToken: encryptSecret(token.refreshToken, options.config.tokenEncryptionKey),
    createdAt: now,
    updatedAt: now,
  });

  return {
    identity,
    redirectAfter: stateRecord.redirectAfter,
  };
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
  options: CompleteGoogleOAuthOptions,
  fetchImpl: OAuthFetch,
): Promise<{ accessToken: string; refreshToken: string; scopes: string[] }> {
  const response = await fetchImpl(options.config.tokenUrl ?? DEFAULT_GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: options.code,
      client_id: options.config.clientId,
      client_secret: options.config.clientSecret,
      redirect_uri: options.config.redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const body = (await response.json()) as GoogleTokenResponse;
  if (!response.ok || !body.access_token) {
    throw new GoogleOAuthError(
      `Google token exchange failed: ${body.error ?? response.statusText}`,
      "token_exchange_failed",
    );
  }

  if (!body.refresh_token) {
    throw new GoogleOAuthError("Google did not return a refresh token", "missing_refresh_token");
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    scopes: scopeStringToArray(body.scope),
  };
}

async function fetchGoogleEmail(
  config: GoogleOAuthConfig,
  accessToken: string,
  fetchImpl: OAuthFetch,
): Promise<string> {
  const response = await fetchImpl(config.userInfoUrl ?? DEFAULT_USER_INFO_URL, {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });

  const body = (await response.json()) as GoogleUserInfoResponse;
  if (!response.ok || !body.email) {
    throw new GoogleOAuthError("Google userinfo lookup failed", "userinfo_failed");
  }

  return body.email;
}

export function scopeStringToArray(scope: string | undefined): string[] {
  return scope ? scope.split(" ").filter(Boolean) : [];
}
