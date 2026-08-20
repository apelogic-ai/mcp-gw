import { readFileSync } from "node:fs";
import { isIP } from "node:net";

import { createRemoteJWKSet, importJWK, type JWK } from "jose";

import {
  OAuthBroker,
  OAuthBrokerError,
  type BrokerClientRegistry,
} from "../../../../shared/oauth/authorization-broker";
import {
  ConstrainedDcrError,
  ConstrainedDcrRegistry,
  type ConstrainedDcrRegistryOptions,
  type StaticDcrClient,
} from "../../../../shared/oauth/dcr";
import {
  DEFAULT_AUTHORIZATION_URL,
  DEFAULT_GOOGLE_TOKEN_URL,
  type GoogleOAuthConfig,
  type OAuthFetch,
} from "../../../../shared/oauth/google";
import type { SqlQueryClient } from "../../../../shared/oauth/sql-store";
import {
  SqlAuthorizationBrokerStore,
  SqlDcrRegistrationStore,
} from "../../../../shared/oauth/sql-authorization-store";
import {
  authorizationServerPublicPaths,
  createAuthorizationServerRouteHandler,
  type AuthorizationRequestContext,
} from "./authorization-routes";
import type { RuntimeTrustedIssuer } from "./runtime";

const DEFAULT_GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

export interface AuthorizationBrokerRuntimeConfig {
  issuer: string;
  resource: string;
  googleCallbackUri: string;
  signingJwksFile: string;
  activeSigningKid: string;
  scopes: string[];
  staticClients: StaticDcrClient[];
  dcr?: Omit<
    ConstrainedDcrRegistryOptions,
    "allowedScopes" | "defaultScopes" | "staticClients" | "store"
  >;
  dcrTrustedProxy?: {
    headerName: string;
    trustedAddresses: string[];
  };
}

export interface AuthorizationBrokerRuntime {
  handler(request: Request, context?: AuthorizationRequestContext): Promise<Response>;
  issuer: RuntimeTrustedIssuer;
  publicPaths: ReadonlySet<string>;
}

export async function createAuthorizationBrokerRuntime(input: {
  config: AuthorizationBrokerRuntimeConfig;
  google: GoogleOAuthConfig;
  queryClient: SqlQueryClient;
  fetch?: OAuthFetch;
  readSigningJwks?: (path: string) => string;
}): Promise<AuthorizationBrokerRuntime> {
  const { privateKey, publicJwk, verificationJwks } = await loadSigningKeys(
    input.config.signingJwksFile,
    input.config.activeSigningKid,
    input.readSigningJwks,
  );
  const registry = new ConstrainedDcrRegistry({
    ...input.config.dcr,
    allowedScopes: input.config.scopes,
    defaultScopes: input.config.scopes,
    staticClients: input.config.staticClients,
    store: new SqlDcrRegistrationStore(input.queryClient),
  });
  const clients: BrokerClientRegistry = {
    get: async (clientId) => {
      const client = await registry.getClient(clientId);
      return client
        ? {
            clientId: client.client_id,
            redirectUris: client.redirect_uris,
            scopes: client.scope?.split(" ").filter(Boolean) ?? [],
            clientName: client.client_name,
            clientUri: client.client_uri,
          }
        : null;
    },
  };
  const issuer = input.config.issuer.replace(/\/$/u, "");
  const fetchImpl = input.fetch ?? fetch;
  const broker = new OAuthBroker({
    issuer,
    resource: input.config.resource,
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    jwksUri: `${issuer}/.well-known/jwks.json`,
    scopesSupported: input.config.scopes,
    google: {
      clientId: input.google.clientId,
      authorizationEndpoint: input.google.authorizationUrl ?? DEFAULT_AUTHORIZATION_URL,
      callbackUri: input.config.googleCallbackUri,
      jwks: createRemoteJWKSet(new URL(input.google.googleJwksUrl ?? DEFAULT_GOOGLE_JWKS_URL)),
    },
    signing: {
      algorithm: "RS256",
      keyId: input.config.activeSigningKid,
      privateKey,
      publicJwk,
      verificationJwks,
    },
    clients,
    store: new SqlAuthorizationBrokerStore(input.queryClient),
    exchangeGoogleCode: (authorization) =>
      exchangeGoogleAuthorizationCode(input.google, authorization, fetchImpl),
  });
  const dcrEnabled = input.config.dcr !== undefined;
  validateTrustedProxyConfig(input.config.dcrTrustedProxy);
  const routeOptions = {
    broker,
    registration: dcrEnabled ? registry : undefined,
    googleCallbackUri: input.config.googleCallbackUri,
    registrationRateLimitKey: (request: Request, context: AuthorizationRequestContext) =>
      registrationAdmissionKey(request, context, input.config.dcrTrustedProxy),
  };
  const handler = createAuthorizationServerRouteHandler(routeOptions);
  const paths = authorizationServerPublicPaths(routeOptions);
  const jwks = broker.jwks().keys;

  return {
    handler,
    issuer: {
      profile: {
        name: "mcp-oauth-broker",
        issuer,
        audiences: [input.config.resource],
        allowedAlgorithms: ["RS256"],
        emailClaim: "email",
        subjectClaim: "sub",
      },
      jwksProvider: () => Promise.resolve(jwks),
    },
    publicPaths: paths.all,
  };
}

