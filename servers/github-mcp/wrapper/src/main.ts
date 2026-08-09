import { readFileSync } from "node:fs";
import { Pool } from "pg";

import { JsonlAuditSink, type AuditSink } from "../../../../shared/audit/audit";
import {
  HOP1_SUPPORTED_ALGORITHMS,
  type Hop1Algorithm,
  type Hop1IssuerConfig,
  validateHop1IssuerProfiles,
} from "../../../../shared/identity/hop1";
import {
  GitHubTokenBroker,
  startGithubOAuth,
  type GitHubOAuthConfig,
} from "../../../../shared/oauth/github";
import { createPostgresQueryClient } from "../../../../shared/oauth/postgres-client";
import { SqlOAuthStateStore, SqlOAuthTokenStore } from "../../../../shared/oauth/sql-store";
import {
  CompositePolicy,
  createOpaPolicyFromUrl,
  createYamlPolicyFromString,
  type ToolPolicy,
} from "../../../../shared/policy/policy";
import {
  createRuntimeAuthenticator,
  createRemoteJwksProvider,
} from "../../../google-workspace/wrapper/src/runtime";
import { createGitHubOAuthRouteHandler } from "./oauth-routes";
import { createGithubMcpProxyHandler } from "./proxy";

export interface MainConfig {
  port: number;
  tokenStoreDsn: string;
  upstreamUrl: string;
  githubOAuth: GitHubOAuthConfig;
  githubScopes: string[];
  aliases: Record<string, string>;
  policy?: PolicyConfig;
  audit?: AuditConfig;
  hop1Issuers: Hop1IssuerConfig[];
}

export interface PolicyConfig {
  opaUrl?: string;
  yamlFile?: string;
}

export interface AuditConfig {
  jsonlPath?: string;
}

const DEFAULT_GITHUB_SCOPES = ["repo", "read:org", "workflow", "notifications", "user:email"];
const DEFAULT_UPSTREAM_URL = "http://github-mcp:8082/mcp";

export function loadMainConfig(env: Record<string, string | undefined>): MainConfig {
  return {
    port: Number(env.PORT ?? "8080"),
    tokenStoreDsn: requiredEnv(env, "TOKEN_STORE_DSN"),
    upstreamUrl: env.GITHUB_MCP_UPSTREAM_URL ?? DEFAULT_UPSTREAM_URL,
    githubOAuth: {
      clientId: requiredEnv(env, "GITHUB_OAUTH_CLIENT_ID"),
      clientSecret: requiredEnv(env, "GITHUB_OAUTH_CLIENT_SECRET"),
      redirectUri: requiredEnv(env, "GITHUB_OAUTH_REDIRECT_URI"),
      tokenEncryptionKey: requiredEnv(env, "GITHUB_TOKEN_ENCRYPTION_KEY"),
      authorizationUrl: optionalEnv(env, "GITHUB_OAUTH_AUTHORIZATION_URL"),
      tokenUrl: optionalEnv(env, "GITHUB_OAUTH_TOKEN_URL"),
      userEmailsUrl: optionalEnv(env, "GITHUB_OAUTH_USER_EMAILS_URL"),
      tokenRevocationUrl: optionalEnv(env, "GITHUB_OAUTH_TOKEN_REVOCATION_URL"),
    },
    githubScopes: parseScopes(env.GITHUB_OAUTH_SCOPES) ?? DEFAULT_GITHUB_SCOPES,
    aliases: parseAliases(env.GITHUB_TOOL_ALIASES_JSON),
    policy:
      env.OPA_POLICY_URL || env.GITHUB_POLICY_FILE
        ? {
            opaUrl: env.OPA_POLICY_URL,
            yamlFile: env.GITHUB_POLICY_FILE,
          }
        : undefined,
    audit: env.AUDIT_LOG_PATH ? { jsonlPath: env.AUDIT_LOG_PATH } : undefined,
    hop1Issuers: loadHop1Issuers(env),
  };
}

function optionalEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim();
  if (!value) {
    return undefined;
  }
  return value;
}

