#!/usr/bin/env bun

interface Args {
  gatewayUrl: string;
  tokenFile: string;
}

interface RpcEnvelope {
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

const APPROVED_TOOL = "list_commits";
const DENIED_TOOL = "actions_get";

const args = parseArgs(process.argv.slice(2));
const token = (await Bun.file(args.tokenFile).text()).trim();
const sessionId = await createSession();
const toolNames = await listTools(sessionId);
const approvedGatewayName = toolNames.find((name) => name.endsWith(APPROVED_TOOL));

if (!approvedGatewayName) {
  throw new Error(`Task-approved tool ${APPROVED_TOOL} was not exposed by the gateway`);
}

const deniedGatewayName = `${approvedGatewayName.slice(0, -APPROVED_TOOL.length)}${DENIED_TOOL}`;
if (toolNames.includes(deniedGatewayName)) {
  throw new Error(`Task-unapproved tool ${deniedGatewayName} was exposed by the gateway`);
}

const deniedResponse = await rpcRequest(
  {
    jsonrpc: "2.0",
    id: "task-tool-denied",
    method: "tools/call",
    params: { name: deniedGatewayName, arguments: {} },
  },
  sessionId,
);
const deniedPayload = await decodeRpcResponse(deniedResponse);
if (
  deniedResponse.status !== 500 ||
  deniedPayload.error?.code !== -32603 ||
  !deniedPayload.error.message?.toLowerCase().includes("unknown tool")
) {
  throw new Error(
    `Expected gateway unknown-tool refusal for ${deniedGatewayName}; received HTTP ${String(deniedResponse.status)} ${JSON.stringify(deniedPayload)}`,
  );
}

console.log("Task-unapproved provider tool was refused by the gateway.");

async function createSession(): Promise<string> {
  const response = await rpcRequest(
    {
      jsonrpc: "2.0",
      id: "task-tool-initialize",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "task-tool-refusal-fixture", version: "1.0.0" },
      },
    },
    undefined,
  );
  if (!response.ok) {
    throw new Error(`MCP initialize failed (${String(response.status)}): ${await response.text()}`);
  }
  const sessionId = response.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("MCP initialize did not return mcp-session-id");
  await decodeRpcResponse(response);
  return sessionId;
}

async function listTools(sessionId: string): Promise<string[]> {
  const response = await rpcRequest(
    { jsonrpc: "2.0", id: "task-tool-list", method: "tools/list", params: {} },
    sessionId,
  );
  if (!response.ok) {
    throw new Error(`tools/list failed (${String(response.status)}): ${await response.text()}`);
  }
  const payload = await decodeRpcResponse(response);
  const tools = payload.result?.tools;
  if (!Array.isArray(tools)) {
    throw new Error(`tools/list did not return tools: ${JSON.stringify(payload)}`);
  }
  return tools.flatMap((tool) =>
    isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [],
  );
}

async function rpcRequest(body: unknown, sessionId: string | undefined): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "mcp-protocol-version": "2025-06-18",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return fetch(args.gatewayUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function decodeRpcResponse(response: Response): Promise<RpcEnvelope> {
  const body = await response.text();
  const data = response.headers.get("content-type")?.includes("text/event-stream")
    ? body
        .split(/\r?\n/)
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim()
    : body;
  if (!data) throw new Error("MCP response body was empty");
  return JSON.parse(data) as RpcEnvelope;
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error(`Invalid argument pair near ${key ?? "<end>"}`);
    }
    values.set(key.slice(2), value);
  }
  return {
    gatewayUrl: required(values, "gateway-url"),
    tokenFile: required(values, "token-file"),
  };
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`Missing required arg: --${key}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
