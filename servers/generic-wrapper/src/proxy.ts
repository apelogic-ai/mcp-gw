import { randomUUID } from "node:crypto";

import { digestArgs, type AuditEvent, type AuditSink } from "../../../shared/audit/audit";
import {
  classifyHop1ValidationFailure,
  normalizedHop1Claims,
  reportHop1AuthenticationFailure,
  type Hop1FailureReporter,
  type Hop1Identity,
} from "../../../shared/identity/hop1";
import { AllowAllPolicy, type ToolPolicy } from "../../../shared/policy/policy";
import {
  parseTaskToolAuthorization,
  TASK_TOOL_DENIED_ERROR,
  TASK_TOOL_DENIED_MESSAGE,
  type TaskToolAuthorization,
  type TaskToolAuthorizationOptions,
} from "../../../packages/wrapper-kit/src/task-tool-authorization";
import { listUpstreamCatalog, type CapturedUpstreamTool } from "./catalog-capture";
import type { GenericUpstreamCredential } from "./credentials";
import {
  isLiveToolCatalog,
  type GenericCatalogTool,
  type GenericGovernedTool,
  type GenericIncludedToolDecision,
  type GenericToolSource,
  type GenericWrapperDescriptor,
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
  catalog: GenericToolSource;
  authenticate(token: string): Promise<Hop1Identity>;
  resolveCredential(
    request: ResolveGenericCredentialRequest,
  ): Promise<GenericUpstreamCredential | null>;
  recoverCredential?(
    request: ResolveGenericCredentialRequest,
    rejectedCredential: string,
  ): Promise<GenericUpstreamCredential | null>;
  validateCredential?(
    request: ResolveGenericCredentialRequest,
    credential: string,
  ): Promise<"valid" | "invalid" | "unavailable">;
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
  taskToolAuthorization?: TaskToolAuthorizationOptions;
}

