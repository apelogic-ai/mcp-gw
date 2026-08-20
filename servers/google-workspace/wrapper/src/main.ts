import { Pool } from "pg";
import { JsonlAuditSink } from "../../../../shared/audit/audit";
import {
  createPostgresPoolConfig,
  createPostgresQueryClient,
} from "../../../../shared/oauth/postgres-client";
import { SqlOAuthStateStore, SqlOAuthTokenStore } from "../../../../shared/oauth/sql-store";
import { createOpaPolicyFromUrl } from "../../../../shared/policy/policy";
import { loadWrapperConfig, type WrapperConfig } from "./app";
import { createOAuthRouteHandler } from "./oauth-routes";
import {
  createAuthorizationBrokerRuntime,
  type AuthorizationBrokerRuntimeConfig,
} from "./broker-runtime";
import {
  createRemoteJwksProvider,
  createRuntimeAuthenticator,
  createRuntimeWrapperHandler,
} from "./runtime";

export interface MainConfig {
  port: number;
  tokenStoreDsn: string;
  postgresCaBundlePath?: string;
  hop1OAuthScopes: string[];
  googleOAuthScopes: string[];
  authorizationBroker?: AuthorizationBrokerRuntimeConfig;
  wrapper: WrapperConfig;
}

const DEFAULT_GOOGLE_OAUTH_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/meetings.space.created",
];
const DEFAULT_HOP1_OAUTH_SCOPES = ["openid", "email"];

export function loadMainConfig(env: Record<string, string | undefined>): MainConfig {
  const wrapper = loadWrapperConfig(env);
  const authorizationBroker = parseAuthorizationBrokerConfig(env);
  if (
    authorizationBroker &&
    wrapper.hop1Issuers.some((issuer) => issuer.issuer === "https://accounts.google.com")
  ) {
    throw new Error(
      "Direct Google identity tokens cannot remain trusted when MCP_BROKER_ENABLED is true",
    );
  }

  return {
    port: Number(env.PORT ?? "8080"),
    tokenStoreDsn: requiredEnv(env, "TOKEN_STORE_DSN"),
    postgresCaBundlePath: optionalEnv(env, "POSTGRES_CA_BUNDLE_PATH"),
    hop1OAuthScopes: parseScopes(env.HOP1_OAUTH_SCOPES) ?? DEFAULT_HOP1_OAUTH_SCOPES,
    googleOAuthScopes: parseScopes(env.GOOGLE_OAUTH_SCOPES) ?? DEFAULT_GOOGLE_OAUTH_SCOPES,
    authorizationBroker,
    wrapper,
  };
}

export async function createMainHandler(
  config: MainConfig,
): Promise<(request: Request, context?: { remoteAddress?: string }) => Promise<Response>> {
  const pool = new Pool(
    createPostgresPoolConfig(config.tokenStoreDsn, config.postgresCaBundlePath),
  );
  const queryClient = createPostgresQueryClient(pool);
  const tokenStore = new SqlOAuthTokenStore(queryClient);
  const configuredHop1Issuers = config.wrapper.hop1Issuers.map((issuer) => ({
    profile: issuer,
    jwksProvider: createRemoteJwksProvider(issuer.jwksUrl),
    introspection:
      issuer.introspectionUrl && issuer.introspectionClientCredential
        ? {
            url: issuer.introspectionUrl,
            clientCredential: issuer.introspectionClientCredential,
          }
        : undefined,
  }));
  const stateStore = new SqlOAuthStateStore(queryClient);
  const audit = config.wrapper.audit?.jsonlPath
    ? new JsonlAuditSink(config.wrapper.audit.jsonlPath)
    : undefined;
  const policy = config.wrapper.policy?.opaUrl
    ? createOpaPolicyFromUrl(config.wrapper.policy.opaUrl)
    : undefined;
  const authorizationBroker = config.authorizationBroker
    ? await createAuthorizationBrokerRuntime({
        config: config.authorizationBroker,
        google: config.wrapper.oauth,
        queryClient,
      })
    : undefined;
  const hop1Issuers = authorizationBroker
    ? [...configuredHop1Issuers, authorizationBroker.issuer]
    : configuredHop1Issuers;
  const authenticate = createRuntimeAuthenticator({ issuers: hop1Issuers });
  const oauthRoutes = createOAuthRouteHandler({
    authenticate,
    config: config.wrapper.oauth,
    scopes: config.googleOAuthScopes,
    stateStore,
    tokenStore,
    audit,
  });
  const mcpHandler = createRuntimeWrapperHandler({
    config: config.wrapper,
    tokenStore,
    issuers: hop1Issuers,
    audit,
    policy,
    providerOAuth: {
      scopes: config.googleOAuthScopes,
      stateStore,
    },
  });

  return (request, context) => {
    const path = new URL(request.url).pathname;
    if (authorizationBroker?.publicPaths.has(path)) {
      return authorizationBroker.handler(request, context);
    }
    return path.startsWith("/oauth/google/") ? oauthRoutes(request) : mcpHandler(request);
  };
}

