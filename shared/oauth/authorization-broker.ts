import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createLocalJWKSet,
  jwtVerify,
  SignJWT,
  type JWK,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

const GOOGLE_ISSUER = "https://accounts.google.com";
const GOOGLE_AUTHORIZATION_ENDPOINT = `${GOOGLE_ISSUER}/o/oauth2/v2/auth`;
const GOOGLE_SIGNING_ALGORITHMS = ["RS256"] as const;
const DEFAULT_TRANSACTION_TTL_SECONDS = 600;
const DEFAULT_AUTHORIZATION_CODE_TTL_SECONDS = 120;
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 300;
const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const MAX_CLIENT_ID_LENGTH = 256;
const MAX_URI_LENGTH = 2048;
const MAX_SCOPE_LENGTH = 1024;
const MAX_CLIENT_STATE_LENGTH = 1024;
const MAX_AUTHORIZATION_CODE_LENGTH = 4096;

export type OAuthBrokerErrorCode =
  | "invalid_client"
  | "invalid_grant"
  | "invalid_request"
  | "invalid_scope"
  | "invalid_target"
  | "server_error"
  | "unsupported_grant_type"
  | "unsupported_response_type";

export class OAuthBrokerError extends Error {
  constructor(
    public readonly code: OAuthBrokerErrorCode,
    message: string,
    public readonly redirectUrl?: string,
  ) {
    super(message);
    this.name = "OAuthBrokerError";
  }
}

export interface BrokerClient {
  clientId: string;
  redirectUris: string[];
  scopes: string[];
  clientName?: string;
  clientUri?: string;
}

export interface BrokerClientRegistry {
  get(clientId: string): Promise<BrokerClient | null>;
}

export interface GoogleIdentity {
  issuer: string;
  subject: string;
  email: string;
  emailVerified: true;
}

export interface AuthorizationTransactionRecord {
  stateHash: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  clientState?: string;
  codeChallenge: string;
  googleNonce: string;
  googleCodeVerifier: string;
  expiresAt: number;
}

export interface BrokerAuthorizationCodeRecord {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  codeChallenge: string;
  identity: GoogleIdentity;
  expiresAt: number;
}

export interface AuthorizationBrokerStore {
  saveTransaction(record: AuthorizationTransactionRecord): Promise<void>;
  consumeTransaction(stateHash: string): Promise<AuthorizationTransactionRecord | null>;
  saveAuthorizationCode(record: BrokerAuthorizationCodeRecord): Promise<void>;
  consumeAuthorizationCode(codeHash: string): Promise<BrokerAuthorizationCodeRecord | null>;
}

export class InMemoryAuthorizationBrokerStore implements AuthorizationBrokerStore {
  private readonly transactions = new Map<string, AuthorizationTransactionRecord>();
  private readonly authorizationCodes = new Map<string, BrokerAuthorizationCodeRecord>();

  saveTransaction(record: AuthorizationTransactionRecord): Promise<void> {
    this.transactions.set(record.stateHash, structuredClone(record));
    return Promise.resolve();
  }

  consumeTransaction(stateHash: string): Promise<AuthorizationTransactionRecord | null> {
    const record = this.transactions.get(stateHash);
    this.transactions.delete(stateHash);
    return Promise.resolve(record ? structuredClone(record) : null);
  }

  saveAuthorizationCode(record: BrokerAuthorizationCodeRecord): Promise<void> {
    this.authorizationCodes.set(record.codeHash, structuredClone(record));
    return Promise.resolve();
  }

  consumeAuthorizationCode(codeHash: string): Promise<BrokerAuthorizationCodeRecord | null> {
    const record = this.authorizationCodes.get(codeHash);
    this.authorizationCodes.delete(codeHash);
    return Promise.resolve(record ? structuredClone(record) : null);
  }
}

export interface BeginAuthorizationRequest {
  responseType: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state?: string;
}

export interface BeginAuthorizationResult {
  authorizationUrl: string;
  client: BrokerClient;
}

export interface CompleteGoogleAuthorizationRequest {
  transactionState: string;
  googleCode: string;
}

export interface CompleteGoogleAuthorizationResult {
  authorizationCode: string;
  redirectUrl: string;
}

