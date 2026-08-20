import { randomBytes } from "node:crypto";
import { isIP } from "node:net";

import { hasCanonicalIpv4Hostname, isSpecialUseIpv4 } from "./public-host";

export type ConstrainedDcrErrorCode =
  | "invalid_client"
  | "invalid_client_metadata"
  | "invalid_pkce"
  | "invalid_redirect_uri"
  | "invalid_request"
  | "invalid_scope"
  | "rate_limited"
  | "registry_full";

export class ConstrainedDcrError extends Error {
  constructor(
    message: string,
    public readonly code: ConstrainedDcrErrorCode,
    public readonly httpStatus = 400,
  ) {
    super(message);
    this.name = "ConstrainedDcrError";
  }
}

export interface DcrRegistrationResponse {
  client_id: string;
  client_id_issued_at: number;
  redirect_uris: string[];
  grant_types: ["authorization_code"];
  response_types: ["code"];
  token_endpoint_auth_method: "none";
  application_type?: "native" | "web";
  client_name?: string;
  client_uri?: string;
  contacts?: string[];
  logo_uri?: string;
  policy_uri?: string;
  scope?: string;
  software_id?: string;
  software_version?: string;
  tos_uri?: string;
}

export interface StoredDynamicDcrClient {
  registration: DcrRegistrationResponse;
  expiresAtMs: number;
}

export interface DcrStoreRegistrationPolicy {
  maxDynamicClients: number;
  nowMs: number;
}

export type DcrStoreRegistrationResult = "saved" | "duplicate" | "full";

export interface DcrStoreRateLimitPolicy {
  maxAttempts: number;
  maxKeys: number;
  nowMs: number;
  windowMs: number;
}

/**
 * Persistence boundary for dynamic clients and registration abuse controls.
 * Implementations must make each method atomic. In particular, pruning,
 * capacity checking, and insertion in saveDynamicClient are one operation.
 */
export interface DcrRegistrationStore {
  consumeRegistrationAttempt(
    rateLimitKey: string,
    policy: DcrStoreRateLimitPolicy,
  ): Promise<"allowed" | "limited">;
  getDynamicClient(clientId: string, nowMs: number): Promise<StoredDynamicDcrClient | null>;
  saveDynamicClient(
    client: StoredDynamicDcrClient,
    policy: DcrStoreRegistrationPolicy,
  ): Promise<DcrStoreRegistrationResult>;
}

interface RateWindow {
  count: number;
  expiresAtMs: number;
}

export class InMemoryDcrRegistrationStore implements DcrRegistrationStore {
  private readonly clients = new Map<string, StoredDynamicDcrClient>();
  private readonly rateWindows = new Map<string, RateWindow>();

  consumeRegistrationAttempt(
    rateLimitKey: string,
    policy: DcrStoreRateLimitPolicy,
  ): Promise<"allowed" | "limited"> {
    this.pruneRateWindows(policy.nowMs);
    const current = this.rateWindows.get(rateLimitKey);
    if (current) {
      if (current.count >= policy.maxAttempts) {
        return Promise.resolve("limited");
      }
      current.count += 1;
      return Promise.resolve("allowed");
    }

    if (this.rateWindows.size >= policy.maxKeys) {
      return Promise.resolve("limited");
    }

    this.rateWindows.set(rateLimitKey, {
      count: 1,
      expiresAtMs: policy.nowMs + policy.windowMs,
    });
    return Promise.resolve("allowed");
  }

  getDynamicClient(clientId: string, nowMs: number): Promise<StoredDynamicDcrClient | null> {
    const client = this.clients.get(clientId);
    if (!client) {
      return Promise.resolve(null);
    }
    if (client.expiresAtMs <= nowMs) {
      this.clients.delete(clientId);
      return Promise.resolve(null);
    }
    return Promise.resolve(cloneStoredClient(client));
  }

  saveDynamicClient(
    client: StoredDynamicDcrClient,
    policy: DcrStoreRegistrationPolicy,
  ): Promise<DcrStoreRegistrationResult> {
    this.pruneClients(policy.nowMs);
    if (this.clients.has(client.registration.client_id)) {
      return Promise.resolve("duplicate");
    }
    if (this.clients.size >= policy.maxDynamicClients) {
      return Promise.resolve("full");
    }
    this.clients.set(client.registration.client_id, cloneStoredClient(client));
    return Promise.resolve("saved");
  }

  private pruneClients(nowMs: number): void {
    for (const [clientId, client] of this.clients) {
      if (client.expiresAtMs <= nowMs) {
        this.clients.delete(clientId);
      }
    }
  }

