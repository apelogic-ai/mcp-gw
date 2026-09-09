#!/usr/bin/env bun

import { createHash } from "node:crypto";

import { decodeJwt } from "jose";

interface Args {
  brokerBaseUrl: string;
  expectedDataTools: string[];
  expectedIssuer: string;
  expectedTools: string[];
  gatewayUrl: string;
  githubWrapperUrl?: string;
  googleFixtureBaseUrl: string;
  googleWrapperUrl?: string;
  invalidTokenDirectory?: string;
  resource: string;
  scope: string;
}

interface RpcEnvelope {
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

const args = parseArgs(process.argv.slice(2));
const redirectUri = "https://client.example.com/oauth/callback";
const verifier = "v".repeat(64);
const challenge = createHash("sha256").update(verifier).digest("base64url");

const metadataUrl = new URL(args.brokerBaseUrl);
metadataUrl.pathname = `/.well-known/oauth-authorization-server${metadataUrl.pathname.replace(/\/$/u, "")}`;
const metadataResponse = await fetch(metadataUrl);
assertStatus(metadataResponse, 200, "authorization-server metadata");
const metadata = (await metadataResponse.json()) as Record<string, unknown>;
if (metadata.issuer !== args.expectedIssuer) {
  throw new Error(`Metadata issuer was not canonical: ${JSON.stringify(metadata)}`);
}
if (metadata.jwks_uri !== `${args.expectedIssuer}/.well-known/jwks.json`) {
  throw new Error(`Metadata JWKS URI was not canonical: ${JSON.stringify(metadata)}`);
}

const registrationResponse = await fetch(`${args.brokerBaseUrl}/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: args.scope,
    client_name: "issuer-normalization-smoke",
  }),
});
assertStatus(registrationResponse, 201, "dynamic client registration");
const registration = (await registrationResponse.json()) as Record<string, unknown>;
const clientId = requiredString(registration, "client_id");

const authorizeUrl = new URL(`${args.brokerBaseUrl}/authorize`);
authorizeUrl.searchParams.set("response_type", "code");
authorizeUrl.searchParams.set("client_id", clientId);
authorizeUrl.searchParams.set("redirect_uri", redirectUri);
authorizeUrl.searchParams.set("resource", args.resource);
authorizeUrl.searchParams.set("scope", args.scope);
authorizeUrl.searchParams.set("code_challenge", challenge);
authorizeUrl.searchParams.set("code_challenge_method", "S256");
authorizeUrl.searchParams.set("state", "issuer-normalization-state");
const authorizeResponse = await fetch(authorizeUrl);
assertStatus(authorizeResponse, 200, "broker authorization");
const consent = await authorizeResponse.text();
const consentMatch = /<a href="([^"]+)">Continue with Google<\/a>/u.exec(consent);
if (!consentMatch?.[1]) {
  throw new Error("Broker consent page did not contain the Google authorization link");
}
const googleAuthorizationUrl = new URL(unescapeHtml(consentMatch[1]));
replaceOrigin(googleAuthorizationUrl, args.googleFixtureBaseUrl);
const googleAuthorization = await fetch(googleAuthorizationUrl, { redirect: "manual" });
assertStatus(googleAuthorization, 302, "fixture Google authorization");
const brokerCallback = new URL(requiredHeader(googleAuthorization, "location"));
replaceOrigin(brokerCallback, args.brokerBaseUrl);
const callbackResponse = await fetch(brokerCallback, { redirect: "manual" });
assertStatus(callbackResponse, 302, "broker Google callback");
const clientCallback = new URL(requiredHeader(callbackResponse, "location"));
if (`${clientCallback.origin}${clientCallback.pathname}` !== redirectUri) {
  throw new Error(`Broker redirected to an unregistered client URI: ${clientCallback}`);
}
if (clientCallback.searchParams.get("state") !== "issuer-normalization-state") {
  throw new Error("Broker did not preserve the client state");
}
const authorizationCode = clientCallback.searchParams.get("code");
if (!authorizationCode) {
  throw new Error("Broker callback did not issue an authorization code");
}

const tokenResponse = await fetch(`${args.brokerBaseUrl}/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code: authorizationCode,
    client_id: clientId,
    redirect_uri: redirectUri,
    resource: args.resource,
    code_verifier: verifier,
  }),
});
assertStatus(tokenResponse, 200, "broker token exchange");
const tokenBody = (await tokenResponse.json()) as Record<string, unknown>;
const accessToken = requiredString(tokenBody, "access_token");
const claims = decodeJwt(accessToken);
if (claims.iss !== args.expectedIssuer || claims.aud !== args.resource) {
  throw new Error("Broker token issuer or audience was not canonical");
}
if (typeof claims.email !== "string" || typeof claims.sub !== "string") {
  throw new Error("Broker token did not contain its fixed email and sub claims");
}
if ("mail" in claims || "oid" in claims) {
  throw new Error("External issuer claim mappings leaked into the broker token");
}

if (args.googleWrapperUrl) {
  await expectPreConsentSurface(args.googleWrapperUrl, accessToken, [
    "google_oauth_status",
    "google_oauth_start",
  ]);
}
if (args.githubWrapperUrl) {
  await expectPreConsentSurface(args.githubWrapperUrl, accessToken, [
    "github_oauth_status",
    "github_oauth_start",
  ]);
}

