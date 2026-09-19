import { randomUUID } from "node:crypto";

import { normalizedHop1Claims, type Hop1Identity } from "../../../../../shared/identity/hop1";
import { digestArgs, type AuditSink } from "../../../../../shared/audit/audit";
import type { ConnectionLifecycleMetricSink } from "../../../../../shared/oauth/connection-metrics";
import {
  ProviderLifecycleError,
  ProviderToolScopeError,
} from "../../../../../shared/oauth/connection-types";
import { GoogleOAuthError } from "../../../../../shared/oauth/google";
import type {
  ConnectionPhase,
  LifecycleErrorCategory,
  ScopeRequirementInput,
} from "../../../../../shared/oauth/connection-types";
import {
  AllowAllPolicy,
  type PolicyDecision,
  type ToolPolicy,
} from "../../../../../shared/policy/policy";
import {
  getGoogleWorkspaceTool,
  listGoogleWorkspaceTools,
  type GoogleWorkspaceCatalogId,
} from "../catalog/google-workspace";
import type { WorkspaceToolDefinition } from "../catalog/types";
import type { ToolRegistry, ToolResult } from "../mcp/registry";
import { resolveWorkspaceOperation } from "./operation-resolver";

export interface GoogleOAuthStatus {
  connected: boolean;
  email?: string;
  scopesRequired: string[];
  scopesGranted: string[];
  missingScopes: string[];
  phase?: ConnectionPhase;
  errorCategory?: LifecycleErrorCategory;
}

export interface GoogleOAuthTools {
  status: GoogleOAuthStatus;
  startOAuth(redirectAfter?: string): Promise<{ authorizationUrl: string }>;
}

export interface AccessTokenBroker {
  getAccessToken(
    identity: Hop1Identity,
    requiredScopes: ScopeRequirementInput,
    diagnosticId?: string,
  ): Promise<string>;
}

export interface ExecuteWorkspaceToolRequest {
  tool: WorkspaceToolDefinition;
  args: Record<string, unknown>;
  accessToken: string;
}

export type WorkspaceToolExecutor = (request: ExecuteWorkspaceToolRequest) => Promise<unknown>;

export interface CreateGoogleWorkspaceRegistryOptions {
  identity: Hop1Identity;
  governanceCatalogId?: GoogleWorkspaceCatalogId;
  audit?: AuditSink;
  metrics?: ConnectionLifecycleMetricSink;
  policy?: ToolPolicy;
  oauth?: GoogleOAuthTools;
  tokenBroker: AccessTokenBroker;
  executor: WorkspaceToolExecutor;
}

export function createGoogleWorkspaceRegistry(
  options: CreateGoogleWorkspaceRegistryOptions,
): ToolRegistry {
  const policy: ToolPolicy = options.policy ?? new AllowAllPolicy();

  return {
    listTools: () => {
      if (!options.oauth) {
        return listGoogleWorkspaceTools(options.governanceCatalogId);
      }

      return [
        ...GOOGLE_OAUTH_TOOL_DEFINITIONS,
        ...listGoogleWorkspaceTools(options.governanceCatalogId),
      ];
    },
    callTool: async (name, args) => {
      const diagnosticId = randomUUID();
      if (name === "google_oauth_start" && options.oauth) {
        const started = Date.now();
        const decision = await policy.decide({
          principal: options.identity.email,
          tokenClaims: normalizedHop1Claims(options.identity),
          tool: name,
          operation: "google.oauth.start",
          service: "google",
          actionClass: "write",
          scopes: options.oauth.status.scopesRequired,
          args,
        });
        await enforcePolicyDecision(decision, { name }, args, started, options, diagnosticId);
      }

      const oauthResult = await callGoogleOAuthTool(name, args, options.oauth);
      if (oauthResult) {
        return oauthResult;
      }

      const started = Date.now();
      const tool = getGoogleWorkspaceTool(name, options.governanceCatalogId);
      if (
        options.oauth &&
        !options.oauth.status.connected &&
        !(
          options.oauth.status.phase === "reauthorization_required" &&
          options.oauth.status.errorCategory === "insufficient_scope" &&
          options.oauth.status.missingScopes.length === 0
        )
      ) {
        return providerOAuthRequiredResult();
      }
      validateRequiredArgs(tool, args);
      const resolved = resolveWorkspaceOperation(tool, args, policy.hardGuardrails === true);
      const scopeRequirement = resolved.scopeRequirement;

      const decision = await policy.decide({
        principal: options.identity.email,
        tokenClaims: normalizedHop1Claims(options.identity),
        tool: tool.name,
        operation: resolved.operation,
        service: resolved.service,
        actionClass: resolved.actionClass,
        scopes: flattenedScopes(scopeRequirement),
        scopeRequirement,
        args: resolved.args,
      });
      await enforcePolicyDecision(decision, tool, resolved.args, started, options, diagnosticId);

      try {
        const accessToken = await options.tokenBroker.getAccessToken(
          options.identity,
          scopeRequirement,
          diagnosticId,
        );
        const result = await options.executor({
          tool,
          args: resolved.args,
          accessToken,
        });

        await options.audit?.emit({
          ts: new Date().toISOString(),
          category: "tool_call",
          principal: options.identity.email,
          status: "allow",
          tool: tool.name,
          argDigest: digestArgs(resolved.args),
          latencyMs: Date.now() - started,
          resultSize: resultSize(result),
        });

        return formatToolResult(result);
      } catch (error) {
        if (error instanceof ProviderToolScopeError) {
          recordMetricSafely(options.metrics, {
            name: "tool_scope_denied",
            provider: "google",
            operation: tool.name,
            diagnosticId,
            value: 1,
          });
        }
        await options.audit?.emit({
          ts: new Date().toISOString(),
          category: "tool_call",
          principal: options.identity.email,
          status: "error",
          tool: tool.name,
          argDigest: digestArgs(resolved.args),
          latencyMs: Date.now() - started,
          error: error instanceof Error ? error.message : "Unknown tool error",
        });
        return formatToolError(error, diagnosticId);
      }
    },
  };
}

