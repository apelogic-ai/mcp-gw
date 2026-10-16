import { createHash } from "node:crypto";

import type { Hop1Identity } from "../../../shared/identity/hop1";
import {
  parseTaskToolAuthorization,
  TASK_TOOL_DENIED_ERROR,
  TASK_TOOL_DENIED_MESSAGE,
} from "../../../packages/wrapper-kit/src/task-tool-authorization";
import type {
  ToolDefinition,
  ToolRegistry,
  ToolResult,
} from "../../../packages/wrapper-kit/src/mcp/registry";
import { SsmRunCommandError, type SsmRunRequest, type SsmRunResult } from "./ssm-run-command";

export const REMOTE_SHELL_TOOL_NAME = "remote_shell_run" as const;
const REMOTE_SHELL_GRANT = {
  provider: "remote-shell",
  resource: REMOTE_SHELL_TOOL_NAME,
  action: "write",
} as const;
const ROLE_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const MAX_COMMAND_BYTES = 16 * 1024;
const MIN_TIMEOUT_SECONDS = 10;
const TASK_AUTHORITY_CLAIM = ["ste", "ward"].join("");

export interface RemoteShellBinding {
  issuer: string;
  subject: string;
  targets: Record<string, string>;
}

export interface RemoteShellAuditEvent extends Record<
  string,
  string | number | boolean | undefined
> {
  category: "remote_shell_command";
  ts: string;
  status: "allow" | "deny" | "error";
  principal: string;
}

export interface RemoteShellAuditSink {
  emit(event: RemoteShellAuditEvent): Promise<void>;
}

export interface CreateRemoteShellRegistryOptions {
  identity: Hop1Identity;
  bindings: readonly RemoteShellBinding[];
  maxTimeoutSeconds: number;
  execute(request: SsmRunRequest): Promise<SsmRunResult>;
  audit?: RemoteShellAuditSink;
}

export function createRemoteShellRegistry(options: CreateRemoteShellRegistryOptions): ToolRegistry {
  const authorization = parseTaskToolAuthorization(options.identity.claims);
  const runtimeUid = taskRuntimeUid(options.identity.claims);
  const binding = options.bindings.find(
    (candidate) =>
      candidate.issuer === options.identity.issuer &&
      candidate.subject === options.identity.subject,
  );
  const permitted =
    authorization.restricted &&
    runtimeUid !== undefined &&
    authorization.allows(REMOTE_SHELL_GRANT) &&
    binding !== undefined;

  return {
    listTools: () => (permitted ? [toolDefinition(options.maxTimeoutSeconds)] : []),
    supportsTool: (name) => name === REMOTE_SHELL_TOOL_NAME,
    callTool: async (_name, args) => {
      if (
        !authorization.restricted ||
        !authorization.allows(REMOTE_SHELL_GRANT) ||
        !binding ||
        !runtimeUid
      ) {
        await emit(
          options.audit,
          refusalEvent(options.identity, runtimeUid, "task_tool_not_approved"),
        );
        return errorResult(TASK_TOOL_DENIED_ERROR, TASK_TOOL_DENIED_MESSAGE);
      }

      const parsed = parseToolArgs(args, options.maxTimeoutSeconds);
      if (!parsed.ok) {
        await emit(
          options.audit,
          refusalEvent(options.identity, runtimeUid, parsed.error, parsed.target, parsed.command),
        );
        return errorResult("remote_shell_invalid_arguments", parsed.error);
      }
      const instanceId = binding.targets[parsed.target];
      if (!instanceId) {
        await emit(
          options.audit,
          refusalEvent(
            options.identity,
            runtimeUid,
            "target_not_bound",
            parsed.target,
            parsed.command,
          ),
        );
        return errorResult("remote_shell_target_not_bound", "Target role is not bound");
      }

      try {
        const result = await options.execute({
          instanceId,
          runtimeUid,
          command: parsed.command,
          timeoutSeconds: parsed.timeoutSeconds,
        });
        await emit(options.audit, {
          category: "remote_shell_command",
          ts: new Date().toISOString(),
          status: "allow",
          principal: principal(options.identity),
          runtime_uid: runtimeUid,
          target_role: parsed.target,
          command_digest: commandDigest(parsed.command),
          exit_code: result.exit_code,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: { ...result },
        };
      } catch (error) {
        if (error instanceof SsmRunCommandError && error.code === "target_not_run_bound") {
          const code = "remote_shell_target_not_run_bound";
          await emit(
            options.audit,
            refusalEvent(options.identity, runtimeUid, code, parsed.target, parsed.command),
          );
          return errorResult(code, "Target is not bound to this run");
        }
        await emit(options.audit, {
          category: "remote_shell_command",
          ts: new Date().toISOString(),
          status: "error",
          principal: principal(options.identity),
          runtime_uid: runtimeUid,
          target_role: parsed.target,
          command_digest: commandDigest(parsed.command),
          error: "remote_shell_execution_failed",
        });
        return errorResult("remote_shell_execution_failed", "Remote command execution failed");
      }
    },
  };
}

function toolDefinition(maxTimeoutSeconds: number): ToolDefinition {
  return {
    name: REMOTE_SHELL_TOOL_NAME,
    description: "Run one command on a platform-bound Systems Manager target role.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        target: {
          type: "string",
          pattern: ROLE_PATTERN.source,
          description: "Platform-defined target role; never an address or instance ID.",
        },
        command: { type: "string", minLength: 1, maxLength: MAX_COMMAND_BYTES },
        timeout_seconds: {
          type: "integer",
          minimum: MIN_TIMEOUT_SECONDS,
          maximum: maxTimeoutSeconds,
        },
      },
      required: ["target", "command"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  };
}

