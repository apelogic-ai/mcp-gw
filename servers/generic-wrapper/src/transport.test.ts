import { describe, expect, test } from "bun:test";

import { createHttpUpstreamTransport, createStdioUpstreamTransport } from "./transport";

describe("generic wrapper HTTP transport", () => {
  test("replaces caller authorization and preserves MCP session headers", async () => {
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
    expect(requests[0]?.headers.get("mcp-session-id")).toBe("client-session");
    expect(requests[0]?.headers.get("authorization")).not.toContain("hop1-token");
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
    await transport.close?.(sessionId ?? undefined, "issuer\nsubject-a");
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