export interface DenyGoogleAuthorizationRequest {
  transactionState: string;
  error: string;
}

export interface DenyGoogleAuthorizationResult {
  redirectUrl: string;
}

export interface ExchangeAuthorizationCodeRequest {
  grantType: string;
  code: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  codeVerifier: string;
}

export interface BrokerTokenResponse {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  scope: string;
}

export interface GoogleTokenExchangeInput {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface GoogleTokenExchangeResult {
  idToken: string;
  accessToken?: string;
  refreshToken?: string;
}

export interface OAuthBrokerOptions {
  issuer: string;
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  scopesSupported: string[];
  google: {
    clientId: string;
    authorizationEndpoint: string;
    callbackUri: string;
    jwks: JWK[] | JWTVerifyGetKey;
  };
  signing: {
    algorithm: "RS256";
    keyId: string;
    privateKey: CryptoKey;
    publicJwk: JWK;
    verificationJwks?: JWK[];
  };
  clients: BrokerClientRegistry;
  store: AuthorizationBrokerStore;
  exchangeGoogleCode(input: GoogleTokenExchangeInput): Promise<GoogleTokenExchangeResult>;
  transactionTtlSeconds?: number;
  authorizationCodeTtlSeconds?: number;
  accessTokenTtlSeconds?: number;
  now?: () => number;
}

export interface VerifyGoogleIdentityTokenOptions {
  clientId: string;
  expectedNonce: string;
  jwks: JWK[] | JWTVerifyGetKey;
  now?: number;
}

export class OAuthBroker {
  private readonly now: () => number;
  private readonly transactionTtlSeconds: number;
  private readonly authorizationCodeTtlSeconds: number;
  private readonly accessTokenTtlSeconds: number;

  constructor(private readonly options: OAuthBrokerOptions) {
    validatePublicConfiguration(options);
    if (options.signing.keyId.length === 0) {
      throw new Error("The active signing key must have a keyId");
    }
    if (
      options.signing.privateKey.type !== "private" ||
      options.signing.privateKey.algorithm.name !== "RSASSA-PKCS1-v1_5" ||
      options.signing.publicJwk.kty !== "RSA"
    ) {
      throw new Error("The active signing key must be an RS256 private/public key pair");
    }
    if (
      options.signing.verificationJwks?.some(
        (jwk) =>
          typeof jwk.kid !== "string" ||
          jwk.kid.length === 0 ||
          jwk.kty !== "RSA" ||
          (jwk.alg !== undefined && jwk.alg !== "RS256") ||
          (jwk.use !== undefined && jwk.use !== "sig"),
      )
    ) {
      throw new Error("Every verification JWK must be a kid-addressable RS256 signing key");
    }
    this.now = options.now ?? Date.now;
    this.transactionTtlSeconds = boundedTtl(
      options.transactionTtlSeconds ?? DEFAULT_TRANSACTION_TTL_SECONDS,
      "transactionTtlSeconds",
      30,
      900,
    );
    this.authorizationCodeTtlSeconds = boundedTtl(
      options.authorizationCodeTtlSeconds ?? DEFAULT_AUTHORIZATION_CODE_TTL_SECONDS,
      "authorizationCodeTtlSeconds",
      30,
      300,
    );
    this.accessTokenTtlSeconds = boundedTtl(
      options.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
      "accessTokenTtlSeconds",
      60,
      600,
    );
  }

