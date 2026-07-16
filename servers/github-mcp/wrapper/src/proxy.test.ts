import { describe, expect, test } from "bun:test";

import type { Hop1Identity } from "../../../../shared/identity/hop1";
import { createGithubMcpProxyHandler } from "./proxy";

describe("GitHub MCP proxy wrapper", () => {
  const identity: Hop1Identity = {
    profile: "test",
    issuer: "https://issuer.example.com",
    subject: "user-123",
    email: "user@example.com",
    claims: {},
  };

  test("rejects requests without a HOP-1 bearer token", async () => {
    const handler = createGithubMcpProxyHandler({
      upstreamUrl: "http://github-mcp:8082/mcp",
      authenticate: async () => identity,
      resolveGithubToken: async () => "gho_user_token",
      fetch: async () => new Response("{}"),
    });

    const response = await handler(new Request("http://wrapper/mcp", { method: "POST" }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32001,
        message: "Unauthorized: bearer token is required",
      },
    });
  });

  test("authenticates HOP-1, resolves GitHub token, and proxies MCP requests upstream", async () => {
    const seenRequests: Request[] = [];
    const handler = createGithubMcpProxyHandler({
      upstreamUrl: "http://github-mcp:8082/mcp",
      authenticate: async (token) => {
        expect(token).toBe("hop1-token");
        return identity;
      },
      resolveGithubToken: async (requestIdentity) => {
        expect(requestIdentity).toBe(identity);
        return "gho_user_token";
      },
      fetch: async (request) => {
        seenRequests.push(request);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "mcp-session-id": "session-1",
          },
        });
      },
    });

    const response = await handler(
      new Request("http://wrapper/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer hop1-token",
          "content-type": "application/json",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBe("session-1");
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    expect(seenRequests).toHaveLength(1);

    const upstreamRequest = seenRequests[0];
    expect(upstreamRequest).toBeDefined();
    expect(upstreamRequest?.url).toBe("http://github-mcp:8082/mcp");
    expect(upstreamRequest?.method).toBe("POST");
    expect(upstreamRequest?.headers.get("authorization")).toBe("Bearer gho_user_token");
    expect(upstreamRequest?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
    expect(upstreamRequest?.headers.get("content-type")).toBe("application/json");
    expect(await upstreamRequest?.text()).toBe(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    );
  });

  test("surfaces missing GitHub credentials as an MCP unauthorized error", async () => {
    const handler = createGithubMcpProxyHandler({
      upstreamUrl: "http://github-mcp:8082/mcp",
      authenticate: async () => identity,
      resolveGithubToken: async () => undefined,
      fetch: async () => new Response("{}"),
    });

    const response = await handler(
      new Request("http://wrapper/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer hop1-token",
        },
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32001,
        message: "Unauthorized: GitHub account is not connected",
      },
    });
  });

  test("preserves upstream MCP error responses", async () => {
    const handler = createGithubMcpProxyHandler({
      upstreamUrl: "http://github-mcp:8082/mcp",
      authenticate: async () => identity,
      resolveGithubToken: async () => "gho_user_token",
      fetch: async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 7,
            error: { code: -32601, message: "Method not found" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    const response = await handler(
      new Request("http://wrapper/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer hop1-token",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "unknown" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32601, message: "Method not found" },
    });
  });
});
