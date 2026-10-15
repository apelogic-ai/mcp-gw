import { spawn } from "node:child_process";
import type { CommandClass } from "./catalog";

export interface CliExecutionResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  duration_ms: number;
  class: CommandClass;
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

export class CliExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliExecutionError";
  }
}

export function executeCli(
  config: CliRunnerConfig,
  args: readonly string[],
  commandClass: CommandClass,
  timeoutSeconds?: number,
): Promise<CliExecutionResult> {
  const timeout = timeoutSeconds ?? config.defaultTimeoutSeconds;
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > config.maxTimeoutSeconds) {
    return Promise.reject(new CliExecutionError("timeout_seconds is outside the allowed range"));
  }

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const extraBytes = Math.max(
      0,
      ...(config.redactValues ?? []).map((value) => Buffer.byteLength(value)),
    );
    const captureLimit = config.maxOutputBytes + extraBytes;
    const proc = spawn(config.binary, [...(config.fixedArgs ?? []), ...args], {
      cwd: config.cwd,
      env: { ...config.env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      stdout = appendBounded(stdout, chunk, captureLimit);
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      stderr = appendBounded(stderr, chunk, captureLimit);
    });
    proc.on("error", (error) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(new CliExecutionError(redact(error.message, config.redactValues)));
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      forceKillTimer = setTimeout(() => proc.kill("SIGKILL"), 250);
      forceKillTimer.unref();
    }, timeout * 1000);
    timer.unref();

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      const boundedStdout = boundRedacted(stdout, config.maxOutputBytes, config.redactValues);
      const boundedStderr = boundRedacted(stderr, config.maxOutputBytes, config.redactValues);
      resolve({
        exit_code: timedOut ? 124 : (code ?? 1),
        stdout: boundedStdout.value,
        stderr: boundedStderr.value,
        stdout_truncated: stdoutBytes > config.maxOutputBytes || boundedStdout.truncated,
        stderr_truncated: stderrBytes > config.maxOutputBytes || boundedStderr.truncated,
        duration_ms: Date.now() - started,
        class: commandClass,
      });
    });
  });
}

function appendBounded(current: Buffer, chunk: Buffer, limit: number): Buffer {
  if (current.length >= limit) return current;
  return Buffer.concat([current, chunk.subarray(0, limit - current.length)]);
}

function boundRedacted(
  value: Buffer,
  limit: number,
  secrets: readonly string[] | undefined,
): { value: string; truncated: boolean } {
  const redacted = Buffer.from(redact(value.toString("utf8"), secrets));
  return {
    value: redacted.subarray(0, limit).toString("utf8"),
    truncated: redacted.length > limit,
  };
}

function redact(value: string, secrets: readonly string[] | undefined): string {
  return (secrets ?? [])
    .filter(Boolean)
    .reduce((result, secret) => result.split(secret).join("[redacted]"), value);
}
