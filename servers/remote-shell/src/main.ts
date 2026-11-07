import { validateHop1IssuerProfiles, type Hop1IssuerConfig } from "../../../shared/identity/hop1";
import {
  createAuthenticator,
  createRemoteJwksProvider,
} from "../../../packages/wrapper-kit/src/authenticator";
import { createRemoteShellHttpHandler } from "./http";
import { createAwsCliRunner, createSsmRunCommand, credentialValues } from "./ssm-run-command";

export interface RemoteShellConfig {
  port: number;
  awsCliPath: string;
  awsRegion?: string;
  maxTimeoutSeconds: number;
  maxOutputBytes: number;
  requestLimits: { maxBodyBytes: number; maxCommandBytes: number };
  jobLimits: {
    maxJobs: number;
    maxRunningJobsPerOwner: number;
    retentionSeconds: number;
  };
  hop1Issuers: Hop1IssuerConfig[];
}

export function loadRemoteShellConfig(
  env: Readonly<Record<string, string | undefined>>,
): RemoteShellConfig {
  const rawIssuers = parseJson(required(env, "HOP1_ISSUERS_JSON"));
  if (!Array.isArray(rawIssuers)) throw new Error("HOP1_ISSUERS_JSON must be an array");
  const hop1Issuers = validateHop1IssuerProfiles(
    rawIssuers.map((value) => issuerWithCredential(value, env)),
  );
  const maxCommandBytes = integer(env.REMOTE_SHELL_MAX_COMMAND_BYTES, 16 * 1024, 1, 1024 * 1024);
  const maxBodyBytes = integer(
    env.REMOTE_SHELL_MAX_BODY_BYTES,
    17 * 1024,
    maxCommandBytes,
    2 * 1024 * 1024,
  );
  const maxJobs = integer(env.REMOTE_SHELL_MAX_JOBS, 64, 1, 4096);

  return {
    port: integer(env.PORT, 8080, 1, 65_535),
    awsCliPath: text(env.REMOTE_SHELL_AWS_CLI_PATH) ?? "/usr/local/bin/aws",
    awsRegion: text(env.AWS_REGION ?? env.AWS_DEFAULT_REGION),
    maxTimeoutSeconds: integer(env.REMOTE_SHELL_MAX_TIMEOUT_SECONDS, 60, 10, 3_600),
    maxOutputBytes: integer(env.REMOTE_SHELL_MAX_OUTPUT_BYTES, 24 * 1024, 1, 1024 * 1024),
    requestLimits: { maxBodyBytes, maxCommandBytes },
    jobLimits: {
      maxJobs,
      maxRunningJobsPerOwner: integer(env.REMOTE_SHELL_MAX_RUNNING_JOBS_PER_OWNER, 4, 1, maxJobs),
      retentionSeconds: integer(env.REMOTE_SHELL_JOB_RETENTION_SECONDS, 30 * 60, 1, 86_400),
    },
    hop1Issuers,
  };
}

function issuerWithCredential(
  value: unknown,
  env: Readonly<Record<string, string | undefined>>,
): Hop1IssuerConfig {
  if (!isRecord(value)) throw new Error("Invalid HOP-1 issuer profile");
  const { introspectionClientCredentialEnv, ...profile } = value;
  const credentialEnv = text(introspectionClientCredentialEnv);
  const credential = credentialEnv ? required(env, credentialEnv) : undefined;
  if (Boolean(profile.introspectionUrl) !== Boolean(credential)) {
    throw new Error("HOP-1 introspection URL and credential must be configured together");
  }
  return {
    ...(profile as unknown as Hop1IssuerConfig),
    ...(credential ? { introspectionClientCredential: credential } : {}),
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Remote-shell JSON configuration is invalid");
  }
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = text(env[name]);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error("Remote-shell numeric configuration is invalid");
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  const config = loadRemoteShellConfig(process.env);
  const runner = createAwsCliRunner({ binary: config.awsCliPath, env: process.env });
  const authenticate = createAuthenticator({
    issuers: config.hop1Issuers.map((issuer) => ({
      profile: issuer,
      jwksProvider: createRemoteJwksProvider(issuer.jwksUrl),
      ...(issuer.introspectionUrl && issuer.introspectionClientCredential
        ? {
            introspection: {
              url: issuer.introspectionUrl,
              clientCredential: issuer.introspectionClientCredential,
            },
          }
        : {}),
    })),
  });
  const handler = createRemoteShellHttpHandler({
    authenticate,
    maxTimeoutSeconds: config.maxTimeoutSeconds,
    requestLimits: config.requestLimits,
    jobLimits: config.jobLimits,
    ssm: createSsmRunCommand({
      runner,
      region: config.awsRegion,
      outputLimitBytes: config.maxOutputBytes,
      credentialValues: credentialValues(process.env),
    }),
    audit: { emit: (event) => Promise.resolve(console.log(JSON.stringify(event))) },
  });
  Bun.serve({ port: config.port, fetch: handler });
}
