import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";

import {
  HOP1_SUPPORTED_ALGORITHMS,
  validateHop1IssuerProfiles,
  type Hop1Algorithm,
  type Hop1IssuerConfig,
  type Hop1Identity,
} from "../../../shared/identity/hop1";
import {
  createAuthenticator,
  createRemoteJwksProvider,
} from "../../../packages/wrapper-kit/src/authenticator";
import { createAuthenticatedMcpHttpHandler } from "../../../packages/wrapper-kit/src/mcp/authenticated-http";
import {
  ConsoleRemoteShellAuditSink,
  createRemoteShellRegistry,
  type RemoteShellAuditSink,
  type RemoteShellBinding,
} from "./registry";
import {
  createAwsCliRunner,
  createSsmRunCommand,
  credentialValues,
  type SsmRunRequest,
  type SsmRunResult,
} from "./ssm-run-command";

const INSTANCE_ID_PATTERN = /^i-[0-9a-f]{8}(?:[0-9a-f]{9})?$/;
const ROLE_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const DEFAULT_MAX_TIMEOUT_SECONDS = 60;
const DEFAULT_MAX_OUTPUT_BYTES = 24 * 1024;

export interface RemoteShellConfig {
  port: number;
  awsCliPath: string;
  awsRegion?: string;
  maxTimeoutSeconds: number;
  maxOutputBytes: number;
  hop1Issuers: Hop1IssuerConfig[];
  bindings: RemoteShellBinding[];
}

export interface CreateRemoteShellHandlerOptions {
  authenticate(token: string): Promise<Hop1Identity>;
  bindings: readonly RemoteShellBinding[];
  maxTimeoutSeconds: number;
  execute(request: SsmRunRequest): Promise<SsmRunResult>;
  audit?: RemoteShellAuditSink;
}

export function loadRemoteShellConfig(
  env: Readonly<Record<string, string | undefined>>,
): RemoteShellConfig {
  return {
    port: positiveInteger(env.PORT, "PORT", 8080, 65_535),
    awsCliPath: optionalString(env.REMOTE_SHELL_AWS_CLI_PATH) ?? "/usr/local/bin/aws",
    awsRegion: optionalString(env.AWS_REGION ?? env.AWS_DEFAULT_REGION),
    maxTimeoutSeconds: positiveInteger(
      env.REMOTE_SHELL_MAX_TIMEOUT_SECONDS,
      "REMOTE_SHELL_MAX_TIMEOUT_SECONDS",
      DEFAULT_MAX_TIMEOUT_SECONDS,
      3_600,
      10,
    ),
    maxOutputBytes: positiveInteger(
      env.REMOTE_SHELL_MAX_OUTPUT_BYTES,
      "REMOTE_SHELL_MAX_OUTPUT_BYTES",
      DEFAULT_MAX_OUTPUT_BYTES,
      1024 * 1024,
    ),
    hop1Issuers: parseHop1Issuers(env),
    bindings: parseBindings(requiredEnv(env, "REMOTE_SHELL_BINDINGS_JSON")),
  };
}

export function createRemoteShellHandler(
  options: CreateRemoteShellHandlerOptions,
): (request: Request) => Promise<Response> {
  return createAuthenticatedMcpHttpHandler({
    serverInfo: { name: "remote-shell", version: "0.1.0" },
    authenticate: (token) => options.authenticate(token),
    registryFor: (identity) =>
      createRemoteShellRegistry({
        identity,
        bindings: options.bindings,
        maxTimeoutSeconds: options.maxTimeoutSeconds,
        execute: (request) => options.execute(request),
        audit: options.audit,
      }),
  });
}

export async function assertAwsCliExecutable(path: string): Promise<void> {
  try {
    await access(path, fsConstants.X_OK);
  } catch {
    throw new Error(`REMOTE_SHELL_AWS_CLI_PATH is not executable: ${path}`);
  }
}

function parseHop1Issuers(env: Readonly<Record<string, string | undefined>>): Hop1IssuerConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requiredEnv(env, "HOP1_ISSUERS_JSON")) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Missing required")) throw error;
    throw new Error("HOP1_ISSUERS_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("HOP1_ISSUERS_JSON must be a non-empty array");
  }
  return validateHop1IssuerProfiles(
    parsed.map((value, index) => parseHop1Issuer(value, index, env)),
  );
}

