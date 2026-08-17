import { describe, expect, test } from "bun:test";

import { InMemoryAuditSink } from "../../../../shared/audit/audit";
import type { Hop1Identity } from "../../../../shared/identity/hop1";
import { GitHubOAuthError } from "../../../../shared/oauth/github";
import type { ToolPolicy, ToolPolicyInput } from "../../../../shared/policy/policy";
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
      authenticate: () => Promise.resolve(identity),
      resolveGithubToken: () => Promise.resolve("gho_user_token"),
      fetch: () => Promise.resolve(new Response("{}")),
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
      authenticate: (token) => {
        expect(token).toBe("hop1-token");
        return Promise.resolve(identity);
      },
      resolveGithubToken: (requestIdentity) => {
        expect(requestIdentity).toBe(identity);
        return Promise.resolve("gho_user_token");
      },
      fetch: (request) => {
        seenRequests.push(request);
        return Promise.resolve(
          new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "mcp-session-id": "session-1",
            },
          }),
        );
      },
    });

    const response = await handler(
      new Request("http://wrapper/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer hop1-token",
          "content-type": "application/json",
          "mcp-protocol-version": "2025-06-18",
          "mcp-session-id": "gateway-session-1",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBe("session-1");
    const responseBody = (await response.json()) as { result: { tools: { name: string }[] } };
    expect(responseBody.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "github_oauth_status",
      "github_oauth_start",
    ]);
    expect(seenRequests).toHaveLength(1);

    const upstreamRequest = seenRequests[0];
    expect(upstreamRequest).toBeDefined();
    expect(upstreamRequest?.url).toBe("http://github-mcp:8082/mcp");
    expect(upstreamRequest?.method).toBe("POST");
    expect(upstreamRequest?.headers.get("authorization")).toBe("Bearer gho_user_token");
    expect(upstreamRequest?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
    expect(upstreamRequest?.headers.get("content-type")).toBe("application/json");
    expect(upstreamRequest?.headers.get("mcp-method")).toBe("tools/list");
    expect(upstreamRequest?.headers.get("mcp-session-id")).toBeNull();
    expect(await upstreamRequest?.text()).toBe(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2025-06-18",
            "io.modelcontextprotocol/clientInfo": {
              name: "github-mcp-wrapper",
              version: "0.1.0",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    );
  });

  test("merges GitHub OAuth helper tools into upstream SSE tools/list responses", async () => {
    const handler = createGithubMcpProxyHandler({
      upstreamUrl: "http://github-mcp:8082/mcp",
      authenticate: () => Promise.resolve(identity),
      resolveGithubToken: () => Promise.resolve("gho_user_token"),
      fetch: () =>
        Promise.resolve(
          new Response(
            [
              "event: message",
              `data: ${JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                result: {
                  tools: [
                    {
                      name: "actions_list",
                      description: "List GitHub Actions resources.",
                      inputSchema: { type: "object" },
                    },
                  ],
                },
              })}`,
              "",
            ].join("\n"),
            {
              status: 200,
              headers: {
                "content-type": "text/event-stream",
              },
            },
          ),
        ),
    });

    const response = await handler(
      new Request("http://wrapper/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer hop1-token",
          "content-type": "application/json",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const body = await response.text();
    const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
    expect(dataLine).toBeDefined();

    const payload = JSON.parse(dataLine?.slice("data: ".length) ?? "{}") as {
      result: { tools: { name: string }[] };
    };
    expect(payload.result.tools.map((tool) => tool.name)).toEqual([
      "github_oauth_status",
      "github_oauth_start",
      "actions_list",
    ]);
  });

  test("surfaces missing GitHub credentials as an MCP unauthorized error", async () => {
    const handler = createGithubMcpProxyHandler({
      upstreamUrl: "http://github-mcp:8082/mcp",
      authenticate: () => Promise.resolve(identity),
      resolveGithubToken: () => Promise.resolve(undefined),
      fetch: () => Promise.resolve(new Response("{}")),
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

  test("advertises GitHub OAuth helper tools before GitHub is connected", async () => {
    let fetched = false;
    const handler = createGithubMcpProxyHandler({
      upstreamUrl: "http://github-mcp:8082/mcp",
      authenticate: () => Promise.resolve(identity),
      resolveGithubToken: () => Promise.resolve(undefined),
      fetch: () => {
        fetched = true;
        return Promise.resolve(new Response("{}"));
      },
    });

    const response = await handler(
      new Request("http://wrapper/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer hop1-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/list" }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      jsonrpc: "2.0",
      id: 11,
      result: {
        tools: [
          expect.objectContaining({ name: "github_oauth_status" }),
          expect.objectContaining({ name: "github_oauth_start" }),
        ],
      },
    });
    expect(fetched).toBe(false);
  });

  test("advertises GitHub OAuth helper tools when token broker requires reauth", async () => {
    let fetched = false;
    const handler = createGithubMcpProxyHandler({
      upstreamUrl: "http://github-mcp:8082/mcp",
      authenticate: () => Promise.resolve(identity),
      resolveGithubToken: () =>
        Promise.reject(new GitHubOAuthError("GitHub account must be connected", "reauth_required")),
      fetch: () => {
        fetched = true;
        return Promise.resolve(new Response("{}"));
      },
    });

    const response = await handler(
      new Request("http://wrapper/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer hop1-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 14, method: "tools/list" }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      jsonrpc: "2.0",
      id: 14,
      result: {
        tools: [
          expect.objectContaining({ name: "github_oauth_status" }),
          expect.objectContaining({ name: "github_oauth_start" }),
        ],
      },
    });
    expect(fetched).toBe(false);
  });

  test("handles MCP initialize before GitHub is connected", async () => {
    let resolvedToken = false;
    let fetched = false;
    const handler = createGithubMcpProxyHandler({
      upstreamUrl: "http://github-mcp:8082/mcp",
      authenticate: () => Promise.resolve(identity),
      resolveGithubToken: () => {
        resolvedToken = true;
        return Promise.resolve(undefined);
      },
      fetch: () => {
        fetched = true;
        return Promise.resolve(new Response("{}"));
      },
    });

    const response = await handler(
      new Request("http://wrapper/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer hop1-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 21, method: "initialize" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 21,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "github-mcp-wrapper",
          version: "0.1.0",
        },
      },
    });
    expect(resolvedToken).toBe(false);
    expect(fetched).toBe(false);
  });

  test("accepts MCP notifications before GitHub is connected", async () => {
    let resolvedToken = false;
    let fetched = false;
    const handler = createGithubMcpProxyHandler({
      upstreamUrl: "http://github-mcp:8082/mcp",
      authenticate: () => Promise.resolve(identity),
      resolveGithubToken: () => {
        resolvedToken = true;
        return Promise.resolve(undefined);
      },
      fetch: () => {
        fetched = true;
        return Promise.resolve(new Response("{}"));
      },
    });

    const response = await handler(
      new Request("http://wrapper/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer hop1-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      }),
    );

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
    expect(resolvedToken).toBe(false);
    expect(fetched).toBe(false);
  });

  test("keeps Codex resource discovery protocol-valid without a matching GitHub grant", async () => {
    const upstreamMethods: string[] = [];
    const policyInputs: ToolPolicyInput[] = [];
    const handler = createGithubMcpProxyHandler({
      upstreamUrl: "http://github-mcp:8082/mcp",
      authenticate: () => Promise.resolve(identity),
      resolveGithubToken: () => Promise.resolve(undefined),
      getOAuthStatus: () =>
        Promise.resolve({
          connected: false,
          scopesRequired: ["user:email"],
          scopesGranted: [],
          missingScopes: ["user:email"],
        }),
      githubScopes: ["user:email"],
      policy: {
        decide: (input) => {
          policyInputs.push(input);
          return Promise.resolve({ kind: "allow" });
        },
      },
      fetch: async (request) => {
        const payload = (await request.json()) as { method?: string };
        if (payload.method) upstreamMethods.push(payload.method);
        return Response.json({ jsonrpc: "2.0", id: null, result: {} });
      },
    });

    const initialize = await rpc(handler, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {} },
    });
    expect(initialize.status).toBe(200);

    const initialized = await rpc(handler, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(initialized.status).toBe(202);

    const tools = await rpc(handler, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const toolNames = (
      (await tools.json()) as { result: { tools: { name: string }[] } }
    ).result.tools.map((tool) => tool.name);
    expect(toolNames).toEqual(["github_oauth_status", "github_oauth_start"]);

    const templates = await rpc(handler, {
      jsonrpc: "2.0",
      id: "templates",
      method: "resources/templates/list",
    });
    expect(templates.status).toBe(200);
    expect(await templates.json()).toEqual({
      jsonrpc: "2.0",
      id: "templates",
      result: { resourceTemplates: [] },
    });

    const resources = await rpc(handler, {
      jsonrpc: "2.0",
      id: 4,
      method: "resources/list",
    });
    expect(resources.status).toBe(200);
    expect(await resources.json()).toEqual({
      jsonrpc: "2.0",
      id: 4,
      result: { resources: [] },
    });

    const fixedCall = await rpc(handler, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "get_file_contents",
        arguments: { owner: "apelogic-ai", repo: "fixture", path: "README.md" },
      },
    });
    expect(fixedCall.status).toBe(401);
    expect(await fixedCall.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "Unauthorized: GitHub account is not connected" },
    });

    const diagnostic = await rpc(handler, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "github_oauth_status", arguments: {} },
    });
    expect(await diagnostic.json()).toEqual({
      jsonrpc: "2.0",
      id: 6,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              connected: false,
              scopesRequired: ["user:email"],
              scopesGranted: [],
              missingScopes: ["user:email"],
            }),
          },
        ],
      },
    });
    expect(policyInputs.map((input) => input.tool)).toEqual(["get_file_contents"]);
    expect(upstreamMethods).toEqual([]);
  });

  test("keeps resource discovery protocol-valid when the exact GitHub grant requires reauth", async () => {
    let fetched = false;
    const handler = createGithubMcpProxyHandler({
      upstreamUrl: "http://github-mcp:8082/mcp",
      authenticate: () => Promise.resolve(identity),
      resolveGithubToken: () =>
        Promise.reject(new GitHubOAuthError("GitHub grant expired", "reauth_required")),
      fetch: () => {
        fetched = true;
        return Promise.resolve(new Response("{}"));
      },
    });

    const templates = await rpc(handler, {
      jsonrpc: "2.0",
      id: 7,
      method: "resources/templates/list",
    });
    expect(await templates.json()).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { resourceTemplates: [] },
    });

    const resources = await rpc(handler, {
      jsonrpc: "2.0",
      id: 8,
      method: "resources/list",
    });
    expect(await resources.json()).toEqual({
      jsonrpc: "2.0",
      id: 8,
      result: { resources: [] },
    });
    expect(fetched).toBe(false);
  });

  test("does not turn malformed or non-discovery resource requests into empty results", async () => {
    let fetched = false;
    const handler = createGithubMcpProxyHandler({
      upstreamUrl: "http://github-mcp:8082/mcp",
      authenticate: () => Promise.resolve(identity),
      resolveGithubToken: () => Promise.resolve(undefined),
      fetch: () => {
        fetched = true;
        return Promise.resolve(new Response("{}"));
      },
    });

    for (const payload of [
      { jsonrpc: "2.0", id: 9, method: "resources/list", params: "invalid" },
      { jsonrpc: "2.0", id: 10, method: "resources/templates/list", params: { cursor: 7 } },
      { jsonrpc: "2.0", id: 11, method: "resources/read", params: { uri: "repo://x/y" } },
    ]) {
      const response = await rpc(handler, payload);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: "Unauthorized: GitHub account is not connected" },
      });
    }
    expect(fetched).toBe(false);
  });

  test("does not synthesize empty resources for malformed JSON-RPC envelopes or transport", async () => {
    let fetched = false;
    const handler = createGithubMcpProxyHandler({
      upstreamUrl: "http://github-mcp:8082/mcp",
      authenticate: () => Promise.resolve(identity),
      resolveGithubToken: () => Promise.resolve(undefined),
      fetch: () => {
        fetched = true;
        return Promise.resolve(new Response("{}"));
      },
    });

    const malformedRequests: {
      body: unknown;
      contentType?: string;
      omitContentType?: boolean;
      rawBody?: string;
    }[] = [
      { body: { id: 20, method: "resources/list" } },
      { body: { jsonrpc: "1.0", id: 21, method: "resources/list" } },
      { body: { jsonrpc: 2, id: 22, method: "resources/list" } },
      { body: { jsonrpc: "2.0", method: "resources/list" } },
      { body: { jsonrpc: "2.0", id: null, method: "resources/list" } },
      { body: { jsonrpc: "2.0", id: true, method: "resources/list" } },
      { body: { jsonrpc: "2.0", id: { nested: true }, method: "resources/list" } },
      {
        body: {
          jsonrpc: "2.0",
          id: 23,
          method: "resources/templates/list",
          params: { _meta: "invalid" },
        },
      },
      {
        body: {
          jsonrpc: "2.0",
          id: 24,
          method: "resources/list",
          params: { _meta: null },
        },
      },
      {
        body: {
          jsonrpc: "2.0",
          id: 25,
          method: "resources/list",
          params: { _meta: [] },
        },
      },
      { body: { jsonrpc: "2.0", id: 26, method: "resources/list", params: null } },
      { body: { jsonrpc: "2.0", id: 27, method: "resources/list", params: [] } },
      {
        body: {
          jsonrpc: "2.0",
          id: 28,
          method: "resources/templates/list",
          params: { cursor: false },
        },
      },
      { body: [{ jsonrpc: "2.0", id: 29, method: "resources/list" }] },
      { body: "not-an-object" },
      { body: null, rawBody: "{" },
      {
        body: { jsonrpc: "2.0", id: 30, method: "resources/list" },
        contentType: "text/plain",
      },
      {
        body: { jsonrpc: "2.0", id: 31, method: "resources/list" },
        contentType: "application/json-patch+json",
      },
      {
        body: { jsonrpc: "2.0", id: 32, method: "resources/list" },
        contentType: "",
      },
      {
        body: { jsonrpc: "2.0", id: 33, method: "resources/list" },
        contentType: "   ",
      },
      {
        body: { jsonrpc: "2.0", id: 34, method: "resources/list" },
        omitContentType: true,
      },
    ];

    for (const requestCase of malformedRequests) {
      const headers = new Headers({
        authorization: "Bearer hop1-token",
        "mcp-protocol-version": "2025-06-18",
      });
      if (requestCase.contentType !== undefined) {
        headers.set("content-type", requestCase.contentType);
      } else if (!requestCase.omitContentType) {
        headers.set("content-type", "application/json");
      }

      const serializedBody = requestCase.rawBody ?? JSON.stringify(requestCase.body);
      const requestBody = requestCase.omitContentType
        ? new TextEncoder().encode(serializedBody)
        : serializedBody;

      const response = await handler(
        new Request("http://wrapper/mcp", {
          method: "POST",
          headers,
          body: requestBody,
        }),
      );
      expect(response.status).not.toBe(200);
      const responseBody = await response.text();
      if (responseBody) {
        const responsePayload = JSON.parse(responseBody) as unknown;
        expect(responsePayload).not.toMatchObject({
          result: { resources: [] },
        });
        expect(responsePayload).not.toMatchObject({
          result: { resourceTemplates: [] },
        });
      }
    }
    expect(fetched).toBe(false);
  });

  test("accepts complete JSON-RPC resource discovery with JSON media-type parameters", async () => {
    const handler = createGithubMcpProxyHandler({
      upstreamUrl: "http://github-mcp:8082/mcp",
      authenticate: () => Promise.resolve(identity),
      resolveGithubToken: () => Promise.resolve(undefined),
    });

    const response = await handler(
      new Request("http://wrapper/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer hop1-token",
          "content-type": "Application/JSON; charset=utf-8",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "resources-with-meta",
          method: "resources/list",
          params: { cursor: "next", _meta: { progressToken: "progress-1" } },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: "resources-with-meta",
      result: { resources: [] },
    });
  });

  test("does not synthesize empty resources for an ambiguous content type", async () => {
    const handler = createGithubMcpProxyHandler({
      upstreamUrl: "http://github-mcp:8082/mcp",
      authenticate: () => Promise.resolve(identity),
      resolveGithubToken: () => Promise.resolve(undefined),
    });
    const headers = new Headers({ authorization: "Bearer hop1-token" });
    headers.append("content-type", "application/json");
    headers.append("content-type", "text/plain");

    const response = await handler(
      new Request("http://wrapper/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 35, method: "resources/list" }),
      }),
    );

    expect(response.status).not.toBe(200);
  });

  test("forwards Codex resource discovery and fixed tool calls with an exact GitHub grant", async () => {
    const upstreamMethods: string[] = [];
    const handler = createGithubMcpProxyHandler({
      upstreamUrl: "http://github-mcp:8082/mcp",
      authenticate: () => Promise.resolve(identity),
      resolveGithubToken: () => Promise.resolve("gho_user_token"),
      fetch: async (request) => {
        expect(request.headers.get("authorization")).toBe("Bearer gho_user_token");
        const payload = (await request.json()) as { id: number; method: string };
        upstreamMethods.push(payload.method);
        if (payload.method === "tools/list") {
          return Response.json({
            jsonrpc: "2.0",
            id: payload.id,
            result: { tools: [{ name: "get_file_contents", inputSchema: { type: "object" } }] },
          });
        }
        if (payload.method === "resources/templates/list") {
          return Response.json({
            jsonrpc: "2.0",
            id: payload.id,
            result: { resourceTemplates: [] },
          });
        }
        if (payload.method === "resources/list") {
          return Response.json({ jsonrpc: "2.0", id: payload.id, result: { resources: [] } });
        }
        return Response.json({
          jsonrpc: "2.0",
          id: payload.id,
          result: { content: [{ type: "text", text: "fixture contents" }] },
        });
      },
    });

    expect(
      (
        (await (await rpc(handler, { jsonrpc: "2.0", id: 11, method: "tools/list" })).json()) as {
          result: { tools: { name: string }[] };
        }
      ).result.tools.map((tool) => tool.name),
    ).toEqual(["github_oauth_status", "github_oauth_start", "get_file_contents"]);
    expect(
      await (
        await rpc(handler, {
          jsonrpc: "2.0",
          id: 12,
          method: "resources/templates/list",
        })
      ).json(),
    ).toEqual({ jsonrpc: "2.0", id: 12, result: { resourceTemplates: [] } });
    expect(
      await (await rpc(handler, { jsonrpc: "2.0", id: 13, method: "resources/list" })).json(),
    ).toEqual({ jsonrpc: "2.0", id: 13, result: { resources: [] } });
    expect(
      await (
        await rpc(handler, {
          jsonrpc: "2.0",
          id: 14,
          method: "tools/call",
          params: {
            name: "get_file_contents",
            arguments: { owner: "apelogic-ai", repo: "fixture", path: "README.md" },
          },
        })
      ).json(),
    ).toEqual({
      jsonrpc: "2.0",
      id: 14,
      result: { content: [{ type: "text", text: "fixture contents" }] },
    });
    expect(upstreamMethods).toEqual([
      "tools/list",
      "resources/templates/list",
      "resources/list",
      "tools/call",
    ]);
  });

  test("prepends GitHub OAuth helper tools to connected upstream tool lists", async () => {
    const handler = createGithubMcpProxyHandler({
      upstreamUrl: "http://github-mcp:8082/mcp",
      authenticate: () => Promise.resolve(identity),
      resolveGithubToken: () => Promise.resolve("gho_user_token"),
      fetch: () =>
        Promise.resolve(
          Response.json({
            jsonrpc: "2.0",
            id: 12,
            result: {
              tools: [{ name: "github_list_pull_requests", inputSchema: { type: "object" } }],
            },
          }),
        ),
    });

    const response = await handler(
      new Request("http://wrapper/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer hop1-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 12, method: "tools/list" }),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "github_oauth_status",
      "github_oauth_start",
      "github_list_pull_requests",
    ]);
  });

  test("allows GitHub OAuth start through policy before issuing state", async () => {
    let resolvedToken = false;
    let stateIssuanceCalls = 0;
    const policyInputs: ToolPolicyInput[] = [];
    const identityWithAuthority = {
      ...identity,
      claims: {
        controlPlane: {
          acting_as: "user",
          runtime_uid: "runtime-uid-oauth",
        },
      },
    };
    const handler = createGithubMcpProxyHandler({
      upstreamUrl: "http://github-mcp:8082/mcp",
      authenticate: () => Promise.resolve(identityWithAuthority),
      resolveGithubToken: () => {
        resolvedToken = true;
        return Promise.resolve(undefined);
      },
      githubScopes: ["repo", "user:email"],
      policy: {
        decide: (input) => {
          policyInputs.push(input);
          return Promise.resolve({ kind: "allow" });
        },
      },
      startOAuth: (requestIdentity, redirectAfter) => {
        stateIssuanceCalls += 1;
        expect(requestIdentity).toBe(identityWithAuthority);
        expect(redirectAfter).toBe("https://app.example.com/after");
        return Promise.resolve({ authorizationUrl: "https://github.com/login/oauth/authorize" });
      },
      fetch: () => Promise.reject(new Error("should not fetch upstream")),
    });

    const response = await handler(
      new Request("http://wrapper/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer hop1-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 13,
          method: "tools/call",
          params: {
            name: "github_oauth_start",
            arguments: { redirectAfter: "https://app.example.com/after" },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 13,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ authorizationUrl: "https://github.com/login/oauth/authorize" }),
          },
        ],
      },
    });
    expect(resolvedToken).toBe(false);
    expect(stateIssuanceCalls).toBe(1);
    expect(policyInputs).toEqual([
      {
        principal: "user@example.com",
        tokenClaims: {
          ...identityWithAuthority.claims,
          email: "user@example.com",
          sub: "user-123",
        },
        tool: "github_oauth_start",
        service: "github",
        actionClass: "write",
        scopes: ["repo", "user:email"],
        args: { redirectAfter: "https://app.example.com/after" },
      },
    ]);
  });

  test("denies GitHub OAuth start before state or authorization URL issuance", async () => {
    let stateIssuanceCalls = 0;
    let resolvedToken = false;
    const audit = new InMemoryAuditSink();
    const handler = createGithubMcpProxyHandler({
      upstreamUrl: "http://github-mcp:8082/mcp",
      authenticate: () => Promise.resolve(identity),
      resolveGithubToken: () => {
        resolvedToken = true;
        return Promise.resolve(undefined);
      },
      githubScopes: ["repo"],
      policy: {
        decide: (input) => {
          expect(input.tool).toBe("github_oauth_start");
          expect(input.principal).toBe(identity.email);
          return Promise.resolve({ kind: "deny", reason: "provider grant absent" });
        },
      },
      audit,
      startOAuth: () => {
        stateIssuanceCalls += 1;
        return Promise.resolve({ authorizationUrl: "https://github.com/should-not-exist" });
      },
      fetch: () => Promise.reject(new Error("should not fetch upstream")),
    });

    const response = await handler(
      new Request("http://wrapper/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer hop1-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 14,
          method: "tools/call",
          params: {
            name: "github_oauth_start",
            arguments: { redirectAfter: "https://app.example.com/after" },
          },
        }),
      }),
    );

    const deniedBody = await response.json();
    expect(deniedBody).toEqual({
      jsonrpc: "2.0",
      id: 14,
      error: {
        code: -32003,
        message: "Policy denied github_oauth_start: provider grant absent",
      },
    });
    expect(stateIssuanceCalls).toBe(0);
    expect(resolvedToken).toBe(false);
    expect(audit.events).toHaveLength(1);
    expect(JSON.stringify(deniedBody)).not.toContain("authorizationUrl");
  });

  test("preserves upstream MCP error responses", async () => {
    const handler = createGithubMcpProxyHandler({
      upstreamUrl: "http://github-mcp:8082/mcp",
      authenticate: () => Promise.resolve(identity),
      resolveGithubToken: () => Promise.resolve("gho_user_token"),
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 7,
              error: { code: -32601, message: "Method not found" },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
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

  test("denies tool calls before resolving GitHub credentials when policy rejects them", async () => {
    const policyInputs: ToolPolicyInput[] = [];
    const audit = new InMemoryAuditSink();
    const identityWithAuthority = {
      ...identity,
      claims: {
        controlPlane: {
          acting_as: "user",
          runtime_uid: "runtime-uid-a",
          tools: [
            {
              provider: "github",
              resource: "github_create_issue",
              action: "write",
            },
          ],
          version: 1,
        },
      },
    };
    const handler = createGithubMcpProxyHandler({
      upstreamUrl: "http://github-mcp:8082/mcp",
      authenticate: () => Promise.resolve(identityWithAuthority),
      resolveGithubToken: () => Promise.reject(new Error("should not resolve token")),
      githubScopes: ["repo"],
      audit,
      policy: {
        decide: (input) => {
          policyInputs.push(input);
          return Promise.resolve({ kind: "deny", reason: "writes disabled" });
        },
      },
      fetch: () => Promise.reject(new Error("should not call upstream")),
    });

    const response = await handler(
      new Request("http://wrapper/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer hop1-token",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: {
            name: "github_create_issue",
            arguments: { owner: "acme", repo: "app", title: "Bug" },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 9,
      error: {
        code: -32003,
        message: "Policy denied github_create_issue: writes disabled",
      },
    });
    expect(policyInputs).toEqual([
      {
        principal: "user@example.com",
        tokenClaims: {
          ...identityWithAuthority.claims,
          email: "user@example.com",
          sub: "user-123",
        },
        tool: "github_create_issue",
        service: "github",
        actionClass: "write",
        scopes: ["repo"],
        args: { owner: "acme", repo: "app", title: "Bug" },
      },
    ]);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      category: "tool_call",
      principal: "user@example.com",
      status: "deny",
      event: "deny",
      tool: "github_create_issue",
      error: "writes disabled",
    });
  });

  test("rewrites compatibility aliases before policy and upstream forwarding", async () => {
    const seenRequests: Request[] = [];
    const seenPolicies: ToolPolicyInput[] = [];
    const audit = new InMemoryAuditSink();
    const allowPolicy: ToolPolicy = {
      decide: (input) => {
        seenPolicies.push(input);
        return Promise.resolve({ kind: "allow" });
      },
    };
    const handler = createGithubMcpProxyHandler({
      upstreamUrl: "http://github-mcp:8082/mcp",
      authenticate: () => Promise.resolve(identity),
      resolveGithubToken: () => Promise.resolve("gho_user_token"),
      githubScopes: ["repo"],
      aliases: {
        github_issues_create: "github_create_issue",
      },
      audit,
      policy: allowPolicy,
      fetch: (request) => {
        seenRequests.push(request);
        return Promise.resolve(Response.json({ jsonrpc: "2.0", id: 10, result: { ok: true } }));
      },
    });

    const response = await handler(
      new Request("http://wrapper/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer hop1-token",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: {
            name: "github_issues_create",
            arguments: { title: "Bug" },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(seenPolicies[0]?.tool).toBe("github_create_issue");
    expect(await seenRequests[0]?.json()).toEqual({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "github_create_issue",
        arguments: { title: "Bug" },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2025-06-18",
          "io.modelcontextprotocol/clientInfo": {
            name: "github-mcp-wrapper",
            version: "0.1.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
    expect(seenRequests[0]?.headers.get("mcp-name")).toBe("github_create_issue");
    expect(audit.events[0]?.status).toBe("allow");
    expect(audit.events[0]?.tool).toBe("github_create_issue");
    expect(typeof audit.events[0]?.resultSize).toBe("number");
    expect(audit.events[0]).toMatchObject({
      status: "allow",
      tool: "github_create_issue",
    });
  });
});

function rpc(
  handler: (request: Request) => Promise<Response>,
  payload: Record<string, unknown>,
): Promise<Response> {
  return handler(
    new Request("http://wrapper/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer hop1-token",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify(payload),
    }),
  );
}