  private pruneRateWindows(nowMs: number): void {
    for (const [key, window] of this.rateWindows) {
      if (window.expiresAtMs <= nowMs) {
        this.rateWindows.delete(key);
      }
    }
  }
}

export interface StaticDcrClient {
  clientId: string;
  redirectUris: string[];
  applicationType?: "native" | "web";
  clientName?: string;
  clientUri?: string;
  scopes?: string[];
}

export interface ConstrainedDcrRegistryOptions {
  allowedScopes?: string[];
  allowLoopbackRedirects?: boolean;
  dynamicClientTtlMs?: number;
  defaultScopes?: string[];
  generateClientId?: () => string;
  maxDynamicClients?: number;
  maxRateLimitKeys?: number;
  maxRegistrationsPerWindow?: number;
  now?: () => number;
  rateLimitWindowMs?: number;
  staticClients?: StaticDcrClient[];
  store?: DcrRegistrationStore;
}

export interface DcrRegistrationContext {
  /** A trusted, server-derived caller bucket such as a normalized source IP. */
  rateLimitKey: string;
}

export interface DcrAuthorizationRequest {
  clientId: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  requestedScopes?: string[];
}

export interface ResolvedDcrClient extends DcrRegistrationResponse {
  expiresAtMs?: number;
  registrationType: "dynamic" | "static";
}

const DEFAULT_DYNAMIC_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_DYNAMIC_CLIENTS = 10_000;
const DEFAULT_MAX_RATE_LIMIT_KEYS = 10_000;
const DEFAULT_MAX_REGISTRATIONS_PER_WINDOW = 10;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const DEFAULT_SCOPES = ["mcp"];
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_REDIRECT_URIS = 10;
const MAX_URI_LENGTH = 2_048;
const CLIENT_ID_ATTEMPTS = 5;

const OPTIONAL_METADATA_KEYS = new Set([
  "application_type",
  "client_name",
  "client_uri",
  "contacts",
  "logo_uri",
  "policy_uri",
  "scope",
  "software_id",
  "software_version",
  "tos_uri",
]);
const REQUIRED_METADATA_KEYS = new Set([
  "grant_types",
  "redirect_uris",
  "response_types",
  "token_endpoint_auth_method",
]);
const ALLOWED_METADATA_KEYS = new Set([...OPTIONAL_METADATA_KEYS, ...REQUIRED_METADATA_KEYS]);
const URL_METADATA_KEYS = ["client_uri", "logo_uri", "policy_uri", "tos_uri"] as const;

export class ConstrainedDcrRegistry {
  private readonly allowedScopes: Set<string>;
  private readonly allowLoopbackRedirects: boolean;
  private readonly dynamicClientTtlMs: number;
  private readonly defaultScopes: string[];
  private readonly generateClientId: () => string;
  private readonly maxDynamicClients: number;
  private readonly maxRateLimitKeys: number;
  private readonly maxRegistrationsPerWindow: number;
  private readonly now: () => number;
  private readonly rateLimitWindowMs: number;
  private readonly staticClients = new Map<string, DcrRegistrationResponse>();
  private readonly store: DcrRegistrationStore;

  constructor(options: ConstrainedDcrRegistryOptions = {}) {
    this.allowLoopbackRedirects = options.allowLoopbackRedirects ?? false;
    this.allowedScopes = new Set(validateConfiguredScopes(options.allowedScopes ?? DEFAULT_SCOPES));
    this.defaultScopes = validateConfiguredScopes(options.defaultScopes ?? DEFAULT_SCOPES);
    if (this.defaultScopes.some((scope) => !this.allowedScopes.has(scope))) {
      throw new TypeError("defaultScopes must be a subset of allowedScopes");
    }
    this.dynamicClientTtlMs = positiveInteger(
      options.dynamicClientTtlMs ?? DEFAULT_DYNAMIC_CLIENT_TTL_MS,
      "dynamicClientTtlMs",
    );
    this.maxDynamicClients = positiveInteger(
      options.maxDynamicClients ?? DEFAULT_MAX_DYNAMIC_CLIENTS,
      "maxDynamicClients",
    );
    this.maxRateLimitKeys = positiveInteger(
      options.maxRateLimitKeys ?? DEFAULT_MAX_RATE_LIMIT_KEYS,
      "maxRateLimitKeys",
    );
    this.maxRegistrationsPerWindow = positiveInteger(
      options.maxRegistrationsPerWindow ?? DEFAULT_MAX_REGISTRATIONS_PER_WINDOW,
      "maxRegistrationsPerWindow",
    );
    this.rateLimitWindowMs = positiveInteger(
      options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
      "rateLimitWindowMs",
    );
    this.generateClientId = options.generateClientId ?? generateClientId;
    this.now = options.now ?? Date.now;
    this.store = options.store ?? new InMemoryDcrRegistrationStore();

    for (const client of options.staticClients ?? []) {
      this.addStaticClient(client);
    }
  }

