#!/usr/bin/env bun

interface Args {
  gatewayUrl: string;
  githubWrapperUrl: string;
  googleWrapperUrl: string;
  tokenFile: string;
}

interface RpcEnvelope {
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

const args = parseArgs(process.argv.slice(2));
const token = await Bun.file(args.tokenFile).text();
const googleTools = ["google_oauth_status", "google_oauth_start"];
const githubTools = ["github_oauth_status", "github_oauth_start"];

await expectSurface(args.googleWrapperUrl, token, googleTools, "Google wrapper");
await expectSurface(args.githubWrapperUrl, token, githubTools, "GitHub wrapper");
await expectSurface(
  args.gatewayUrl,
  token,
  [
    "google_google_oauth_start",
    "google_google_oauth_status",
    "github_github_oauth_start",
    "github_github_oauth_status",
  ],
  "AgentGateway aggregate",
  true,
);

for (const invalid of ["wrong-issuer", "wrong-audience", "invalid-signature", "expired"]) {
  const invalidToken = await Bun.file(`${args.tokenFile}.${invalid}`).text();
  for (const [label, url] of [
    ["Google wrapper", args.googleWrapperUrl],
    ["GitHub wrapper", args.githubWrapperUrl],
    ["AgentGateway", args.gatewayUrl],
  ] as const) {
    const response = await initialize(url, invalidToken);
    if (response.status !== 401) {
      throw new Error(`${label} accepted ${invalid} token with HTTP ${String(response.status)}`);
    }
  }
}

console.log(
  "Broker-disabled external issuer journey passed through both wrappers and AgentGateway.",
);

async function expectSurface(
  url: string,
  accessToken: string,
  expectedTools: string[],
  label: string,
  sessionRequired = false,
): Promise<void> {
  const initialized = await initialize(url, accessToken);
  if (!initialized.ok) {
    throw new Error(
      `${label} initialize failed (${String(initialized.status)}): ${await initialized.text()}`,
    );
  }
  await decodeRpcResponse(initialized.clone());
  const sessionId = initialized.headers.get("mcp-session-id") ?? undefined;
  if (sessionRequired && !sessionId) {
    throw new Error(`${label} did not create an MCP session`);
  }
  if (sessionId) {
    const notification = await rpcRequest(
      url,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      accessToken,
      sessionId,
    );
    if (!notification.ok) {
      throw new Error(`${label} initialized notification failed (${String(notification.status)})`);
    }
  }
  const response = await rpcRequest(
    url,
    { jsonrpc: "2.0", id: "tools", method: "tools/list", params: {} },
    accessToken,
    sessionId,
  );
  if (!response.ok) {
    throw new Error(
      `${label} tools/list failed (${String(response.status)}): ${await response.text()}`,
    );
  }
  const payload = await decodeRpcResponse(response);
  const tools = payload.result?.tools;
  if (!Array.isArray(tools)) {
    throw new Error(`${label} tools/list did not return tools: ${JSON.stringify(payload)}`);
  }
  const actual = tools
    .flatMap((tool) => (isRecord(tool) && typeof tool.name === "string" ? [tool.name] : []))
    .sort();
  const expected = [...expectedTools].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} tools differed: expected ${expected.join(", ")}; got ${actual.join(", ")}`,
    );
  }
}

function initialize(url: string, accessToken: string): Promise<Response> {
  return rpcRequest(
    url,
    {
      jsonrpc: "2.0",
      id: "initialize",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "external-issuer-regression", version: "1.0.0" },
      },
    },
    accessToken,
  );
}

function rpcRequest(
  url: string,
  body: unknown,
  accessToken: string,
  sessionId?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    "mcp-protocol-version": "2025-06-18",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
}

async function decodeRpcResponse(response: Response): Promise<RpcEnvelope> {
  const body = await response.text();
  const data = response.headers.get("content-type")?.includes("text/event-stream")
    ? body
        .split(/\r?\n/u)
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim()
    : body;
  if (!data) throw new Error("MCP response body was empty");
  const payload = JSON.parse(data) as RpcEnvelope;
  if (payload.error) throw new Error(`MCP error: ${JSON.stringify(payload.error)}`);
  return payload;
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
    googleWrapperUrl: required(values, "google-wrapper-url"),
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
