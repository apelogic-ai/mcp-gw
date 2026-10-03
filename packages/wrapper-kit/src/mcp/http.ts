import { hasTool, type ToolRegistry } from "./registry";

type JsonRpcId = string | number | null;

interface ServerInfo {
  name: string;
  version: string;
}

interface CreateMcpHttpHandlerOptions {
  registry: ToolRegistry;
  serverInfo: ServerInfo;
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
  };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;
type JsonRpcHandlerResult = JsonRpcResponse | undefined;

const JSON_HEADERS = {
  "content-type": "application/json",
};

export function createMcpHttpHandler(
  options: CreateMcpHttpHandlerOptions,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return jsonResponse(errorResponse(null, -32600, "Invalid request: POST is required"), 405);
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse(errorResponse(null, -32700, "Parse error"));
    }

    const result = await handleJsonRpc(payload, options);
    return result ? jsonResponse(result) : new Response(null, { status: 202 });
  };
}

async function handleJsonRpc(
  payload: unknown,
  options: CreateMcpHttpHandlerOptions,
): Promise<JsonRpcHandlerResult> {
  const request = payload as JsonRpcRequest;
  const isNotification = isRecord(payload) && !Object.prototype.hasOwnProperty.call(payload, "id");
  const id = request.id ?? null;

  if (!isRecord(payload) || payload.jsonrpc !== "2.0") {
    return errorResponse(id, -32600, "Invalid request: jsonrpc must be 2.0");
  }

  if (typeof payload.method !== "string") {
    return errorResponse(id, -32600, "Invalid request: method is required");
  }

  if (isNotification) {
    return undefined;
  }

  switch (payload.method) {
    case "initialize":
      return successResponse(id, {
        protocolVersion: "2025-06-18",
        capabilities: {
          tools: {},
        },
        serverInfo: options.serverInfo,
      });

    case "tools/list":
      return successResponse(id, {
        tools: options.registry.listTools(),
      });

    case "tools/call":
      return callTool(id, request.params, options.registry);

    default:
      return errorResponse(id, -32601, `Method not found: ${payload.method}`);
  }
}

async function callTool(
  id: JsonRpcId,
  params: unknown,
  registry: ToolRegistry,
): Promise<JsonRpcResponse> {
  if (!isRecord(params) || typeof params.name !== "string") {
    return errorResponse(id, -32602, "Invalid params: tool name is required");
  }

  if (!hasTool(registry, params.name)) {
    return errorResponse(id, -32602, `Unknown tool: ${params.name}`);
  }

  const args = isRecord(params.arguments) ? params.arguments : {};
  const result = await registry.callTool(params.name, args);
  return successResponse(id, result);
}

function successResponse(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function errorResponse(id: JsonRpcId, code: number, message: string): JsonRpcError {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  };
}

function jsonResponse(body: JsonRpcResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