  async register(
    metadata: unknown,
    context: DcrRegistrationContext,
  ): Promise<DcrRegistrationResponse> {
    const rateLimitKey = validateRateLimitKey(context.rateLimitKey);
    const rateResult = await this.store.consumeRegistrationAttempt(rateLimitKey, {
      maxAttempts: this.maxRegistrationsPerWindow,
      maxKeys: this.maxRateLimitKeys,
      nowMs: this.now(),
      windowMs: this.rateLimitWindowMs,
    });
    if (rateResult === "limited") {
      throw new ConstrainedDcrError("Registration rate limit exceeded", "rate_limited", 429);
    }

    const validated = validateClientMetadata(
      metadata,
      this.allowLoopbackRedirects,
      this.allowedScopes,
      this.defaultScopes,
    );
    const nowMs = this.now();
    for (let attempt = 0; attempt < CLIENT_ID_ATTEMPTS; attempt += 1) {
      const clientId = this.generateClientId();
      validateGeneratedClientId(clientId);
      if (this.staticClients.has(clientId)) {
        continue;
      }

      const registration: DcrRegistrationResponse = {
        client_id: clientId,
        client_id_issued_at: Math.floor(nowMs / 1000),
        ...validated,
      };
      const result = await this.store.saveDynamicClient(
        {
          registration,
          expiresAtMs: nowMs + this.dynamicClientTtlMs,
        },
        { maxDynamicClients: this.maxDynamicClients, nowMs },
      );
      if (result === "saved") {
        return cloneRegistration(registration);
      }
      if (result === "full") {
        throw new ConstrainedDcrError(
          "Dynamic client registry capacity exceeded",
          "registry_full",
          503,
        );
      }
    }

    throw new ConstrainedDcrError("Unable to allocate a client identifier", "registry_full", 503);
  }

  async getClient(clientId: string): Promise<ResolvedDcrClient | null> {
    const staticClient = this.staticClients.get(clientId);
    if (staticClient) {
      return { ...cloneRegistration(staticClient), registrationType: "static" };
    }

    const dynamic = await this.store.getDynamicClient(clientId, this.now());
    return dynamic
      ? {
          ...cloneRegistration(dynamic.registration),
          expiresAtMs: dynamic.expiresAtMs,
          registrationType: "dynamic",
        }
      : null;
  }

  async validateAuthorizationRequest(request: DcrAuthorizationRequest): Promise<ResolvedDcrClient> {
    const client = await this.getClient(request.clientId);
    if (!client) {
      throw new ConstrainedDcrError("Unknown or expired client", "invalid_client");
    }
    if (!client.redirect_uris.includes(request.redirectUri)) {
      throw new ConstrainedDcrError(
        "Redirect URI does not exactly match the registered URI",
        "invalid_redirect_uri",
      );
    }
    if (
      request.codeChallengeMethod !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/.test(request.codeChallenge)
    ) {
      throw new ConstrainedDcrError("A valid S256 PKCE challenge is required", "invalid_pkce");
    }
    const registeredScopes = new Set(client.scope?.split(" ") ?? []);
    const requestedScopes = request.requestedScopes ?? [...registeredScopes];
    if (
      requestedScopes.length === 0 ||
      new Set(requestedScopes).size !== requestedScopes.length ||
      requestedScopes.some((scope) => !isValidScopeToken(scope) || !registeredScopes.has(scope))
    ) {
      throw new ConstrainedDcrError(
        "Requested scope is not registered for this client",
        "invalid_scope",
      );
    }
    return client;
  }

  private addStaticClient(client: StaticDcrClient): void {
    validateGeneratedClientId(client.clientId);
    if (this.staticClients.has(client.clientId)) {
      throw new TypeError(`Duplicate static client id: ${client.clientId}`);
    }
    const redirectUris = validateRedirectUris(client.redirectUris, this.allowLoopbackRedirects);
    const registration: DcrRegistrationResponse = {
      client_id: client.clientId,
      client_id_issued_at: 0,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: validateStaticScopes(client.scopes ?? this.defaultScopes, this.allowedScopes).join(
        " ",
      ),
    };
    if (client.applicationType) {
      registration.application_type = validateApplicationType(client.applicationType);
    }
    if (client.clientName) {
      registration.client_name = validateBoundedString(client.clientName, "client_name", 128);
    }
    if (client.clientUri) {
      registration.client_uri = validatePublicMetadataUrl(client.clientUri, "client_uri");
    }
    this.staticClients.set(client.clientId, registration);
  }
}

