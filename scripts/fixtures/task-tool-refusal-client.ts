#!/usr/bin/env bun

interface Args {
  gatewayUrl: string;
  githubWrapperUrl: string;
  providerFixtureUrl: string;
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

await connectGithub(`${approvedGatewayName.slice(0, -APPROVED_TOOL.length)}github_oauth_start`);

const approvedPayload = await decodeRpcResponse(
  await rpcRequest(
    {
      jsonrpc: "2.0",
      id: "task-tool-approved",
      method: "tools/call",
      params: {
        name: approvedGatewayName,
        arguments: { owner: "example", repo: "fixture" },
      },
    },
    sessionId,
  ),
);
if (approvedPayload.error || approvedPayload.result?.isError === true) {
  throw new Error(`Task-approved tool failed: ${JSON.stringify(approvedPayload)}`);
}
if (!JSON.stringify(approvedPayload).includes("Fixture commits")) {
  throw new Error(
    `Task-approved tool did not reach the fixture: ${JSON.stringify(approvedPayload)}`,
  );
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
const taskDenied =
  deniedResponse.status === 200 &&
  deniedPayload.result?.isError === true &&
  isRecord(deniedPayload.result.structuredContent) &&
  deniedPayload.result.structuredContent.error === "task_tool_not_approved";
const gatewayDenied =
  deniedResponse.status === 500 &&
  deniedPayload.error?.code === -32603 &&
  deniedPayload.error.message?.toLowerCase().includes("unknown tool") === true;
if (!taskDenied && !gatewayDenied) {
  throw new Error(
    `Expected Task-tool refusal for ${deniedGatewayName}; received HTTP ${String(deniedResponse.status)} ${JSON.stringify(deniedPayload)}`,
  );
}

const providerCallsResponse = await fetch(`${args.providerFixtureUrl}/github-mcp/calls`);
if (!providerCallsResponse.ok) {
  throw new Error(`Provider fixture call log failed (${String(providerCallsResponse.status)})`);
}
const providerCalls = (await providerCallsResponse.json()) as { tools?: unknown };
if (
  !Array.isArray(providerCalls.tools) ||
  providerCalls.tools.length !== 1 ||
  providerCalls.tools[0] !== APPROVED_TOOL
) {
  throw new Error(
    `Provider fixture received unexpected tool calls: ${JSON.stringify(providerCalls.tools)}`,
  );
}

console.log("Task-approved tool succeeded and the unapproved tool was refused before upstream.");

async function connectGithub(oauthStartTool: string): Promise<void> {
  const startPayload = await decodeRpcResponse(
    await rpcRequest(
      {
        jsonrpc: "2.0",
        id: "task-tool-oauth-start",
        method: "tools/call",
        params: { name: oauthStartTool, arguments: {} },
      },
      sessionId,
    ),
  );
  const content = startPayload.result?.content;
  const text = Array.isArray(content)
    ? content.find(
        (item) => isRecord(item) && item.type === "text" && typeof item.text === "string",
      )
    : undefined;
  if (!isRecord(text) || typeof text.text !== "string") {
    throw new Error(`GitHub OAuth start returned no text result: ${JSON.stringify(startPayload)}`);
  }
  const start = JSON.parse(text.text) as { authorizationUrl?: unknown };
  if (typeof start.authorizationUrl !== "string") {
    throw new Error(`GitHub OAuth start returned no authorization URL: ${text.text}`);
  }
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) throw new Error("GitHub OAuth authorization URL contained no state");

  const callback = new URL("/oauth/github/callback", args.githubWrapperUrl);
  callback.searchParams.set("code", "fixture-code");
  callback.searchParams.set("state", state);
  const response = await fetch(callback, { redirect: "manual" });
  if (!response.ok) {
    throw new Error(
      `GitHub OAuth callback failed (${String(response.status)}): ${await response.text()}`,
    );
  }
}

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
    githubWrapperUrl: required(values, "github-wrapper-url"),
    providerFixtureUrl: required(values, "provider-fixture-url"),
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
