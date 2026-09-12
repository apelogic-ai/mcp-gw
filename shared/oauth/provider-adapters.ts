import type { Hop1Identity } from "../identity/hop1";
import type { GitHubOAuthConfig } from "./github";
import type { GoogleOAuthConfig, OAuthFetch } from "./google";
import {
  ProviderLifecycleError,
  type DecryptedCredentialGeneration,
  type DownstreamConnectionAdapter,
  type ProviderConnectionCapabilities,
  type ProviderRevocationResult,
  type RenewedCredentialGeneration,
  type ValidatedProviderIdentity,
  type StartAuthorizationRequest,
  type AuthorizationContinuation,
  type CompleteAuthorizationRequest,
  type IssuedCredentialGeneration,
} from "./connection-types";

const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const GOOGLE_REVOCATION_URL = "https://oauth2.googleapis.com/revoke";
const GITHUB_AUTHORIZATION_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_EMAILS_URL = "https://api.github.com/user/emails";
const GITHUB_APPLICATIONS_URL = "https://api.github.com/applications";
const PROVIDER_TIMEOUT_MS = 5_000;

export const GOOGLE_CONNECTION_CAPABILITIES: ProviderConnectionCapabilities = {
  interactiveAuthorization: true,
  activeCredentialExpiry: true,
  automaticRenewal: true,
  manualRenewal: true,
  rotatingRenewalCredential: false,
  providerValidation: true,
  providerRevocation: true,
  scopeReporting: true,
  identityVerification: true,
};

export const GITHUB_CONNECTION_CAPABILITIES: ProviderConnectionCapabilities = {
  interactiveAuthorization: true,
  activeCredentialExpiry: true,
  automaticRenewal: true,
  manualRenewal: true,
  rotatingRenewalCredential: true,
  providerValidation: true,
  providerRevocation: true,
  scopeReporting: true,
  identityVerification: true,
};

export class GoogleConnectionAdapter implements DownstreamConnectionAdapter {
  readonly providerId = "google" as const;
  readonly capabilities = GOOGLE_CONNECTION_CAPABILITIES;
  private readonly fetchImpl: OAuthFetch;

  constructor(
    private readonly config: GoogleOAuthConfig,
    fetchImpl?: OAuthFetch,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  hasRequiredScopes(granted: string[], required: string[]): boolean {
    const grantedSet = new Set(granted);
    return required.every((scope) => hasGoogleScope(grantedSet, scope));
  }

  startAuthorization(request: StartAuthorizationRequest): Promise<AuthorizationContinuation> {
    const url = new URL(this.config.authorizationUrl ?? GOOGLE_AUTHORIZATION_URL);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", request.scopes.join(" "));
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", request.state);
    url.searchParams.set("login_hint", request.identity.email);
    return Promise.resolve({ authorizationUrl: url.toString() });
  }

  async completeAuthorization(
    request: CompleteAuthorizationRequest,
  ): Promise<IssuedCredentialGeneration> {
    const response = await providerFetch(this.fetchImpl, this.config.tokenUrl ?? GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: request.code,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: this.config.redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const body = await jsonObject(response);
    if (!response.ok || typeof body.access_token !== "string")
      throw providerResponseError(response);
    if (typeof body.refresh_token !== "string") {
      throw new ProviderLifecycleError(
        "Provider did not issue a renewal credential",
        "malformed_provider_response",
      );
    }
    const userInfo = await providerFetch(
      this.fetchImpl,
      this.config.userInfoUrl ?? GOOGLE_USERINFO_URL,
      { headers: { authorization: `Bearer ${body.access_token}` } },
    );
    const profile = await jsonObject(userInfo);
    if (!userInfo.ok || typeof profile.email !== "string") throw providerResponseError(userInfo);
    if (profile.email !== request.expectedPrincipal.email) {
      throw new ProviderLifecycleError("Provider identity does not match", "identity_mismatch");
    }
    const now = Date.now();
    return {
      credential: {
        activeCredential: body.access_token,
        renewalCredential: body.refresh_token,
      },
      displayAccountIdentity: profile.email,
      grantedScopes:
        typeof body.scope === "string" ? splitScopes(body.scope) : request.requestedScopes,
      activeCredentialExpiresAt: new Date(now + (positiveNumber(body.expires_in) ?? 3600) * 1000),
      validatedAt: new Date(now),
    };
  }

  async renew(credential: DecryptedCredentialGeneration): Promise<RenewedCredentialGeneration> {
    const renewalCredential = credential.credential.renewalCredential;
    if (!renewalCredential) throw invalidRenewal();
    const response = await providerFetch(this.fetchImpl, this.config.tokenUrl ?? GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: renewalCredential,
        grant_type: "refresh_token",
      }),
    });
    const body = await jsonObject(response);
    if (!response.ok) {
      if (body.error === "invalid_grant") throw invalidRenewal();
      throw providerResponseError(response);
    }
    if (typeof body.access_token !== "string") throw malformedResponse();
    const expiresIn = positiveNumber(body.expires_in) ?? 3600;
    return {
      credential: {
        activeCredential: body.access_token,
        renewalCredential:
          typeof body.refresh_token === "string" ? body.refresh_token : renewalCredential,
      },
      grantedScopes:
        typeof body.scope === "string" ? splitScopes(body.scope) : credential.grantedScopes,
      activeCredentialExpiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  }