type ParsedArgs =
  | { ok: true; target: string; command: string; timeoutSeconds: number }
  | { ok: false; error: string; target?: string; command?: string };

function parseToolArgs(args: Record<string, unknown>, maxTimeoutSeconds: number): ParsedArgs {
  const target = typeof args.target === "string" ? args.target : undefined;
  const command = typeof args.command === "string" ? args.command : undefined;
  if (Object.keys(args).some((key) => !["target", "command", "timeout_seconds"].includes(key))) {
    return { ok: false, error: "Unsupported argument", target, command };
  }
  if (!target || !ROLE_PATTERN.test(target)) {
    return { ok: false, error: "Target must be a platform-defined role", target, command };
  }
  if (!command || Buffer.byteLength(command) > MAX_COMMAND_BYTES) {
    return { ok: false, error: "Command must be non-empty and within the size limit", target };
  }
  const timeout = args.timeout_seconds ?? maxTimeoutSeconds;
  if (
    !Number.isSafeInteger(timeout) ||
    (timeout as number) < MIN_TIMEOUT_SECONDS ||
    (timeout as number) > maxTimeoutSeconds
  ) {
    return { ok: false, error: "Timeout is outside the configured limit", target, command };
  }
  return { ok: true, target, command, timeoutSeconds: timeout as number };
}

function taskRuntimeUid(claims: Readonly<Record<string, unknown>>): string | undefined {
  const authority = claims[TASK_AUTHORITY_CLAIM];
  if (!isRecord(authority) || typeof authority.runtime_uid !== "string") return undefined;
  const value = authority.runtime_uid.trim();
  return value || undefined;
}

function errorResult(code: string, message: string): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { error: code },
  };
}

function refusalEvent(
  identity: Hop1Identity,
  runtimeUid: string | undefined,
  error: string,
  target?: string,
  command?: string,
): RemoteShellAuditEvent {
  return {
    category: "remote_shell_command",
    ts: new Date().toISOString(),
    status: "deny",
    principal: principal(identity),
    ...(runtimeUid ? { runtime_uid: runtimeUid } : {}),
    ...(target ? { target_role: ROLE_PATTERN.test(target) ? target : "invalid" } : {}),
    ...(command ? { command_digest: commandDigest(command) } : {}),
    error,
  };
}

function principal(identity: Hop1Identity): string {
  return `${identity.issuer}#${identity.subject}`;
}

function commandDigest(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}

async function emit(
  sink: RemoteShellAuditSink | undefined,
  event: RemoteShellAuditEvent,
): Promise<void> {
  try {
    await sink?.emit(event);
  } catch {
    // Audit failures must not expose command data or change authorization decisions.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
