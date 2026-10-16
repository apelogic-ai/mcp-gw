import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parse } from "yaml";

import type { CliRunnerConfig } from "./executor";
import { CLI_DECISIONS_SCHEMA, type CliDecisionCatalog, type CommandClass } from "./catalog";

export const CLI_PACK_SCHEMA = "mcp-gateway.cli-pack/v1" as const;

export interface CliPackFlags {
  value: readonly string[];
  boolean: readonly string[];
  output: readonly string[];
}

export interface CliPackOperation {
  rbacVerbs: readonly string[];
  rbacResources: readonly string[];
  flags: CliPackFlags;
}

export interface CliPack {
  schemaVersion: typeof CLI_PACK_SCHEMA;
  cli: string;
  parser: "kubectl";
  binary: {
    path: string;
    version: string;
    sha256: Readonly<Record<"amd64" | "arm64", string>>;
  };
  credential: { provider: string; sourceEnv: string; targetEnv: string };
  runner: CliRunnerConfig;
  requestLimits: { maxBodyBytes: number; maxArgs: number; maxArgBytes: number };
  jobLimits: { maxJobs: number; maxRunningJobsPerOwner: number; retentionSeconds: number };
  operations: Readonly<Record<string, CliPackOperation>>;
  outputFormats: ReadonlySet<string>;
  secretOverlay: {
    operations: ReadonlySet<string>;
    resources: ReadonlySet<string>;
    class: "secret-read";
  };
  catalog: CliDecisionCatalog;
}

export async function loadCliPack(path: string): Promise<CliPack> {
  return parseCliPack(await readFile(path, "utf8"));
}

export function parseCliPack(source: string): CliPack {
  const root = record(parse(source) as unknown, "pack");
  only(root, [
    "schemaVersion",
    "cli",
    "parser",
    "binary",
    "credential",
    "runner",
    "operations",
    "outputFormats",
    "secretOverlay",
  ]);
  if (root.schemaVersion !== CLI_PACK_SCHEMA) {
    throw new Error(`pack.schemaVersion must be ${CLI_PACK_SCHEMA}`);
  }
  const cli = name(root.cli, "pack.cli");
  if (root.parser !== "kubectl") throw new Error("pack.parser must be kubectl");

  const binary = record(root.binary, "pack.binary");
  only(binary, ["path", "version", "sha256"]);
  const path = absolute(binary.path, "pack.binary.path");
  const version = text(binary.version, "pack.binary.version");
  const sha256 = record(binary.sha256, "pack.binary.sha256");
  only(sha256, ["amd64", "arm64"]);
  const digests = {
    amd64: digest(sha256.amd64, "pack.binary.sha256.amd64"),
    arm64: digest(sha256.arm64, "pack.binary.sha256.arm64"),
  };

  const credential = record(root.credential, "pack.credential");
  only(credential, ["provider", "sourceEnv", "targetEnv"]);
  const credentialConfig = {
    provider: name(credential.provider, "pack.credential.provider"),
    sourceEnv: envName(credential.sourceEnv, "pack.credential.sourceEnv"),
    targetEnv: envName(credential.targetEnv, "pack.credential.targetEnv"),
  };

  const runner = record(root.runner, "pack.runner");
  only(runner, ["cwd", "env", "limits"]);
  const fixedEnv = stringRecord(runner.env, "pack.runner.env");
  if (credentialConfig.targetEnv in fixedEnv) {
    throw new Error("credential targetEnv must not be present in runner.env");
  }
  const limits = record(runner.limits, "pack.runner.limits");
  only(limits, [
    "requestBodyBytes",
    "args",
    "argBytes",
    "timeoutSeconds",
    "maxTimeoutSeconds",
    "outputBytes",
    "maxJobs",
    "maxRunningJobsPerOwner",
    "jobRetentionSeconds",
  ]);
  const timeoutSeconds = positive(limits.timeoutSeconds, "pack.runner.limits.timeoutSeconds");
  const maxTimeoutSeconds = positive(
    limits.maxTimeoutSeconds,
    "pack.runner.limits.maxTimeoutSeconds",
  );
  if (timeoutSeconds > maxTimeoutSeconds) {
    throw new Error("pack runner timeout exceeds its maximum");
  }

  const operations = parseOperations(root.operations);
  const outputFormats = new Set(stringList(root.outputFormats, "pack.outputFormats"));
  const overlay = record(root.secretOverlay, "pack.secretOverlay");
  only(overlay, ["operations", "resources", "class"]);
  if (overlay.class !== "secret-read") {
    throw new Error("pack.secretOverlay.class must be secret-read");
  }
  const overlayOperations = new Set(
    stringList(overlay.operations, "pack.secretOverlay.operations"),
  );
  for (const operation of overlayOperations) {
    if (!operations[operation]) throw new Error(`secret overlay references unknown ${operation}`);
  }
  const secretOverlay = {
    operations: overlayOperations,
    resources: new Set(stringList(overlay.resources, "pack.secretOverlay.resources")),
    class: "secret-read" as const,
  };

  const commands: Record<string, { class: CommandClass }> = {};
  for (const [operation, config] of Object.entries(operations)) {
    commands[operation] = { class: classForRbacVerbs(config.rbacVerbs) };
    if (secretOverlay.operations.has(operation)) {
      commands[`${operation}:secret`] = { class: secretOverlay.class };
    }
  }

  return {
    schemaVersion: CLI_PACK_SCHEMA,
    cli,
    parser: "kubectl",
    binary: { path, version, sha256: digests },
    credential: credentialConfig,
    runner: {
      binary: path,
      env: fixedEnv,
      cwd: absolute(runner.cwd, "pack.runner.cwd"),
      defaultTimeoutSeconds: timeoutSeconds,
      maxTimeoutSeconds,
      maxOutputBytes: positive(limits.outputBytes, "pack.runner.limits.outputBytes"),
    },
    requestLimits: {
      maxBodyBytes: positive(limits.requestBodyBytes, "pack.runner.limits.requestBodyBytes"),
      maxArgs: positive(limits.args, "pack.runner.limits.args"),
      maxArgBytes: positive(limits.argBytes, "pack.runner.limits.argBytes"),
    },
    jobLimits: {
      maxJobs: positive(limits.maxJobs, "pack.runner.limits.maxJobs"),
      maxRunningJobsPerOwner: positive(
        limits.maxRunningJobsPerOwner,
        "pack.runner.limits.maxRunningJobsPerOwner",
      ),
      retentionSeconds: positive(
        limits.jobRetentionSeconds,
        "pack.runner.limits.jobRetentionSeconds",
      ),
    },
    operations,
    outputFormats,
    secretOverlay,
    catalog: { schemaVersion: CLI_DECISIONS_SCHEMA, cli, commands },
  };
}

