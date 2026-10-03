import { describe, expect, test } from "bun:test";

import { createHttpUpstreamTransport, createStdioUpstreamTransport } from "./transport";

describe("generic wrapper HTTP transport", () => {
  test("replaces caller authorization and translates wrapper session IDs", async () => {
    const requests: Request[] = [];
    const transport = createHttpUpstreamTransport(
      { transport: "http", url: "https://mcp.example.com/mcp" },
      {
        fetch: (input, init) => {
          requests.push(
            input instanceof Request
              ? new Request(input, init)
              : new Request(input.toString(), init),
          );
          return Promise.resolve(new Response("ok"));
        },
      },
    );
    await transport.send({
      incomingRequest: request("initialize", 1, "client-session"),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      credential: {
        header: "authorization",
        value: "Bearer provider-token",
        rawValue: "provider-token",
      },
      principalKey: "issuer\nsubject",
    });

    expect(requests[0]?.headers.get("authorization")).toBe("Bearer provider-token");
    expect(requests[0]?.headers.get("mcp-session-id")).toBeNull();
    expect(requests[0]?.headers.get("authorization")).not.toContain("hop1-token");
  });

  test("lazily initializes a stateful upstream behind a wrapper-owned session", async () => {
    const requests: Array<{ headers: Record<string, string>; method: string; body: object }> = [];
    const transport = createHttpUpstreamTransport(
      { transport: "http", url: "https://mcp.example.com/mcp" },
      {
        serverInfo: { name: "reference-wrapper", version: "1.0.0" },
        async fetch(input, init) {
          const observed = new Request(input.toString(), init);
          const body = observed.method === "GET" ? {} : ((await observed.json()) as object);
          requests.push({
            headers: Object.fromEntries(observed.headers.entries()),
            method: observed.method,
            body,
          });
          const method = "method" in body ? body.method : undefined;
          if (method === "initialize") {
            return Response.json(
              { jsonrpc: "2.0", id: "init", result: { protocolVersion: "2025-06-18" } },
              { headers: { "mcp-session-id": "upstream-session" } },
            );
          }
          if (method === "notifications/initialized") return new Response(null, { status: 202 });
          return Response.json({ jsonrpc: "2.0", id: 2, result: { content: [] } });
        },
      },
    );
    const response = await transport.send({
      incomingRequest: request("tools/call", 2, "wrapper-session"),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "query", arguments: {} },
      }),
      credential: {
        header: "authorization",
        value: "Bearer provider-token",
        rawValue: "provider-token",
      },
      principalKey: "issuer\nsubject",
    });

    expect(requests).toHaveLength(3);
    expect(requests[0]?.headers["mcp-session-id"]).toBeUndefined();
    expect(requests[1]?.headers["mcp-session-id"]).toBe("upstream-session");
    expect(requests[2]?.headers["mcp-session-id"]).toBe("upstream-session");
    expect(requests[2]?.headers.authorization).toBe("Bearer provider-token");
    expect(response.headers.get("mcp-session-id")).toBe("wrapper-session");
  });

  test("bounds wrapper-owned HTTP sessions", async () => {
    let now = 0;
    const transport = createHttpUpstreamTransport(
      { transport: "http", url: "https://mcp.example.com/mcp" },
      {
        maxSessions: 1,
        sessionIdleTtlMs: 10,
        now: () => now,
        fetch: () => Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, result: {} })),
      },
    );
    const first = {
      incomingRequest: request("initialize", 1, "session-one"),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      credential: null,
      principalKey: "issuer\nsubject",
    };
    await transport.send(first);

    await expect(
      transport.send({
        ...first,
        incomingRequest: request("initialize", 2, "session-two"),
      }),
    ).rejects.toThrow("session limit");
    now = 10;
    await expect(
      transport.send({
        ...first,
        incomingRequest: request("initialize", 2, "session-two"),
      }),
    ).resolves.toBeInstanceOf(Response);
    await transport.close?.({
      ...first,
      incomingRequest: new Request("http://wrapper.test/mcp", {
        method: "DELETE",
        headers: { "mcp-session-id": "session-two" },
      }),
    });
  });
});

