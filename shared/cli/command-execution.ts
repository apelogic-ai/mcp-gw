import { spawn } from "node:child_process";

import type { PolicyDecision, ToolPolicy, ToolPolicyInput } from "../policy/policy";

export const ACTION_CLASSES = ["read", "write", "destructive"] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

export interface CliExecutionResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  duration_ms: number;
  class: ActionClass;
}

export interface CliRunnerConfig {
  binary: string;
  fixedArgs?: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd: string;
  redactValues?: readonly string[];
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  maxOutputBytes: number;
}

export interface CliExecutionOptions {
  credentialEnv?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  rejectOnNonZero?: boolean;
}

export class CliExecutionError extends Error {
  constructor(
    message: string,
    public readonly code: "configuration" | "spawn" | "timeout" | "exit" = "configuration",
    public readonly stderr = "",
    public readonly stdout = "",
    public readonly exitCode: number | null = null,
  ) {
    super(message);
    this.name = "CliExecutionError";
  }
}

export function executeCli(
  config: CliRunnerConfig,
  args: readonly string[],
  commandClass: ActionClass,
  timeoutSeconds?: number,
  options: CliExecutionOptions = {},
): Promise<CliExecutionResult> {
  const timeout = timeoutSeconds ?? config.defaultTimeoutSeconds;
  if (
    options.timeoutMs === undefined &&
    (!Number.isInteger(timeout) || timeout <= 0 || timeout > config.maxTimeoutSeconds)
  ) {
    return Promise.reject(new CliExecutionError("timeout_seconds is outside the allowed range"));
  }

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const redactions = [
      ...(config.redactValues ?? []),
      ...Object.values(options.credentialEnv ?? {}),
    ].filter(Boolean);
    const outputLimit = config.maxOutputBytes;
    const extraBytes = Math.max(0, ...redactions.map((value) => Buffer.byteLength(value)));
    const captureLimit = outputLimit + extraBytes;
    const proc = spawn(config.binary, [...(config.fixedArgs ?? []), ...args], {
      cwd: config.cwd,
      env: { ...config.env, ...options.credentialEnv },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const output = (value: Buffer, bytes: number, alwaysRedact = false) =>
      boundOutput(
        value,
        bytes,
        outputLimit,
        redactions,
        alwaysRedact || Number.isFinite(outputLimit),
      );
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      callback();
    };
    const failure = (
      code: "spawn" | "timeout" | "exit",
      message: string,
      exitCode: number | null = null,
    ): CliExecutionError => {
      const [stderrValue] = output(stderr, stderrBytes, true);
      const [stdoutValue] = output(stdout, stdoutBytes, true);
      return new CliExecutionError(
        redact(message, redactions),
        code,
        stderrValue,
        stdoutValue,
        exitCode,
      );
    };

    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      stdout = appendBounded(stdout, chunk, captureLimit);
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      stderr = appendBounded(stderr, chunk, captureLimit);
    });
    proc.on("error", (error) => settle(() => reject(failure("spawn", error.message))));
    proc.on("close", (exitCode) => {
      if (settled) return;
      if (options.rejectOnNonZero && exitCode !== 0) {
        settle(() => reject(failure("exit", "command exited unsuccessfully", exitCode)));
        return;
      }
      const [stdoutValue, stdoutTruncated] = output(stdout, stdoutBytes);
      const [stderrValue, stderrTruncated] = output(stderr, stderrBytes);
      settle(() =>
        resolve({
          exit_code: timedOut ? 124 : (exitCode ?? 1),
          stdout: stdoutValue,
          stderr: stderrValue,
          stdout_truncated: stdoutTruncated,
          stderr_truncated: stderrTruncated,
          duration_ms: Date.now() - started,
          class: commandClass,
        }),
      );
    });

    const timeoutTimer = setTimeout(
      () => {
        timedOut = true;
        proc.kill("SIGTERM");
        if (options.timeoutMs !== undefined) {
          settle(() => reject(failure("timeout", "command timed out")));
        } else {
          forceKillTimer = setTimeout(() => proc.kill("SIGKILL"), 250);
          forceKillTimer.unref();
        }
      },
      options.timeoutMs ?? timeout * 1000,
    );
    timeoutTimer.unref();
  });
}

export const evaluateCommandPolicy = (
  policy: ToolPolicy,
  input: ToolPolicyInput,
): Promise<PolicyDecision> => policy.decide(input);

function appendBounded(current: Buffer, chunk: Buffer, limit: number): Buffer {
  if (current.length >= limit) return current;
  return Buffer.concat([current, chunk.subarray(0, limit - current.length)]);
}

function boundOutput(
  value: Buffer,
  originalBytes: number,
  limit: number,
  redactions: readonly string[],
  shouldRedact: boolean,
): [string, boolean] {
  const raw = value.toString("utf8");
  const safe = shouldRedact ? redact(raw, redactions) : raw;
  const bounded = Buffer.from(safe);
  return [
    bounded.subarray(0, limit).toString("utf8"),
    originalBytes > limit || bounded.length > limit,
  ];
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets.reduce((result, secret) => result.split(secret).join("[redacted]"), value);
}