  async beginAuthorization(request: BeginAuthorizationRequest): Promise<BeginAuthorizationResult> {
    requireBoundedString(request.clientId, "client_id", MAX_CLIENT_ID_LENGTH);
    requireBoundedString(request.redirectUri, "redirect_uri", MAX_URI_LENGTH);
    const client = await this.options.clients.get(request.clientId);
    if (client?.clientId !== request.clientId) {
      throw new OAuthBrokerError("invalid_client", "Unknown OAuth client");
    }
    if (!client.redirectUris.includes(request.redirectUri)) {
      throw new OAuthBrokerError("invalid_request", "redirect_uri is not registered");
    }
    let scopes: string[];
    try {
      requireBoundedString(request.state, "state", MAX_CLIENT_STATE_LENGTH);
      requireBoundedString(request.resource, "resource", MAX_URI_LENGTH);
      requireBoundedString(request.scope, "scope", MAX_SCOPE_LENGTH);
      requireBoundedString(request.responseType, "response_type", 32);
      requireBoundedString(request.codeChallenge, "code_challenge", 128);
      requireBoundedString(request.codeChallengeMethod, "code_challenge_method", 16);
      if (request.responseType !== "code") {
        throw new OAuthBrokerError(
          "unsupported_response_type",
          "Only the authorization code response type is supported",
        );
      }
      if (request.resource !== this.options.resource) {
        throw new OAuthBrokerError("invalid_target", "resource does not identify this MCP server");
      }
      if (
        request.codeChallengeMethod !== "S256" ||
        !PKCE_CHALLENGE_PATTERN.test(request.codeChallenge)
      ) {
        throw new OAuthBrokerError("invalid_request", "PKCE S256 is required");
      }
      scopes = parseAndValidateScopes(request.scope, [
        ...new Set(client.scopes.filter((scope) => this.options.scopesSupported.includes(scope))),
      ]);
    } catch (error) {
      if (error instanceof OAuthBrokerError) {
        const errorCode = authorizationErrorCode(error.code);
        throw new OAuthBrokerError(
          errorCode,
          error.message,
          clientRedirect(request.redirectUri, {
            error: errorCode,
            errorDescription: error.message,
            state: boundedClientState(request.state),
          }),
        );
      }
      throw error;
    }
    try {
      const transactionState = randomSecret();
      const googleNonce = randomSecret();
      const googleCodeVerifier = randomBytes(48).toString("base64url");

      await this.options.store.saveTransaction({
        stateHash: hashSecret(transactionState),
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        resource: request.resource,
        scopes,
        clientState: request.state,
        codeChallenge: request.codeChallenge,
        googleNonce,
        googleCodeVerifier,
        expiresAt: this.now() + this.transactionTtlSeconds * 1000,
      });

      const authorizationUrl = new URL(this.options.google.authorizationEndpoint);
      authorizationUrl.searchParams.set("client_id", this.options.google.clientId);
      authorizationUrl.searchParams.set("redirect_uri", this.options.google.callbackUri);
      authorizationUrl.searchParams.set("response_type", "code");
      authorizationUrl.searchParams.set("scope", "openid email");
      authorizationUrl.searchParams.set("state", transactionState);
      authorizationUrl.searchParams.set("nonce", googleNonce);
      authorizationUrl.searchParams.set("code_challenge", pkceChallenge(googleCodeVerifier));
      authorizationUrl.searchParams.set("code_challenge_method", "S256");

      return { authorizationUrl: authorizationUrl.toString(), client: structuredClone(client) };
    } catch {
      const errorCode = "server_error";
      const message = "Authorization transaction could not be created";
      throw new OAuthBrokerError(
        errorCode,
        message,
        clientRedirect(request.redirectUri, {
          error: errorCode,
          errorDescription: message,
          state: request.state,
        }),
      );
    }
  }

  async completeGoogleAuthorization(
    request: CompleteGoogleAuthorizationRequest,
  ): Promise<CompleteGoogleAuthorizationResult> {
    requireBoundedString(request.transactionState, "state", 256);
    const transaction = await this.consumeLiveTransaction(request.transactionState);

    let authorizationCode: string;
    try {
      requireBoundedString(request.googleCode, "code", MAX_AUTHORIZATION_CODE_LENGTH);
      const exchanged: GoogleTokenExchangeResult = await this.options.exchangeGoogleCode({
        code: request.googleCode,
        codeVerifier: transaction.googleCodeVerifier,
        redirectUri: this.options.google.callbackUri,
      });
      const identity = await verifyGoogleIdentityToken(exchanged.idToken, {
        clientId: this.options.google.clientId,
        expectedNonce: transaction.googleNonce,
        jwks: this.options.google.jwks,
        now: this.now(),
      });
      authorizationCode = randomSecret();
      await this.options.store.saveAuthorizationCode({
        codeHash: hashSecret(authorizationCode),
        clientId: transaction.clientId,
        redirectUri: transaction.redirectUri,
        resource: transaction.resource,
        scopes: transaction.scopes,
        codeChallenge: transaction.codeChallenge,
        identity,
        expiresAt: this.now() + this.authorizationCodeTtlSeconds * 1000,
      });
    } catch {
      const errorCode = "server_error";
      const message = "Upstream identity verification failed";
      throw new OAuthBrokerError(
        errorCode,
        message,
        clientRedirect(transaction.redirectUri, {
          error: errorCode,
          errorDescription: message,
          state: transaction.clientState,
        }),
      );
    }

    return {
      authorizationCode,
      redirectUrl: clientRedirect(transaction.redirectUri, {
        code: authorizationCode,
        state: transaction.clientState,
      }),
    };
  }