function parseAuthorizationBrokerConfig(
  env: Record<string, string | undefined>,
): AuthorizationBrokerRuntimeConfig | undefined {
  if (!parseBoolean(env.MCP_BROKER_ENABLED, false)) {
    return undefined;
  }
  const scopes = parseScopes(env.MCP_BROKER_SCOPES) ?? ["mcp"];
  const staticClients = parseJsonArray(
    env.MCP_OAUTH_STATIC_CLIENTS_JSON,
    "MCP_OAUTH_STATIC_CLIENTS_JSON",
  );
  const dcrEnabled = parseBoolean(env.MCP_DCR_ENABLED, false);
  const trustedProxyHeader = optionalEnv(env, "MCP_DCR_TRUSTED_PROXY_HEADER");
  const trustedProxyAddresses = parseScopes(env.MCP_DCR_TRUSTED_PROXY_ADDRESSES);
  if (Boolean(trustedProxyHeader) !== Boolean(trustedProxyAddresses)) {
    throw new Error(
      "MCP_DCR_TRUSTED_PROXY_HEADER and MCP_DCR_TRUSTED_PROXY_ADDRESSES must be set together",
    );
  }
  if (staticClients.length === 0 && !dcrEnabled) {
    throw new Error("MCP broker requires a static client or constrained DCR");
  }
  return {
    issuer: requiredEnv(env, "MCP_AUTHORIZATION_ISSUER"),
    resource: requiredEnv(env, "MCP_RESOURCE_URI"),
    googleCallbackUri: requiredEnv(env, "MCP_BROKER_GOOGLE_REDIRECT_URI"),
    signingJwksFile: requiredEnv(env, "MCP_BROKER_SIGNING_JWKS_FILE"),
    activeSigningKid: requiredEnv(env, "MCP_BROKER_ACTIVE_KID"),
    scopes,
    staticClients: staticClients as AuthorizationBrokerRuntimeConfig["staticClients"],
    dcrTrustedProxy:
      trustedProxyHeader && trustedProxyAddresses
        ? { headerName: trustedProxyHeader.toLowerCase(), trustedAddresses: trustedProxyAddresses }
        : undefined,
    dcr: dcrEnabled
      ? {
          allowLoopbackRedirects: parseBoolean(env.MCP_DCR_ALLOW_LOOPBACK_REDIRECTS, false),
          dynamicClientTtlMs: parsePositiveInteger(env.MCP_DCR_CLIENT_TTL_MS),
          maxDynamicClients: parsePositiveInteger(env.MCP_DCR_MAX_CLIENTS),
          maxRateLimitKeys: parsePositiveInteger(env.MCP_DCR_MAX_RATE_KEYS),
          maxRegistrationsPerWindow: parsePositiveInteger(env.MCP_DCR_RATE_LIMIT),
          rateLimitWindowMs: parsePositiveInteger(env.MCP_DCR_RATE_WINDOW_MS),
        }
      : undefined,
  };
}

function requiredEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}

function optionalEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim();
  if (!value) {
    return undefined;
  }
  return value;
}

function parseScopes(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const scopes = value
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

  return scopes.length > 0 ? scopes : undefined;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Expected boolean value, received: ${value}`);
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }
  return parsed;
}

function parseJsonArray(value: string | undefined, name: string): unknown[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON array`);
  }
  return parsed;
}

if (import.meta.main) {
  const config = loadMainConfig(process.env);
  const handler = await createMainHandler(config);

  Bun.serve({
    port: config.port,
    fetch: (request, server) =>
      handler(request, { remoteAddress: server.requestIP(request)?.address }),
  });

  console.log(`google-workspace wrapper listening on ${String(config.port)}`);
}
