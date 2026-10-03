import { digestArgs, type AuditEvent, type AuditSink } from "../../../shared/audit/audit";
import {
  classifyHop1ValidationFailure,
  normalizedHop1Claims,
  reportHop1AuthenticationFailure,
  type Hop1FailureReporter,
  type Hop1Identity,
} from "../../../shared/identity/hop1";
import { AllowAllPolicy, type ToolPolicy } from "../../../shared/policy/policy";
import type { GenericUpstreamCredential } from "./credentials";
import type {
  GenericCatalogTool,
  GenericToolCatalog,
  GenericWrapperDescriptor,
} from "./descriptor";
import type { GenericUpstreamTransport } from "./transport";

type JsonRpcId = string | number | null;

export interface ResolveGenericCredentialRequest {
  identity: Hop1Identity;
  hop1Token: string;
  scopes: string[];
}

export interface CreateGenericMcpProxyHandlerOptions {
  descriptor: GenericWrapperDescriptor;
  catalog: GenericToolCatalog;
  authenticate(token: string): Promise<Hop1Identity>;
  resolveCredential(
    request: ResolveGenericCredentialRequest,
  ): Promise<GenericUpstreamCredential | null>;
  transport: GenericUpstreamTransport;
  policy?: ToolPolicy;
  audit?: AuditSink;
  oauth?: {
    providerId: string;
    status(identity: Hop1Identity): Promise<Record<string, unknown>>;
    start(identity: Hop1Identity, redirectAfter?: string): Promise<{ authorizationUrl: string }>;
  };
  requireCredential?: boolean;
  onAuthenticationFailure?: Hop1FailureReporter;
}

const JSON_HEADERS = { "content-type": "application/json" };

export function createGenericMcpProxyHandler(
  options: CreateGenericMcpProxyHandlerOptions,
): (request: Request) => Promise<Response> {
  const policy = options.policy ?? new AllowAllPolicy();
  const toolsByName = new Map(options.catalog.tools.map((tool) => [tool.exposedName, tool]));

  return async (request) => {
    if (new URL(request.url).pathname !== "/mcp") return mcpError(null, -32601, "Not found", 404);
    const hop1Token = bearerToken(request);
    const reportFailure = options.onAuthenticationFailure ?? reportHop1AuthenticationFailure;
    if (!hop1Token) {
      reportFailure("missing_bearer");
      return unauthorized("bearer token is required");
    }
    let identity: Hop1Identity;
    try {
      identity = await options.authenticate(hop1Token);
    } catch (error) {
      reportFailure(classifyHop1ValidationFailure(error));
      return unauthorized("invalid bearer token");
    }

    if (request.method === "DELETE") {
      await options.transport.close?.(
        request.headers.get("mcp-session-id") ?? undefined,
        principalKey(identity),
      );
      return new Response(null, { status: 204 });
    }
    if (request.method !== "POST") return mcpError(null, -32600, "Invalid request", 405);

    const body = await request.text();
    const message = parseJsonRpcMessage(body);
    if (!message) return mcpError(null, -32700, "Parse error");
    if (message.method === "tools/list") {
      return mcpResult(message.id, {
        tools: [
          ...oauthToolDefinitions(options),
          ...options.catalog.tools.map(publicToolDefinition),
        ],
      });
    }

    const started = Date.now();
    const oauthTool =
      message.method === "tools/call" ? oauthToolKind(options, message.toolName) : undefined;
    const tool =
      message.method === "tools/call" && !oauthTool
        ? toolsByName.get(message.toolName ?? "")
        : undefined;
    if (message.method === "tools/call" && !tool && !oauthTool) {
      return mcpError(
        message.id,
        -32601,
        `Unsupported MCP tool: ${message.toolName ?? "<missing>"}`,
      );
    }
    if (oauthTool && options.oauth) {
      const decision = await policy.decide({
        principal: identity.email,
        tokenClaims: normalizedHop1Claims(identity),
        tool: message.toolName ?? "",
        operation: `${options.descriptor.name}.oauth.${oauthTool}`,
        service: options.descriptor.name,
        actionClass: oauthTool === "status" ? "read" : "write",
        scopes: [],
        args: message.arguments,
      });
      if (decision.kind !== "allow") {
        return mcpResult(message.id, {
          isError: true,
          content: [{ type: "text", text: "Tool call denied by policy" }],
          structuredContent: {
            error: "policy_denied",
            ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
          },
        });
      }
      try {
        const value =
          oauthTool === "status"
            ? await options.oauth.status(identity)
            : await options.oauth.start(
                identity,
                typeof message.arguments.redirectAfter === "string"
                  ? message.arguments.redirectAfter
                  : undefined,
              );
        await emitSafely(options.audit, {
          ts: new Date().toISOString(),
          category: "tool_call",
          principal: identity.email,
          status: "allow",
          tool: message.toolName,
          argDigest: digestArgs(message.arguments),
          latencyMs: Date.now() - started,
        });
        return mcpResult(message.id, {
          content: [{ type: "text", text: JSON.stringify(value) }],
          structuredContent: value,
        });
      } catch {
        await emitSafely(options.audit, {
          ts: new Date().toISOString(),
          category: "tool_call",
          principal: identity.email,
          status: "error",
          tool: message.toolName,
          argDigest: digestArgs(message.arguments),
          latencyMs: Date.now() - started,
          error: "oauth_operation_failed",
        });
        return mcpResult(message.id, {
          isError: true,
          content: [{ type: "text", text: "Provider authorization operation failed" }],
          structuredContent: { error: "provider_oauth_failure" },
        });
      }
    }
    if (tool) {
      const decision = await policy.decide({
        principal: identity.email,
        tokenClaims: normalizedHop1Claims(identity),
        tool: tool.exposedName,
        operation: tool.grants.operation,
        service: options.descriptor.name,
        actionClass: tool.grants.actionClass,
        scopes: tool.grants.scopes,
        args: message.arguments,
      });
      if (decision.kind !== "allow") {
        await emitSafely(options.audit, {
          ts: new Date().toISOString(),
          category: "tool_call",
          principal: identity.email,
          status: "deny",
          event: "policy_denied",
          tool: tool.exposedName,
          argDigest: digestArgs(message.arguments),
          latencyMs: Date.now() - started,
          error: decision.kind,
        });
        return mcpResult(message.id, {
          isError: true,
          content: [{ type: "text", text: "Tool call denied by policy" }],
          structuredContent: {
            error: "policy_denied",
            ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
          },
        });
      }
    }

    try {
      const scopes = tool?.grants.scopes ?? [];
      const credential = await options.resolveCredential({ identity, hop1Token, scopes });
      if (!credential && options.requireCredential) {
        return mcpResult(message.id, {
          isError: true,
          content: [
            {
              type: "text",
              text: `Provider authorization is required. Call ${options.descriptor.toolPrefix}_oauth_start.`,
            },
          ],
          structuredContent: {
            error: "provider_oauth_required",
            provider: options.oauth?.providerId,
            connectionHelper: `${options.descriptor.toolPrefix}_oauth_start`,
          },
        });
      }
      const upstreamBody = tool ? rewriteToolName(body, tool.upstreamName) : body;
      const upstream = await options.transport.send({
        incomingRequest: request,
        body: upstreamBody,
        credential,
        principalKey: principalKey(identity),
      });
      const responseBody = await upstream.text();
      if (tool) {
        await emitSafely(options.audit, {
          ts: new Date().toISOString(),
          category: "tool_call",
          principal: identity.email,
          status: upstream.ok ? "allow" : "error",
          tool: tool.exposedName,
          argDigest: digestArgs(message.arguments),
          latencyMs: Date.now() - started,
          resultSize: responseBody.length,
          ...(upstream.ok ? {} : { error: `upstream_${String(upstream.status)}` }),
        });
      }
      return new Response(responseBody, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: forwardedResponseHeaders(upstream),
      });
    } catch {
      if (tool) {
        await emitSafely(options.audit, {
          ts: new Date().toISOString(),
          category: "tool_call",
          principal: identity.email,
          status: "error",
          tool: tool.exposedName,
          argDigest: digestArgs(message.arguments),
          latencyMs: Date.now() - started,
          error: "upstream_failure",
        });
      }
      return mcpError(message.id, -32000, "MCP upstream request failed");
    }
  };
}

