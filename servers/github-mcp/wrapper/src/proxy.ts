import {
  classifyHop1ValidationFailure,
  normalizedHop1Claims,
  reportHop1AuthenticationFailure,
  type Hop1FailureReporter,
  type Hop1Identity,
} from "../../../../shared/identity/hop1";
import { digestArgs, type AuditSink } from "../../../../shared/audit/audit";
import { GitHubOAuthError } from "../../../../shared/oauth/github";
import {
  AllowAllPolicy,
  type PolicyActionClass,
  type PolicyDecision,
  type ToolPolicy,
} from "../../../../shared/policy/policy";
import {
  createCredentialBridge,
  type CredentialBridge,
} from "../../../../packages/wrapper-kit/src/credential-bridge";
import {
  forwardedMcpResponseHeaders,
  forwardMcpRequest,
  withUpstreamProtocolMetadata,
} from "../../../../packages/wrapper-kit/src/mcp/proxy";
import {
  GITHUB_MCP_CATALOG_ID,
  GITHUB_MCP_SHIPPED_TOOLSETS,
  classifyGithubToolAction,
  isPinnedGithubTool,
  listStableGithubTools,
  pinnedGithubToolAnnotationsMatch,
  type GithubMcpCatalogId,
  type GithubMcpToolsetName,
} from "./catalog/github-mcp";

export interface CreateGithubMcpProxyHandlerOptions {
  upstreamUrl: string;
  governanceCatalogId?: GithubMcpCatalogId;
  githubToolsets?: readonly GithubMcpToolsetName[];
  authenticate(token: string): Promise<Hop1Identity>;
  resolveGithubToken(identity: Hop1Identity): Promise<string | undefined>;
  recoverGithubToken?: (
    identity: Hop1Identity,
    rejectedActiveCredential: string,
  ) => Promise<string | undefined>;
  getOAuthStatus?(identity: Hop1Identity): Promise<GithubOAuthStatus>;
  startOAuth?(
    identity: Hop1Identity,
    redirectAfter?: string,
  ): Promise<{ authorizationUrl: string }>;
  githubScopes?: string[];
  aliases?: Record<string, string>;
  audit?: AuditSink;
  policy?: ToolPolicy;
  fetch?: GithubMcpProxyFetch;
  onAuthenticationFailure?: Hop1FailureReporter;
}

export type GithubMcpProxyFetch = (request: Request) => Promise<Response>;

export interface GithubOAuthStatus {
  version?: "2";
  connected: boolean;
  email?: string;
  account?: {
    provider: "github";
    displayName?: string;
    id?: string;
    login?: string;
  };
  scopesRequired: string[];
  scopesGranted: string[];
  missingScopes: string[];
}

type JsonRpcId = string | number | null;

interface ToolCallContext {
  id: JsonRpcId;
  originalName: string;
  toolName: string;
  args: Record<string, unknown>;
  actionClass: PolicyActionClass | undefined;
  body: string;
}

const JSON_HEADERS = {
  "content-type": "application/json",
};

const LOCAL_TOOLS = [
  {
    name: "github_oauth_status",
    description:
      "Check whether the current MCP-GW user has connected a GitHub account for GitHub MCP tools.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
  {
    name: "github_oauth_start",
    description:
      "Start GitHub OAuth connection for the current MCP-GW user and return a browser authorization URL.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        redirectAfter: {
          type: "string",
          description: "Optional URL to return to after GitHub OAuth completes.",
        },
      },
      required: [],
    },
    annotations: { readOnlyHint: false },
  },
];
const SERVER_INFO = {
  name: "github-mcp-wrapper",
  version: "0.1.0",
};