function validateClientMetadata(
  input: unknown,
  allowLoopbackRedirects: boolean,
  allowedScopes: Set<string>,
  defaultScopes: string[],
): Omit<DcrRegistrationResponse, "client_id" | "client_id_issued_at"> {
  if (!isPlainRecord(input)) {
    throw invalidMetadata("Registration metadata must be a JSON object");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw invalidMetadata("Registration metadata must be serializable JSON");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_METADATA_BYTES) {
    throw invalidMetadata("Registration metadata is too large");
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_METADATA_KEYS.has(key)) {
      throw invalidMetadata(`Unsupported client metadata: ${key}`);
    }
  }

  requireExactStringArray(input.grant_types, ["authorization_code"], "grant_types");
  requireExactStringArray(input.response_types, ["code"], "response_types");
  if (input.token_endpoint_auth_method !== "none") {
    throw invalidMetadata("token_endpoint_auth_method must be none");
  }

  const registration: Omit<DcrRegistrationResponse, "client_id" | "client_id_issued_at"> = {
    redirect_uris: validateRedirectUris(input.redirect_uris, allowLoopbackRedirects),
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };

  if (input.application_type !== undefined) {
    registration.application_type = validateApplicationType(input.application_type);
  }
  if (input.client_name !== undefined) {
    registration.client_name = validateBoundedString(input.client_name, "client_name", 128);
  }
  if (input.contacts !== undefined) {
    registration.contacts = validateContacts(input.contacts);
  }
  registration.scope = validateRequestedScope(input.scope, allowedScopes, defaultScopes);
  for (const key of URL_METADATA_KEYS) {
    const value = input[key];
    if (value !== undefined) {
      registration[key] = validatePublicMetadataUrl(value, key);
    }
  }
  for (const key of ["software_id", "software_version"] as const) {
    const value = input[key];
    if (value !== undefined) {
      registration[key] = validateBoundedString(value, key, 128);
    }
  }

  return registration;
}

function validateRedirectUris(input: unknown, allowLoopback: boolean): string[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_REDIRECT_URIS) {
    throw new ConstrainedDcrError(
      `redirect_uris must contain between 1 and ${String(MAX_REDIRECT_URIS)} entries`,
      "invalid_redirect_uri",
    );
  }
  const unique = new Set<string>();
  for (const value of input) {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_URI_LENGTH) {
      throw new ConstrainedDcrError("Redirect URI is invalid", "invalid_redirect_uri");
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ConstrainedDcrError("Redirect URI is invalid", "invalid_redirect_uri");
    }
    if (
      url.hash ||
      url.username ||
      url.password ||
      !hasCanonicalIpv4Hostname(value, url) ||
      url.toString() !== value
    ) {
      throw new ConstrainedDcrError(
        "Redirect URI must be an exact canonical URI without credentials or fragment",
        "invalid_redirect_uri",
      );
    }
    const loopback = isLoopbackHostname(url.hostname);
    const validHttps = url.protocol === "https:" && !isPrivateHostname(url.hostname);
    const validLoopback = allowLoopback && url.protocol === "http:" && loopback;
    if (!validHttps && !validLoopback) {
      throw new ConstrainedDcrError(
        "Redirect URI must use public HTTPS or an enabled HTTP loopback address",
        "invalid_redirect_uri",
      );
    }
    if (unique.has(value)) {
      throw new ConstrainedDcrError("Redirect URIs must be unique", "invalid_redirect_uri");
    }
    unique.add(value);
  }
  return [...unique];
}

