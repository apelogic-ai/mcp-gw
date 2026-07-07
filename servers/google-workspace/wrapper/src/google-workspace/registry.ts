import type { Hop1Identity } from "../../../../../shared/identity/hop1";
import { digestArgs, type AuditSink } from "../../../../../shared/audit/audit";
import {
  AllowAllPolicy,
  type PolicyDecision,
  type ToolPolicy,
} from "../../../../../shared/policy/policy";
import {
  getGoogleWorkspaceTool,
  isExcludedGoogleWorkspaceScope,
  listGoogleWorkspaceTools,
} from "../catalog/google-workspace";
import type { WorkspaceToolDefinition } from "../catalog/types";
import type { ToolRegistry, ToolResult } from "../mcp/registry";

export interface AccessTokenBroker {
  getAccessToken(identity: Hop1Identity, requiredScopes: string[]): Promise<string>;
}

export interface ExecuteWorkspaceToolRequest {
  tool: WorkspaceToolDefinition;
  args: Record<string, unknown>;
  accessToken: string;
}

export type WorkspaceToolExecutor = (request: ExecuteWorkspaceToolRequest) => Promise<unknown>;

export interface CreateGoogleWorkspaceRegistryOptions {
  identity: Hop1Identity;
  audit?: AuditSink;
  policy?: ToolPolicy;
  tokenBroker: AccessTokenBroker;
  executor: WorkspaceToolExecutor;
}

export function createGoogleWorkspaceRegistry(
  options: CreateGoogleWorkspaceRegistryOptions,
): ToolRegistry {
  const policy = options.policy ?? new AllowAllPolicy();

  return {
    listTools: () => listGoogleWorkspaceTools(),
    callTool: async (name, args) => {
      const started = Date.now();
      const tool = getGoogleWorkspaceTool(name);
      validateRequiredArgs(tool, args);

      const decision = await policy.decide({
        principal: options.identity.email,
        tool: tool.name,
        service: tool.service,
        actionClass: tool.actionClass,
        scopes: requiredScopes(tool, args),
        args,
      });
      await enforcePolicyDecision(decision, tool, args, started, options);

      try {
        const accessToken = await options.tokenBroker.getAccessToken(
          options.identity,
          requiredScopes(tool, args),
        );
        const result = await options.executor({
          tool,
          args,
          accessToken,
        });

        await options.audit?.emit({
          ts: new Date().toISOString(),
          category: "tool_call",
          principal: options.identity.email,
          status: "allow",
          tool: tool.name,
          argDigest: digestArgs(args),
          latencyMs: Date.now() - started,
          resultSize: resultSize(result),
        });

        return formatToolResult(result);
      } catch (error) {
        await options.audit?.emit({
          ts: new Date().toISOString(),
          category: "tool_call",
          principal: options.identity.email,
          status: "error",
          tool: tool.name,
          argDigest: digestArgs(args),
          latencyMs: Date.now() - started,
          error: error instanceof Error ? error.message : "Unknown tool error",
        });
        return formatToolError(error);
      }
    },
  };
}

async function enforcePolicyDecision(
  decision: PolicyDecision,
  tool: WorkspaceToolDefinition,
  args: Record<string, unknown>,
  started: number,
  options: CreateGoogleWorkspaceRegistryOptions,
): Promise<void> {
  if (decision.kind === "allow") {
    return;
  }

  const event = decision.kind === "approval_required" ? "approval_required" : "deny";
  await options.audit?.emit({
    ts: new Date().toISOString(),
    category: "tool_call",
    principal: options.identity.email,
    status: "deny",
    event,
    tool: tool.name,
    argDigest: digestArgs(args),
    latencyMs: Date.now() - started,
    error: decision.reason,
  });

  if (decision.kind === "approval_required") {
    throw new Error(`Policy requires approval for ${tool.name}: ${decision.reason}`);
  }

  throw new Error(`Policy denied ${tool.name}: ${decision.reason}`);
}

function validateRequiredArgs(tool: WorkspaceToolDefinition, args: Record<string, unknown>): void {
  const missing = [...tool.params, ...(tool.bodyParams ?? [])]
    .filter((param) => param.required && args[param.name] === undefined)
    .map((param) => param.name);

  if (missing.length > 0) {
    throw new Error(`Missing required arguments for ${tool.name}: ${missing.join(", ")}`);
  }
}

function requiredScopes(tool: WorkspaceToolDefinition, args: Record<string, unknown>): string[] {
  if (!tool.dynamicScopesParam) {
    return tool.scopes;
  }

  const value = args[tool.dynamicScopesParam];
  if (!isStringArray(value)) {
    throw new Error(`${tool.dynamicScopesParam} must be an array of strings`);
  }

  const excludedScopes = value.filter(isExcludedGoogleWorkspaceScope);
  if (excludedScopes.length > 0) {
    throw new Error(
      `${tool.dynamicScopesParam} contains unsupported Google Workspace scopes: ${excludedScopes.join(", ")}`,
    );
  }

  return value;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function formatToolResult(result: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
      },
    ],
  };
}

function formatToolError(error: unknown): ToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(serializableError(error), null, 2),
      },
    ],
  };
}

function serializableError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return {
      error: "Tool execution failed",
      detail: String(error),
    };
  }

  const record: Record<string, unknown> = {
    error: error.message,
    name: error.name,
  };
  addStringProperty(record, "code", error);
  addStringProperty(record, "stderr", error);
  addStringProperty(record, "stdout", error);
  return record;
}

function addStringProperty(
  record: Record<string, unknown>,
  property: string,
  source: object,
): void {
  if (!(property in source)) {
    return;
  }

  const value = (source as Record<string, unknown>)[property];
  if (typeof value === "string" && value.length > 0) {
    record[property] = value;
  }
}

function resultSize(result: unknown): number {
  return typeof result === "string" ? result.length : JSON.stringify(result).length;
}