describe("generic wrapper stdio transport", () => {
  test("isolates a persistent child session by principal and injects only provider credentials", async () => {
    const transport = createStdioUpstreamTransport({
      transport: "stdio",
      command: process.execPath,
      args: ["servers/generic-wrapper/src/fixtures/stdio-server.ts"],
      credentialEnv: "UPSTREAM_TOKEN",
      timeoutMs: 5_000,
    });
    const credential = {
      header: "authorization",
      value: "Bearer provider-token",
      rawValue: "provider-token",
    };
    const initialized = await transport.send({
      incomingRequest: request("initialize", 1),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      credential,
      principalKey: "issuer\nsubject-a",
    });
    const sessionId = initialized.headers.get("mcp-session-id");
    expect(sessionId).toBeString();
    expect(await initialized.json()).toMatchObject({
      result: { serverInfo: { name: "stdio-fixture" } },
    });

    const called = await transport.send({
      incomingRequest: request("tools/call", 2, sessionId ?? undefined),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "query", arguments: {} },
      }),
      credential,
      principalKey: "issuer\nsubject-a",
    });
    expect(await called.json()).toMatchObject({
      result: {
        content: [
          {
            text: JSON.stringify({ name: "query", credentialPresent: true }),
          },
        ],
      },
    });

    await expect(
      transport.send({
        incomingRequest: request("tools/call", 3, sessionId ?? undefined),
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call" }),
        credential,
        principalKey: "issuer\nsubject-b",
      }),
    ).rejects.toThrow("session does not belong");
    await transport.close?.({
      incomingRequest: new Request("http://wrapper.test/mcp", {
        method: "DELETE",
        headers: { "mcp-session-id": sessionId ?? "" },
      }),
      body: "",
      credential,
      principalKey: "issuer\nsubject-a",
    });
  });

  test("lazily initializes a stdio process for a wrapper-owned session", async () => {
    const transport = createStdioUpstreamTransport({
      transport: "stdio",
      command: process.execPath,
      args: ["servers/generic-wrapper/src/fixtures/stdio-server.ts"],
      timeoutMs: 5_000,
    });
    const incomingRequest = request("tools/call", 4, "wrapper-session");
    const called = await transport.send({
      incomingRequest,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "query", arguments: {} },
      }),
      credential: null,
      principalKey: "issuer\nsubject-a",
    });

    expect(called.headers.get("mcp-session-id")).toBe("wrapper-session");
    expect(await called.json()).toMatchObject({
      result: { content: [{ text: JSON.stringify({ name: "query", credentialPresent: false }) }] },
    });
    await transport.close?.({
      incomingRequest: new Request("http://wrapper.test/mcp", {
        method: "DELETE",
        headers: { "mcp-session-id": "wrapper-session" },
      }),
      body: "",
      credential: null,
      principalKey: "issuer\nsubject-a",
    });
  });

  test("bounds persistent stdio child sessions", async () => {
    let now = 0;
    const transport = createStdioUpstreamTransport(
      {
        transport: "stdio",
        command: process.execPath,
        args: ["servers/generic-wrapper/src/fixtures/stdio-server.ts"],
        timeoutMs: 5_000,
      },
      process.env,
      undefined,
      { maxSessions: 1, sessionIdleTtlMs: 10, now: () => now },
    );
    const firstRequest = {
      incomingRequest: request("initialize", 1, "stdio-one"),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      credential: null,
      principalKey: "issuer\nsubject",
    };
    await transport.send(firstRequest);
    await expect(
      transport.send({
        ...firstRequest,
        incomingRequest: request("initialize", 2, "stdio-two"),
      }),
    ).rejects.toThrow("session limit");
    now = 10;
    await expect(
      transport.send({
        ...firstRequest,
        incomingRequest: request("initialize", 2, "stdio-two"),
      }),
    ).resolves.toBeInstanceOf(Response);
    await transport.close?.({
      ...firstRequest,
      incomingRequest: new Request("http://wrapper.test/mcp", {
        method: "DELETE",
        headers: { "mcp-session-id": "stdio-two" },
      }),
    });
  });
});

function request(method: string, id: number, sessionId?: string): Request {
  const headers = new Headers({
    authorization: "Bearer hop1-token",
    "content-type": "application/json",
  });
  if (sessionId) headers.set("mcp-session-id", sessionId);
  return new Request("http://wrapper.test/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method }),
  });
}
