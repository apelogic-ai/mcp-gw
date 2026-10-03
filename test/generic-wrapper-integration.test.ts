import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { stringify } from "yaml";

import { createGenericMainHandler } from "../servers/generic-wrapper/src/main";

const catalog = {
  schemaVersion: "mcp-gateway.generic-catalog/v1",
  catalogId: "modelcontextprotocol-everything@2026.8.31",
  tools: [
    {
      name: "echo",
      description: "Echo a message through the official MCP reference server.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
      annotations: { readOnlyHint: true },
      grants: { actionClass: "read", operation: "reference.echo", scopes: [] },
    },
  ],
};

let referenceServer: Bun.Subprocess<"ignore", "pipe", "pipe">;
let referencePort = 0;
let apiKeyGate: ReturnType<typeof Bun.serve>;
let identityServer: ReturnType<typeof Bun.serve>;
let observedGateHeaders: Headers[] = [];
let hop1Token = "";
let candidateHop1Token = "";
let identityIssuer = "";
let candidateIdentityIssuer = "";

beforeAll(async () => {
  referencePort = await unusedPort();
  referenceServer = Bun.spawn(
    [
      process.execPath,
      "node_modules/@modelcontextprotocol/server-everything/dist/index.js",
      "streamableHttp",
    ],
    {
      env: { ...process.env, PORT: String(referencePort) },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  void new Response(referenceServer.stdout).text();
  void new Response(referenceServer.stderr).text();
  await waitForReferenceServer();

  apiKeyGate = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    async fetch(request) {
      observedGateHeaders.push(new Headers(request.headers));
      if (request.headers.get("x-api-key") !== "fixture-api-key") {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const url = new URL(request.url);
      return fetch(`http://127.0.0.1:${String(referencePort)}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" ? undefined : await request.arrayBuffer(),
      });
    },
  });

  const signing = await generateKeyPair("EdDSA");
  const publicJwk = await exportJWK(signing.publicKey);
  publicJwk.kid = "integration-key";
  identityServer = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    fetch(request) {
      return new URL(request.url).pathname === "/jwks.json"
        ? Response.json({ keys: [publicJwk] })
        : new Response(null, { status: 404 });
    },
  });
  identityIssuer = `http://127.0.0.1:${String(identityServer.port)}`;
  candidateIdentityIssuer = `http://host.docker.internal:${String(identityServer.port)}`;
  hop1Token = await new SignJWT({ email: "developer@example.com" })
    .setProtectedHeader({ alg: "EdDSA", kid: "integration-key" })
    .setIssuer(identityIssuer)
    .setSubject("generic-wrapper-integration")
    .setAudience("mcp-gateway")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signing.privateKey);
  candidateHop1Token = await new SignJWT({ email: "developer@example.com" })
    .setProtectedHeader({ alg: "EdDSA", kid: "integration-key" })
    .setIssuer(candidateIdentityIssuer)
    .setSubject("generic-wrapper-container-integration")
    .setAudience("mcp-gateway")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signing.privateKey);
});

afterAll(async () => {
  await apiKeyGate.stop(true);
  await identityServer.stop(true);
  referenceServer.kill();
  await referenceServer.exited;
});

describe("generic wrapper reference-server integration", () => {
  test("proxies the public Everything reference server without an upstream credential", async () => {
    const result = await exerciseWrapper({
      mode: "none",
      upstreamUrl: `http://127.0.0.1:${String(referencePort)}/mcp`,
    });

    expect(result.listedTools).toEqual(["reference_echo"]);
    expect(result.echoText).toBe("Echo: hello through no credential");
  });

  test("injects an API key without forwarding HOP-1 to the reference server", async () => {
    observedGateHeaders = [];
    const result = await exerciseWrapper({
      mode: "static_secret",
      upstreamUrl: `http://127.0.0.1:${String(apiKeyGate.port)}/mcp`,
    });

    expect(result.listedTools).toEqual(["reference_echo"]);
    expect(result.echoText).toBe("Echo: hello through static secret");
    expect(observedGateHeaders.length).toBeGreaterThan(0);
    for (const headers of observedGateHeaders) {
      expect(headers.get("x-api-key")).toBe("fixture-api-key");
      expect(headers.get("authorization")).toBeNull();
    }
  });

  test("runs the built candidate image with no credential and an API-key credential", async () => {
    const image = process.env.GENERIC_WRAPPER_IMAGE;
    if (!image) return;
    expect(await exerciseCandidateImage(image, "none")).toBe("Echo: candidate none");

    observedGateHeaders = [];
    expect(await exerciseCandidateImage(image, "static_secret")).toBe(
      "Echo: candidate static_secret",
    );
    expect(observedGateHeaders.length).toBeGreaterThan(0);
    for (const headers of observedGateHeaders) {
      expect(headers.get("x-api-key")).toBe("fixture-api-key");
      expect(headers.get("authorization")).toBeNull();
    }
  }, 60_000);
});

async function exerciseCandidateImage(
  image: string,
  mode: "none" | "static_secret",
): Promise<string> {
  const wrapperPort = await unusedPort();
  const directory = await mkdtemp(join(tmpdir(), "mcp-gw-generic-container-"));
  const descriptorPath = join(directory, "descriptor.yaml");
  const catalogPath = join(directory, "catalog.yaml");
  const upstreamUrl =
    mode === "none"
      ? `http://host.docker.internal:${String(referencePort)}/mcp`
      : `http://host.docker.internal:${String(apiKeyGate.port)}/mcp`;
  await Promise.all([
    writeFile(
      descriptorPath,
      stringify({
        schemaVersion: "mcp-gateway.generic-wrapper/v1",
        name: `reference-container-${mode.replace("_", "-")}`,
        toolPrefix: "reference",
        catalogPath: "/config/catalog.yaml",
        lifecycleRoutes: false,
        upstream: { transport: "http", url: upstreamUrl },
        credential:
          mode === "none"
            ? { mode: "none" }
            : { mode: "static_secret", env: "REFERENCE_API_KEY", header: "x-api-key" },
        serverInfo: { name: "generic-reference-wrapper", version: "1.0.0" },
      }),
    ),
    writeFile(catalogPath, stringify(catalog)),
  ]);
  const containerName = `mcp-gw-generic-${randomUUID()}`;
  const hostGatewayArgs =
    process.platform === "linux"
      ? ["--add-host", "host.docker.internal:host-gateway"]
      : [];
  const containerArgs = [
    "docker",
    "run",
    "--rm",
    "--name",
    containerName,
    ...hostGatewayArgs,
    "--publish",
    `127.0.0.1:${String(wrapperPort)}:8080`,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=16m",
    "--volume",
    `${directory}:/config:ro`,
    "--env",
    "PORT=8080",
    "--env",
    "GENERIC_WRAPPER_DESCRIPTOR_PATH=/config/descriptor.yaml",
    "--env",
    `HOP1_ISSUERS_JSON=${issuerProfilesJson(candidateIdentityIssuer)}`,
  ];
  if (mode === "static_secret") {
    containerArgs.push("--env", "REFERENCE_API_KEY=fixture-api-key");
  }
  containerArgs.push(image);
  const container = Bun.spawn(containerArgs, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  void new Response(container.stdout).text();
  void new Response(container.stderr).text();

  try {
    const baseUrl = `http://127.0.0.1:${String(wrapperPort)}`;
    await waitForHealth(baseUrl, container);
    const initialized = await fetch(
      `${baseUrl}/mcp`,
      requestInit(
        "initialize",
        {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "generic-container-integration", version: "1.0.0" },
        },
        1,
        undefined,
        candidateHop1Token,
      ),
    );
    expect(initialized.status).toBe(200);
    const sessionId = initialized.headers.get("mcp-session-id");
    expect(sessionId).toBeString();
    const listed = await fetch(
      `${baseUrl}/mcp`,
      requestInit("tools/list", {}, 2, sessionId ?? undefined, candidateHop1Token),
    );
    const listedBody = (await listed.json()) as {
      result: { tools: { name: string }[] };
    };
    expect(listedBody.result.tools.map((tool) => tool.name)).toEqual(["reference_echo"]);
    const message = `candidate ${mode}`;
    const called = await fetch(
      `${baseUrl}/mcp`,
      requestInit(
        "tools/call",
        { name: "reference_echo", arguments: { message } },
        3,
        sessionId ?? undefined,
        candidateHop1Token,
      ),
    );
    const body = extractSseMessage(await called.text()) as {
      result?: { content?: { type?: string; text?: string }[] };
    };
    return body.result?.content?.find((item) => item.type === "text")?.text ?? "";
  } finally {
    Bun.spawnSync(["docker", "stop", "--timeout", "1", containerName]);
    await container.exited;
    await rm(directory, { recursive: true, force: true });
  }
}

async function exerciseWrapper(options: {
  mode: "none" | "static_secret";
  upstreamUrl: string;
}): Promise<{ listedTools: string[]; echoText: string }> {
  const credential =
    options.mode === "none"
      ? ({ mode: "none" } as const)
      : ({
          mode: "static_secret",
          env: "REFERENCE_API_KEY",
          header: "x-api-key",
        } as const);
  const descriptor = {
    schemaVersion: "mcp-gateway.generic-wrapper/v1",
    name: `reference-${options.mode.replace("_", "-")}`,
    toolPrefix: "reference",
    catalogPath: "",
    lifecycleRoutes: false,
    upstream: { transport: "http", url: options.upstreamUrl },
    credential,
    serverInfo: { name: "generic-reference-wrapper", version: "1.0.0" },
  };
  const directory = await mkdtemp(join(tmpdir(), "mcp-gw-generic-integration-"));
  const descriptorPath = join(directory, "descriptor.yaml");
  const catalogPath = join(directory, "catalog.yaml");
  descriptor.catalogPath = catalogPath;
  await Promise.all([
    writeFile(descriptorPath, stringify(descriptor)),
    writeFile(catalogPath, stringify(catalog)),
  ]);
  const handler = createGenericMainHandler(
    { port: 8080, descriptorPath },
    {
      REFERENCE_API_KEY: "fixture-api-key",
      HOP1_ISSUERS_JSON: JSON.stringify([
        {
          name: "fixture",
          issuer: identityIssuer,
          jwksUrl: `${identityIssuer}/jwks.json`,
          audiences: ["mcp-gateway"],
          allowedAlgorithms: ["EdDSA"],
          emailClaim: "email",
          subjectClaim: "sub",
        },
      ]),
    },
  );

  try {
    const health = await handler(new Request("http://wrapper.example.com/health/ready"));
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("ok");
    const listed = await handler(wrapperRequest("tools/list", {}, 1));
    const listedBody = (await listed.json()) as {
      result: { tools: { name: string }[] };
    };
    const initialized = await handler(
      wrapperRequest(
        "initialize",
        {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "generic-wrapper-integration", version: "1.0.0" },
        },
        2,
      ),
    );
    expect(initialized.status).toBe(200);
    expect(await initialized.json()).toMatchObject({
      result: { protocolVersion: "2025-06-18" },
    });
    const sessionId = initialized.headers.get("mcp-session-id");
    expect(sessionId).toBeString();

    await handler(
      wrapperRequest("notifications/initialized", {}, undefined, sessionId ?? undefined),
    );
    const message = `hello through ${options.mode === "none" ? "no credential" : "static secret"}`;
    const called = await handler(
      wrapperRequest(
        "tools/call",
        { name: "reference_echo", arguments: { message } },
        3,
        sessionId ?? undefined,
      ),
    );
    expect(called.status).toBe(200);
    const callBody = extractSseMessage(await called.text()) as {
      result?: { content?: { type?: string; text?: string }[] };
    };
    return {
      listedTools: listedBody.result.tools.map((tool) => tool.name),
      echoText: callBody.result?.content?.find((item) => item.type === "text")?.text ?? "",
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function issuerProfilesJson(issuer = identityIssuer): string {
  return JSON.stringify([
    {
      name: "fixture",
      issuer,
      jwksUrl: `${issuer}/jwks.json`,
      audiences: ["mcp-gateway"],
      allowedAlgorithms: ["EdDSA"],
      emailClaim: "email",
      subjectClaim: "sub",
    },
  ]);
}

function wrapperRequest(
  method: string,
  params: Record<string, unknown>,
  id: number | undefined,
  sessionId?: string,
): Request {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${hop1Token}`,
    "content-type": "application/json",
    "mcp-protocol-version": "2025-06-18",
  });
  if (sessionId) headers.set("mcp-session-id", sessionId);
  return new Request("http://wrapper.example.com/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }),
  });
}

function requestInit(
  method: string,
  params: Record<string, unknown>,
  id: number | undefined,
  sessionId?: string,
  bearerToken = hop1Token,
): RequestInit {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${bearerToken}`,
    "content-type": "application/json",
    "mcp-protocol-version": "2025-06-18",
  });
  if (sessionId) headers.set("mcp-session-id", sessionId);
  return {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }),
  };
}

function extractSseMessage(body: string): Record<string, unknown> {
  const data = body
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  if (!data) throw new Error(`Reference server returned no SSE data: ${body.slice(0, 200)}`);
  return JSON.parse(data) as Record<string, unknown>;
}

async function unusedPort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) throw new Error("Bun did not allocate a test port");
  return port;
}

async function waitForReferenceServer(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (referenceServer.exitCode !== null) {
      throw new Error(
        `Everything reference server exited with ${String(referenceServer.exitCode)}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${String(referencePort)}/mcp`);
      if (response.status > 0) return;
    } catch {
      // The reference server is still binding its local test port.
    }
    await Bun.sleep(20);
  }
  throw new Error("Everything reference server did not become ready");
}

async function waitForHealth(
  baseUrl: string,
  container: Bun.Subprocess<"ignore", "pipe", "pipe">,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (container.exitCode !== null) {
      throw new Error(`Generic wrapper candidate exited with ${String(container.exitCode)}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health/ready`, {
        signal: AbortSignal.timeout(250),
      });
      if (response.ok) return;
    } catch {
      // The candidate container is still starting.
    }
    await Bun.sleep(50);
  }
  throw new Error("Generic wrapper candidate did not become ready");
}
