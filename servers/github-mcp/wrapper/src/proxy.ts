import type { Hop1Identity } from "../../../../shared/identity/hop1";
import { digestArgs, type AuditSink } from "../../../../shared/audit/audit";
import {
  AllowAllPolicy,
  type PolicyActionClass,
  type PolicyDecision,
  type ToolPolicy,
} from "../../../../shared/policy/policy";

export interface CreateGithubMcpProxyHandlerOptions {
  upstreamUrl: string;
  authenticate(token: string): Promise<Hop1Identity>;
  resolveGithubToken(identity: Hop1Identity): Promise<string | undefined>;
  githubScopes?: string[];
  aliases?: Record<string, string>;
  audit?: AuditSink;
  policy?: ToolPolicy;
  fetch?: GithubMcpProxyFetch;
}

export type GithubMcpProxyFetch = (request: Request) => Promise<Response>;

type JsonRpcId = string | number | null;

interface ToolCallContext {
  id: JsonRpcId;
  originalName: string;
  toolName: string;
  args: Record<string, unknown>;
  actionClass: PolicyActionClass;
  body: string;
}

const JSON_HEADERS = {
  "content-type": "application/json",
};

const FORWARDED_REQUEST_HEADERS = ["content-type", "mcp-protocol-version"];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "mcp-session-id"];

export function createGithubMcpProxyHandler(
  options: CreateGithubMcpProxyHandlerOptions,
): (request: Request) => Promise<Response> {
  const fetchImpl = options.fetch ?? fetch;
  const policy = options.policy ?? new AllowAllPolicy();

  return async (request: Request): Promise<Response> => {
    const started = Date.now();
    const hop1Token = bearerToken(request);
    if (!hop1Token) {
      return unauthorized("bearer token is required");
    }

    let identity: Hop1Identity;
    try {
      identity = await options.authenticate(hop1Token);
    } catch (error) {
      return unauthorized(error instanceof Error ? error.message : "invalid token");
    }

    const body = await request.text();
    const toolCall = parseToolCall(body, options.aliases ?? {});
    if (toolCall) {
      const decision = await policy.decide({
        principal: identity.email,
        tool: toolCall.toolName,
        service: "github",
        actionClass: toolCall.actionClass,
        scopes: options.githubScopes ?? [],
        args: toolCall.args,
      });
      const denied = await denyIfNeeded(decision, identity, toolCall, started, options.audit);
      if (denied) {
        return denied;
      }
    }

    const githubToken = await options.resolveGithubToken(identity);
    if (!githubToken) {
      return unauthorized("GitHub account is not connected");
    }

    try {
      const upstreamResponse = await fetchImpl(
        new Request(options.upstreamUrl, {
          method: request.method,
          headers: upstreamHeaders(request, githubToken),
          body: toolCall?.body ?? body,
        }),
      );
      const responseBody = await upstreamResponse.text();

      if (toolCall) {
        await options.audit?.emit({
          ts: new Date().toISOString(),
          category: "tool_call",
          principal: identity.email,
          status: upstreamResponse.ok ? "allow" : "error",
          tool: toolCall.toolName,
          argDigest: digestArgs(toolCall.args),
          latencyMs: Date.now() - started,
          resultSize: responseBody.length,
          error: upstreamResponse.ok ? undefined : upstreamResponse.statusText,
        });
      }

      return new Response(responseBody, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders(upstreamResponse),
      });
    } catch (error) {
      if (toolCall) {
        await options.audit?.emit({
          ts: new Date().toISOString(),
          category: "tool_call",
          principal: identity.email,
          status: "error",
          tool: toolCall.toolName,
          argDigest: digestArgs(toolCall.args),
          latencyMs: Date.now() - started,
          error: error instanceof Error ? error.message : "Unknown upstream error",
        });
      }

      return mcpError(toolCall?.id ?? null, -32000, "GitHub MCP upstream request failed");
    }
  };
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (!header) {
    return undefined;
  }

  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    return undefined;
  }

  return token;
}

function upstreamHeaders(request: Request, githubToken: string): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }

  headers.set("authorization", `Bearer ${githubToken}`);
  return headers;
}

function responseHeaders(response: Response): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }

  return headers;
}

async function denyIfNeeded(
  decision: PolicyDecision,
  identity: Hop1Identity,
  toolCall: ToolCallContext,
  started: number,
  audit: AuditSink | undefined,
): Promise<Response | undefined> {
  if (decision.kind === "allow") {
    return undefined;
  }

  const event = decision.kind === "approval_required" ? "approval_required" : "deny";
  await audit?.emit({
    ts: new Date().toISOString(),
    category: "tool_call",
    principal: identity.email,
    status: "deny",
    event,
    tool: toolCall.toolName,
    argDigest: digestArgs(toolCall.args),
    latencyMs: Date.now() - started,
    error: decision.reason,
  });

  return mcpError(
    toolCall.id,
    -32003,
    decision.kind === "approval_required"
      ? `Policy requires approval for ${toolCall.toolName}: ${decision.reason}`
      : `Policy denied ${toolCall.toolName}: ${decision.reason}`,
  );
}

function parseToolCall(body: string, aliases: Record<string, string>): ToolCallContext | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }

  if (!isRecord(payload) || payload.method !== "tools/call" || !isRecord(payload.params)) {
    return undefined;
  }

  const name = payload.params.name;
  if (typeof name !== "string" || name.length === 0) {
    return undefined;
  }

  const toolName = aliases[name] ?? name;
  const args = isRecord(payload.params.arguments) ? payload.params.arguments : {};
  const rewritten =
    toolName === name
      ? payload
      : {
          ...payload,
          params: {
            ...payload.params,
            name: toolName,
          },
        };

  return {
    id: jsonRpcId(payload.id),
    originalName: name,
    toolName,
    args,
    actionClass: classifyAction(toolName),
    body: JSON.stringify(rewritten),
  };
}

function jsonRpcId(value: unknown): JsonRpcId {
  return typeof value === "string" || typeof value === "number" || value === null ? value : null;
}

function classifyAction(toolName: string): PolicyActionClass {
  const normalized = toolName.toLowerCase();
  if (["delete", "remove", "destroy"].some((verb) => normalized.includes(verb))) {
    return "destructive";
  }
  if (
    [
      "create",
      "update",
      "edit",
      "merge",
      "close",
      "reopen",
      "add",
      "set",
      "request",
      "review",
      "comment",
    ].some((verb) => normalized.includes(verb))
  ) {
    return "write";
  }

  return "read";
}

function mcpError(id: JsonRpcId, code: number, message: string, status = 200): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
      },
    }),
    {
      status,
      headers: JSON_HEADERS,
    },
  );
}

function unauthorized(message: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32001,
        message: `Unauthorized: ${message}`,
      },
    }),
    {
      status: 401,
      headers: JSON_HEADERS,
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
