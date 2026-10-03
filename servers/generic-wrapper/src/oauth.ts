import type { Hop1Identity } from "../../../shared/identity/hop1";
import type { AuditSink } from "../../../shared/audit/audit";
import {
  ConnectionLifecycle,
  isCompleteAuthorizationActivationGuard,
  snapshotAuthorizationGuard,
} from "../../../shared/oauth/connection-lifecycle";
import {
  ProviderLifecycleError,
  type AuthorizationContinuation,
  type CompleteAuthorizationRequest,
  type DecryptedCredentialGeneration,
  type DownstreamConnectionAdapter,
  type IssuedCredentialGeneration,
  type ProviderConnectionCapabilities,
  type ProviderRevocationResult,
  type RenewedCredentialGeneration,
  type StartAuthorizationRequest,
  type ValidatedProviderIdentity,
} from "../../../shared/oauth/connection-types";
import { generateOAuthState, hashState } from "../../../shared/oauth/state";
import type { OAuthStateStore, OAuthTokenStore } from "../../../shared/oauth/store";
import type { GenericOAuthCredentialDescriptor } from "./descriptor";

export type GenericOAuthFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface GenericOAuthRuntimeConfig {
  descriptor: GenericOAuthCredentialDescriptor;
  clientId: string;
  clientSecret: string;
  encryptionKey: string;
  tokenStoreDsn: string;
  lifecycle(tokenStore: OAuthTokenStore, fetch?: GenericOAuthFetch): ConnectionLifecycle;
}

export interface CreateGenericOAuthRuntimeConfigOptions {
  audit?: AuditSink;
}

export interface StartGenericOAuthOptions {
  identity: Hop1Identity;
  config: GenericOAuthRuntimeConfig;
  stateStore: OAuthStateStore;
  tokenStore: OAuthTokenStore;
  redirectAfter?: string;
  fetch?: GenericOAuthFetch;
}

export interface CompleteGenericOAuthOptions {
  identity?: Hop1Identity;
  code: string;
  state: string;
  config: GenericOAuthRuntimeConfig;
  stateStore: OAuthStateStore;
  tokenStore: OAuthTokenStore;
  fetch?: GenericOAuthFetch;
}

export interface CancelGenericOAuthOptions {
  state: string;
  config: GenericOAuthRuntimeConfig;
  stateStore: OAuthStateStore;
  tokenStore: OAuthTokenStore;
}

export interface StartedGenericOAuth {
  authorizationUrl: string;
  state: string;
}

export class GenericOAuthError extends Error {
  constructor(
    message: string,
    public readonly code:
      "invalid_state" | "identity_mismatch" | "authorization_denied" | "token_exchange_failed",
  ) {
    super(message);
    this.name = "GenericOAuthError";
  }
}

const STATE_TTL_MS = 10 * 60 * 1000;

export function createGenericOAuthRuntimeConfig(
  descriptor: GenericOAuthCredentialDescriptor,
  env: Record<string, string | undefined>,
  options: CreateGenericOAuthRuntimeConfigOptions = {},
): GenericOAuthRuntimeConfig {
  const config: GenericOAuthRuntimeConfig = {
    descriptor,
    clientId: requiredEnv(env, descriptor.clientIdEnv),
    clientSecret: requiredEnv(env, descriptor.clientSecretEnv),
    encryptionKey: requiredEnv(env, descriptor.encryptionKeyEnv),
    tokenStoreDsn: requiredEnv(env, descriptor.tokenStoreDsnEnv),
    lifecycle(tokenStore, fetch) {
      return new ConnectionLifecycle({
        adapter: new GenericOAuthConnectionAdapter(config, fetch),
        store: tokenStore,
        credentialEncryptionKey: config.encryptionKey,
        audit: options.audit,
      });
    },
  };
  return config;
}

export class GenericOAuthConnectionAdapter implements DownstreamConnectionAdapter {
  readonly providerId: string;
  readonly capabilities: ProviderConnectionCapabilities;
  private readonly fetchImpl: GenericOAuthFetch;

  constructor(
    private readonly config: GenericOAuthRuntimeConfig,
    fetchImpl: GenericOAuthFetch = fetch,
  ) {
    this.providerId = config.descriptor.providerId;
    this.fetchImpl = fetchImpl;
    this.capabilities = {
      interactiveAuthorization: true,
      activeCredentialExpiry: true,
      automaticRenewal: true,
      manualRenewal: true,
      rotatingRenewalCredential: true,
      providerValidation: true,
      providerRevocation: Boolean(config.descriptor.revocationUrl),
      scopeReporting: true,
      identityVerification: true,
      accountIdentityReporting: true,
    };
  }

