import {
  HOP1_SUPPORTED_ALGORITHMS,
  type Hop1Algorithm,
  type Hop1Identity,
  type Hop1IssuerConfig,
  type IssuerProfile,
  validateHop1IssuerProfiles,
} from "../../../../shared/identity/hop1";
import type { AuditSink } from "../../../../shared/audit/audit";
import type { GoogleOAuthConfig } from "../../../../shared/oauth/google";
import type { ToolPolicy } from "../../../../shared/policy/policy";
import type { GoogleOAuthStatus, WorkspaceToolExecutor } from "./google-workspace/registry";
import { createGoogleWorkspaceRegistry } from "./google-workspace/registry";
import { createAuthenticatedMcpHttpHandler } from "./mcp/authenticated-http";

interface ServerInfo {
  name: string;
  version: string;
}

export interface WrapperConfig {
  gwsBinary: string;
  hop1: IssuerProfile;
  hop1Issuers: Hop1IssuerConfig[];
  oauth: GoogleOAuthConfig;
  policy?: PolicyConfig;
  audit?: AuditConfig;
}

export interface PolicyConfig {
  opaUrl?: string;
  yamlFile?: string;
}

export interface AuditConfig {
  jsonlPath?: string;
}

export interface CreateGoogleWorkspaceWrapperHandlerOptions {
  serverInfo: ServerInfo;
  authenticate(token: string): Promise<Hop1Identity>;
  audit?: AuditSink;
  policy?: ToolPolicy;
  getOAuthStatus?: (identity: Hop1Identity) => Promise<GoogleOAuthStatus>;
  startOAuth?: (
    identity: Hop1Identity,
    redirectAfter?: string,
  ) => Promise<{ authorizationUrl: string }>;
  tokenBroker: {
    getAccessToken(identity: Hop1Identity, requiredScopes: string[]): Promise<string>;
  };
  executor: WorkspaceToolExecutor;
}

export function createGoogleWorkspaceWrapperHandler(
  options: CreateGoogleWorkspaceWrapperHandlerOptions,
): (request: Request) => Promise<Response> {
  const startOAuth = options.startOAuth;
  return createAuthenticatedMcpHttpHandler({
    serverInfo: options.serverInfo,
    authenticate: (token) => options.authenticate(token),
    registryFor: async (identity) => {
      const oauthStatus = await options.getOAuthStatus?.(identity);
      return createGoogleWorkspaceRegistry({
        identity,
        audit: options.audit,
        policy: options.policy,
        tokenBroker: {
          getAccessToken: (requestIdentity, scopes) =>
            options.tokenBroker.getAccessToken(requestIdentity, scopes),
        },
        oauth:
          oauthStatus && startOAuth
            ? {
                status: oauthStatus,
                startOAuth: (redirectAfter) => startOAuth(identity, redirectAfter),
              }
            : undefined,
        executor: options.executor,
      });
    },
  });
}

export function loadWrapperConfig(env: Record<string, string | undefined>): WrapperConfig {
  const oauth: GoogleOAuthConfig = {
    clientId: requiredEnv(env, "GOOGLE_OAUTH_CLIENT_ID"),
    clientSecret: requiredEnv(env, "GOOGLE_OAUTH_CLIENT_SECRET"),
    redirectUri: requiredEnv(env, "GOOGLE_OAUTH_REDIRECT_URI"),
    tokenEncryptionKey: requiredEnv(env, "GOOGLE_TOKEN_ENCRYPTION_KEY"),
    authorizationUrl: optionalEnv(env, "GOOGLE_OAUTH_AUTHORIZATION_URL"),
    tokenUrl: optionalEnv(env, "GOOGLE_OAUTH_TOKEN_URL"),
    userInfoUrl: optionalEnv(env, "GOOGLE_OAUTH_USERINFO_URL"),
  };
  const hop1Issuers = loadHop1Issuers(env);
  const defaultHop1Issuer = hop1Issuers[0];
  if (!defaultHop1Issuer) {
    throw new Error("At least one HOP-1 issuer is required");
  }

  return {
    gwsBinary: requiredEnv(env, "GWS_BINARY_PATH"),
    hop1: defaultHop1Issuer,
    hop1Issuers,
    oauth,
    policy:
      env.OPA_POLICY_URL || env.GOOGLE_WORKSPACE_POLICY_FILE
        ? {
            opaUrl: env.OPA_POLICY_URL,
            yamlFile: env.GOOGLE_WORKSPACE_POLICY_FILE,
          }
        : undefined,
    audit: env.AUDIT_LOG_PATH ? { jsonlPath: env.AUDIT_LOG_PATH } : undefined,
  };
}

function optionalEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim();
  if (!value) {
    return undefined;
  }
  return value;
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
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}