export function registrationAdmissionKey(
  request: Request,
  context: AuthorizationRequestContext,
  trustedProxy?: AuthorizationBrokerRuntimeConfig["dcrTrustedProxy"],
): string {
  const remoteAddress = normalizedIp(context.remoteAddress);
  if (!remoteAddress) {
    throw new ConstrainedDcrError(
      "Registration admission identity is unavailable",
      "registry_full",
      503,
    );
  }
  if (trustedProxy?.trustedAddresses.includes(remoteAddress)) {
    const forwarded = request.headers.get(trustedProxy.headerName);
    const forwardedAddress = normalizedIp(forwarded ?? undefined);
    if (!forwardedAddress) {
      throw new ConstrainedDcrError(
        "Trusted proxy did not supply one valid client address",
        "registry_full",
        503,
      );
    }
    return `ip:${forwardedAddress}`;
  }
  return `ip:${remoteAddress}`;
}

export async function exchangeGoogleAuthorizationCode(
  google: GoogleOAuthConfig,
  authorization: { code: string; codeVerifier: string; redirectUri: string },
  fetchImpl: OAuthFetch = fetch,
): Promise<{ idToken: string }> {
  const response = await fetchImpl(google.tokenUrl ?? DEFAULT_GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: authorization.code,
      client_id: google.clientId,
      client_secret: google.clientSecret,
      redirect_uri: authorization.redirectUri,
      code_verifier: authorization.codeVerifier,
    }),
  });
  const body = await readGoogleTokenResponse(response);
  if (!response.ok || typeof body.id_token !== "string" || body.id_token.length === 0) {
    throw new OAuthBrokerError("invalid_grant", "Google authorization code exchange failed");
  }
  return { idToken: body.id_token };
}

async function loadSigningKeys(
  path: string,
  activeKid: string,
  read: (path: string) => string = (file) => readFileSync(file, "utf8"),
): Promise<{ privateKey: CryptoKey; publicJwk: JWK; verificationJwks: JWK[] }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(read(path)) as unknown;
  } catch {
    throw new Error("MCP broker signing JWKS could not be read as JSON");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.keys)) {
    throw new Error("MCP broker signing file must contain a JWKS keys array");
  }
  const keys = parsed.keys.filter(isRecord) as JWK[];
  const active = keys.find((key) => key.kid === activeKid);
  if (active?.kty !== "RSA" || active.alg !== "RS256" || active.use !== "sig" || !active.d) {
    throw new Error("Active MCP broker key must be a private RS256 signing JWK");
  }
  const imported = await importJWK(active, "RS256");
  if (!(imported instanceof CryptoKey) || imported.type !== "private") {
    throw new Error("Active MCP broker key could not be imported as a private key");
  }
  const publicKeys = keys.map(publicJwk).filter((key) => key.kid !== activeKid);
  return { privateKey: imported, publicJwk: publicJwk(active), verificationJwks: publicKeys };
}

function publicJwk(key: JWK): JWK {
  const result: JWK = { ...key };
  delete result.d;
  delete result.dp;
  delete result.dq;
  delete result.p;
  delete result.q;
  delete result.qi;
  return result;
}

async function readGoogleTokenResponse(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    return isRecord(body) ? body : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateTrustedProxyConfig(
  config: AuthorizationBrokerRuntimeConfig["dcrTrustedProxy"],
): void {
  if (!config) return;
  if (!/^[a-z0-9-]{1,64}$/u.test(config.headerName)) {
    throw new Error("DCR trusted proxy header must be a normalized HTTP header name");
  }
  if (
    config.trustedAddresses.length === 0 ||
    config.trustedAddresses.some((address) => normalizedIp(address) !== address)
  ) {
    throw new Error("DCR trusted proxy addresses must contain normalized IP addresses");
  }
}

function normalizedIp(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate || candidate.length > 64 || candidate.includes(",") || isIP(candidate) === 0) {
    return undefined;
  }
  return candidate.toLowerCase();
}
