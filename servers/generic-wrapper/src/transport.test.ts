import { describe, expect, spyOn, test } from "bun:test";

import { createHttpUpstreamTransport, createStdioUpstreamTransport } from "./transport";

interface SessionAwareTransport {
  issueSession(session: { id: string; principalKey: string }): void;
  assertSession(sessionId: string, principalKey: string): void;
}

function sessions(transport: unknown): SessionAwareTransport {
  return transport as SessionAwareTransport;
}

describe("generic wrapper HTTP transport", () => {
  test("preserves fixed upstream query parameters on every MCP request", async () => {
    const urls: string[] = [];
    const transport = createHttpUpstreamTransport(
      { transport: "http", url: "https://mcp.example.com/v2/mcp?tools=all" },
      {
        fetch: (input, init) => {
          const request =
            input instanceof Request
              ? new Request(input, init)
              : new Request(input.toString(), init);
          urls.push(request.url);
          return Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, result: {} }));
        },
      },
    );
    sessions(transport).issueSession({ id: "client-session", principalKey: "issuer\nsubject" });
    await transport.send({
      incomingRequest: request("initialize", 1, "client-session"),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      credential: null,
      principalKey: "issuer\nsubject",
    });

    expect(urls).toEqual(["https://mcp.example.com/v2/mcp?tools=all"]);
  });

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
    sessions(transport).issueSession({ id: "client-session", principalKey: "issuer\nsubject" });
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
    const requests: { headers: Record<string, string>; method: string; body: object }[] = [];
    const transport = createHttpUpstreamTransport(
      { transport: "http", url: "https://mcp.example.com/mcp" },
      {
        serverInfo: { name: "reference-wrapper", version: "1.0.0" },
        async fetch(input, init) {
          const observed =
            input instanceof Request
              ? new Request(input, init)
              : new Request(input instanceof URL ? input.href : input, init);
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
    sessions(transport).issueSession({ id: "wrapper-session", principalKey: "issuer\nsubject" });
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

  test("evicts the same principal's least-recently-used idle HTTP session", async () => {
    let now = 0;
    const info = spyOn(console, "info").mockImplementation(() => undefined);
    const transport = createHttpUpstreamTransport(
      { transport: "http", url: "https://mcp.example.com/mcp" },
      {
        maxSessions: 3,
        maxSessionsPerPrincipal: 2,
        sessionIdleTtlMs: 10,
        reapIntervalMs: 5,
        now: () => now,
        fetch: () => Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, result: {} })),
      },
    );
    sessions(transport).issueSession({ id: "principal-old", principalKey: "issuer\nsubject" });
    now = 1;
    sessions(transport).issueSession({ id: "principal-lru", principalKey: "issuer\nsubject" });
    now = 2;
    sessions(transport).issueSession({ id: "other", principalKey: "issuer\nother" });
    now = 3;
    sessions(transport).assertSession("principal-old", "issuer\nsubject");
    now = 4;

    expect(() =>
      sessions(transport).issueSession({ id: "principal-new", principalKey: "issuer\nsubject" }),
    ).not.toThrow();
    expect(() => sessions(transport).assertSession("principal-lru", "issuer\nsubject")).toThrow(
      "unknown or expired",
    );
    expect(() =>
      sessions(transport).assertSession("principal-old", "issuer\nsubject"),
    ).not.toThrow();
    expect(() => sessions(transport).assertSession("other", "issuer\nother")).not.toThrow();
    expect(info).toHaveBeenCalledWith(
      "generic_mcp_session_evicted reason=per_principal_cap sessions_total=3 sessions_principal=2",
    );
    expect(String(info.mock.calls[0]?.[0])).not.toContain("subject");
    expect(String(info.mock.calls[0]?.[0])).not.toContain("principal-lru");
    now = 14;
    await Bun.sleep(20);
    expect(() => sessions(transport).assertSession("principal-new", "issuer\nsubject")).toThrow(
      "unknown or expired",
    );
    info.mockRestore();
  });

  test("refuses at the global HTTP session cap without evicting another principal", () => {
    const transport = createHttpUpstreamTransport(
      { transport: "http", url: "https://mcp.example.com/mcp" },
      { maxSessions: 2, maxSessionsPerPrincipal: 2 },
    );
    sessions(transport).issueSession({ id: "first", principalKey: "issuer\nfirst" });
    sessions(transport).issueSession({ id: "second", principalKey: "issuer\nsecond" });

    expect(() =>
      sessions(transport).issueSession({ id: "third", principalKey: "issuer\nthird" }),
    ).toThrow("global session limit");
    expect(() => sessions(transport).assertSession("first", "issuer\nfirst")).not.toThrow();
    expect(() => sessions(transport).assertSession("second", "issuer\nsecond")).not.toThrow();
  });

  test("refuses to evict a busy same-principal HTTP session", async () => {
    let releaseFetch!: () => void;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const pendingFetch = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const transport = createHttpUpstreamTransport(
      { transport: "http", url: "https://mcp.example.com/mcp" },
      {
        maxSessions: 1,
        maxSessionsPerPrincipal: 1,
        fetch: async () => {
          markFetchStarted();
          await pendingFetch;
          return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
        },
      },
    );
    sessions(transport).issueSession({ id: "busy", principalKey: "issuer\nsubject" });
    const inFlight = transport.send({
      incomingRequest: request("initialize", 1, "busy"),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      credential: null,
      principalKey: "issuer\nsubject",
    });
    await fetchStarted;

    expect(() =>
      sessions(transport).issueSession({ id: "replacement", principalKey: "issuer\nsubject" }),
    ).toThrow("global session limit");
    expect(() => sessions(transport).assertSession("busy", "issuer\nsubject")).not.toThrow();
    releaseFetch();
    await inFlight;
  });

  test("rejects missing, unissued, and cross-principal HTTP sessions before upstream access", () => {
    let fetchCalls = 0;
    const transport = createHttpUpstreamTransport(
      { transport: "http", url: "https://mcp.example.com/mcp" },
      {
        fetch: () => {
          fetchCalls += 1;
          return Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, result: {} }));
        },
      },
    );
    const base = {
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
      credential: null,
      principalKey: "issuer\nsubject",
    };

    expect(transport.send({ ...base, incomingRequest: request("tools/call", 1) })).rejects.toThrow(
      "session ID is required",
    );
    expect(
      transport.send({ ...base, incomingRequest: request("tools/call", 1, "forged") }),
    ).rejects.toThrow("unknown or expired");
    sessions(transport).issueSession({ id: "issued", principalKey: "issuer\nsubject" });
    expect(
      transport.send({
        ...base,
        principalKey: "issuer\nother",
        incomingRequest: request("tools/call", 1, "issued"),
      }),
    ).rejects.toThrow("does not belong");
    expect(fetchCalls).toBe(0);
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
    sessions(transport).issueSession({ id: "stdio-issued", principalKey: "issuer\nsubject-a" });
    const initialized = await transport.send({
      incomingRequest: request("initialize", 1, "stdio-issued"),
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

    expect(
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

  test("lazily initializes a stdio process for an issued wrapper-owned session", async () => {
    const transport = createStdioUpstreamTransport({
      transport: "stdio",
      command: process.execPath,
      args: ["servers/generic-wrapper/src/fixtures/stdio-server.ts"],
      timeoutMs: 5_000,
    });
    sessions(transport).issueSession({ id: "wrapper-session", principalKey: "issuer\nsubject-a" });
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

  test("evicts the same principal's idle stdio session and terminates its child", async () => {
    let now = 0;
    const info = spyOn(console, "info").mockImplementation(() => undefined);
    const transport = createStdioUpstreamTransport(
      {
        transport: "stdio",
        command: process.execPath,
        args: ["servers/generic-wrapper/src/fixtures/stdio-server.ts"],
        timeoutMs: 5_000,
      },
      process.env,
      undefined,
      {
        maxSessions: 1,
        maxSessionsPerPrincipal: 1,
        sessionIdleTtlMs: 10,
        reapIntervalMs: 5,
        now: () => now,
      },
    );
    const firstRequest = {
      incomingRequest: request("initialize", 1, "stdio-one"),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      credential: null,
      principalKey: "issuer\nsubject",
    };
    sessions(transport).issueSession({ id: "stdio-one", principalKey: "issuer\nsubject" });
    const initialized = await transport.send(firstRequest);
    const childPid = ((await initialized.json()) as { result: { serverInfo: { pid: number } } })
      .result.serverInfo.pid;
    expect(process.kill(childPid, 0)).toBe(true);
    now = 1;

    expect(() =>
      sessions(transport).issueSession({ id: "stdio-two", principalKey: "issuer\nsubject" }),
    ).not.toThrow();
    expect(() => sessions(transport).assertSession("stdio-one", "issuer\nsubject")).toThrow(
      "unknown or expired",
    );
    expect(() => sessions(transport).assertSession("stdio-two", "issuer\nsubject")).not.toThrow();
    await waitForProcessExit(childPid);
    expect(info).toHaveBeenCalledWith(
      "generic_mcp_session_evicted reason=per_principal_cap sessions_total=1 sessions_principal=1",
    );
    now = 11;
    await Bun.sleep(20);
    expect(() => sessions(transport).assertSession("stdio-two", "issuer\nsubject")).toThrow(
      "unknown or expired",
    );
    info.mockRestore();
  });

  test("rejects missing and unissued stdio sessions without spawning a child", () => {
    const transport = createStdioUpstreamTransport({
      transport: "stdio",
      command: process.execPath,
      args: ["servers/generic-wrapper/src/fixtures/stdio-server.ts"],
      timeoutMs: 5_000,
    });
    const base = {
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
      credential: null,
      principalKey: "issuer\nsubject",
    };

    expect(transport.send({ ...base, incomingRequest: request("tools/call", 1) })).rejects.toThrow(
      "session ID is required",
    );
    expect(
      transport.send({ ...base, incomingRequest: request("tools/call", 1, "forged") }),
    ).rejects.toThrow("unknown or expired");
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

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`fixture process ${String(pid)} did not exit`);
}