function oauthToolDefinitions(
  options: CreateGenericMcpProxyHandlerOptions,
): Record<string, unknown>[] {
  if (!options.oauth || !options.descriptor.lifecycleRoutes) return [];
  const prefix = options.descriptor.toolPrefix;
  return [
    {
      name: `${prefix}_oauth_status`,
      description: `Check the ${options.oauth.providerId} connection for the current user.`,
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      annotations: { readOnlyHint: true },
    },
    {
      name: `${prefix}_oauth_start`,
      description: `Start ${options.oauth.providerId} authorization for the current user.`,
      inputSchema: {
        type: "object",
        properties: { redirectAfter: { type: "string" } },
        required: [],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
    },
  ];
}

function oauthToolKind(
  options: CreateGenericMcpProxyHandlerOptions,
  name: string | undefined,
): "status" | "start" | undefined {
  if (!options.oauth || !options.descriptor.lifecycleRoutes) return undefined;
  if (name === `${options.descriptor.toolPrefix}_oauth_status`) return "status";
  if (name === `${options.descriptor.toolPrefix}_oauth_start`) return "start";
  return undefined;
}

interface ParsedMessage {
  id: JsonRpcId;
  method: string;
  toolName?: string;
  arguments: Record<string, unknown>;
}

function parseJsonRpcMessage(body: string): ParsedMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") {
    return undefined;
  }
  const params = isRecord(value.params) ? value.params : {};
  return {
    id: jsonRpcId(value.id),
    method: value.method,
    ...(typeof params.name === "string" ? { toolName: params.name } : {}),
    arguments: isRecord(params.arguments) ? params.arguments : {},
  };
}

function publicToolDefinition(tool: GenericCatalogTool): Record<string, unknown> {
  return {
    name: tool.exposedName,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  };
}

function rewriteToolName(body: string, upstreamName: string): string {
  const value = JSON.parse(body) as Record<string, unknown>;
  const params = isRecord(value.params) ? value.params : {};
  return JSON.stringify({ ...value, params: { ...params, name: upstreamName } });
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (!header) return undefined;
  const [scheme, token, extra] = header.split(" ");
  return scheme === "Bearer" && token && !extra ? token : undefined;
}

function forwardedResponseHeaders(response: Response): Headers {
  const headers = new Headers();
  for (const name of ["content-type", "mcp-session-id"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function principalKey(identity: Hop1Identity): string {
  return `${identity.issuer}\n${identity.subject}`;
}

async function emitSafely(sink: AuditSink | undefined, event: AuditEvent): Promise<void> {
  try {
    await sink?.emit(event);
  } catch {
    // Audit availability must not change an already decided tool call.
  }
}

function unauthorized(message: string): Response {
  return mcpError(null, -32001, `Unauthorized: ${message}`, 401);
}

function mcpResult(id: JsonRpcId, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: JSON_HEADERS,
  });
}

function mcpError(id: JsonRpcId, code: number, message: string, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status,
    headers: JSON_HEADERS,
  });
}

function jsonRpcId(value: unknown): JsonRpcId {
  if (value === null || typeof value === "string") return value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