function parseHop1Issuer(
  value: unknown,
  index: number,
  env: Readonly<Record<string, string | undefined>>,
): Hop1IssuerConfig {
  if (!isRecord(value)) throw new Error(`HOP1_ISSUERS_JSON[${String(index)}] must be an object`);
  const audiences = stringArray(value.audiences, `HOP1_ISSUERS_JSON[${String(index)}].audiences`);
  const algorithms = stringArray(
    value.allowedAlgorithms,
    `HOP1_ISSUERS_JSON[${String(index)}].allowedAlgorithms`,
  );
  if (
    algorithms.some((algorithm) => !HOP1_SUPPORTED_ALGORITHMS.includes(algorithm as Hop1Algorithm))
  ) {
    throw new Error(`HOP1_ISSUERS_JSON[${String(index)}].allowedAlgorithms is unsupported`);
  }
  const introspectionUrl = optionalString(value.introspectionUrl);
  const credentialEnv = optionalString(value.introspectionClientCredentialEnv);
  if (Boolean(introspectionUrl) !== Boolean(credentialEnv)) {
    throw new Error(
      `HOP1_ISSUERS_JSON[${String(index)}] introspectionUrl and introspectionClientCredentialEnv must be set together`,
    );
  }
  const introspectionClientCredential = credentialEnv ? requiredEnv(env, credentialEnv) : undefined;

  return {
    name: requiredString(value.name, `HOP1_ISSUERS_JSON[${String(index)}].name`),
    issuer: requiredString(value.issuer, `HOP1_ISSUERS_JSON[${String(index)}].issuer`),
    jwksUrl: requiredString(value.jwksUrl, `HOP1_ISSUERS_JSON[${String(index)}].jwksUrl`),
    audiences,
    allowedAlgorithms: algorithms as Hop1Algorithm[],
    emailClaim: requiredString(value.emailClaim, `HOP1_ISSUERS_JSON[${String(index)}].emailClaim`),
    subjectClaim: optionalString(value.subjectClaim),
    ...(introspectionUrl && introspectionClientCredential
      ? { introspectionUrl, introspectionClientCredential }
      : {}),
  };
}

function parseBindings(raw: string): RemoteShellBinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("REMOTE_SHELL_BINDINGS_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("REMOTE_SHELL_BINDINGS_JSON must be a non-empty array");
  }
  const bindings = parsed.map((value, index) => parseBinding(value, index));
  const keys = new Set<string>();
  for (const binding of bindings) {
    const key = JSON.stringify([binding.issuer, binding.subject]);
    if (keys.has(key)) throw new Error("REMOTE_SHELL_BINDINGS_JSON contains a duplicate principal");
    keys.add(key);
  }
  return bindings;
}

function parseBinding(value: unknown, index: number): RemoteShellBinding {
  if (!isRecord(value)) {
    throw new Error(`REMOTE_SHELL_BINDINGS_JSON[${String(index)}] must be an object`);
  }
  if (!isRecord(value.targets) || Object.keys(value.targets).length === 0) {
    throw new Error(
      `REMOTE_SHELL_BINDINGS_JSON[${String(index)}].targets must be a non-empty object`,
    );
  }
  const targets: Record<string, string> = {};
  for (const [role, instanceId] of Object.entries(value.targets)) {
    if (
      !ROLE_PATTERN.test(role) ||
      typeof instanceId !== "string" ||
      !INSTANCE_ID_PATTERN.test(instanceId)
    ) {
      throw new Error(
        `REMOTE_SHELL_BINDINGS_JSON[${String(index)}].targets contains an invalid role or instance ID`,
      );
    }
    targets[role] = instanceId;
  }
  return {
    issuer: requiredString(value.issuer, `REMOTE_SHELL_BINDINGS_JSON[${String(index)}].issuer`),
    subject: requiredString(value.subject, `REMOTE_SHELL_BINDINGS_JSON[${String(index)}].subject`),
    targets,
  };
}

function requiredEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function positiveInteger(
  value: string | undefined,
  name: string,
  defaultValue: number,
  maximum: number,
  minimum = 1,
): number {
  if (!value?.trim()) return defaultValue;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${String(minimum)} and ${String(maximum)}`);
  }
  return parsed;
}

function requiredString(value: unknown, path: string): string {
  const parsed = optionalString(value);
  if (!parsed) throw new Error(`${path} must be a non-empty string`);
  return parsed;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => !optionalString(item))) {
    throw new Error(`${path} must be a non-empty string array`);
  }
  return value.map((item) => (item as string).trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  const config = loadRemoteShellConfig(process.env);
  await assertAwsCliExecutable(config.awsCliPath);
  const runner = createAwsCliRunner({ binary: config.awsCliPath, env: process.env });
  const execute = createSsmRunCommand({
    runner,
    region: config.awsRegion,
    outputLimitBytes: config.maxOutputBytes,
    credentialValues: credentialValues(process.env),
  });
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
  const handler = createRemoteShellHandler({
    authenticate,
    bindings: config.bindings,
    maxTimeoutSeconds: config.maxTimeoutSeconds,
    execute,
    audit: new ConsoleRemoteShellAuditSink(),
  });

  Bun.serve({ port: config.port, fetch: handler });
  console.log(`remote-shell server listening on ${String(config.port)}`);
}
