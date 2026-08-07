#!/usr/bin/env bun

interface Args {
  gatewayUrl: string;
  tokenFile: string;
  googleCallbackUrl: string;
  githubCallbackUrl: string;
}

interface RpcEnvelope {
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

const args = parseArgs(process.argv.slice(2));
const token = (await Bun.file(args.tokenFile).text()).trim();

const initial = await createSession();
const initialTools = await listTools(initial.sessionId);
assertHasTools(initialTools, ["google_oauth_status", "google_oauth_start"]);
assertHasTools(initialTools, ["github_oauth_status", "github_oauth_start"]);
assertLacksTools(initialTools, ["google_drive_files_list", "github_list_pull_requests"]);

const googleAuthorizationUrl = await startOAuth(initial.sessionId, "google_oauth_start");
const githubAuthorizationUrl = await startOAuth(initial.sessionId, "github_oauth_start");
await completeOAuth(args.googleCallbackUrl, googleAuthorizationUrl);
await completeOAuth(args.githubCallbackUrl, githubAuthorizationUrl);

const connected = await createSession();
const connectedTools = await listTools(connected.sessionId);
assertHasTools(connectedTools, ["google_drive_files_list", "github_list_pull_requests"]);

const googleResult = await callTool(connected.sessionId, "google_drive_files_list", {});
const githubResult = await callTool(connected.sessionId, "github_list_pull_requests", {});
assertResultContains(googleResult, "Fixture document");
assertResultContains(githubResult, "Fixture pull request");
assertNoProviderCredentials([googleResult, githubResult]);

console.log("Full provider bundle integration passed.");

async function createSession(): Promise<{ sessionId: string }> {
  const response = await rpcRequest(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "full-bundle-fixture", version: "1.0.0" },
      },
    },
    undefined,
  );
  const sessionId = response.headers.get("mcp-session-id");
  if (!sessionId) {
    throw new Error("MCP initialize did not return mcp-session-id");
  }
  await decodeRpcResponse(response);
  return { sessionId };
}

async function listTools(sessionId: string): Promise<string[]> {
  const response = await rpcRequest(
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    sessionId,
  );
  const payload = await decodeRpcResponse(response);
  const tools = payload.result?.tools;
  if (!Array.isArray(tools)) {
    throw new Error(`tools/list did not return tools: ${JSON.stringify(payload)}`);
  }
  return tools.flatMap((tool) =>
    isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [],
  );
}

async function startOAuth(sessionId: string, toolName: string): Promise<string> {
  const payload = await callTool(sessionId, toolName, {});
  const content = payload.result?.content;
  if (!Array.isArray(content)) {
    throw new Error(`${toolName} returned no content`);
  }
  const text = content.find(
    (item) => isRecord(item) && item.type === "text" && typeof item.text === "string",
  );
  if (!isRecord(text) || typeof text.text !== "string") {
    throw new Error(`${toolName} returned no text result`);
  }
  const result = JSON.parse(text.text) as { authorizationUrl?: unknown };
  if (typeof result.authorizationUrl !== "string") {
    throw new Error(`${toolName} returned no authorizationUrl`);
  }
  return result.authorizationUrl;
}

async function completeOAuth(callbackBase: string, authorizationUrl: string): Promise<void> {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error(`Authorization URL has no state: ${authorizationUrl}`);
  }
  const callback = new URL(callbackBase);
  callback.searchParams.set("code", "fixture-code");
  callback.searchParams.set("state", state);
  const response = await fetch(callback, { redirect: "manual" });
  if (!response.ok) {
    throw new Error(`OAuth callback failed (${String(response.status)}): ${await response.text()}`);
  }
}

async function callTool(
  sessionId: string,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<RpcEnvelope> {
  return decodeRpcResponse(
    await rpcRequest(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name, arguments: arguments_ },
      },
      sessionId,
    ),
  );
}

async function rpcRequest(body: unknown, sessionId: string | undefined): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "mcp-protocol-version": "2025-06-18",
  };
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }
  const response = await fetch(args.gatewayUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`MCP request failed (${String(response.status)}): ${await response.text()}`);
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
  if (!data) {
    throw new Error("MCP response body was empty");
  }
  const payload = JSON.parse(data) as RpcEnvelope;
  if (payload.error) {
    throw new Error(`MCP error: ${JSON.stringify(payload.error)}`);
  }
  return payload;
}

function assertHasTools(actual: string[], expected: string[]): void {
  for (const tool of expected) {
    if (!actual.includes(tool)) {
      throw new Error(`Expected tool ${tool}; received ${actual.join(", ")}`);
    }
  }
}

function assertLacksTools(actual: string[], unexpected: string[]): void {
  for (const tool of unexpected) {
    if (actual.includes(tool)) {
      throw new Error(`Tool ${tool} was exposed before provider consent`);
    }
  }
}

function assertResultContains(payload: RpcEnvelope, expected: string): void {
  if (!JSON.stringify(payload).includes(expected)) {
    throw new Error(`Tool result did not contain ${expected}: ${JSON.stringify(payload)}`);
  }
}

function assertNoProviderCredentials(payloads: RpcEnvelope[]): void {
  const serialized = JSON.stringify(payloads);
  for (const credential of [
    "fixture-google-provider-token",
    "fixture-google-refresh-token",
    "fixture-github-provider-token",
  ]) {
    if (serialized.includes(credential)) {
      throw new Error("Provider credential appeared in an MCP response");
    }
  }
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
    googleCallbackUrl: required(values, "google-callback-url"),
    githubCallbackUrl: required(values, "github-callback-url"),
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
