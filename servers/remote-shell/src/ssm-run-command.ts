import { executeCli } from "../../governed-cli/src/executor";

export const SSM_DOCUMENT_NAME = "AWS-RunShellScript" as const;

const TERMINAL = new Set(["Success", "Cancelled", "TimedOut", "Failed", "Cancelling"]);
const SENSITIVE_ENV_NAME = /(?:authorization|credential|password|secret|token|access_key)/i;

export interface AwsCliRunner {
  run(args: string[], timeoutMs?: number): Promise<string>;
}

export interface SsmRunRequest {
  instanceId: string;
  runtimeUid: string;
  command: string;
  timeoutSeconds: number;
}

export interface SsmRunResult extends Record<string, unknown> {
  exit_code: number;
  stdout: string;
  stderr: string;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  duration_ms: number;
}

export class SsmRunCommandError extends Error {
  constructor(
    public readonly code:
      | "aws_cli_failed"
      | "invalid_response"
      | "invocation_pending"
      | "target_not_run_bound"
      | "timeout",
  ) {
    super(code);
    this.name = "SsmRunCommandError";
  }
}

export function createAwsCliRunner(
  options: {
    binary?: string;
    env?: Record<string, string | undefined>;
    maxResponseBytes?: number;
  } = {},
): AwsCliRunner {
  const binary = options.binary ?? "aws";
  const env = options.env ?? process.env;
  const redactions = credentialValues(env);
  const maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
  const childEnvironment = Object.fromEntries(
    Object.entries(env).filter(
      ([name, value]) =>
        value !== undefined && (!SENSITIVE_ENV_NAME.test(name) || name.startsWith("AWS_")),
    ),
  ) as Record<string, string>;

  return {
    run: async (args, timeoutMs = 15_000) => {
      const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
      const result = await executeCli(
        {
          binary,
          cwd: process.cwd(),
          env: childEnvironment,
          redactValues: redactions,
          defaultTimeoutSeconds: timeoutSeconds,
          maxTimeoutSeconds: timeoutSeconds,
          maxOutputBytes: maxResponseBytes,
        },
        args,
        "read",
        timeoutSeconds,
      );
      if (result.stdout_truncated || result.stderr_truncated) {
        throw new Error("aws CLI response exceeded the local size limit");
      }
      if (result.exit_code !== 0) {
        throw new Error(`aws CLI exited with code ${String(result.exit_code)}: ${result.stderr}`);
      }
      return result.stdout;
    },
  };
}

export function createSsmRunCommand(options: {
  runner: AwsCliRunner;
  region?: string;
  runTagKey: string;
  outputLimitBytes: number;
  credentialValues?: readonly string[];
  pollIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? Bun.sleep;

  return async (request: SsmRunRequest): Promise<SsmRunResult> => {
    const filters = JSON.stringify([
      { Name: "resource-id", Values: [request.instanceId] },
      { Name: "key", Values: [options.runTagKey] },
    ]);
    let runId: unknown;
    try {
      const response = await runJson(
        options.runner,
        regional(
          ["ec2", "describe-tags", "--filters", filters, "--output", "json", "--no-cli-pager"],
          options.region,
        ),
      );
      runId = record(Array.isArray(response.Tags) ? response.Tags[0] : undefined)?.Value;
    } catch {
      throw new SsmRunCommandError("target_not_run_bound");
    }
    if (runId !== request.runtimeUid) {
      throw new SsmRunCommandError("target_not_run_bound");
    }
    const started = now();
    const parameters = JSON.stringify({
      commands: [request.command],
      executionTimeout: [String(request.timeoutSeconds)],
    });
    const sent = await runJson(
      options.runner,
      regional(
        [
          "ssm",
          "send-command",
          "--instance-ids",
          request.instanceId,
          "--document-name",
          SSM_DOCUMENT_NAME,
          "--parameters",
          parameters,
          "--output",
          "json",
          "--no-cli-pager",
        ],
        options.region,
      ),
    );
    const commandId = string(record(sent.Command)?.CommandId);
    if (!commandId) throw new SsmRunCommandError("invalid_response");

    const deadline = started + request.timeoutSeconds * 1000 + 15_000;
    while (now() <= deadline) {
      let invocation: Record<string, unknown>;
      try {
        invocation = await runJson(
          options.runner,
          regional(
            [
              "ssm",
              "get-command-invocation",
              "--command-id",
              commandId,
              "--instance-id",
              request.instanceId,
              "--output",
              "json",
              "--no-cli-pager",
            ],
            options.region,
          ),
        );
      } catch (error) {
        if (!(error instanceof SsmRunCommandError) || error.code !== "invocation_pending") {
          throw error;
        }
        await sleep(options.pollIntervalMs ?? 250);
        continue;
      }
      const status = string(invocation.Status);
      if (status && TERMINAL.has(status)) {
        const stdout = redact(
          string(invocation.StandardOutputContent) ?? "",
          options.credentialValues ?? [],
        );
        const stderr = redact(
          string(invocation.StandardErrorContent) ?? "",
          options.credentialValues ?? [],
        );
        return {
          exit_code: number(invocation.ResponseCode) ?? (status === "Success" ? 0 : 1),
          ...limitedOutput("stdout", stdout, options.outputLimitBytes),
          ...limitedOutput("stderr", stderr, options.outputLimitBytes),
          duration_ms: Math.max(0, now() - started),
        } as SsmRunResult;
      }
      await sleep(options.pollIntervalMs ?? 250);
    }
    throw new SsmRunCommandError("timeout");
  };
}

export function credentialValues(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(env).flatMap(([name, value]) =>
    SENSITIVE_ENV_NAME.test(name) && value && value.length >= 4 ? [value] : [],
  );
}

async function runJson(runner: AwsCliRunner, args: string[]): Promise<Record<string, unknown>> {
  let output: string;
  try {
    output = await runner.run(args);
  } catch (error) {
    if (error instanceof Error && error.message.includes("InvocationDoesNotExist")) {
      throw new SsmRunCommandError("invocation_pending");
    }
    throw new SsmRunCommandError("aws_cli_failed");
  }
  try {
    const parsed = JSON.parse(output) as unknown;
    const result = record(parsed);
    if (!result) throw new Error("not an object");
    return result;
  } catch {
    throw new SsmRunCommandError("invalid_response");
  }
}

function limitedOutput(name: "stdout" | "stderr", value: string, limit: number) {
  const bytes = Buffer.from(value);
  return {
    [name]: bytes.byteLength > limit ? bytes.subarray(0, limit).toString("utf8") : value,
    [`${name}_bytes`]: bytes.byteLength,
    [`${name}_truncated`]: bytes.byteLength > limit,
  };
}

function regional(args: string[], region: string | undefined): string[] {
  return region ? [...args, "--region", region] : args;
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets.reduce((text, secret) => text.split(secret).join("[redacted]"), value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