export function createGithubMcpProxyHandler(
  options: CreateGithubMcpProxyHandlerOptions,
): (request: Request) => Promise<Response> {
  const fetchImpl = options.fetch ?? fetch;
  const recoverGithubToken = options.recoverGithubToken;
  const credentialBridge = createCredentialBridge<Hop1Identity, undefined, string | undefined>({
    mode: "per_user_oauth",
    resolve: (identity) => options.resolveGithubToken(identity),
    recover: recoverGithubToken
      ? (identity, _requirement, rejectedCredential) =>
          rejectedCredential
            ? recoverGithubToken(identity, rejectedCredential)
            : Promise.resolve(undefined)
      : undefined,
  });
  const policy = options.policy ?? new AllowAllPolicy();
  const oauthCatalog = options.getOAuthStatus
    ? listStableGithubTools(
        options.githubToolsets ?? GITHUB_MCP_SHIPPED_TOOLSETS,
        options.governanceCatalogId,
      )
    : undefined;
  const oauthCatalogNames: ReadonlySet<string> | undefined = oauthCatalog
    ? new Set(oauthCatalog.map((tool) => tool.name))
    : undefined;

  return async (request: Request): Promise<Response> => {
    const started = Date.now();
    const reportFailure = options.onAuthenticationFailure ?? reportHop1AuthenticationFailure;
    const hop1Token = bearerToken(request);
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

    const body = await request.text();
    const method = parseMethod(body);
    if (method?.isNotification) {
      return new Response(null, { status: 202 });
    }
    if (method?.method === "initialize") {
      return mcpResult(method.id, {
        protocolVersion: "2025-06-18",
        capabilities: {
          tools: {},
        },
        serverInfo: SERVER_INFO,
      });
    }
    if (method?.method === "tools/list") {
      if (options.getOAuthStatus) {
        return mcpResult(method.id, {
          tools: [...LOCAL_TOOLS, ...(oauthCatalog ?? [])],
        });
      }
      return handleToolsList(
        request,
        body,
        identity,
        method.id,
        options,
        fetchImpl,
        credentialBridge,
      );
    }

    let resourceDiscoveryToken: string | undefined;
    if (
      method &&
      isResourceDiscoveryMethod(method.method) &&
      isValidResourceDiscoveryRequest(request, body)
    ) {
      resourceDiscoveryToken = await resolveGithubTokenOrUndefined(credentialBridge, identity);
      if (!resourceDiscoveryToken) {
        return mcpResult(
          method.id,
          method.method === "resources/templates/list"
            ? { resourceTemplates: [] }
            : { resources: [] },
        );
      }
    }

    const toolCall = parseToolCall(body, options.aliases ?? {}, options.governanceCatalogId);
    const actionClass = toolCall?.actionClass;
    if (
      toolCall &&
      (actionClass === undefined ||
        (oauthCatalogNames &&
          !isLocalTool(toolCall.toolName) &&
          !oauthCatalogNames.has(toolCall.toolName)))
    ) {
      await options.audit?.emit({
        ts: new Date().toISOString(),
        category: "tool_call",
        principal: identity.email,
        status: "deny",
        event: "deny",
        tool: toolCall.toolName,
        argDigest: digestArgs(toolCall.args),
        latencyMs: Date.now() - started,
        error: "unsupported GitHub MCP tool",
      });
      return mcpError(
        toolCall.id,
        -32601,
        `GitHub MCP tool is not supported: ${toolCall.toolName}`,
      );
    }
    if (toolCall && toolCall.toolName !== "github_oauth_status" && actionClass) {
      const decision = await policy.decide({
        principal: identity.email,
        tokenClaims: normalizedHop1Claims(identity),
        tool: toolCall.toolName,
        service: "github",
        actionClass,
        scopes: options.githubScopes ?? [],
        args: toolCall.args,
      });
      const denied = await denyIfNeeded(decision, identity, toolCall, started, options.audit);
      if (denied) {
        return denied;
      }
    }
    if (toolCall && !isLocalTool(toolCall.toolName) && options.getOAuthStatus) {
      const status = await options.getOAuthStatus(identity);
      if (!status.connected) {
        return providerOAuthRequired(toolCall.id);
      }
    }

    const localTool = toolCall ? await handleLocalToolCall(toolCall, identity, options) : undefined;
    if (localTool) {
      return localTool;
    }

    const githubToken =
      resourceDiscoveryToken ?? (await resolveGithubTokenOrUndefined(credentialBridge, identity));
    if (!githubToken) {
      if (toolCall) {
        return providerOAuthRequired(toolCall.id);
      }
      return unauthorized("GitHub account is not connected");
    }

    try {
      const upstreamBody = withUpstreamProtocolMetadata(
        request,
        toolCall?.body ?? body,
        SERVER_INFO,
      );
      let upstreamResponse = await forwardMcpRequest({
        fetch: fetchImpl,
        upstreamUrl: options.upstreamUrl,
        request,
        credential: githubToken,
        body: upstreamBody,
      });
      if (upstreamResponse.status === 401 && credentialBridge.recover) {
        const replacement = await credentialBridge.recover(identity, undefined, githubToken);
        if (replacement) {
          upstreamResponse = await forwardMcpRequest({
            fetch: fetchImpl,
            upstreamUrl: options.upstreamUrl,
            request,
            credential: replacement,
            body: upstreamBody,
          });
        }
      }
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
        headers: forwardedMcpResponseHeaders(upstreamResponse),
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

function isLocalTool(toolName: string): boolean {
  return toolName === "github_oauth_status" || toolName === "github_oauth_start";
}

function providerOAuthRequired(id: JsonRpcId): Response {
  return mcpResult(id, {
    isError: true,
    content: [
      {
        type: "text",
        text: "GitHub authorization is required. Call github_oauth_start to connect the provider.",
      },
    ],
    structuredContent: {
      error: "provider_oauth_required",
      provider: "github",
      connectionHelper: "github_oauth_start",
    },
  });
}

function isResourceDiscoveryMethod(method: string): boolean {
  return method === "resources/list" || method === "resources/templates/list";
}

function isValidResourceDiscoveryRequest(request: Request, body: string): boolean {
  if (request.method !== "POST" || !hasJsonContentType(request)) {
    return false;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    return false;
  }

  if (
    !isRecord(payload) ||
    payload.jsonrpc !== "2.0" ||
    !Object.prototype.hasOwnProperty.call(payload, "id") ||
    (typeof payload.id !== "string" &&
      (typeof payload.id !== "number" || !Number.isFinite(payload.id))) ||
    typeof payload.method !== "string" ||
    !isResourceDiscoveryMethod(payload.method)
  ) {
    return false;
  }

  if (!("params" in payload)) {
    return true;
  }
  if (!isRecord(payload.params)) {
    return false;
  }
  if ("cursor" in payload.params && typeof payload.params.cursor !== "string") {
    return false;
  }
  return !("_meta" in payload.params) || isRecord(payload.params._meta);
}

function hasJsonContentType(request: Request): boolean {
  const value = request.headers.get("content-type");
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

async function handleToolsList(
  request: Request,
  body: string,
  identity: Hop1Identity,
  id: JsonRpcId,
  options: CreateGithubMcpProxyHandlerOptions,
  fetchImpl: GithubMcpProxyFetch,
  credentialBridge: CredentialBridge<Hop1Identity, undefined, string | undefined>,
): Promise<Response> {
  const githubToken = await resolveGithubTokenOrUndefined(credentialBridge, identity);
  if (!githubToken) {
    return mcpResult(id, { tools: LOCAL_TOOLS });
  }

  const upstreamBody = withUpstreamProtocolMetadata(request, body, SERVER_INFO);
  const upstreamResponse = await forwardMcpRequest({
    fetch: fetchImpl,
    upstreamUrl: options.upstreamUrl,
    request,
    credential: githubToken,
    body: upstreamBody,
  });
  const responseBody = await upstreamResponse.text();

  return new Response(
    mergeToolsList(responseBody, options.governanceCatalogId === GITHUB_MCP_CATALOG_ID),
    {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: forwardedMcpResponseHeaders(upstreamResponse),
    },
  );
}

async function resolveGithubTokenOrUndefined(
  bridge: CredentialBridge<Hop1Identity, undefined, string | undefined>,
  identity: Hop1Identity,
): Promise<string | undefined> {
  try {
    return await bridge.resolve(identity, undefined);
  } catch (error) {
    if (error instanceof GitHubOAuthError && error.code === "reauth_required") {
      return undefined;
    }
    throw error;
  }
}

async function handleLocalToolCall(
  toolCall: ToolCallContext,
  identity: Hop1Identity,
  options: CreateGithubMcpProxyHandlerOptions,
): Promise<Response | undefined> {
  if (toolCall.toolName === "github_oauth_status") {
    const status = (await options.getOAuthStatus?.(identity)) ?? {
      connected: false,
      scopesRequired: options.githubScopes ?? [],
      scopesGranted: [],
      missingScopes: options.githubScopes ?? [],
    };

    return mcpResult(toolCall.id, {
      content: [
        {
          type: "text",
          text: JSON.stringify(status),
        },
      ],
    });
  }

  if (toolCall.toolName === "github_oauth_start") {
    if (!options.startOAuth) {
      return mcpError(toolCall.id, -32000, "GitHub OAuth is not configured");
    }

    const redirectAfter =
      typeof toolCall.args.redirectAfter === "string" && toolCall.args.redirectAfter.length > 0
        ? toolCall.args.redirectAfter
        : undefined;
    const started = await options.startOAuth(identity, redirectAfter);

    return mcpResult(toolCall.id, {
      content: [
        {
          type: "text",
          text: JSON.stringify(started),
        },
      ],
    });
  }

  return undefined;
}

function parseMethod(body: string):
  | {
      id: JsonRpcId;
      method: string;
      isNotification: boolean;
      requestName?: string;
      requestArguments?: Record<string, unknown>;
    }
  | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }

  if (!isRecord(payload) || typeof payload.method !== "string") {
    return undefined;
  }

  const params = isRecord(payload.params) ? payload.params : undefined;
  const requestName =
    typeof params?.name === "string"
      ? params.name
      : typeof params?.uri === "string"
        ? params.uri
        : undefined;
  const requestArguments = isRecord(params?.arguments) ? params.arguments : undefined;

  return {
    id: jsonRpcId(payload.id),
    method: payload.method,
    isNotification: !Object.prototype.hasOwnProperty.call(payload, "id"),
    requestName,
    requestArguments,
  };
}

function mergeToolsList(body: string, enforceCatalog: boolean): string {
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    return mergeSseToolsList(body, enforceCatalog) ?? body;
  }

  return JSON.stringify(mergeToolPayload(payload, enforceCatalog) ?? payload);
}

function mergeSseToolsList(body: string, enforceCatalog: boolean): string | undefined {
  let changed = false;
  const lines: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      lines.push(line);
      continue;
    }

    const data = line.slice("data:".length).trimStart();
    if (!data || data === "[DONE]") {
      lines.push(line);
      continue;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(data) as unknown;
    } catch {
      lines.push(line);
      continue;
    }

    const merged = mergeToolPayload(payload, enforceCatalog);
    if (!merged) {
      lines.push(line);
      continue;
    }

    changed = true;
    lines.push(`data: ${JSON.stringify(merged)}`);
  }

  return changed ? lines.join("\n") : undefined;
}