  async validateIdentity(
    credential: DecryptedCredentialGeneration,
    expectedPrincipal: Hop1Identity,
  ): Promise<ValidatedProviderIdentity> {
    const active = credential.credential.activeCredential;
    if (!active)
      throw new ProviderLifecycleError("Active credential is absent", "invalid_active_credential");
    const response = await providerFetch(
      this.fetchImpl,
      this.config.userInfoUrl ?? GOOGLE_USERINFO_URL,
      { headers: { authorization: `Bearer ${active}` } },
    );
    const body = await jsonObject(response);
    if (!response.ok || typeof body.email !== "string") throw providerResponseError(response);
    if (body.email !== expectedPrincipal.email) {
      throw new ProviderLifecycleError("Provider identity does not match", "identity_mismatch");
    }
    return { displayAccountIdentity: body.email };
  }

  async revoke(credential: DecryptedCredentialGeneration): Promise<ProviderRevocationResult> {
    const token = credential.credential.renewalCredential ?? credential.credential.activeCredential;
    if (!token) return "already_absent";
    const response = await providerFetch(
      this.fetchImpl,
      this.config.revocationUrl ?? GOOGLE_REVOCATION_URL,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      },
    );
    if (response.ok) return "revoked";
    if (response.status === 400 || response.status === 404) return "already_absent";
    return response.status === 429 || response.status >= 500
      ? "retryable_failure"
      : "permanent_failure";
  }
}

export class GitHubConnectionAdapter implements DownstreamConnectionAdapter {
  readonly providerId = "github" as const;
  readonly capabilities = GITHUB_CONNECTION_CAPABILITIES;
  private readonly fetchImpl: OAuthFetch;

  constructor(
    private readonly config: GitHubOAuthConfig,
    fetchImpl?: OAuthFetch,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  startAuthorization(request: StartAuthorizationRequest): Promise<AuthorizationContinuation> {
    const url = new URL(this.config.authorizationUrl ?? GITHUB_AUTHORIZATION_URL);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("scope", request.scopes.join(" "));
    url.searchParams.set("state", request.state);
    url.searchParams.set("login", request.identity.email);
    return Promise.resolve({ authorizationUrl: url.toString() });
  }

  async completeAuthorization(
    request: CompleteAuthorizationRequest,
  ): Promise<IssuedCredentialGeneration> {
    const response = await providerFetch(this.fetchImpl, this.config.tokenUrl ?? GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code: request.code,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: this.config.redirectUri,
      }),
    });
    const body = await jsonObject(response);
    if (!response.ok || typeof body.access_token !== "string")
      throw providerResponseError(response);
    const emailResponse = await providerFetch(
      this.fetchImpl,
      this.config.userEmailsUrl ?? GITHUB_EMAILS_URL,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${body.access_token}`,
        },
      },
    );
    const emailBody = await emailResponse.json().catch(() => undefined);
    if (!emailResponse.ok || !Array.isArray(emailBody)) throw providerResponseError(emailResponse);
    const matching = emailBody.some(
      (entry) =>
        isRecord(entry) &&
        entry.verified === true &&
        typeof entry.email === "string" &&
        entry.email.toLowerCase() === request.expectedPrincipal.email.toLowerCase(),
    );
    if (!matching) {
      await this.revoke({
        provider: "github",
        generation: 0,
        credential: { activeCredential: body.access_token },
        grantedScopes: [],
      }).catch(() => undefined);
      throw new ProviderLifecycleError("Provider identity does not match", "identity_mismatch");
    }
    const now = Date.now();
    const expiresIn = positiveNumber(body.expires_in);
    const renewalExpiresIn = positiveNumber(body.refresh_token_expires_in);
    return {
      credential: {
        activeCredential: body.access_token,
        renewalCredential: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
      },
      displayAccountIdentity: request.expectedPrincipal.email,
      grantedScopes:
        typeof body.scope === "string" ? splitScopes(body.scope) : request.requestedScopes,
      activeCredentialExpiresAt:
        expiresIn === undefined ? undefined : new Date(now + expiresIn * 1000),
      renewalCredentialExpiresAt:
        renewalExpiresIn === undefined ? undefined : new Date(now + renewalExpiresIn * 1000),
      validatedAt: new Date(now),
    };
  }

  async renew(credential: DecryptedCredentialGeneration): Promise<RenewedCredentialGeneration> {
    const renewalCredential = credential.credential.renewalCredential;
    if (!renewalCredential) throw invalidRenewal();
    const response = await providerFetch(this.fetchImpl, this.config.tokenUrl ?? GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: renewalCredential,
        grant_type: "refresh_token",
      }),
    });
    const body = await jsonObject(response);
    if (!response.ok) {
      if (body.error === "bad_refresh_token" || body.error === "invalid_grant") {
        throw invalidRenewal();
      }
      throw providerResponseError(response);
    }
    if (typeof body.access_token !== "string") throw malformedResponse();
    const expiresIn = positiveNumber(body.expires_in);
    const renewalExpiresIn = positiveNumber(body.refresh_token_expires_in);
    return {
      credential: {
        activeCredential: body.access_token,
        renewalCredential: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
      },
      grantedScopes:
        typeof body.scope === "string" ? splitScopes(body.scope) : credential.grantedScopes,
      activeCredentialExpiresAt:
        expiresIn === undefined ? undefined : new Date(Date.now() + expiresIn * 1000),
      renewalCredentialExpiresAt:
        renewalExpiresIn === undefined
          ? credential.renewalCredentialExpiresAt
          : new Date(Date.now() + renewalExpiresIn * 1000),
    };
  }

  async validateIdentity(
    credential: DecryptedCredentialGeneration,
    expectedPrincipal: Hop1Identity,
  ): Promise<ValidatedProviderIdentity> {
    const active = credential.credential.activeCredential;
    if (!active)
      throw new ProviderLifecycleError("Active credential is absent", "invalid_active_credential");
    const response = await providerFetch(
      this.fetchImpl,
      this.config.userEmailsUrl ?? GITHUB_EMAILS_URL,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${active}`,
        },
      },
    );
    const body = await response.json().catch(() => undefined);
    if (!response.ok || !Array.isArray(body)) throw providerResponseError(response);
    const matching = body.some(
      (entry) =>
        isRecord(entry) &&
        entry.verified === true &&
        typeof entry.email === "string" &&
        entry.email.toLowerCase() === expectedPrincipal.email.toLowerCase(),
    );
    if (!matching) {
      throw new ProviderLifecycleError("Provider identity does not match", "identity_mismatch");
    }
    return { displayAccountIdentity: expectedPrincipal.email };
  }

  async revoke(credential: DecryptedCredentialGeneration): Promise<ProviderRevocationResult> {
    const active = credential.credential.activeCredential;
    if (!active) return "already_absent";
    const url =
      this.config.tokenRevocationUrl ??
      `${GITHUB_APPLICATIONS_URL}/${encodeURIComponent(this.config.clientId)}/token`;
    const response = await providerFetch(this.fetchImpl, url, {
      method: "DELETE",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ access_token: active }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (response.status === 204) return "revoked";
    if (response.status === 404 || response.status === 422) return "already_absent";
    return response.status === 429 || response.status >= 500
      ? "retryable_failure"
      : "permanent_failure";
  }
}

