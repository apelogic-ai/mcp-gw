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
    expect(await upstreamRequest?.text()).toBe(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    );
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

  test("handles GitHub OAuth helper tool calls without resolving GitHub credentials", async () => {
    let resolvedToken = false;
    const handler = createGithubMcpProxyHandler({
      upstreamUrl: "http://github-mcp:8082/mcp",
      authenticate: () => Promise.resolve(identity),
      resolveGithubToken: () => {
        resolvedToken = true;
        return Promise.resolve(undefined);
      },
      startOAuth: (requestIdentity, redirectAfter) => {
        expect(requestIdentity).toBe(identity);
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
    const handler = createGithubMcpProxyHandler({
      upstreamUrl: "http://github-mcp:8082/mcp",
      authenticate: () => Promise.resolve(identity),
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
      },
    });
    expect(audit.events[0]?.status).toBe("allow");
    expect(audit.events[0]?.tool).toBe("github_create_issue");
    expect(typeof audit.events[0]?.resultSize).toBe("number");
    expect(audit.events[0]).toMatchObject({
      status: "allow",
      tool: "github_create_issue",
    });
  });
});