  hasRequiredScopes(granted: string[], required: string[]): boolean {
    const available = new Set(granted);
    return required.every((scope) => available.has(scope));
  }

  startAuthorization(request: StartAuthorizationRequest): Promise<AuthorizationContinuation> {
    const descriptor = this.config.descriptor;
    const url = new URL(descriptor.authorizationUrl);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", descriptor.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", request.scopes.join(" "));
    url.searchParams.set("state", request.state);
    for (const [name, value] of Object.entries(descriptor.authorizationParams ?? {})) {
      if (!url.searchParams.has(name)) url.searchParams.set(name, value);
    }
    return Promise.resolve({ authorizationUrl: url.toString() });
  }

  async completeAuthorization(
    request: CompleteAuthorizationRequest,
  ): Promise<IssuedCredentialGeneration> {
    const body = await this.tokenRequest({
      code: request.code,
      redirect_uri: this.config.descriptor.redirectUri,
      grant_type: "authorization_code",
    });
    const issued = issuedCredentials(body, request.requestedScopes);
    return {
      ...issued,
      displayAccountIdentity: request.expectedPrincipal.email,
    };
  }

  async renew(credential: DecryptedCredentialGeneration): Promise<RenewedCredentialGeneration> {
    const renewalCredential = credential.credential.renewalCredential;
    if (!renewalCredential) {
      throw new ProviderLifecycleError(
        "Renewal credential is absent",
        "invalid_renewal_credential",
      );
    }
    const body = await this.tokenRequest({
      refresh_token: renewalCredential,
      grant_type: "refresh_token",
    });
    return renewedCredentials(body, credential.grantedScopes);
  }

  async validateIdentity(
    credential: DecryptedCredentialGeneration,
    expectedPrincipal: Hop1Identity,
  ): Promise<ValidatedProviderIdentity> {
    const active = credential.credential.activeCredential;
    if (!active) {
      throw new ProviderLifecycleError("Active credential is absent", "invalid_active_credential");
    }
    const response = await providerFetch(
      this.fetchImpl,
      this.config.descriptor.userInfoUrl,
      {
        headers: { authorization: `Bearer ${active}` },
      },
      this.timeoutMs,
    );
    const body = await jsonObject(response);
    if (!response.ok) throw providerResponseError(response);
    const identityConfig = this.config.descriptor.identity;
    const id = stringAtPath(body, identityConfig.idField);
    const email = stringAtPath(body, identityConfig.emailField);
    const login = identityConfig.loginField
      ? stringAtPath(body, identityConfig.loginField)
      : undefined;
    const verified = identityConfig.emailVerifiedField
      ? valueAtPath(body, identityConfig.emailVerifiedField)
      : true;
    if (!id || !email || verified !== true) throw malformedResponse();
    if (email.toLowerCase() !== expectedPrincipal.email.toLowerCase()) {
      throw new ProviderLifecycleError("Provider identity does not match", "identity_mismatch");
    }
    return {
      displayAccountIdentity: email,
      providerAccount: { id, ...(login ? { login } : {}) },
    };
  }

  async revoke(credential: DecryptedCredentialGeneration): Promise<ProviderRevocationResult> {
    const url = this.config.descriptor.revocationUrl;
    if (!url) return "not_supported";
    const token = credential.credential.renewalCredential ?? credential.credential.activeCredential;
    if (!token) return "already_absent";
    const params = new URLSearchParams({ token });
    const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
    this.applyClientAuthentication(headers, params);
    let response: Response;
    try {
      response = await providerFetch(
        this.fetchImpl,
        url,
        { method: "POST", headers, body: params.toString() },
        this.timeoutMs,
      );
    } catch (error) {
      if (
        error instanceof ProviderLifecycleError &&
        error.category === "transient_provider_failure"
      ) {
        return "retryable_failure";
      }
      return "permanent_failure";
    }
    if (response.ok) return "revoked";
    if (response.status === 400 || response.status === 404) return "already_absent";
    return response.status === 429 || response.status >= 500
      ? "retryable_failure"
      : "permanent_failure";
  }

  private get timeoutMs(): number {
    return this.config.descriptor.timeoutMs ?? 5_000;
  }

  private async tokenRequest(parameters: Record<string, string>): Promise<Record<string, unknown>> {
    const params = new URLSearchParams(parameters);
    const headers = new Headers({
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    });
    this.applyClientAuthentication(headers, params);
    const response = await providerFetch(
      this.fetchImpl,
      this.config.descriptor.tokenUrl,
      { method: "POST", headers, body: params.toString() },
      this.timeoutMs,
    );
    const body = await jsonObject(response);
    if (!response.ok) {
      if (body.error === "invalid_grant") {
        throw new ProviderLifecycleError(
          "Renewal credential is invalid",
          "invalid_renewal_credential",
        );
      }
      throw providerResponseError(response);
    }
    return body;
  }

  private applyClientAuthentication(headers: Headers, params: URLSearchParams): void {
    if (this.config.descriptor.tokenEndpointAuthMethod === "client_secret_post") {
      params.set("client_id", this.config.clientId);
      params.set("client_secret", this.config.clientSecret);
      return;
    }
    headers.set(
      "authorization",
      `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`,
    );
  }
}