export async function verifyCliPackBinary(
  pack: CliPack,
  architecture: NodeJS.Architecture = process.arch,
): Promise<void> {
  const arch = architecture === "x64" ? "amd64" : architecture;
  if (arch !== "amd64" && arch !== "arm64") throw new Error(`unsupported architecture: ${arch}`);
  await access(pack.binary.path, fsConstants.X_OK);
  const actual = createHash("sha256")
    .update(await readFile(pack.binary.path))
    .digest("hex");
  if (actual !== pack.binary.sha256[arch]) throw new Error("CLI binary digest mismatch");
}

function parseOperations(value: unknown): Record<string, CliPackOperation> {
  const source = record(value, "pack.operations");
  if (Object.keys(source).length === 0) throw new Error("pack.operations must not be empty");
  const operations: Record<string, CliPackOperation> = {};
  for (const [operation, raw] of Object.entries(source)) {
    name(operation, "pack operation");
    const config = record(raw, `pack.operations.${operation}`);
    only(config, ["rbacVerbs", "rbacResources", "flags"]);
    const flags = record(config.flags, `pack.operations.${operation}.flags`);
    only(flags, ["value", "boolean", "output"]);
    const parsedFlags = {
      value: flagList(flags.value, operation),
      boolean: flagList(flags.boolean, operation),
      output: flagList(flags.output, operation),
    };
    const allFlags = [...parsedFlags.value, ...parsedFlags.boolean, ...parsedFlags.output];
    if (new Set(allFlags).size !== allFlags.length) {
      throw new Error(`pack operation ${operation} repeats a flag`);
    }
    const rbacVerbs = stringList(config.rbacVerbs, `${operation}.rbacVerbs`);
    classForRbacVerbs(rbacVerbs);
    operations[operation] = {
      rbacVerbs,
      rbacResources: stringList(config.rbacResources, `${operation}.rbacResources`),
      flags: parsedFlags,
    };
  }
  return operations;
}

function classForRbacVerbs(verbs: readonly string[]): "read" {
  if (verbs.length === 0 || verbs.some((verb) => verb !== "get" && verb !== "list")) {
    throw new Error("kubectl pack permits only read RBAC verbs get and list");
  }
  return "read";
}

function flagList(value: unknown, operation: string): string[] {
  if (!Array.isArray(value) || value.some((item) => !textValue(item))) {
    throw new Error(`${operation}.flags must be a string array`);
  }
  const flags = value as string[];
  if (flags.some((flag) => !flag.startsWith("-") || flag.includes("="))) {
    throw new Error(`pack operation ${operation} contains an invalid flag`);
  }
  return flags;
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => !textValue(item))) {
    throw new Error(`${field} must be a non-empty string array`);
  }
  return value as string[];
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  const source = record(value, field);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(source)) {
    envName(key, `${field} key`);
    result[key] = text(item, `${field}.${key}`);
  }
  return result;
}

function only(value: Record<string, unknown>, fields: string[]): void {
  const extra = Object.keys(value).find((field) => !fields.includes(field));
  if (extra) throw new Error(`unknown pack field: ${extra}`);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function positive(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value as number;
}

function name(value: unknown, field: string): string {
  const result = text(value, field);
  if (!/^[a-z][a-z0-9-]*$/.test(result)) throw new Error(`${field} is invalid`);
  return result;
}

function absolute(value: unknown, field: string): string {
  const result = text(value, field);
  if (!result.startsWith("/")) throw new Error(`${field} must be absolute`);
  return result;
}

function envName(value: unknown, field: string): string {
  const result = text(value, field);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(result)) throw new Error(`${field} is invalid`);
  return result;
}

function digest(value: unknown, field: string): string {
  const result = text(value, field);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${field} is invalid`);
  return result;
}

function text(value: unknown, field: string): string {
  if (!textValue(value)) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function textValue(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