function validatePublicMetadataUrl(input: unknown, field: string): string {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_URI_LENGTH) {
    throw invalidMetadata(`${field} must be a public HTTPS URL`);
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw invalidMetadata(`${field} must be a public HTTPS URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !hasCanonicalIpv4Hostname(input, url) ||
    isPrivateHostname(url.hostname)
  ) {
    throw invalidMetadata(`${field} must be a public HTTPS URL`);
  }
  return url.toString();
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[(.*)]$/, "$1")
    .replace(/\.$/, "");
  if (
    isLoopbackHostname(normalized) ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".home.arpa")
  ) {
    return true;
  }
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    return isPrivateOrReservedIpv4(normalized);
  }
  if (ipVersion === 6) {
    const compact = normalized.toLowerCase();
    return (
      compact === "::" ||
      compact === "::1" ||
      compact.startsWith("::ffff:") ||
      compact.startsWith("fc") ||
      compact.startsWith("fd") ||
      /^fe[89abcdef]/.test(compact)
    );
  }
  return normalized.length === 0 || !normalized.includes(".");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[(.*)]$/, "$1")
    .replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  );
}

function isPrivateOrReservedIpv4(ip: string): boolean {
  return isSpecialUseIpv4(ip);
}

function validateApplicationType(input: unknown): "native" | "web" {
  if (input !== "native" && input !== "web") {
    throw invalidMetadata("application_type must be native or web");
  }
  return input;
}

function validateContacts(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 10) {
    throw invalidMetadata("contacts must be a non-empty array of email addresses");
  }
  return input.map((contact) => {
    const value = validateBoundedString(contact, "contacts", 254);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      throw invalidMetadata("contacts must contain valid email addresses");
    }
    return value;
  });
}

function validateScopeSyntax(input: unknown): string {
  const scope = validateBoundedString(input, "scope", 1_024);
  if (scope.split(" ").some((part) => !isValidScopeToken(part))) {
    throw invalidMetadata("scope is invalid");
  }
  return scope;
}

function validateRequestedScope(
  input: unknown,
  allowedScopes: Set<string>,
  defaultScopes: string[],
): string {
  const scopes = input === undefined ? [...defaultScopes] : validateScopeSyntax(input).split(" ");
  if (new Set(scopes).size !== scopes.length || scopes.some((scope) => !allowedScopes.has(scope))) {
    throw invalidMetadata("scope contains an unapproved value");
  }
  return scopes.join(" ");
}

function validateStaticScopes(input: string[], allowedScopes: Set<string>): string[] {
  const scopes = validateConfiguredScopes(input);
  if (scopes.some((scope) => !allowedScopes.has(scope))) {
    throw new TypeError("Static client scopes must be a subset of allowedScopes");
  }
  return scopes;
}

function validateConfiguredScopes(input: string[]): string[] {
  if (
    input.length === 0 ||
    new Set(input).size !== input.length ||
    input.some((scope) => !isValidScopeToken(scope))
  ) {
    throw new TypeError("Configured scopes must be unique valid OAuth scope tokens");
  }
  return [...input];
}

function isValidScopeToken(scope: unknown): scope is string {
  return typeof scope === "string" && scope.length > 0 && !/[^\x21\x23-\x5b\x5d-\x7e]/.test(scope);
}

function validateBoundedString(input: unknown, field: string, maxLength: number): string {
  if (typeof input !== "string" || input.length === 0 || input.length > maxLength) {
    throw invalidMetadata(
      `${field} must be a non-empty string of at most ${String(maxLength)} characters`,
    );
  }
  return input;
}

function requireExactStringArray(input: unknown, expected: string[], field: string): void {
  if (
    !Array.isArray(input) ||
    input.length !== expected.length ||
    input.some((value, index) => value !== expected[index])
  ) {
    throw invalidMetadata(`${field} must be ${JSON.stringify(expected)}`);
  }
}

function validateRateLimitKey(input: unknown): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 256) {
    throw new ConstrainedDcrError("A trusted rate-limit key is required", "invalid_request");
  }
  return input;
}

function validateGeneratedClientId(clientId: string): void {
  if (!/^[A-Za-z0-9._~-]{8,200}$/.test(clientId)) {
    throw new TypeError("Generated/static client id is invalid");
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function invalidMetadata(message: string): ConstrainedDcrError {
  return new ConstrainedDcrError(message, "invalid_client_metadata");
}

function cloneRegistration(registration: DcrRegistrationResponse): DcrRegistrationResponse {
  const cloned: DcrRegistrationResponse = {
    ...registration,
    redirect_uris: [...registration.redirect_uris],
    grant_types: ["authorization_code"],
    response_types: ["code"],
  };
  if (registration.contacts) {
    cloned.contacts = [...registration.contacts];
  }
  return cloned;
}

function cloneStoredClient(client: StoredDynamicDcrClient): StoredDynamicDcrClient {
  return {
    registration: cloneRegistration(client.registration),
    expiresAtMs: client.expiresAtMs,
  };
}

function generateClientId(): string {
  return `mcp_${randomBytes(24).toString("base64url")}`;
}
