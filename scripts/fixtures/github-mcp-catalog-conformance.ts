#!/usr/bin/env bun

import {
  GITHUB_MCP_TOOLS,
  pinnedGithubToolAnnotationsMatch,
} from "../../servers/github-mcp/wrapper/src/catalog/github-mcp";

interface RpcEnvelope {
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

const upstreamUrl = requiredArg(process.argv.slice(2), "url");
const authorization = "Bearer gho_catalog-conformance-placeholder";

await waitUntilReachable(upstreamUrl);

const initialized = await rpcRequest({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-gw-catalog-conformance", version: "1.0.0" },
  },
});
const sessionId = initialized.headers.get("mcp-session-id") ?? undefined;
await decodeRpcResponse(initialized);

const notification = await rpcRequest(
  { jsonrpc: "2.0", method: "notifications/initialized" },
  sessionId,
);
if (!notification.ok) {
  throw new Error(`initialized notification failed (${String(notification.status)})`);
}

const listResponse = await rpcRequest(
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  sessionId,
);
const payload = await decodeRpcResponse(listResponse);
const tools = payload.result?.tools;
if (!Array.isArray(tools)) {
  throw new Error("pinned GitHub MCP tools/list returned no tools array");
}

const actualNames = tools.flatMap((tool) =>
  isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [],
);
const expectedNames = GITHUB_MCP_TOOLS.map((tool) => tool.name);
if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
  throw new Error(
    `pinned GitHub MCP catalog drift: expected ${expectedNames.length} exact tools, received ${actualNames.length}`,
  );
}

for (const tool of tools) {
  if (
    !isRecord(tool) ||
    typeof tool.name !== "string" ||
    !pinnedGithubToolAnnotationsMatch(tool.name, tool.annotations)
  ) {
    const name = isRecord(tool) && typeof tool.name === "string" ? tool.name : "<malformed>";
    throw new Error(`pinned GitHub MCP annotations drifted for ${name}`);
  }
}

console.log(`Pinned GitHub MCP catalog conformance passed: ${String(tools.length)} tools.`);

async function waitUntilReachable(url: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await fetch(url, { headers: { authorization } });
      return;
    } catch {
      await Bun.sleep(500);
    }
  }
  throw new Error("pinned GitHub MCP server did not become reachable");
}

async function rpcRequest(body: unknown, sessionId?: string): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    authorization,
    "content-type": "application/json",
    "mcp-protocol-version": "2025-06-18",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const response = await fetch(upstreamUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`pinned GitHub MCP request failed (${String(response.status)})`);
  }
  return response;
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
  if (!data) throw new Error("pinned GitHub MCP response body was empty");
  const payload = JSON.parse(data) as RpcEnvelope;
  if (payload.error) throw new Error(`pinned GitHub MCP error: ${JSON.stringify(payload.error)}`);
  return payload;
}

function requiredArg(argv: string[], name: string): string {
  const index = argv.indexOf(`--${name}`);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing required arg: --${name}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
