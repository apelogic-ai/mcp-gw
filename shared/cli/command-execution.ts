import { spawn } from "node:child_process";

import type { PolicyDecision, ToolPolicy, ToolPolicyInput } from "../policy/policy";

export const ACTION_CLASSES = ["read", "secret-read", "write", "destructive"] as const;
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
  onOutput?: (stream: "stdout" | "stderr", data: string) => void;
  signal?: AbortSignal;
}

export class CliExecutionError extends Error {
  constructor(
    message: string,
    public readonly code:
      "configuration" | "spawn" | "timeout" | "exit" | "cancelled" = "configuration",
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
  if (options.signal?.aborted) {
    return Promise.reject(new CliExecutionError("command cancelled", "cancelled"));
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
    const stdoutStream = new RedactedOutputStream(outputLimit, redactions, (data) =>
      options.onOutput?.("stdout", data),
    );
    const stderrStream = new RedactedOutputStream(outputLimit, redactions, (data) =>
      options.onOutput?.("stderr", data),
    );
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
    let cancelled = false;
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
      stdoutStream.flush();
      stderrStream.flush();
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", cancel);
      callback();
    };
    const failure = (
      code: "spawn" | "timeout" | "exit" | "cancelled",
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
      stdoutStream.push(chunk);
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      stderr = appendBounded(stderr, chunk, captureLimit);
      stderrStream.push(chunk);
    });
    proc.on("error", (error) => settle(() => reject(failure("spawn", error.message))));
    proc.on("close", (exitCode) => {
      if (settled) return;
      if (cancelled) {
        settle(() => reject(failure("cancelled", "command cancelled")));
        return;
      }
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

    const terminate = (): void => {
      proc.kill("SIGTERM");
      forceKillTimer = setTimeout(() => proc.kill("SIGKILL"), 250);
      forceKillTimer.unref();
    };
    const cancel = (): void => {
      if (settled || cancelled) return;
      cancelled = true;
      clearTimeout(timeoutTimer);
      terminate();
    };
    options.signal?.addEventListener("abort", cancel, { once: true });

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

class RedactedOutputStream {
  private readonly decoder = new TextDecoder();
  private pending = "";
  private emittedBytes = 0;
  private flushed = false;

  constructor(
    private readonly limit: number,
    private readonly secrets: readonly string[],
    private readonly emit: (data: string) => void,
  ) {}

  push(chunk: Buffer): void {
    if (this.flushed) return;
    this.pending += this.decoder.decode(chunk, { stream: true });
    this.drain(false);
  }

  flush(): void {
    if (this.flushed) return;
    this.flushed = true;
    this.pending += this.decoder.decode();
    this.drain(true);
  }

  private drain(final: boolean): void {
    while (this.pending) {
      const match = earliestSecret(this.pending, this.secrets);
      if (match) {
        this.emitBounded(this.pending.slice(0, match.index));
        this.emitBounded("[redacted]");
        this.pending = this.pending.slice(match.index + match.secret.length);
        continue;
      }
      if (!final) {
        const retained = longestSecretPrefixSuffix(this.pending, this.secrets);
        this.emitBounded(this.pending.slice(0, this.pending.length - retained));
        this.pending = this.pending.slice(this.pending.length - retained);
        return;
      }
      this.emitBounded(this.pending);
      this.pending = "";
    }
  }

  private emitBounded(data: string): void {
    const remaining = this.limit - this.emittedBytes;
    if (!data || remaining <= 0) return;
    const bounded = Buffer.from(data)
      .subarray(0, remaining)
      .toString()
      .replace(/\uFFFD$/u, "");
    this.emittedBytes += Buffer.byteLength(bounded);
    if (bounded) this.emit(bounded);
  }
}

function earliestSecret(
  value: string,
  secrets: readonly string[],
): { index: number; secret: string } | undefined {
  let match: { index: number; secret: string } | undefined;
  for (const secret of secrets) {
    const index = value.indexOf(secret);
    if (index < 0) continue;
    if (
      !match ||
      index < match.index ||
      (index === match.index && secret.length > match.secret.length)
    ) {
      match = { index, secret };
    }
  }
  return match;
}

function longestSecretPrefixSuffix(value: string, secrets: readonly string[]): number {
  let longest = 0;
  for (const secret of secrets) {
    const max = Math.min(value.length, secret.length - 1);
    for (let length = max; length > longest; length -= 1) {
      if (secret.startsWith(value.slice(-length))) {
        longest = length;
        break;
      }
    }
  }
  return longest;
}