  async denyGoogleAuthorization(
    request: DenyGoogleAuthorizationRequest,
  ): Promise<DenyGoogleAuthorizationResult> {
    requireBoundedString(request.transactionState, "state", 256);
    const transaction = await this.consumeLiveTransaction(request.transactionState);
    const accessDenied = request.error === "access_denied";
    return {
      redirectUrl: clientRedirect(transaction.redirectUri, {
        error: accessDenied ? "access_denied" : "server_error",
        errorDescription: accessDenied
          ? "The resource owner denied the authorization request"
          : "Upstream authorization failed",
        state: transaction.clientState,
      }),
    };
  }

  async exchangeAuthorizationCode(
    request: ExchangeAuthorizationCodeRequest,
  ): Promise<BrokerTokenResponse> {
    requireBoundedString(request.grantType, "grant_type", 64);
    requireBoundedString(request.code, "code", 256, "invalid_grant");
    requireBoundedString(request.clientId, "client_id", MAX_CLIENT_ID_LENGTH);
    requireBoundedString(request.redirectUri, "redirect_uri", MAX_URI_LENGTH);
    requireBoundedString(request.resource, "resource", MAX_URI_LENGTH);
    requireBoundedString(request.codeVerifier, "code_verifier", 128, "invalid_grant");
    if (request.grantType !== "authorization_code") {
      throw new OAuthBrokerError(
        "unsupported_grant_type",
        "Only the authorization_code grant is supported",
      );
    }
    const record = await this.options.store.consumeAuthorizationCode(hashSecret(request.code));
    if (!record || record.expiresAt <= this.now()) {
      throw new OAuthBrokerError("invalid_grant", "Authorization code is invalid or expired");
    }
    if (request.resource !== this.options.resource || request.resource !== record.resource) {
      throw new OAuthBrokerError("invalid_target", "resource does not identify this MCP server");
    }
    if (
      request.clientId !== record.clientId ||
      request.redirectUri !== record.redirectUri ||
      !validPkceVerifier(request.codeVerifier, record.codeChallenge)
    ) {
      throw new OAuthBrokerError("invalid_grant", "Authorization code binding is invalid");
    }
    const client = await this.options.clients.get(record.clientId);
    if (
      client?.clientId !== record.clientId ||
      !client.redirectUris.includes(record.redirectUri) ||
      record.scopes.some((scope) => !client.scopes.includes(scope))
    ) {
      throw new OAuthBrokerError("invalid_grant", "OAuth client is no longer active");
    }

    const issuedAt = Math.floor(this.now() / 1000);
    const accessToken = await new SignJWT({
      email: record.identity.email,
      email_verified: true,
      identity_provider: "google",
      scope: record.scopes.join(" "),
    })
      .setProtectedHeader({
        alg: this.options.signing.algorithm,
        kid: this.options.signing.keyId,
        typ: "at+jwt",
      })
      .setIssuer(this.options.issuer)
      .setAudience(record.resource)
      .setSubject(record.identity.subject)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + this.accessTokenTtlSeconds)
      .setJti(randomSecret())
      .sign(this.options.signing.privateKey);

    return {
      accessToken,
      tokenType: "Bearer",
      expiresIn: this.accessTokenTtlSeconds,
      scope: record.scopes.join(" "),
    };
  }