export function createMainHandler(config: MainConfig): (request: Request) => Promise<Response> {
  const pool = new Pool({
    connectionString: config.tokenStoreDsn,
  });
  const queryClient = createPostgresQueryClient(pool);
  const tokenStore = new SqlOAuthTokenStore(queryClient);
  const stateStore = new SqlOAuthStateStore(queryClient);
  const hop1Issuers = config.hop1Issuers.map((issuer) => ({
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
  const tokenBroker = new GitHubTokenBroker({
    config: config.githubOAuth,
    tokenStore,
  });
  const authenticate = createRuntimeAuthenticator({ issuers: hop1Issuers });
  const audit = createAuditSink(config);
  const oauthRoutes = createGitHubOAuthRouteHandler({
    authenticate,
    config: config.githubOAuth,
    scopes: config.githubScopes,
    stateStore,
    tokenStore,
    audit,
  });
  const mcpHandler = createGithubMcpProxyHandler({
    upstreamUrl: config.upstreamUrl,
    authenticate,
    resolveGithubToken: (identity) => tokenBroker.getAccessToken(identity, config.githubScopes),
    getOAuthStatus: async (identity) => {
      const account = await tokenStore.getAccount(identity.issuer, identity.subject, "github");
      if (!account || account.revokedAt) {
        return {
          connected: false,
          scopesRequired: config.githubScopes,
          scopesGranted: [],
          missingScopes: config.githubScopes,
        };
      }
      const missingScopes = missingRequiredScopes(config.githubScopes, account.scopesGranted);

      return {
        connected: missingScopes.length === 0,
        email: account.email,
        scopesRequired: config.githubScopes,
        scopesGranted: account.scopesGranted,
        missingScopes,
      };
    },
    startOAuth: async (identity, redirectAfter) =>
      startGithubOAuth({
        identity,
        scopes: config.githubScopes,
        config: config.githubOAuth,
        stateStore,
        redirectAfter,
      }),
    githubScopes: config.githubScopes,
    aliases: config.aliases,
    audit,
    policy: createPolicy(config),
  });

  return (request) => {
    const path = new URL(request.url).pathname;
    return path.startsWith("/oauth/github/") ? oauthRoutes(request) : mcpHandler(request);
  };
}

function createAuditSink(config: MainConfig): AuditSink | undefined {
  return config.audit?.jsonlPath ? new JsonlAuditSink(config.audit.jsonlPath) : undefined;
}

function createPolicy(config: MainConfig): ToolPolicy | undefined {
  const policies: ToolPolicy[] = [];

  if (config.policy?.yamlFile) {
    policies.push(createYamlPolicyFromString(readFileSync(config.policy.yamlFile, "utf8")));
  }
  if (config.policy?.opaUrl) {
    policies.push(createOpaPolicyFromUrl(config.policy.opaUrl));
  }

  if (policies.length === 0) {
    return undefined;
  }

  return policies.length === 1 ? policies[0] : new CompositePolicy(policies);
}

function loadHop1Issuers(env: Record<string, string | undefined>): Hop1IssuerConfig[] {
  if (env.HOP1_ISSUERS_JSON) {
    const parsed = JSON.parse(env.HOP1_ISSUERS_JSON) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("HOP1_ISSUERS_JSON must be a non-empty array");
    }

    return validateHop1IssuerProfiles(
      parsed.map((issuer, index) => parseHop1IssuerConfig(issuer, index, env)),
    );
  }

  const introspection = introspectionConfig(
    env.HOP1_INTROSPECTION_URL,
    env.HOP1_INTROSPECTION_CLIENT_CREDENTIAL,
    "HOP1_INTROSPECTION_URL and HOP1_INTROSPECTION_CLIENT_CREDENTIAL",
  );
  return validateHop1IssuerProfiles([
    {
      name: env.HOP1_PROFILE ?? "issuer",
      issuer: requiredEnv(env, "HOP1_ISSUER"),
      jwksUrl: requiredEnv(env, "HOP1_JWKS_URL"),
      audiences: requiredEnv(env, "HOP1_AUDIENCE")
        .split(",")
        .map((audience) => audience.trim())
        .filter(Boolean),
      allowedAlgorithms: parseAllowedAlgorithms(
        requiredEnv(env, "HOP1_ALLOWED_ALGORITHMS").split(/[\s,]+/),
        "HOP1_ALLOWED_ALGORITHMS",
      ),
      emailClaim: requiredEnv(env, "HOP1_EMAIL_CLAIM"),
      subjectClaim: env.HOP1_SUBJECT_CLAIM,
      ...introspection,
    },
  ]);
}

function parseHop1IssuerConfig(
  value: unknown,
  index: number,
  env: Record<string, string | undefined>,
): Hop1IssuerConfig {
  if (!value || typeof value !== "object") {
    throw new Error(`HOP1_ISSUERS_JSON[${String(index)}] must be an object`);
  }

  const record = value as Record<string, unknown>;
  const audiences = record.audiences;
  if (!Array.isArray(audiences) || audiences.some((audience) => typeof audience !== "string")) {
    throw new Error(`HOP1_ISSUERS_JSON[${String(index)}].audiences must be a string array`);
  }
  const audienceValues = audiences as string[];
  const allowedAlgorithms = parseAllowedAlgorithms(
    record.allowedAlgorithms,
    `HOP1_ISSUERS_JSON[${String(index)}].allowedAlgorithms`,
  );
  const introspectionUrl =
    typeof record.introspectionUrl === "string" && record.introspectionUrl.length > 0
      ? record.introspectionUrl
      : undefined;
  const literalIntrospectionClientCredential =
    typeof record.introspectionClientCredential === "string" &&
    record.introspectionClientCredential.length > 0
      ? record.introspectionClientCredential
      : undefined;
  const credentialEnv =
    typeof record.introspectionClientCredentialEnv === "string" &&
    record.introspectionClientCredentialEnv.length > 0
      ? record.introspectionClientCredentialEnv
      : undefined;
  const introspectionClientCredential =
    literalIntrospectionClientCredential ?? (credentialEnv ? env[credentialEnv] : undefined);
  const introspection = introspectionConfig(
    introspectionUrl,
    introspectionClientCredential,
    `HOP1_ISSUERS_JSON[${String(index)}].introspectionUrl and introspectionClientCredential`,
  );

  return {
    name: stringField(record, "name", index),
    issuer: stringField(record, "issuer", index),
    jwksUrl: stringField(record, "jwksUrl", index),
    audiences: audienceValues,
    allowedAlgorithms,
    emailClaim: stringField(record, "emailClaim", index),
    subjectClaim:
      typeof record.subjectClaim === "string" && record.subjectClaim.length > 0
        ? record.subjectClaim
        : undefined,
    ...introspection,
  };
}

function parseAllowedAlgorithms(value: unknown, name: string): Hop1Algorithm[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (algorithm) =>
        typeof algorithm !== "string" ||
        !HOP1_SUPPORTED_ALGORITHMS.includes(algorithm as Hop1Algorithm),
    )
  ) {
    throw new Error(`${name} must be a non-empty string array of supported algorithms`);
  }

  return value as Hop1Algorithm[];
}