const initialize = await rpcRequest(
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "issuer-normalization-smoke", version: "1.0.0" },
    },
  },
  accessToken,
);
const sessionId = initialize.headers.get("mcp-session-id");
if (!sessionId) {
  throw new Error("Release-built AgentGateway did not create an MCP session");
}
await decodeRpcResponse(initialize);
const initialized = await rpcRequest(
  { jsonrpc: "2.0", method: "notifications/initialized" },
  accessToken,
  sessionId,
);
if (!initialized.ok) {
  throw new Error(`MCP initialized notification failed (${String(initialized.status)})`);
}
const toolsResponse = await rpcRequest(
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  accessToken,
  sessionId,
);
const toolsPayload = await decodeRpcResponse(toolsResponse);
const tools = toolsPayload.result?.tools;
if (!Array.isArray(tools)) {
  throw new Error(`tools/list did not return tools: ${JSON.stringify(toolsPayload)}`);
}
const toolNames = tools
  .flatMap((tool) => (isRecord(tool) && typeof tool.name === "string" ? [tool.name] : []))
  .sort();
const expectedTools = [...args.expectedTools].sort();
for (const expectedTool of expectedTools) {
  if (!toolNames.includes(expectedTool)) {
    throw new Error(`Pre-consent tools omitted ${expectedTool}; received ${toolNames.join(", ")}`);
  }
}
for (const dataTool of args.expectedDataTools) {
  if (!toolNames.includes(dataTool)) {
    throw new Error(`Stable pre-consent catalog omitted ${dataTool}`);
  }
}

if (args.invalidTokenDirectory) {
  await expectGatewayRejection();
  for (const name of ["wrong-issuer", "wrong-audience", "invalid-signature", "expired"]) {
    const token = await Bun.file(`${args.invalidTokenDirectory}/${name}.jwt`).text();
    await expectGatewayRejection(token.trim());
  }
}

console.log("Trailing-slash broker DCR journey passed through release-built AgentGateway.");

async function expectGatewayRejection(accessToken?: string): Promise<void> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": "2025-06-18",
  };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const response = await fetch(args.gatewayUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "negative-initialize",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "broker-negative-smoke", version: "1.0.0" },
      },
    }),
  });
  if (response.status !== 401) {
    throw new Error(`Invalid MCP bearer was not rejected (${String(response.status)})`);
  }
}

async function expectPreConsentSurface(
  url: string,
  accessToken: string,
  expectedTools: string[],
): Promise<void> {
  const initialize = await rpcRequestTo(
    url,
    {
      jsonrpc: "2.0",
      id: "direct-initialize",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "broker-wrapper-regression", version: "1.0.0" },
      },
    },
    accessToken,
  );
  await decodeRpcResponse(initialize);

  const toolsResponse = await rpcRequestTo(
    url,
    { jsonrpc: "2.0", id: "direct-tools", method: "tools/list", params: {} },
    accessToken,
  );
  const toolsPayload = await decodeRpcResponse(toolsResponse);
  const tools = toolsPayload.result?.tools;
  if (!Array.isArray(tools)) {
    throw new Error(
      `Direct wrapper tools/list did not return tools: ${JSON.stringify(toolsPayload)}`,
    );
  }
  const toolNames = tools.flatMap((tool) =>
    isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [],
  );
  for (const expectedTool of expectedTools) {
    if (!toolNames.includes(expectedTool)) {
      throw new Error(
        `Direct wrapper pre-consent tools omitted ${expectedTool}; received ${toolNames.join(", ")}`,
      );
    }
  }
  const isGoogle = expectedTools.includes("google_oauth_start");
  const dataTool = isGoogle ? "google_drive_files_list" : "get_file_contents";
  if (!toolNames.includes(dataTool)) {
    throw new Error(`Direct wrapper stable catalog omitted ${dataTool}`);
  }
  const callPayload = await decodeRpcResponse(
    await rpcRequestTo(
      url,
      {
        jsonrpc: "2.0",
        id: "direct-pre-consent-call",
        method: "tools/call",
        params: { name: dataTool, arguments: {} },
      },
      accessToken,
    ),
  );
  if (
    callPayload.result?.isError !== true ||
    !isRecord(callPayload.result.structuredContent) ||
    callPayload.result.structuredContent.error !== "provider_oauth_required"
  ) {
    throw new Error(`Pre-consent ${dataTool} did not fail closed: ${JSON.stringify(callPayload)}`);
  }
}

async function rpcRequest(
  body: unknown,
  accessToken: string,
  sessionId?: string,
): Promise<Response> {
  return rpcRequestTo(args.gatewayUrl, body, accessToken, sessionId);
}

async function rpcRequestTo(
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
  const response = await fetch(url, {
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

function assertStatus(response: Response, expected: number, label: string): void {
  if (response.status !== expected) {
    throw new Error(
      `${label} returned HTTP ${String(response.status)}; expected ${String(expected)}`,
    );
  }
}

function replaceOrigin(url: URL, replacement: string): void {
  const origin = new URL(replacement);
  url.protocol = origin.protocol;
  url.host = origin.host;
}

function requiredHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  if (!value) throw new Error(`Response did not contain ${name}`);
  return value;
}

function requiredString(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Response did not contain ${name}`);
  }
  return value;
}

function unescapeHtml(value: string): string {
  return value
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'");
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
    brokerBaseUrl: required(values, "broker-base-url"),
    expectedDataTools: required(values, "expected-data-tools").split(",").filter(Boolean),
    expectedIssuer: required(values, "expected-issuer"),
    expectedTools: required(values, "expected-tools").split(",").filter(Boolean),
    gatewayUrl: required(values, "gateway-url"),
    githubWrapperUrl: values.get("github-wrapper-url"),
    googleFixtureBaseUrl: required(values, "google-fixture-base-url"),
    googleWrapperUrl: values.get("google-wrapper-url"),
    invalidTokenDirectory: values.get("invalid-token-directory"),
    resource: required(values, "resource"),
    scope: values.get("scope") ?? "openid email",
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