async function providerFetch(
  fetchImpl: OAuthFetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch {
    throw new ProviderLifecycleError(
      "Provider is temporarily unavailable",
      "transient_provider_failure",
    );
  }
}

async function jsonObject(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => undefined);
  if (!isRecord(body)) throw malformedResponse();
  return body;
}

function providerResponseError(response: Response): ProviderLifecycleError {
  return new ProviderLifecycleError(
    "Provider request failed",
    response.status === 429 || response.status >= 500
      ? "transient_provider_failure"
      : "invalid_active_credential",
  );
}

function invalidRenewal(): ProviderLifecycleError {
  return new ProviderLifecycleError("Renewal credential is invalid", "invalid_renewal_credential");
}

function malformedResponse(): ProviderLifecycleError {
  return new ProviderLifecycleError(
    "Provider response is malformed",
    "malformed_provider_response",
  );
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function splitScopes(value: string): string[] {
  return value.split(/[,\s]+/).filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasGoogleScope(granted: Set<string>, required: string): boolean {
  if (granted.has(required)) return true;
  return [...granted].some((scope) => googleScopeImplies(scope, required));
}

function googleScopeImplies(granted: string, required: string): boolean {
  if (granted === "https://www.googleapis.com/auth/drive") {
    return required.startsWith("https://www.googleapis.com/auth/drive.");
  }
  if (granted === "https://www.googleapis.com/auth/gmail.modify") {
    return (
      [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose",
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/gmail.insert",
        "https://www.googleapis.com/auth/gmail.labels",
        "https://www.googleapis.com/auth/gmail.metadata",
      ].includes(required) || required.startsWith("https://www.googleapis.com/auth/gmail.addons.")
    );
  }
  if (granted === "https://www.googleapis.com/auth/calendar") {
    return (
      required.startsWith("https://www.googleapis.com/auth/calendar.") ||
      required === "https://www.googleapis.com/auth/calendar.readonly" ||
      required === "https://www.googleapis.com/auth/calendar.freebusy"
    );
  }
  return ["documents", "spreadsheets", "presentations", "tasks"].some(
    (service) =>
      granted === `https://www.googleapis.com/auth/${service}` &&
      required === `https://www.googleapis.com/auth/${service}.readonly`,
  );
}