export async function startGenericOAuth(
  options: StartGenericOAuthOptions,
): Promise<StartedGenericOAuth> {
  const provider = options.config.descriptor.providerId;
  const state = generateOAuthState();
  const expiresAt = new Date(Date.now() + STATE_TTL_MS);
  const observed = await options.tokenStore.getConnection(
    provider,
    options.identity.issuer,
    options.identity.subject,
  );
  const guard = snapshotAuthorizationGuard(observed);
  await options.stateStore.save({
    provider,
    stateHash: hashState(state),
    hop1Issuer: options.identity.issuer,
    hop1Subject: options.identity.subject,
    email: options.identity.email,
    requestedScopes: options.config.descriptor.scopes,
    redirectAfter: options.redirectAfter,
    expiresAt,
    connectionGeneration: guard.generation,
    connectionLocallyDisabled: guard.locallyDisabled,
    connectionUpdatedAt: guard.updatedAt,
  });
  await options.config
    .lifecycle(options.tokenStore, options.fetch)
    .markAuthorizationStarted(options.identity, options.config.descriptor.scopes, expiresAt);
  const continuation = await new GenericOAuthConnectionAdapter(
    options.config,
    options.fetch,
  ).startAuthorization({
    identity: options.identity,
    scopes: options.config.descriptor.scopes,
    state,
  });
  return { ...continuation, state };
}

export async function completeGenericOAuth(
  options: CompleteGenericOAuthOptions,
): Promise<{ identity: Hop1Identity; redirectAfter?: string }> {
  const provider = options.config.descriptor.providerId;
  const stateRecord = await options.stateStore.consume(provider, options.state);
  if (!stateRecord)
    throw new GenericOAuthError("OAuth state is invalid or expired", "invalid_state");
  const stateIdentity = identityFromState(stateRecord);
  const identity = options.identity ?? stateIdentity;
  if (
    identity.issuer !== stateRecord.hop1Issuer ||
    identity.subject !== stateRecord.hop1Subject ||
    identity.email.toLowerCase() !== stateRecord.email.toLowerCase()
  ) {
    await clearAuthorizing(options, stateRecord);
    throw new GenericOAuthError(
      "OAuth state does not match authenticated user",
      "identity_mismatch",
    );
  }
  if (
    stateRecord.provider !== provider ||
    !isCompleteAuthorizationActivationGuard({
      generation: stateRecord.connectionGeneration,
      locallyDisabled: stateRecord.connectionLocallyDisabled,
      updatedAt: stateRecord.connectionUpdatedAt,
    })
  ) {
    await clearAuthorizing(options, stateRecord);
    throw new GenericOAuthError("OAuth state is stale", "invalid_state");
  }

  const adapter = new GenericOAuthConnectionAdapter(options.config, options.fetch);
  let issued: IssuedCredentialGeneration;
  try {
    issued = await adapter.completeAuthorization({
      code: options.code,
      expectedPrincipal: identity,
      requestedScopes: stateRecord.requestedScopes,
    });
  } catch (error) {
    await clearAuthorizing(options, stateRecord);
    throw new GenericOAuthError(
      error instanceof ProviderLifecycleError && error.category === "identity_mismatch"
        ? "Provider identity does not match"
        : "OAuth token exchange failed",
      error instanceof ProviderLifecycleError && error.category === "identity_mismatch"
        ? "identity_mismatch"
        : "token_exchange_failed",
    );
  }
  try {
    await options.config
      .lifecycle(options.tokenStore, options.fetch)
      .activateAuthorizedGeneration(identity, stateRecord.requestedScopes, issued, {
        generation: stateRecord.connectionGeneration,
        locallyDisabled: stateRecord.connectionLocallyDisabled,
        updatedAt: stateRecord.connectionUpdatedAt,
      });
  } catch (error) {
    await clearAuthorizing(options, stateRecord);
    if (error instanceof ProviderLifecycleError && error.category === "identity_mismatch") {
      throw new GenericOAuthError("Provider identity does not match", "identity_mismatch");
    }
    throw error;
  }
  return {
    identity,
    ...(stateRecord.redirectAfter ? { redirectAfter: stateRecord.redirectAfter } : {}),
  };
}