function providerOAuthRequiredResult(): ToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: "Google Workspace authorization is required. Call google_oauth_start to connect the provider.",
      },
    ],
    structuredContent: {
      error: "provider_oauth_required",
      provider: "google_workspace",
      connectionHelper: "google_oauth_start",
    },
  };
}

const GOOGLE_OAUTH_TOOL_DEFINITIONS = [
  {
    name: "google_oauth_status",
    description:
      "Check whether the current MCP-GW user has connected Google Workspace for Google tools.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "google_oauth_start",
    description:
      "Start Google Workspace OAuth for the current MCP-GW user and return a browser authorization URL.",
    inputSchema: {
      type: "object" as const,
      properties: {
        redirectAfter: {
          type: "string",
          description: "Optional URL to return to after Google Workspace OAuth completes.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
];

async function callGoogleOAuthTool(
  name: string,
  args: Record<string, unknown>,
  oauth: GoogleOAuthTools | undefined,
): Promise<ToolResult | undefined> {
  if (!oauth) {
    return undefined;
  }

  if (name === "google_oauth_status") {
    return formatCompactToolResult(oauth.status);
  }

  if (name === "google_oauth_start") {
    const redirectAfter =
      typeof args.redirectAfter === "string" && args.redirectAfter.length > 0
        ? args.redirectAfter
        : undefined;
    return formatCompactToolResult(await oauth.startOAuth(redirectAfter));
  }

  return undefined;
}

function formatCompactToolResult(result: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result),
      },
    ],
  };
}

async function enforcePolicyDecision(
  decision: PolicyDecision,
  tool: Pick<WorkspaceToolDefinition, "name">,
  args: Record<string, unknown>,
  started: number,
  options: CreateGoogleWorkspaceRegistryOptions,
  diagnosticId: string,
): Promise<void> {
  if (decision.kind === "allow") {
    return;
  }

  const event = decision.kind === "approval_required" ? "approval_required" : "deny";
  recordMetricSafely(options.metrics, {
    name: "policy_denied",
    provider: "google",
    operation: tool.name,
    ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
    diagnosticId,
    value: 1,
  });
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

function flattenedScopes(required: ScopeRequirementInput): string[] {
  return Array.isArray(required)
    ? required
    : [...new Set(required.allOf.flatMap((group) => group.anyOf))];
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

function formatToolError(error: unknown, diagnosticId: string): ToolResult {
  const code =
    error instanceof ProviderToolScopeError
      ? "insufficient_scope"
      : error instanceof ProviderLifecycleError
        ? error.category
        : error instanceof GoogleOAuthError
          ? error.code
          : undefined;
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          code
            ? { error: safeBrokerageMessage(code), code, diagnosticId }
            : serializableError(error),
          null,
          2,
        ),
      },
    ],
    ...(code ? { structuredContent: { error: code, diagnosticId } } : {}),
  };
}

function safeBrokerageMessage(code: string): string {
  switch (code) {
    case "insufficient_scope":
      return "This tool needs an additional Google Workspace scope";
    case "reauth_required":
    case "invalid_active_credential":
    case "invalid_renewal_credential":
    case "renewal_expired":
      return "Google Workspace must be reconnected";
    case "transient_provider_failure":
      return "Google Workspace is temporarily unavailable";
    case "persistence_failure":
      return "Credential storage is temporarily unavailable";
    default:
      return "Google Workspace tool execution failed";
  }
}

function recordMetricSafely(
  sink: ConnectionLifecycleMetricSink | undefined,
  metric: Parameters<ConnectionLifecycleMetricSink["record"]>[0],
): void {
  try {
    sink?.record(metric);
  } catch {
    // Diagnostics cannot affect policy or credential behavior.
  }
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
