import type { Hop1Identity, IssuerProfile } from "../../../../shared/identity/hop1";
import type { AuditSink } from "../../../../shared/audit/audit";
import type { GoogleOAuthConfig } from "../../../../shared/oauth/google";
import type { ToolPolicy } from "../../../../shared/policy/policy";
import type { WorkspaceToolExecutor } from "./google-workspace/registry";
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

export interface Hop1IssuerConfig extends IssuerProfile {
  jwksUrl: string;
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
  tokenBroker: {
    getAccessToken(identity: Hop1Identity, requiredScopes: string[]): Promise<string>;
  };
  executor: WorkspaceToolExecutor;
}

export function createGoogleWorkspaceWrapperHandler(
  options: CreateGoogleWorkspaceWrapperHandlerOptions,
): (request: Request) => Promise<Response> {
  return createAuthenticatedMcpHttpHandler({
    serverInfo: options.serverInfo,
    authenticate: (token) => options.authenticate(token),
    registryFor: (identity) =>
      createGoogleWorkspaceRegistry({
        identity,
        audit: options.audit,
        policy: options.policy,
        tokenBroker: {
          getAccessToken: (requestIdentity, scopes) =>
            options.tokenBroker.getAccessToken(requestIdentity, scopes),
        },
        executor: options.executor,
      }),
  });
}

export function loadWrapperConfig(env: Record<string, string | undefined>): WrapperConfig {
  const oauth: GoogleOAuthConfig = {
    clientId: requiredEnv(env, "GOOGLE_OAUTH_CLIENT_ID"),
    clientSecret: requiredEnv(env, "GOOGLE_OAUTH_CLIENT_SECRET"),
    redirectUri: requiredEnv(env, "GOOGLE_OAUTH_REDIRECT_URI"),
    tokenEncryptionKey: requiredEnv(env, "GOOGLE_TOKEN_ENCRYPTION_KEY"),
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
