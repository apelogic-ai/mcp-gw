import { Pool } from "pg";
import { JsonlAuditSink } from "../../../../shared/audit/audit";
import { createPostgresQueryClient } from "../../../../shared/oauth/postgres-client";
import { SqlOAuthStateStore, SqlOAuthTokenStore } from "../../../../shared/oauth/sql-store";
import { createOpaPolicyFromUrl } from "../../../../shared/policy/policy";
import { loadWrapperConfig, type WrapperConfig } from "./app";
import { createOAuthRouteHandler } from "./oauth-routes";
import {
  createRemoteJwksProvider,
  createRuntimeAuthenticator,
  createRuntimeWrapperHandler,
} from "./runtime";

export interface MainConfig {
  port: number;
  tokenStoreDsn: string;
  googleOAuthScopes: string[];
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

export function loadMainConfig(env: Record<string, string | undefined>): MainConfig {
  const wrapper = loadWrapperConfig(env);

  return {
    port: Number(env.PORT ?? "8080"),
    tokenStoreDsn: requiredEnv(env, "TOKEN_STORE_DSN"),
    googleOAuthScopes: parseScopes(env.GOOGLE_OAUTH_SCOPES) ?? DEFAULT_GOOGLE_OAUTH_SCOPES,
    wrapper,
  };
}

export function createMainHandler(config: MainConfig): (request: Request) => Promise<Response> {
  const pool = new Pool({
    connectionString: config.tokenStoreDsn,
  });
  const queryClient = createPostgresQueryClient(pool);
  const tokenStore = new SqlOAuthTokenStore(queryClient);
  const hop1Issuers = config.wrapper.hop1Issuers.map((issuer) => ({
    profile: issuer,
    jwksProvider: createRemoteJwksProvider(issuer.jwksUrl),
  }));
  const authenticate = createRuntimeAuthenticator({ issuers: hop1Issuers });
  const audit = config.wrapper.audit?.jsonlPath
    ? new JsonlAuditSink(config.wrapper.audit.jsonlPath)
    : undefined;
  const policy = config.wrapper.policy?.opaUrl
    ? createOpaPolicyFromUrl(config.wrapper.policy.opaUrl)
    : undefined;
  const oauthRoutes = createOAuthRouteHandler({
    authenticate,
    config: config.wrapper.oauth,
    scopes: config.googleOAuthScopes,
    stateStore: new SqlOAuthStateStore(queryClient),
    tokenStore,
    audit,
  });
  const mcpHandler = createRuntimeWrapperHandler({
    config: config.wrapper,
    tokenStore,
    issuers: hop1Issuers,
    audit,
    policy,
  });

  return (request) => {
    const path = new URL(request.url).pathname;
    return path === "/authorize" || path === "/token" || path.startsWith("/oauth/google/")
      ? oauthRoutes(request)
      : mcpHandler(request);
  };
}

function requiredEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
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

if (import.meta.main) {
  const config = loadMainConfig(process.env);
  const handler = createMainHandler(config);

  Bun.serve({
    port: config.port,
    fetch: handler,
  });

  console.log(`google-workspace wrapper listening on ${String(config.port)}`);
}
