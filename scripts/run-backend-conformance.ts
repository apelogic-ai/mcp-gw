import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse as parseYaml } from "yaml";

import {
  runBackendConformance,
  type BackendConformanceScenario,
  type BackendConformanceTarget,
  type BackendConformanceToolCall,
} from "../packages/backend-conformance/src/index";

const CONFIG_SCHEMA = "mcp-gateway.backend-conformance/v1";

interface FileScenario {
  url?: string;
  toolCall?: BackendConformanceToolCall;
}

interface FileConfig {
  schemaVersion: typeof CONFIG_SCHEMA;
  name: string;
  url: string;
  sessionMode: "required" | "optional";
  policyDenial: BackendConformanceTarget["policyDenial"];
  tokens: {
    validEnv: string;
    expiredEnv: string;
    wrongAudienceEnv: string;
    otherPrincipalEnv?: string;
  };
  toolCall: BackendConformanceToolCall;
  concurrency?: number;
  requestTimeoutMs?: number;
  scenarios?: {
    policyDenied?: FileScenario;
    upstream5xx?: FileScenario;
    upstreamTimeout?: FileScenario;
    gatewayFailOpen?: FileScenario;
    gatewayFailClosed?: FileScenario;
  };
  evidence?: {
    upstreamFiles?: string[];
    logFiles?: string[];
    forbiddenUpstreamEnv?: string[];
    requiredUpstreamEnv?: string[];
    forbiddenOutputEnv?: string[];
  };
}

export async function runBackendConformanceCli(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const configPath = configArgument(argv);
  const config = parseFileConfig(parseYaml(await readFile(configPath, "utf8")));
  let activeUrl = config.url;
  const scenario = (
    kind: BackendConformanceScenario,
    input: FileScenario | undefined,
  ): { activate(): void; toolCall?: BackendConformanceToolCall } | undefined => {
    if (!input) return undefined;
    return {
      activate: () => {
        activeUrl = input.url ?? config.url;
        void kind;
      },
      ...(input.toolCall ? { toolCall: input.toolCall } : {}),
    };
  };
  const target: BackendConformanceTarget = {
    name: config.name,
    endpoint: config.url,
    send: (request) => fetch(copyRequestToUrl(request, activeUrl)),
    tokens: {
      valid: requiredEnv(env, config.tokens.validEnv),
      expired: requiredEnv(env, config.tokens.expiredEnv),
      wrongAudience: requiredEnv(env, config.tokens.wrongAudienceEnv),
      ...(config.tokens.otherPrincipalEnv
        ? { otherPrincipal: requiredEnv(env, config.tokens.otherPrincipalEnv) }
        : {}),
    },
    sessionMode: config.sessionMode,
    policyDenial: config.policyDenial,
    toolCall: config.toolCall,
    ...(config.concurrency ? { concurrency: config.concurrency } : {}),
    ...(config.requestTimeoutMs ? { requestTimeoutMs: config.requestTimeoutMs } : {}),
    scenarios: {
      policyDenied: scenario("policy_denied", config.scenarios?.policyDenied),
      upstream5xx: scenario("upstream_5xx", config.scenarios?.upstream5xx),
      upstreamTimeout: scenario("upstream_timeout", config.scenarios?.upstreamTimeout),
      gatewayFailOpen: scenario("upstream_5xx", config.scenarios?.gatewayFailOpen),
      gatewayFailClosed: scenario("upstream_5xx", config.scenarios?.gatewayFailClosed),
      reset: () => {
        activeUrl = config.url;
      },
    },
    ...(config.evidence
      ? {
          evidence: {
            upstream: () => readEvidenceFiles(config.evidence?.upstreamFiles ?? []),
            logs: async () => (await readEvidenceFiles(config.evidence?.logFiles ?? [])).join("\n"),
            forbiddenUpstreamValues: envValues(env, config.evidence.forbiddenUpstreamEnv ?? []),
            requiredUpstreamValues: envValues(env, config.evidence.requiredUpstreamEnv ?? []),
            forbiddenOutputValues: envValues(env, config.evidence.forbiddenOutputEnv ?? []),
          },
        }
      : {}),
  };
  const report = await runBackendConformance(target);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.failures.length === 0 ? 0 : 1;
}

function configArgument(argv: string[]): string {
  const index = argv.indexOf("--config");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) throw new Error("Usage: bun run conformance:backend --config <path>");
  return resolve(value);
}