  authorizationServerMetadata(): Record<string, unknown> {
    return {
      issuer: this.options.issuer,
      authorization_endpoint: this.options.authorizationEndpoint,
      token_endpoint: this.options.tokenEndpoint,
      jwks_uri: this.options.jwksUri,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [...this.options.scopesSupported],
    };
  }

  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.options.resource,
      authorization_servers: [this.options.issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: [...this.options.scopesSupported],
    };
  }

  jwks(): { keys: JWK[] } {
    const active = publicSigningJwk(this.options.signing.publicJwk, {
      keyId: this.options.signing.keyId,
      algorithm: this.options.signing.algorithm,
    });
    const seenKeyIds = new Set([active.kid]);
    const previous = (this.options.signing.verificationJwks ?? [])
      .map((jwk) => publicSigningJwk(jwk))
      .filter((jwk) => {
        if (seenKeyIds.has(jwk.kid)) {
          return false;
        }
        seenKeyIds.add(jwk.kid);
        return true;
      });
    return {
      keys: [active, ...previous],
    };
  }

  private async consumeLiveTransaction(
    transactionState: string,
  ): Promise<AuthorizationTransactionRecord> {
    if (!transactionState) {
      throw new OAuthBrokerError("invalid_request", "Authorization transaction state is required");
    }
    const transaction = await this.options.store.consumeTransaction(hashSecret(transactionState));
    if (!transaction || transaction.expiresAt <= this.now()) {
      throw new OAuthBrokerError(
        "invalid_request",
        "Authorization transaction is invalid or expired",
      );
    }
    return transaction;
  }
}

export async function verifyGoogleIdentityToken(
  idToken: string,
  options: VerifyGoogleIdentityTokenOptions,
): Promise<GoogleIdentity> {
  try {
    const keySet = Array.isArray(options.jwks)
      ? createLocalJWKSet({ keys: options.jwks })
      : options.jwks;
    const result = await jwtVerify(idToken, keySet, {
      issuer: GOOGLE_ISSUER,
      audience: options.clientId,
      algorithms: [...GOOGLE_SIGNING_ALGORITHMS],
      currentDate: new Date(options.now ?? Date.now()),
    });
    return googleIdentityFromPayload(result.payload, options);
  } catch (error) {
    if (error instanceof OAuthBrokerError) {
      throw error;
    }
    throw new OAuthBrokerError("invalid_grant", "Google ID token verification failed");
  }
}

function googleIdentityFromPayload(
  payload: JWTPayload,
  options: VerifyGoogleIdentityTokenOptions,
): GoogleIdentity {
  if (payload.exp === undefined) {
    throw new OAuthBrokerError("invalid_grant", "Google ID token is missing expiration");
  }
  if (payload.nonce !== options.expectedNonce) {
    throw new OAuthBrokerError("invalid_grant", "Google ID token nonce does not match");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new OAuthBrokerError("invalid_grant", "Google ID token is missing a stable subject");
  }
  if (typeof payload.email !== "string" || payload.email.length === 0) {
    throw new OAuthBrokerError("invalid_grant", "Google ID token is missing email");
  }
  if (payload.email_verified !== true) {
    throw new OAuthBrokerError("invalid_grant", "Google ID token email is not verified");
  }
  if (payload.azp !== undefined && payload.azp !== options.clientId) {
    throw new OAuthBrokerError("invalid_grant", "Google ID token authorized party does not match");
  }
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== options.clientId) {
    throw new OAuthBrokerError("invalid_grant", "Google ID token is missing its authorized party");
  }

  return {
    issuer: String(payload.iss),
    subject: payload.sub,
    email: payload.email,
    emailVerified: true,
  };
}

function parseAndValidateScopes(scope: string, allowedScopes: string[]): string[] {
  const scopes = scope.split(/\s+/).filter(Boolean);
  if (scopes.length === 0 || scopes.some((candidate) => !allowedScopes.includes(candidate))) {
    throw new OAuthBrokerError("invalid_scope", "Requested OAuth scope is not permitted");
  }
  return [...new Set(scopes)];
}

function validPkceVerifier(verifier: string, expectedChallenge: string): boolean {
  if (!PKCE_VERIFIER_PATTERN.test(verifier)) {
    return false;
  }
  const actual = Buffer.from(pkceChallenge(verifier));
  const expected = Buffer.from(expectedChallenge);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}

function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

function clientRedirect(
  redirectUri: string,
  parameters: { code?: string; error?: string; errorDescription?: string; state?: string },
): string {
  const redirect = new URL(redirectUri);
  const entries: [string, string | undefined][] = [
    ["code", parameters.code],
    ["error", parameters.error],
    ["error_description", parameters.errorDescription],
    ["state", parameters.state],
  ];
  for (const [name, value] of entries) {
    if (value !== undefined) {
      redirect.searchParams.set(name, value);
    }
  }
  return redirect.toString();
}

