import { Pool } from "pg";

import {
  createRuntimeAuthenticator,
  createRemoteJwksProvider,
} from "../../../google-workspace/wrapper/src/runtime";
import type { Hop1IssuerConfig } from "../../../google-workspace/wrapper/src/app";
import { GitHubTokenBroker, type GitHubOAuthConfig } from "../../../../shared/oauth/github";
import { createPostgresQueryClient } from "../../../../shared/oauth/postgres-client";
import { SqlOAuthTokenStore } from "../../../../shared/oauth/sql-store";
import { createGithubMcpProxyHandler } from "./proxy";

export interface MainConfig {
  port: number;
  tokenStoreDsn: string;
  upstreamUrl: string;
  githubOAuth: GitHubOAuthConfig;
  githubScopes: string[];
  hop1Issuers: Hop1IssuerConfig[];
}

const DEFAULT_GITHUB_SCOPES = ["repo", "read:org", "workflow", "notifications"];
const DEFAULT_UPSTREAM_URL = "http://github-mcp:8082/mcp";

export function loadMainConfig(env: Record<string, string | undefined>): MainConfig {
  return {
    port: Number(env.PORT ?? "8080"),
    tokenStoreDsn: requiredEnv(env, "TOKEN_STORE_DSN"),
    upstreamUrl: env.GITHUB_MCP_UPSTREAM_URL ?? DEFAULT_UPSTREAM_URL,
    githubOAuth: {
      clientId: env.GITHUB_OAUTH_CLIENT_ID ?? "",
      clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET ?? "",
      redirectUri: env.GITHUB_OAUTH_REDIRECT_URI ?? "",
      tokenEncryptionKey: requiredEnv(env, "GITHUB_TOKEN_ENCRYPTION_KEY"),
    },
    githubScopes: parseScopes(env.GITHUB_OAUTH_SCOPES) ?? DEFAULT_GITHUB_SCOPES,
    hop1Issuers: loadHop1Issuers(env),
  };
}

export function createMainHandler(config: MainConfig): (request: Request) => Promise<Response> {
  const pool = new Pool({
    connectionString: config.tokenStoreDsn,
  });
  const queryClient = createPostgresQueryClient(pool);
  const tokenStore = new SqlOAuthTokenStore(queryClient);
  const hop1Issuers = config.hop1Issuers.map((issuer) => ({
    profile: issuer,
    jwksProvider: createRemoteJwksProvider(issuer.jwksUrl),
  }));
  const tokenBroker = new GitHubTokenBroker({
    config: config.githubOAuth,
    tokenStore,
  });

  return createGithubMcpProxyHandler({
    upstreamUrl: config.upstreamUrl,
    authenticate: createRuntimeAuthenticator({ issuers: hop1Issuers }),
    resolveGithubToken: (identity) => tokenBroker.getAccessToken(identity, config.githubScopes),
  });
}

function loadHop1Issuers(env: Record<string, string | undefined>): Hop1IssuerConfig[] {
  if (env.HOP1_ISSUERS_JSON) {
    const parsed = JSON.parse(env.HOP1_ISSUERS_JSON) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("HOP1_ISSUERS_JSON must be a non-empty array");
    }

    return parsed.map((issuer, index) => parseHop1IssuerConfig(issuer, index));
  }

  return [
    {
      name: env.HOP1_PROFILE ?? "google",
      issuer: requiredEnv(env, "HOP1_ISSUER"),
      jwksUrl: requiredEnv(env, "HOP1_JWKS_URL"),
      audiences: requiredEnv(env, "HOP1_AUDIENCE")
        .split(",")
        .map((audience) => audience.trim())
        .filter(Boolean),
      emailClaim: requiredEnv(env, "HOP1_EMAIL_CLAIM"),
      subjectClaim: env.HOP1_SUBJECT_CLAIM,
    },
  ];
}

function parseHop1IssuerConfig(value: unknown, index: number): Hop1IssuerConfig {
  if (!value || typeof value !== "object") {
    throw new Error(`HOP1_ISSUERS_JSON[${String(index)}] must be an object`);
  }

  const record = value as Record<string, unknown>;
  const audiences = record.audiences;
  if (!Array.isArray(audiences) || audiences.some((audience) => typeof audience !== "string")) {
    throw new Error(`HOP1_ISSUERS_JSON[${String(index)}].audiences must be a string array`);
  }
  const audienceValues = audiences as string[];

  return {
    name: stringField(record, "name", index),
    issuer: stringField(record, "issuer", index),
    jwksUrl: stringField(record, "jwksUrl", index),
    audiences: audienceValues,
    emailClaim: stringField(record, "emailClaim", index),
    subjectClaim:
      typeof record.subjectClaim === "string" && record.subjectClaim.length > 0
        ? record.subjectClaim
        : undefined,
  };
}

function stringField(record: Record<string, unknown>, name: string, index: number): string {
  const value = record[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`HOP1_ISSUERS_JSON[${String(index)}].${name} must be a non-empty string`);
  }

  return value;
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

  console.log(`github-mcp wrapper listening on ${String(config.port)}`);
}