export async function cancelGenericOAuth(
  options: CancelGenericOAuthOptions,
): Promise<Hop1Identity> {
  const stateRecord = await options.stateStore.consume(
    options.config.descriptor.providerId,
    options.state,
  );
  if (!stateRecord)
    throw new GenericOAuthError("OAuth state is invalid or expired", "invalid_state");
  const identity = identityFromState(stateRecord);
  await options.tokenStore.clearAuthorizing(
    options.config.descriptor.providerId,
    identity.issuer,
    identity.subject,
  );
  return identity;
}

function issuedCredentials(
  body: Record<string, unknown>,
  fallbackScopes: string[],
): Omit<IssuedCredentialGeneration, "displayAccountIdentity"> {
  const active = nonEmptyString(body.access_token);
  const renewal = nonEmptyString(body.refresh_token);
  if (!active && !renewal) throw malformedResponse();
  const now = Date.now();
  const expiresIn = positiveNumber(body.expires_in);
  const renewalExpiresIn = positiveNumber(body.refresh_token_expires_in);
  return {
    credential: {
      ...(active ? { activeCredential: active } : {}),
      ...(renewal ? { renewalCredential: renewal } : {}),
    },
    grantedScopes: scopesFrom(body.scope) ?? fallbackScopes,
    ...(expiresIn ? { activeCredentialExpiresAt: new Date(now + expiresIn * 1000) } : {}),
    ...(renewalExpiresIn
      ? { renewalCredentialExpiresAt: new Date(now + renewalExpiresIn * 1000) }
      : {}),
  };
}

function renewedCredentials(
  body: Record<string, unknown>,
  fallbackScopes: string[],
): RenewedCredentialGeneration {
  return issuedCredentials(body, fallbackScopes);
}

async function providerFetch(
  fetchImpl: GenericOAuthFetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ProviderLifecycleError(
      "Provider is temporarily unavailable",
      "transient_provider_failure",
    );
  }
}

async function jsonObject(response: Response): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    if (isTimeout(error)) {
      throw new ProviderLifecycleError("Provider response timed out", "transient_provider_failure");
    }
    throw malformedResponse();
  }
  if (!isRecord(value)) throw malformedResponse();
  return value;
}

function providerResponseError(response: Response): ProviderLifecycleError {
  return new ProviderLifecycleError(
    "Provider request failed",
    response.status === 429 || response.status >= 500
      ? "transient_provider_failure"
      : "invalid_active_credential",
  );
}

function malformedResponse(): ProviderLifecycleError {
  return new ProviderLifecycleError(
    "Provider response is malformed",
    "malformed_provider_response",
  );
}

function identityFromState(record: {
  hop1Issuer: string;
  hop1Subject: string;
  email: string;
}): Hop1Identity {
  return {
    profile: "oauth-state",
    issuer: record.hop1Issuer,
    subject: record.hop1Subject,
    email: record.email,
    claims: {},
  };
}

async function clearAuthorizing(
  options: CompleteGenericOAuthOptions,
  record: { hop1Issuer: string; hop1Subject: string },
): Promise<void> {
  await options.tokenStore.clearAuthorizing(
    options.config.descriptor.providerId,
    record.hop1Issuer,
    record.hop1Subject,
  );
}

function valueAtPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    return isRecord(current) ? current[segment] : undefined;
  }, value);
}

function stringAtPath(value: unknown, path: string): string | undefined {
  return nonEmptyString(valueAtPath(value, path));
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function scopesFrom(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const scopes = value.split(/[\s,]+/).filter(Boolean);
  return scopes.length > 0 ? scopes : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function requiredEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required OAuth environment variable: ${name}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimeout(error: unknown): boolean {
  return isRecord(error) && (error.name === "AbortError" || error.name === "TimeoutError");
}