function authorizationErrorCode(code: OAuthBrokerErrorCode): OAuthBrokerErrorCode {
  return code === "invalid_grant" || code === "unsupported_grant_type" ? "server_error" : code;
}

function boundedClientState(state: string | undefined): string | undefined {
  return state && state.length <= MAX_CLIENT_STATE_LENGTH ? state : undefined;
}

function publicSigningJwk(jwk: JWK, active?: { keyId: string; algorithm: "RS256" }): JWK {
  const publicEntries = Object.entries(jwk).filter(
    ([name]) => !["d", "p", "q", "dp", "dq", "qi", "oth", "k"].includes(name),
  );
  return {
    ...Object.fromEntries(publicEntries),
    kid: active?.keyId ?? jwk.kid,
    alg: active?.algorithm ?? "RS256",
    use: "sig",
  };
}

function boundedTtl(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${String(minimum)} and ${String(maximum)}`);
  }
  return value;
}

function requireBoundedString(
  value: string | undefined,
  name: string,
  maximumLength: number,
  code: OAuthBrokerErrorCode = "invalid_request",
): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new OAuthBrokerError(
      code,
      `${name} must be between 1 and ${String(maximumLength)} characters`,
    );
  }
}

function validatePublicConfiguration(options: OAuthBrokerOptions): void {
  requireBoundedConfigurationString(options.google.clientId, "google.clientId", 256);
  if (Array.isArray(options.google.jwks) && options.google.jwks.length === 0) {
    throw new Error("google.jwks must not be empty");
  }
  const issuer = requireHttpsUrl(options.issuer, "issuer");
  if (issuer.search || issuer.hash || issuer.username || issuer.password) {
    throw new Error("issuer must not contain credentials, query parameters, or a fragment");
  }
  const resource = requireHttpsUrl(options.resource, "resource");
  if (resource.search || resource.hash || resource.username || resource.password) {
    throw new Error("resource must not contain credentials, query parameters, or a fragment");
  }
  for (const [name, value] of [
    ["authorizationEndpoint", options.authorizationEndpoint],
    ["tokenEndpoint", options.tokenEndpoint],
    ["jwksUri", options.jwksUri],
    ["google.callbackUri", options.google.callbackUri],
  ] as const) {
    const url = requireHttpsUrl(value, name);
    requireCleanUrl(url, name);
    if (url.origin !== issuer.origin) {
      throw new Error(`${name} must use the authorization-server origin`);
    }
  }
  const googleAuthorization = requireHttpsUrl(
    options.google.authorizationEndpoint,
    "google.authorizationEndpoint",
  );
  requireCleanUrl(googleAuthorization, "google.authorizationEndpoint");
  if (googleAuthorization.toString() !== GOOGLE_AUTHORIZATION_ENDPOINT) {
    throw new Error("google.authorizationEndpoint must be the exact Google authorization URL");
  }
  if (
    options.scopesSupported.length === 0 ||
    options.scopesSupported.some((scope) => scope.length === 0 || scope.length > 256) ||
    new Set(options.scopesSupported).size !== options.scopesSupported.length
  ) {
    throw new Error("scopesSupported must contain unique, bounded scopes");
  }
}

function requireHttpsUrl(value: string, name: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || !isPublicHostname(url.hostname)) {
      throw new Error("not HTTPS");
    }
    return url;
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL`);
  }
}

function requireCleanUrl(url: URL, name: string): void {
  if (url.search || url.hash || url.username || url.password) {
    throw new Error(`${name} must not contain credentials, query parameters, or a fragment`);
  }
}

function requireBoundedConfigurationString(value: string, name: string, maximum: number): void {
  if (value.length === 0 || value.length > maximum) {
    throw new Error(`${name} must be between 1 and ${String(maximum)} characters`);
  }
}

function isPublicHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    !normalized.includes(".") ||
    normalized.includes(":")
  ) {
    return false;
  }
  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
    return true;
  }
  const [first = 0, second = 0] = octets;
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127) ||
    first >= 224
  );
}