function introspectionConfig(
  url: string | undefined,
  clientCredential: string | undefined,
  names: string,
): Pick<Hop1IssuerConfig, "introspectionUrl" | "introspectionClientCredential"> {
  if (Boolean(url) !== Boolean(clientCredential)) {
    throw new Error(`${names} must be set together`);
  }
  return url && clientCredential
    ? {
        introspectionUrl: url,
        introspectionClientCredential: clientCredential,
      }
    : {};
}

function stringField(record: Record<string, unknown>, name: string, index: number): string {
  const value = record[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`HOP1_ISSUERS_JSON[${String(index)}].${name} must be a non-empty string`);
  }

  return value;
}

function requiredEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
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

function parseAliases(value: string | undefined): Record<string, string> {
  if (!value) {
    return {};
  }

  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("GITHUB_TOOL_ALIASES_JSON must be an object");
  }

  const aliases: Record<string, string> = {};
  for (const [key, target] of Object.entries(parsed)) {
    if (typeof target !== "string" || target.length === 0) {
      throw new Error(`GITHUB_TOOL_ALIASES_JSON.${key} must be a non-empty string`);
    }
    aliases[key] = target;
  }

  return aliases;
}

function missingRequiredScopes(required: string[], granted: string[]): string[] {
  const grantedSet = new Set(granted);
  return required.filter((scope) => !grantedSet.has(scope));
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