const JSON_HEADERS = { "content-type": "application/json" };
const MAX_UPSTREAM_RESPONSE_BYTES = 4 * 1024 * 1024;

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
      return unauthorized("bearer token is required", "Bearer");
    }
    let identity: Hop1Identity;
    try {
      identity = await options.authenticate(hop1Token);
    } catch (error) {
      reportFailure(classifyHop1ValidationFailure(error));
      return unauthorized("invalid bearer token", 'Bearer error="invalid_token"');
    }
    const taskAuthorization = parseTaskToolAuthorization(
      identity.claims,
      options.taskToolAuthorization,
    );

    if (request.method === "DELETE") {
      const invalidSession = validateRequestSession(options.transport, request, identity);
      if (invalidSession) return invalidSession;
      let credential: GenericUpstreamCredential | null = null;
      try {
        credential = await options.resolveCredential({ identity, hop1Token, scopes: [] });
      } catch {
        // Session cleanup is best-effort and may use the transport's last credential.
      }
      try {
        const closed = await options.transport.close?.({
          incomingRequest: request,
          body: "",
          credential,
          principalKey: principalKey(identity),
        });
        return closed ? safeStreamingResponse(closed) : new Response(null, { status: 204 });
      } catch {
        return mcpError(null, -32000, "MCP upstream session cleanup failed");
      }
    }
    if (request.method === "GET") {
      if (options.descriptor.upstream.transport !== "http") {
        return mcpError(null, -32600, "Streaming GET is unavailable for a stdio upstream", 405);
      }
      const invalidSession = validateRequestSession(options.transport, request, identity);
      if (invalidSession) return invalidSession;
      try {
        const credential = await options.resolveCredential({ identity, hop1Token, scopes: [] });
        if (!credential && options.requireCredential) {
          return unauthorized("provider authorization is required");
        }
        return safeStreamingResponse(
          await options.transport.send({
            incomingRequest: request,
            body: "",
            credential,
            principalKey: principalKey(identity),
          }),
        );
      } catch {
        return mcpError(null, -32000, "MCP upstream request failed");
      }
    }
    if (request.method !== "POST") return mcpError(null, -32600, "Invalid request", 405);

    const body = await request.text();
    const message = parseJsonRpcMessage(body);
    if (!message) return mcpError(null, -32700, "Parse error");
    if (message.method === "initialize") {
      const sessionId = randomUUID();
      try {
        options.transport.issueSession({ id: sessionId, principalKey: principalKey(identity) });
      } catch {
        return mcpError(message.id, -32000, "MCP session capacity is unavailable");
      }
      const headers = new Headers(JSON_HEADERS);
      headers.set("mcp-session-id", sessionId);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: message.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: options.descriptor.serverInfo,
          },
        }),
        { status: 200, headers },
      );
    }
    if (message.method === "notifications/initialized") {
      const invalidSession = validateRequestSession(options.transport, request, identity);
      if (invalidSession) return invalidSession;
      return new Response(null, { status: 202 });
    }
    if (message.method === "tools/list") {
      if (isLiveToolCatalog(options.catalog)) {
        const invalidSession = validateRequestSession(options.transport, request, identity);
        if (invalidSession) return invalidSession;
        return liveToolsList(options, request, message.id, identity, hop1Token, taskAuthorization);
      }
      return mcpResult(message.id, {
        tools: [
          ...(taskAuthorization.allowsConnectionHelpers ? oauthToolDefinitions(options) : []),
          ...options.catalog.tools
            .filter((tool) => taskAuthorization.allows(genericTaskToolGrant(options, tool)))
            .map(publicToolDefinition),
        ],
      });
    }
    if (message.method !== "tools/call") {
      return mcpError(message.id, -32601, `Unsupported MCP method: ${message.method}`);
    }
    const invalidSession = validateRequestSession(options.transport, request, identity);
    if (invalidSession) return invalidSession;

    const started = Date.now();
    const oauthTool = oauthToolKind(options, message.toolName);
    const tool = !oauthTool ? toolsByName.get(message.toolName ?? "") : undefined;
    if (!tool && !oauthTool) {
      await emitSafely(options.audit, {
        ts: new Date().toISOString(),
        category: "tool_call",
        principal: identity.email,
        status: "deny",
        event: "unsupported_tool",
        tool: message.toolName,
        argDigest: digestArgs(message.arguments),
        latencyMs: Date.now() - started,
        error: "unsupported_tool",
      });
      return mcpError(
        message.id,
        -32601,
        `Unsupported MCP tool: ${message.toolName ?? "<missing>"}`,
      );
    }
    if (oauthTool && !taskAuthorization.allowsConnectionHelpers) {
      return taskToolDenied(message.id);
    }
    if (tool && !taskAuthorization.allows(genericTaskToolGrant(options, tool))) {
      await emitSafely(options.audit, {
        ts: new Date().toISOString(),
        category: "tool_call",
        principal: identity.email,
        status: "deny",
        event: "task_tool_not_approved",
        tool: tool.exposedName,
        argDigest: digestArgs(message.arguments),
        latencyMs: Date.now() - started,
        error: TASK_TOOL_DENIED_ERROR,
      });
      return taskToolDenied(message.id);
    }
    if (tool) {
      message.arguments = effectiveToolArguments(options.descriptor, message.arguments);
    }
    if (oauthTool && options.oauth) {
      const decision = await policy.decide({
        principal: identity.email,
        tokenClaims: normalizedHop1Claims(identity),
        tool: message.toolName ?? "",
        operation: `${options.descriptor.name}.oauth.${oauthTool}`,
        service: options.descriptor.name,
        actionClass: "read",
        scopes: [],
        args: message.arguments,
      });
      if (decision.kind !== "allow") {
        await emitSafely(options.audit, {
          ts: new Date().toISOString(),
          category: "tool_call",
          principal: identity.email,
          status: "deny",
          event: "policy_denied",
          tool: message.toolName,
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
      const credentialRequest = { identity, hop1Token, scopes };
      const canAutomaticallyReplay = tool?.grants.actionClass === "read";
      let credential = await options.resolveCredential(credentialRequest);
      if (!credential && options.requireCredential) {
        await emitSafely(options.audit, {
          ts: new Date().toISOString(),
          category: "tool_call",
          principal: identity.email,
          status: "deny",
          event: "provider_authorization_required",
          tool: tool?.exposedName,
          argDigest: digestArgs(message.arguments),
          latencyMs: Date.now() - started,
          error: "provider_oauth_required",
        });
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
      const upstreamBody = tool
        ? rewriteToolCall(body, tool.upstreamName, message.arguments)
        : body;
      let upstream = await options.transport.send({
        incomingRequest: request,
        body: upstreamBody,
        credential,
        principalKey: principalKey(identity),
      });
      let responseBody = await readBoundedText(upstream, MAX_UPSTREAM_RESPONSE_BYTES);
      if (isJiraProvider(options.descriptor)) {
        if (upstream.status === 401 && credential?.rawValue && options.recoverCredential) {
          const replacement = await options.recoverCredential(
            credentialRequest,
            credential.rawValue,
          );
          if (replacement) {
            credential = replacement;
            if (!canAutomaticallyReplay) {
              await emitProviderFailureAudit(
                options.audit,
                identity,
                tool,
                message.arguments,
                started,
                "provider_retry_required",
              );
              return providerFailure(
                message.id,
                "provider_retry_required",
                "Provider credential was renewed; retry the request",
                options,
              );
            }
            upstream = await options.transport.send({
              incomingRequest: request,
              body: upstreamBody,
              credential,
              principalKey: principalKey(identity),
            });
            responseBody = await readBoundedText(upstream, MAX_UPSTREAM_RESPONSE_BYTES);
          }
        }
        let opaqueFailure = atlassianOpaqueFailure(responseBody);
        if (opaqueFailure && credential?.rawValue && options.validateCredential) {
          let validation: "valid" | "invalid" | "unavailable" = "unavailable";
          try {
            validation = await options.validateCredential(credentialRequest, credential.rawValue);
          } catch {
            validation = "unavailable";
          }
          if (validation === "invalid" && options.recoverCredential) {
            const replacement = await options.recoverCredential(
              credentialRequest,
              credential.rawValue,
            );
            if (replacement) {
              credential = replacement;
              if (!canAutomaticallyReplay) {
                await emitProviderFailureAudit(
                  options.audit,
                  identity,
                  tool,
                  message.arguments,
                  started,
                  "provider_retry_required",
                );
                return providerFailure(
                  message.id,
                  "provider_retry_required",
                  "Provider credential was renewed; retry the request",
                  options,
                );
              }
              upstream = await options.transport.send({
                incomingRequest: request,
                body: upstreamBody,
                credential,
                principalKey: principalKey(identity),
              });
              responseBody = await readBoundedText(upstream, MAX_UPSTREAM_RESPONSE_BYTES);
              opaqueFailure = atlassianOpaqueFailure(responseBody);
            }
          }
          if (opaqueFailure) {
            const failure =
              validation === "invalid"
                ? {
                    error: "provider_oauth_required",
                    message: "Provider authorization is required",
                  }
                : validation === "valid" && opaqueFailure === "access_verification"
                  ? {
                      error: "provider_permission_denied",
                      message: "Provider permission was denied",
                    }
                  : {
                      error: "provider_unavailable",
                      message: "Provider is temporarily unavailable",
                    };
            await emitProviderFailureAudit(
              options.audit,
              identity,
              tool,
              message.arguments,
              started,
              failure.error,
            );
            return providerFailure(message.id, failure.error, failure.message, options);
          }
        }
        const failure = jiraHttpFailure(upstream);
        if (failure) {
          await emitProviderFailureAudit(
            options.audit,
            identity,
            tool,
            message.arguments,
            started,
            failure.error,
          );
          const mapped = providerFailure(
            message.id,
            failure.error,
            failure.message,
            options,
            failure.retryAfter,
          );
          if (failure.retryAfter) mapped.headers.set("retry-after", failure.retryAfter);
          return mapped;
        }
      }
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
  protocolVersion?: string;
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
    ...(typeof params.protocolVersion === "string"
      ? { protocolVersion: params.protocolVersion }
      : {}),
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

async function liveToolsList(
  options: CreateGenericMcpProxyHandlerOptions,
  request: Request,
  id: JsonRpcId,
  identity: Hop1Identity,
  hop1Token: string,
  taskAuthorization: TaskToolAuthorization,
): Promise<Response> {
  if (!isLiveToolCatalog(options.catalog)) {
    throw new Error("liveToolsList requires a live tool-decisions catalog");
  }
  const helpers = taskAuthorization.allowsConnectionHelpers ? oauthToolDefinitions(options) : [];
  const approvedDecisions = options.catalog.tools.filter((tool) =>
    taskAuthorization.allows(genericTaskToolGrant(options, tool)),
  );
  if (approvedDecisions.length === 0) {
    return mcpResult(id, { tools: helpers });
  }
  let credential: GenericUpstreamCredential | null;
  try {
    credential = await options.resolveCredential({ identity, hop1Token, scopes: [] });
  } catch {
    return liveCatalogUnavailable(id, helpers, "Upstream tool discovery is unavailable");
  }
  if (!credential) {
    return liveCatalogUnavailable(id, helpers, "Provider authorization is required", {
      connectionHelper: `${options.descriptor.toolPrefix}_oauth_start`,
    });
  }
  try {
    const upstream = await listUpstreamCatalog({
      transport: options.transport,
      incomingRequest: request,
      credential,
      principalKey: principalKey(identity),
    });
    const decisions = new Map(
      approvedDecisions.map((decision) => [decision.upstreamName, decision]),
    );
    const tools = upstream.tools.flatMap((tool) => {
      const decision = decisions.get(tool.name);
      return decision ? [publicLiveToolDefinition(options.descriptor, decision, tool)] : [];
    });
    return mcpResult(id, { tools: [...helpers, ...tools] });
  } catch {
    return liveCatalogUnavailable(id, helpers, "Upstream tool discovery is unavailable");
  }
}

function genericTaskToolGrant(
  options: CreateGenericMcpProxyHandlerOptions,
  tool: GenericGovernedTool,
) {
  return {
    provider:
      options.descriptor.credential.mode === "per_user_oauth"
        ? options.descriptor.credential.providerId
        : options.descriptor.name,
    resource: tool.exposedName,
    action: tool.grants.actionClass,
  };
}

function liveCatalogUnavailable(
  id: JsonRpcId,
  tools: Record<string, unknown>[],
  message: string,
  details: Record<string, unknown> = {},
): Response {
  return mcpResult(id, {
    tools,
    _meta: {
      "mcp-gw/catalog": {
        status: "unavailable",
        error: message,
        ...details,
      },
    },
  });
}

function publicLiveToolDefinition(
  descriptor: GenericWrapperDescriptor,
  decision: GenericIncludedToolDecision,
  upstream: CapturedUpstreamTool,
): Record<string, unknown> {
  if (typeof upstream.description !== "string" || upstream.description.length === 0) {
    throw new Error(`Upstream tool ${upstream.name} has no description`);
  }
  if (!isRecord(upstream.inputSchema)) {
    throw new Error(`Upstream tool ${upstream.name} has no input schema`);
  }
  return {
    name: decision.exposedName,
    description: upstream.description,
    inputSchema: publicLiveInputSchema(descriptor, upstream.inputSchema),
    annotations: {
      readOnlyHint: decision.grants.actionClass === "read",
      ...(decision.grants.actionClass === "destructive" ? { destructiveHint: true } : {}),
    },
  };
}

function publicLiveInputSchema(
  descriptor: GenericWrapperDescriptor,
  inputSchema: Record<string, unknown>,
): Record<string, unknown> {
  const schema = structuredClone(inputSchema);
  if (!isJiraProvider(descriptor)) return schema;
  if (isRecord(schema.properties)) delete schema.properties.cloudId;
  if (Array.isArray(schema.required)) {
    const required = schema.required.filter((name) => name !== "cloudId");
    if (required.length > 0) schema.required = required;
    else delete schema.required;
  }
  return schema;
}

function rewriteToolCall(
  body: string,
  upstreamName: string,
  args: Record<string, unknown>,
): string {
  const value = JSON.parse(body) as Record<string, unknown>;
  const params = isRecord(value.params) ? value.params : {};
  return JSON.stringify({
    ...value,
    params: { ...params, name: upstreamName, arguments: args },
  });
}

function effectiveToolArguments(
  descriptor: GenericWrapperDescriptor,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const credential = descriptor.credential;
  if (
    credential.mode === "per_user_oauth" &&
    credential.providerId === "jira" &&
    credential.identity.mode === "atlassian_jira_asserted_email"
  ) {
    return { ...args, cloudId: credential.identity.siteUrl };
  }
  return args;
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

function isJiraProvider(descriptor: GenericWrapperDescriptor): boolean {
  return (
    descriptor.credential.mode === "per_user_oauth" && descriptor.credential.providerId === "jira"
  );
}

function atlassianOpaqueFailure(body: string): "transient" | "access_verification" | undefined {
  let envelope: unknown;
  try {
    envelope = JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(envelope) || !isRecord(envelope.result) || envelope.result.isError !== true) {
    return undefined;
  }
  const content = envelope.result.content;
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
    const normalized = item.text.trimStart().toLowerCase();
    if (normalized.startsWith("we are having trouble completing this action")) return "transient";
    if (normalized.startsWith("we couldn't verify your access")) return "access_verification";
  }
  return undefined;
}

function jiraHttpFailure(
  response: Response,
): { error: string; message: string; retryAfter?: string } | undefined {
  if (response.status === 401) {
    return {
      error: "provider_oauth_required",
      message: "Provider authorization is required",
    };
  }
  if (response.status === 403) {
    return {
      error: "provider_permission_denied",
      message: "Provider permission was denied",
    };
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after")?.trim();
    return {
      error: "provider_rate_limited",
      message: "Provider rate limit exceeded",
      ...(retryAfter ? { retryAfter } : {}),
    };
  }
  if (response.status >= 500) {
    return {
      error: "provider_unavailable",
      message: "Provider is temporarily unavailable",
    };
  }
  return undefined;
}

async function emitProviderFailureAudit(
  audit: AuditSink | undefined,
  identity: Hop1Identity,
  tool: GenericGovernedTool | undefined,
  args: Record<string, unknown>,
  started: number,
  error: string,
): Promise<void> {
  if (!tool) return;
  await emitSafely(audit, {
    ts: new Date().toISOString(),
    category: "tool_call",
    principal: identity.email,
    status: "error",
    event: "provider_failure",
    tool: tool.exposedName,
    argDigest: digestArgs(args),
    latencyMs: Date.now() - started,
    error,
  });
}

function providerFailure(
  id: JsonRpcId,
  error: string,
  message: string,
  options: CreateGenericMcpProxyHandlerOptions,
  retryAfter?: string,
): Response {
  return mcpResult(id, {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: {
      error,
      provider:
        options.oauth?.providerId ??
        (options.descriptor.credential.mode === "per_user_oauth"
          ? options.descriptor.credential.providerId
          : undefined),
      ...(error === "provider_oauth_required"
        ? { connectionHelper: `${options.descriptor.toolPrefix}_oauth_start` }
        : {}),
      ...(retryAfter ? { retryAfter } : {}),
    },
  });
}

function safeStreamingResponse(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: forwardedResponseHeaders(response),
  });
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let body = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) return body + decoder.decode();
    const chunk: Uint8Array = next.value;
    total += chunk.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("MCP upstream response exceeded the size limit");
    }
    body += decoder.decode(chunk, { stream: true });
  }
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

function unauthorized(message: string, challenge = 'Bearer error="invalid_token"'): Response {
  const response = mcpError(null, -32001, `Unauthorized: ${message}`, 401);
  response.headers.set("www-authenticate", challenge);
  return response;
}

function validateRequestSession(
  transport: GenericUpstreamTransport,
  request: Request,
  identity: Hop1Identity,
): Response | undefined {
  const sessionId = request.headers.get("mcp-session-id")?.trim();
  if (!sessionId) return mcpError(null, -32000, "MCP session ID is required");
  try {
    transport.assertSession(sessionId, principalKey(identity));
    return undefined;
  } catch {
    return mcpError(null, -32000, "MCP session is unknown or unavailable");
  }
}

function mcpResult(id: JsonRpcId, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: JSON_HEADERS,
  });
}

function taskToolDenied(id: JsonRpcId): Response {
  return mcpResult(id, {
    isError: true,
    content: [{ type: "text", text: TASK_TOOL_DENIED_MESSAGE }],
    structuredContent: { error: TASK_TOOL_DENIED_ERROR },
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
