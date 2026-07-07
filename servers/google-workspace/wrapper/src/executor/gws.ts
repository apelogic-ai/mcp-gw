import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { CatalogParam, WorkspaceToolDefinition } from "../catalog/types";

export type GwsExecutionErrorCode = "exit" | "invalid_json" | "spawn" | "timeout";

export class GwsExecutionError extends Error {
  constructor(
    message: string,
    public readonly code: GwsExecutionErrorCode,
    public readonly stderr = "",
    public readonly stdout = "",
  ) {
    super(message);
    this.name = "GwsExecutionError";
  }
}

export interface ExecuteGwsToolOptions {
  tool: WorkspaceToolDefinition;
  args: Record<string, unknown>;
  accessToken: string;
  gwsBinary: string;
  timeoutMs?: number;
  parentEnv?: Record<string, string | undefined>;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export async function executeGwsTool(options: ExecuteGwsToolOptions): Promise<unknown> {
  const homeDir = await mkdtemp(join(tmpdir(), "gws-home-"));
  const configDir = await mkdtemp(join(tmpdir(), "gws-config-"));

  try {
    const result = await spawnGws({
      ...options,
      childArgs: buildGwsArgs(options.tool, options.args),
      homeDir,
      configDir,
    });

    if (options.tool.resultMode === "text") {
      return result.stdout;
    }

    try {
      return JSON.parse(result.stdout) as unknown;
    } catch (error) {
      throw new GwsExecutionError("gws returned invalid JSON", "invalid_json", String(error));
    }
  } finally {
    await Promise.all([
      rm(homeDir, { recursive: true, force: true }),
      rm(configDir, { recursive: true, force: true }),
    ]);
  }
}

export function buildGwsArgs(
  tool: WorkspaceToolDefinition,
  args: Record<string, unknown>,
): string[] {
  if (tool.rawArgvParam) {
    return stringArrayArg(args, tool.rawArgvParam);
  }

  const commandArgs = [...tool.command];
  if (tool.paramsJsonParam || tool.bodyJsonParam || tool.extraArgsParam) {
    appendGeneratedGwsFlags(commandArgs, tool, args);
    return commandArgs;
  }

  const params = collectValues(tool.params, args, tool.defaultParams);
  const body = collectValues(tool.bodyParams ?? [], args);

  if (Object.keys(params).length > 0) {
    commandArgs.push("--params", JSON.stringify(params));
  }

  if (Object.keys(body).length > 0) {
    commandArgs.push("--json", JSON.stringify(body));
  }

  commandArgs.push("--format", "json");
  return commandArgs;
}

function appendGeneratedGwsFlags(
  commandArgs: string[],
  tool: WorkspaceToolDefinition,
  args: Record<string, unknown>,
): void {
  appendOptionalJsonFlag(commandArgs, "--params", args, tool.paramsJsonParam);
  appendOptionalJsonFlag(commandArgs, "--json", args, tool.bodyJsonParam);
  appendOptionalStringFlag(commandArgs, "--format", args, "format");
  appendOptionalStringFlag(commandArgs, "--sanitize", args, "sanitize");
  appendOptionalStringFlag(commandArgs, "--output", args, "output");
  appendOptionalStringFlag(commandArgs, "--upload", args, "upload");
  appendOptionalStringFlag(commandArgs, "--upload-content-type", args, "uploadContentType");
  appendOptionalNumberFlag(commandArgs, "--page-limit", args, "pageLimit");
  appendOptionalNumberFlag(commandArgs, "--page-delay", args, "pageDelay");

  if (args.dryRun === true) {
    commandArgs.push("--dry-run");
  }
  if (args.pageAll === true) {
    commandArgs.push("--page-all");
  }
  if (tool.extraArgsParam && args[tool.extraArgsParam] !== undefined) {
    commandArgs.push(...stringArrayArg(args, tool.extraArgsParam));
  }
}

function appendOptionalJsonFlag(
  commandArgs: string[],
  flag: string,
  args: Record<string, unknown>,
  name: string | undefined,
): void {
  if (!name || args[name] === undefined) {
    return;
  }

  if (!isRecord(args[name])) {
    throw new Error(`${name} must be an object`);
  }

  commandArgs.push(flag, JSON.stringify(args[name]));
}

function appendOptionalStringFlag(
  commandArgs: string[],
  flag: string,
  args: Record<string, unknown>,
  name: string,
): void {
  const value = args[name];
  if (value === undefined) {
    return;
  }

  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }

  commandArgs.push(flag, value);
}

function appendOptionalNumberFlag(
  commandArgs: string[],
  flag: string,
  args: Record<string, unknown>,
  name: string,
): void {
  const value = args[name];
  if (value === undefined) {
    return;
  }

  if (typeof value !== "number") {
    throw new Error(`${name} must be a number`);
  }

  commandArgs.push(flag, String(value));
}

function stringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (!isStringArray(value)) {
    throw new Error(`${name} must be an array of strings`);
  }

  return value;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface SpawnGwsOptions extends ExecuteGwsToolOptions {
  childArgs: string[];
  homeDir: string;
  configDir: string;
}

interface SpawnGwsResult {
  stdout: string;
}

function spawnGws(options: SpawnGwsOptions): Promise<SpawnGwsResult> {
  return new Promise((resolve, reject) => {
    const env = childEnv(options);
    const proc = spawn(options.gwsBinary, options.childArgs, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      callback();
    };

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      settle(() =>
        reject(
          new GwsExecutionError(
            "gws command timed out",
            "timeout",
            redact(stderr, options),
            redact(stdout, options),
          ),
        ),
      );
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timeout.unref();

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (error) => {
      settle(() =>
        reject(
          new GwsExecutionError(
            `failed to spawn gws: ${redact(error.message, options)}`,
            "spawn",
            redact(stderr, options),
            redact(stdout, options),
          ),
        ),
      );
    });

    proc.on("close", (exitCode) => {
      if (exitCode === 0) {
        settle(() => resolve({ stdout }));
        return;
      }

      settle(() =>
        reject(
          new GwsExecutionError(
            `gws exited with code ${String(exitCode ?? 1)}: ${redact(stderr || stdout, options)}`,
            "exit",
            redact(stderr, options),
            redact(stdout, options),
          ),
        ),
      );
    });
  });
}

function childEnv(options: SpawnGwsOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(options.parentEnv ?? process.env)) {
    if (key.toLowerCase() === "authorization") {
      continue;
    }

    if (key === "GOOGLE_WORKSPACE_CLI_TOKEN") {
      continue;
    }

    if (value !== undefined) {
      env[key] = value;
    }
  }

  env.GOOGLE_WORKSPACE_CLI_TOKEN = options.accessToken;
  env.HOME = options.homeDir;
  env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR = options.configDir;

  return env;
}

function collectValues(
  params: CatalogParam[],
  args: Record<string, unknown>,
  defaults: Record<string, unknown> = {},
): Record<string, unknown> {
  const values: Record<string, unknown> = { ...defaults };

  for (const param of params) {
    if (args[param.name] !== undefined) {
      values[param.name] = args[param.name];
    }
  }

  return values;
}

function redact(value: string, options: ExecuteGwsToolOptions): string {
  return value.split(options.accessToken).join("[redacted]");
}