function parseFileConfig(value: unknown): FileConfig {
  const record = objectValue(value, "config");
  if (record.schemaVersion !== CONFIG_SCHEMA) {
    throw new Error(`schemaVersion must be ${CONFIG_SCHEMA}`);
  }
  const tokens = objectValue(record.tokens, "tokens");
  const toolCall = parseToolCall(record.toolCall, "toolCall");
  const sessionMode = record.sessionMode;
  if (sessionMode !== "required" && sessionMode !== "optional") {
    throw new Error("sessionMode must be required or optional");
  }
  const policyDenial = record.policyDenial;
  if (
    policyDenial !== "mcp_tool_error" &&
    policyDenial !== "jsonrpc_error" &&
    policyDenial !== "transport_error"
  ) {
    throw new Error("policyDenial must name a supported denial contract");
  }
  const scenarios = optionalObject(record.scenarios, "scenarios");
  const evidence = optionalObject(record.evidence, "evidence");
  return {
    schemaVersion: CONFIG_SCHEMA,
    name: nonEmptyString(record.name, "name"),
    url: httpUrl(record.url, "url"),
    sessionMode,
    policyDenial,
    tokens: {
      validEnv: envName(tokens.validEnv, "tokens.validEnv"),
      expiredEnv: envName(tokens.expiredEnv, "tokens.expiredEnv"),
      wrongAudienceEnv: envName(tokens.wrongAudienceEnv, "tokens.wrongAudienceEnv"),
      ...(tokens.otherPrincipalEnv === undefined
        ? {}
        : { otherPrincipalEnv: envName(tokens.otherPrincipalEnv, "tokens.otherPrincipalEnv") }),
    },
    toolCall,
    ...(record.concurrency === undefined
      ? {}
      : { concurrency: positiveInteger(record.concurrency, "concurrency") }),
    ...(record.requestTimeoutMs === undefined
      ? {}
      : {
          requestTimeoutMs: positiveInteger(record.requestTimeoutMs, "requestTimeoutMs"),
        }),
    ...(scenarios
      ? {
          scenarios: {
            policyDenied: parseScenario(scenarios.policyDenied, "scenarios.policyDenied"),
            upstream5xx: parseScenario(scenarios.upstream5xx, "scenarios.upstream5xx"),
            upstreamTimeout: parseScenario(scenarios.upstreamTimeout, "scenarios.upstreamTimeout"),
            gatewayFailOpen: parseScenario(scenarios.gatewayFailOpen, "scenarios.gatewayFailOpen"),
            gatewayFailClosed: parseScenario(
              scenarios.gatewayFailClosed,
              "scenarios.gatewayFailClosed",
            ),
          },
        }
      : {}),
    ...(evidence
      ? {
          evidence: {
            upstreamFiles: stringArray(evidence.upstreamFiles, "evidence.upstreamFiles"),
            logFiles: stringArray(evidence.logFiles, "evidence.logFiles"),
            forbiddenUpstreamEnv: envNameArray(
              evidence.forbiddenUpstreamEnv,
              "evidence.forbiddenUpstreamEnv",
            ),
            requiredUpstreamEnv: envNameArray(
              evidence.requiredUpstreamEnv,
              "evidence.requiredUpstreamEnv",
            ),
            forbiddenOutputEnv: envNameArray(
              evidence.forbiddenOutputEnv,
              "evidence.forbiddenOutputEnv",
            ),
          },
        }
      : {}),
  };
}

function parseScenario(value: unknown, name: string): FileScenario | undefined {
  if (value === undefined) return undefined;
  const record = objectValue(value, name);
  return {
    ...(record.url === undefined ? {} : { url: httpUrl(record.url, `${name}.url`) }),
    ...(record.toolCall === undefined
      ? {}
      : { toolCall: parseToolCall(record.toolCall, `${name}.toolCall`) }),
  };
}

function parseToolCall(value: unknown, name: string): BackendConformanceToolCall {
  const record = objectValue(value, name);
  return {
    name: nonEmptyString(record.name, `${name}.name`),
    arguments: objectValue(record.arguments ?? {}, `${name}.arguments`),
  };
}

function copyRequestToUrl(request: Request, url: string): Request {
  return new Request(url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    duplex: request.body ? "half" : undefined,
  } as RequestInit);
}

async function readEvidenceFiles(paths: readonly string[]): Promise<string[]> {
  return Promise.all(paths.map((path) => readFile(resolve(path), "utf8")));
}

function envValues(env: Record<string, string | undefined>, names: readonly string[]): string[] {
  return names.map((name) => requiredEnv(env, name));
}

function requiredEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Required environment variable is missing: ${name}`);
  return value;
}

function envName(value: unknown, name: string): string {
  const result = nonEmptyString(value, name);
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(result)) throw new Error(`${name} must be an env name`);
  return result;
}

function envNameArray(value: unknown, name: string): string[] {
  return stringArray(value, name).map((entry, index) =>
    envName(entry, `${name}[${String(index)}]`),
  );
}

function stringArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be a string array`);
  return value.map((entry, index) => nonEmptyString(entry, `${name}[${String(index)}]`));
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function httpUrl(value: unknown, name: string): string {
  const result = nonEmptyString(value, name);
  const url = new URL(result);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
    throw new Error(`${name} must be an absolute HTTP(S) URL`);
  }
  return result;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be non-empty`);
  return value;
}

function optionalObject(value: unknown, name: string): Record<string, unknown> | undefined {
  return value === undefined ? undefined : objectValue(value, name);
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

if (import.meta.main) {
  try {
    process.exitCode = await runBackendConformanceCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "backend conformance failed");
    process.exitCode = 2;
  }
}