function mergeToolPayload(
  payload: unknown,
  enforceCatalog: boolean,
): Record<string, unknown> | undefined {
  const tools = toolsFromPayload(payload, enforceCatalog);
  if (!tools || !isRecord(payload) || !isRecord(payload.result)) {
    return undefined;
  }

  return {
    ...payload,
    result: {
      ...payload.result,
      tools,
    },
  };
}

function toolsFromPayload(
  payload: unknown,
  enforceCatalog: boolean,
): readonly unknown[] | undefined {
  if (!isRecord(payload) || !isRecord(payload.result) || !Array.isArray(payload.result.tools)) {
    return undefined;
  }
  const upstreamTools = enforceCatalog
    ? (payload.result.tools as unknown[]).filter(isSupportedUpstreamTool)
    : (payload.result.tools as unknown[]);
  const existingNames = new Set(
    upstreamTools
      .map((tool) => (isRecord(tool) && typeof tool.name === "string" ? tool.name : undefined))
      .filter((name): name is string => Boolean(name)),
  );
  const localTools = LOCAL_TOOLS.filter((tool) => !existingNames.has(tool.name));
  return [...localTools, ...upstreamTools];
}

function isSupportedUpstreamTool(tool: unknown): boolean {
  if (!isRecord(tool) || typeof tool.name !== "string" || !isPinnedGithubTool(tool.name)) {
    return false;
  }

  return pinnedGithubToolAnnotationsMatch(tool.name, tool.annotations);
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

function parseToolCall(
  body: string,
  aliases: Record<string, string>,
  governanceCatalogId?: GithubMcpCatalogId,
): ToolCallContext | undefined {
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
    actionClass:
      governanceCatalogId === GITHUB_MCP_CATALOG_ID
        ? classifyGithubToolAction(toolName, args)
        : classifyLegacyGithubToolAction(toolName),
    body: JSON.stringify(rewritten),
  };
}

function classifyLegacyGithubToolAction(toolName: string): PolicyActionClass {
  if (toolName === "github_oauth_start") return "write";
  if (/(?:delete|remove|destroy)/i.test(toolName)) return "destructive";
  if (/(?:create|update|edit|merge|close|reopen|add|set|request|review|comment)/i.test(toolName)) {
    return "write";
  }
  return "read";
}

function jsonRpcId(value: unknown): JsonRpcId {
  return typeof value === "string" || typeof value === "number" || value === null ? value : null;
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

function mcpResult(id: JsonRpcId, result: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      result,
    }),
    {
      status: 200,
      headers: JSON_HEADERS,
    },
  );
}

function unauthorized(message: string, challenge = 'Bearer error="invalid_token"'): Response {
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
      headers: { ...JSON_HEADERS, "www-authenticate": challenge },
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
