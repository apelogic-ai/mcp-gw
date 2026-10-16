import { describe, expect, test } from "bun:test";
import { taskAuthority, withTaskAuthority } from "../../../test/support/task-authority-fixture";

import { InMemoryAuditSink } from "../../../shared/audit/audit";
import type { Hop1Identity } from "../../../shared/identity/hop1";
import { YamlPolicy } from "../../../shared/policy/policy";
import {
  loadGenericToolCatalog,
  type GenericToolCatalog,
  type GenericWrapperDescriptor,
} from "./descriptor";
import { createGenericMcpProxyHandler } from "./proxy";
import type { GenericUpstreamRequest, GenericUpstreamTransport } from "./transport";

const identity: Hop1Identity = {
  profile: "fixture",
  issuer: "https://identity.example.com",
  subject: "subject-1",
  email: "user@example.com",
  claims: { department: "engineering" },
};

const descriptor: GenericWrapperDescriptor = {
  schemaVersion: "mcp-gateway.generic-wrapper/v1",
  name: "hosted-search",
  toolPrefix: "search",
  catalogPath: "/etc/mcp-gw/catalog.json",
  lifecycleRoutes: false,
  upstream: { transport: "http", url: "https://mcp.example.com/mcp" },
  credential: { mode: "none" },
  serverInfo: { name: "hosted-search-wrapper", version: "1.0.0" },
  sessions: { maxTotal: 64, maxPerPrincipal: 4, idleTtlMs: 1_800_000 },
};

const catalog: GenericToolCatalog = {
  schemaVersion: "mcp-gateway.generic-catalog/v1",
  catalogId: "example-search@1",
  tools: [
    {
      exposedName: "search_query",
      upstreamName: "query",
      description: "Search public documents.",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      annotations: { readOnlyHint: true },
      grants: { actionClass: "read", operation: "search.query", scopes: ["search.read"] },
    },
  ],
};

const taskCatalog: GenericToolCatalog = {
  ...catalog,
  tools: [
    ...catalog.tools,
    {
      exposedName: "search_metadata",
      upstreamName: "metadata",
      description: "Read search metadata.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      grants: { actionClass: "read", operation: "search.metadata", scopes: [] },
    },
    {
      exposedName: "search_reindex",
      upstreamName: "reindex",
      description: "Rebuild the search index.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: false },
      grants: { actionClass: "write", operation: "search.reindex", scopes: [] },
    },
  ],
};

const jiraWriteCatalog: GenericToolCatalog = {
  ...catalog,
  tools: [
    {
      exposedName: "jira_edit_issue",
      upstreamName: "editJiraIssue",
      description: "Edit a Jira issue.",
      inputSchema: { type: "object", properties: { issueKey: { type: "string" } } },
      annotations: { readOnlyHint: false },
      grants: {
        actionClass: "write",
        operation: "jira.issues.edit",
        scopes: ["write:jira:agent-interface"],
      },
    },
  ],
};

const jiraDescriptor: GenericWrapperDescriptor = {
  ...descriptor,
  name: "jira",
  toolPrefix: "jira",
  lifecycleRoutes: true,
  upstream: { transport: "http", url: "https://mcp.atlassian.com/v2/mcp?tools=all" },
  credential: {
    mode: "per_user_oauth",
    providerId: "jira",
    authorizationUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    userInfoUrl: "https://api.atlassian.com/oauth/token/accessible-resources",
    redirectUri: "http://127.0.0.1:28080/oauth/jira/callback",
    scopes: ["read:jira-user", "read:jira:agent-interface", "offline_access"],
    clientIdEnv: "JIRA_OAUTH_CLIENT_ID",
    clientSecretEnv: "JIRA_OAUTH_CLIENT_SECRET",
    encryptionKeyEnv: "JIRA_TOKEN_ENCRYPTION_KEY",
    tokenStoreDsnEnv: "TOKEN_STORE_DSN",
    identity: {
      mode: "atlassian_jira_asserted_email",
      siteUrl: "https://example.atlassian.net",
    },
    tokenEndpointAuthMethod: "client_secret_post",
  },
};

const jiraRestCatalog = loadGenericToolCatalog(
  "servers/generic-wrapper/catalog/jira/read-only.yaml",
  "jira",
);

class RecordingTransport implements GenericUpstreamTransport {
  readonly requests: GenericUpstreamRequest[] = [];
  readonly issuedSessions: { id: string; principalKey: string }[] = [];

  issueSession(session: { id: string; principalKey: string }): void {
    this.issuedSessions.push(session);
  }

  assertSession(sessionId: string, principalKey: string): void {
    void sessionId;
    void principalKey;
  }

  send(request: GenericUpstreamRequest): Promise<Response> {
    this.requests.push(request);
    return Promise.resolve(
      Response.json(
        { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "ok" }] } },
        {
          headers: { "mcp-session-id": "upstream-session" },
        },
      ),
    );
  }
}

describe("generic MCP proxy", () => {
  test("lists and executes only exact Task-approved generic tool tuples", async () => {
    const transport = new RecordingTransport();
    let credentialCalls = 0;
    let policyCalls = 0;
    const taskIdentity: Hop1Identity = {
      ...identity,
      claims: withTaskAuthority({
        ...taskAuthority,
        tools: [{ provider: "hosted-search", resource: "search_query", action: "read" }],
      }),
    };
    const proxy = createGenericMcpProxyHandler({
      descriptor,
      catalog: taskCatalog,
      authenticate: () => Promise.resolve(taskIdentity),
      taskToolAuthorization: {},
      transport,
      policy: {
        decide: () => {
          policyCalls += 1;
          return Promise.resolve({ kind: "allow" });
        },
      },
      resolveCredential: () => {
        credentialCalls += 1;
        return Promise.resolve(null);
      },
    });

    const listed = await proxy(mcpRequest("tools/list", {}, 101));
    expect(
      ((await listed.json()) as { result: { tools: { name: string }[] } }).result.tools.map(
        (tool) => tool.name,
      ),
    ).toEqual(["search_query"]);

    expect(
      await (
        await proxy(
          mcpRequest("tools/call", { name: "search_query", arguments: { q: "mcp" } }, 102),
        )
      ).json(),
    ).toMatchObject({ result: { content: [{ type: "text", text: "ok" }] } });

    for (const denied of ["search_metadata", "search_reindex"]) {
      expect(
        await (await proxy(mcpRequest("tools/call", { name: denied, arguments: {} }, 103))).json(),
      ).toMatchObject({
        result: {
          isError: true,
          content: [{ type: "text", text: "Tool is not approved for this Task" }],
          structuredContent: { error: "task_tool_not_approved" },
        },
      });
    }
    expect(policyCalls).toBe(1);
    expect(credentialCalls).toBe(1);
    expect(transport.requests).toHaveLength(1);
  });

  test("maps Jira authority to the prefixed alias, not the upstream tool name", async () => {
    const transport = new RecordingTransport();
    const claimsFor = (resource: string): Hop1Identity => ({
      ...identity,
      claims: withTaskAuthority({
        ...taskAuthority,
        tools: [{ provider: "jira", resource, action: "write" }],
      }),
    });
    const create = (resource: string) =>
      createGenericMcpProxyHandler({
        descriptor: jiraDescriptor,
        catalog: jiraWriteCatalog,
        authenticate: () => Promise.resolve(claimsFor(resource)),
        taskToolAuthorization: {},
        transport,
        resolveCredential: () =>
          Promise.resolve({ header: "authorization", value: "Bearer provider-token" }),
      });

    const denied = await create("editJiraIssue")(
      mcpRequest("tools/call", { name: "jira_edit_issue", arguments: {} }, 104),
    );
    expect(await denied.json()).toMatchObject({
      result: { structuredContent: { error: "task_tool_not_approved" } },
    });
    expect(transport.requests).toHaveLength(0);

    const allowed = await create("jira_edit_issue")(
      mcpRequest("tools/call", { name: "jira_edit_issue", arguments: {} }, 105),
    );
    expect(await allowed.json()).toMatchObject({ result: { content: [{ text: "ok" }] } });
    expect(JSON.parse(transport.requests[0]?.body ?? "")).toMatchObject({
      params: { name: "editJiraIssue" },
    });
  });

  test("runs only Task-approved Jira REST tools and refuses removed aliases before REST", async () => {
    const transport = new RecordingTransport();
    let credentialCalls = 0;
    const restCalls: Record<string, unknown>[] = [];
    const proxy = createGenericMcpProxyHandler({
      descriptor: jiraDescriptor,
      catalog: jiraRestCatalog,
      authenticate: () =>
        Promise.resolve({
          ...identity,
          claims: withTaskAuthority({
            ...taskAuthority,
            tools: [{ provider: "jira", resource: "jira_get_issue", action: "read" }],
          }),
        }),
      taskToolAuthorization: {},
      transport,
      resolveCredential: () => {
        credentialCalls += 1;
        return Promise.resolve({
          header: "authorization",
          value: "Bearer provider-token",
          rawValue: "provider-token",
        });
      },
      executeJiraRestTool: (request) => {
        restCalls.push(request.arguments);
        return Promise.resolve(
          Response.json({ jsonrpc: "2.0", id: request.id, result: { content: [] } }),
        );
      },
    });

    for (const name of ["jira_search_issues", "jira_list_projects"]) {
      await proxy(mcpRequest("tools/call", { name, arguments: {} }, 106));
    }
    expect(restCalls).toHaveLength(0);
    expect(credentialCalls).toBe(0);
    expect(transport.requests).toHaveLength(0);

    const allowed = await proxy(
      mcpRequest("tools/call", { name: "jira_get_issue", arguments: { issueKey: "EX-1" } }, 107),
    );
    expect(allowed.status).toBe(200);
    expect(restCalls).toEqual([{ issueKey: "EX-1" }]);
    expect(credentialCalls).toBe(1);
    expect(transport.requests).toHaveLength(0);
  });

  test("a Task without tool tuples sees only the generic connection helpers", async () => {
    const taskIdentity: Hop1Identity = {
      ...identity,
      claims: withTaskAuthority({ ...taskAuthority, tools: undefined }),
    };
    const proxy = createGenericMcpProxyHandler({
      descriptor: jiraDescriptor,
      catalog: jiraWriteCatalog,
      authenticate: () => Promise.resolve(taskIdentity),
      taskToolAuthorization: {},
      transport: new RecordingTransport(),
      resolveCredential: () => Promise.reject(new Error("credential lookup must not run")),
      oauth: {
        providerId: "jira",
        status: () => Promise.resolve({ connected: false }),
        start: () => Promise.resolve({ authorizationUrl: "https://auth.example.com/start" }),
      },
    });

    const listed = await proxy(mcpRequest("tools/list", {}, 106));
    expect(
      ((await listed.json()) as { result: { tools: { name: string }[] } }).result.tools.map(
        (tool) => tool.name,
      ),
    ).toEqual(["jira_oauth_status", "jira_oauth_start"]);
  });

  test("owns initialization so provider authorization can start before upstream access", async () => {
    const transport = new RecordingTransport();
    let credentialCalls = 0;
    const proxy = handler({
      transport,
      resolveCredential: () => {
        credentialCalls += 1;
        return Promise.resolve(null);
      },
    });
    const initialized = await proxy(
      mcpRequest(
        "initialize",
        {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "fixture", version: "1" },
        },
        1,
      ),
    );

    expect(initialized.status).toBe(200);
    expect(initialized.headers.get("mcp-session-id")).toBeString();
    expect(await initialized.json()).toMatchObject({
      result: {
        protocolVersion: "2025-06-18",
        serverInfo: descriptor.serverInfo,
      },
    });
    expect(credentialCalls).toBe(0);
    expect(transport.requests).toHaveLength(0);
    expect(transport.issuedSessions).toHaveLength(1);
    expect(transport.issuedSessions[0]?.id).toBe(
      initialized.headers.get("mcp-session-id") ?? undefined,
    );
    expect(transport.issuedSessions[0]?.principalKey).toBe(
      "https://identity.example.com\nsubject-1",
    );

    const notification = await proxy(mcpRequest("notifications/initialized", {}, undefined));
    expect(notification.status).toBe(202);
    expect(transport.requests).toHaveLength(0);
  });

  test("tells clients to re-initialize an expired or evicted session", async () => {
    const transport: GenericUpstreamTransport = {
      issueSession(session) {
        void session;
      },
      assertSession() {
        throw new Error("MCP session is unknown or expired");
      },
      send() {
        throw new Error("upstream access must not run");
      },
    };
    const response = await handler({ transport })(
      mcpRequest("tools/call", { name: "search_query", arguments: { q: "mcp" } }, 2),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      error: { code: -32000, message: "MCP session expired; re-initialize" },
    });
  });

  test("advertises the pinned prefixed catalog without contacting the upstream", async () => {
    const transport = new RecordingTransport();
    const response = await handler({ transport })(mcpRequest("tools/list", {}, 1));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          {
            name: "search_query",
            description: "Search public documents.",
            inputSchema: { type: "object", properties: { q: { type: "string" } } },
            annotations: { readOnlyHint: true },
          },
        ],
      },
    });
    expect(transport.requests).toHaveLength(0);
  });

  test.each([
    "resources/read",
    "prompts/get",
    "completion/complete",
    "logging/setLevel",
    "vendor/custom",
  ])(
    "rejects ungoverned MCP method %s without resolving credentials or calling upstream",
    async (method) => {
      const transport = new RecordingTransport();
      let credentialCalls = 0;
      const response = await handler({
        transport,
        resolveCredential: () => {
          credentialCalls += 1;
          return Promise.resolve({ header: "authorization", value: "Bearer provider-secret" });
        },
      })(mcpRequest(method, {}, 91));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        jsonrpc: "2.0",
        id: 91,
        error: { code: -32601, message: `Unsupported MCP method: ${method}` },
      });
      expect(credentialCalls).toBe(0);
      expect(transport.requests).toHaveLength(0);
    },
  );

  test("pins missing and invalid HOP-1 rejection responses and challenges", async () => {
    const missing = await handler({ transport: new RecordingTransport() })(
      new Request("http://wrapper.test/mcp", { method: "POST" }),
    );
    const invalid = await createGenericMcpProxyHandler({
      descriptor,
      catalog,
      authenticate: () => Promise.reject(new Error("invalid")),
      transport: new RecordingTransport(),
      resolveCredential: () => Promise.resolve(null),
    })(
      new Request("http://wrapper.test/mcp", {
        method: "POST",
        headers: { authorization: "Bearer invalid" },
      }),
    );

    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe("Bearer");
    expect(await missing.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "Unauthorized: bearer token is required" },
    });
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
    expect(await invalid.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "Unauthorized: invalid bearer token" },
    });
  });

  test("authorizes the exposed tool and sends only the upstream name and provider credential", async () => {
    const transport = new RecordingTransport();
    const audit = new InMemoryAuditSink();
    const response = await handler({
      transport,
      audit,
      credential: { header: "x-api-key", value: "provider-secret" },
    })(mcpRequest("tools/call", { name: "search_query", arguments: { q: "mcp" } }, 2));

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBe("upstream-session");
    expect(transport.requests).toHaveLength(1);
    expect(JSON.parse(transport.requests[0]?.body ?? "")).toMatchObject({
      method: "tools/call",
      params: { name: "query", arguments: { q: "mcp" } },
    });
    expect(transport.requests[0]?.credential).toEqual({
      header: "x-api-key",
      value: "provider-secret",
    });
    expect("hop1Token" in (transport.requests[0] ?? {})).toBeFalse();
    expect(audit.events).toMatchObject([
      { category: "tool_call", status: "allow", tool: "search_query" },
    ]);
  });

  test("denies policy before credential resolution or upstream execution", async () => {
    const transport = new RecordingTransport();
    let credentialCalls = 0;
    const response = await handler({
      transport,
      policy: new YamlPolicy({
        default: "allow",
        rules: [{ effect: "deny", match: { operation: "search.query" } }],
      }),
      resolveCredential: () => {
        credentialCalls += 1;
        return Promise.resolve(null);
      },
    })(mcpRequest("tools/call", { name: "search_query", arguments: { q: "mcp" } }, 3));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { isError: true, structuredContent: { error: "policy_denied" } },
    });
    expect(credentialCalls).toBe(0);
    expect(transport.requests).toHaveLength(0);
  });

  test("adds prefixed OAuth helpers only when lifecycle support is configured", async () => {
    const transport = new RecordingTransport();
    const oauthHandler = createGenericMcpProxyHandler({
      descriptor: { ...descriptor, lifecycleRoutes: true },
      catalog,
      authenticate: () => Promise.resolve(identity),
      transport,
      resolveCredential: () => Promise.resolve(null),
      oauth: {
        providerId: "search-provider",
        status: () =>
          Promise.resolve({
            provider: "search-provider",
            phase: "disconnected",
            connected: false,
          }),
        start: () =>
          Promise.resolve({ authorizationUrl: "https://identity.example.com/oauth/authorize" }),
      },
    });

    const listed = await oauthHandler(mcpRequest("tools/list", {}, 4));
    const listedBody = (await listed.json()) as { result: { tools: { name: string }[] } };
    expect(listedBody.result.tools.map((tool) => tool.name)).toEqual([
      "search_oauth_status",
      "search_oauth_start",
      "search_query",
    ]);
    const status = await oauthHandler(
      mcpRequest("tools/call", { name: "search_oauth_status", arguments: {} }, 5),
    );
    const statusBody = (await status.json()) as {
      result: { content: { text: string }[] };
    };
    expect(statusBody.result.content[0]?.text).toContain('"phase":"disconnected"');
    expect(transport.requests).toHaveLength(0);
  });

  test("audits policy denials for wrapper-owned OAuth helpers", async () => {
    const audit = new InMemoryAuditSink();
    const oauthHandler = createGenericMcpProxyHandler({
      descriptor: { ...descriptor, lifecycleRoutes: true },
      catalog,
      authenticate: () => Promise.resolve(identity),
      transport: new RecordingTransport(),
      resolveCredential: () => Promise.resolve(null),
      policy: new YamlPolicy({
        default: "allow",
        rules: [{ effect: "deny", match: { operation: "hosted-search.oauth.start" } }],
      }),
      audit,
      oauth: {
        providerId: "search-provider",
        status: () => Promise.resolve({ connected: false }),
        start: () =>
          Promise.resolve({ authorizationUrl: "https://identity.example.com/oauth/authorize" }),
      },
    });

    const response = await oauthHandler(
      mcpRequest("tools/call", { name: "search_oauth_start", arguments: {} }, 6),
    );

    expect(await response.json()).toMatchObject({
      result: { isError: true, structuredContent: { error: "policy_denied" } },
    });
    expect(audit.events).toMatchObject([
      { category: "tool_call", status: "deny", tool: "search_oauth_start" },
    ]);
  });

  test("recovers one rejected Jira credential and retries with the rotated token", async () => {
    const requests: GenericUpstreamRequest[] = [];
    const transport: GenericUpstreamTransport = {
      issueSession(session) {
        void session;
      },
      assertSession(sessionId, principalKey) {
        void sessionId;
        void principalKey;
      },
      send(request) {
        requests.push(request);
        return Promise.resolve(
          requests.length === 1
            ? new Response("unauthorized", { status: 401 })
            : Response.json({ jsonrpc: "2.0", id: 20, result: { content: [] } }),
        );
      },
    };
    const recovered: string[] = [];
    const proxy = createGenericMcpProxyHandler({
      descriptor: jiraDescriptor,
      catalog,
      authenticate: () => Promise.resolve(identity),
      transport,
      resolveCredential: () =>
        Promise.resolve({
          header: "authorization",
          value: "Bearer rejected-token",
          rawValue: "rejected-token",
        }),
      recoverCredential: (_request, rejectedCredential) => {
        recovered.push(rejectedCredential);
        return Promise.resolve({
          header: "authorization",
          value: "Bearer replacement-token",
          rawValue: "replacement-token",
        });
      },
    });

    const response = await proxy(
      mcpRequest("tools/call", { name: "search_query", arguments: { q: "mcp" } }, 20),
    );

    expect(response.status).toBe(200);
    expect(recovered).toEqual(["rejected-token"]);
    expect(requests.map((request) => request.credential?.rawValue)).toEqual([
      "rejected-token",
      "replacement-token",
    ]);
  });

  test("recovers a rejected Jira write credential without replaying the write", async () => {
    const requests: GenericUpstreamRequest[] = [];
    const recovered: string[] = [];
    const transport: GenericUpstreamTransport = {
      issueSession(session) {
        void session;
      },
      assertSession(sessionId, principalKey) {
        void sessionId;
        void principalKey;
      },
      send(request) {
        requests.push(request);
        return Promise.resolve(new Response("unauthorized", { status: 401 }));
      },
    };
    const proxy = createGenericMcpProxyHandler({
      descriptor: jiraDescriptor,
      catalog: jiraWriteCatalog,
      authenticate: () => Promise.resolve(identity),
      transport,
      resolveCredential: () =>
        Promise.resolve({
          header: "authorization",
          value: "Bearer rejected-token",
          rawValue: "rejected-token",
        }),
      recoverCredential: (_request, rejectedCredential) => {
        recovered.push(rejectedCredential);
        return Promise.resolve({
          header: "authorization",
          value: "Bearer replacement-token",
          rawValue: "replacement-token",
        });
      },
    });

    const response = await proxy(
      mcpRequest("tools/call", { name: "jira_edit_issue", arguments: { issueKey: "TEST-1" } }, 24),
    );

    expect(recovered).toEqual(["rejected-token"]);
    expect(requests).toHaveLength(1);
    expect(await response.json()).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          error: "provider_retry_required",
          provider: "jira",
        },
      },
    });
  });

  test("overrides caller-supplied Jira cloudId with the configured site", async () => {
    const transport = new RecordingTransport();
    const proxy = createGenericMcpProxyHandler({
      descriptor: jiraDescriptor,
      catalog: jiraWriteCatalog,
      authenticate: () => Promise.resolve(identity),
      transport,
      resolveCredential: () =>
        Promise.resolve({
          header: "authorization",
          value: "Bearer provider-token",
          rawValue: "provider-token",
        }),
    });

    await proxy(
      mcpRequest(
        "tools/call",
        {
          name: "jira_edit_issue",
          arguments: { issueKey: "TEST-1", cloudId: "https://other.atlassian.net" },
        },
        25,
      ),
    );

    const forwarded = JSON.parse(transport.requests[0]?.body ?? "") as {
      params: { name: string; arguments: Record<string, unknown> };
    };
    expect(forwarded.params).toMatchObject({
      name: "editJiraIssue",
      arguments: {
        issueKey: "TEST-1",
        cloudId: "https://example.atlassian.net",
      },
    });
  });

  test.each([
    [401, "provider_oauth_required"],
    [403, "provider_permission_denied"],
    [429, "provider_rate_limited"],
  ] as const)(
    "maps Jira HTTP %d to %s without leaking the provider body",
    async (status, error) => {
      const audit = new InMemoryAuditSink();
      const transport: GenericUpstreamTransport = {
        issueSession(session) {
          void session;
        },
        assertSession(sessionId, principalKey) {
          void sessionId;
          void principalKey;
        },
        send: () =>
          Promise.resolve(
            new Response("sensitive provider detail", {
              status,
              headers: status === 429 ? { "retry-after": "17" } : undefined,
            }),
          ),
      };
      const proxy = createGenericMcpProxyHandler({
        descriptor: jiraDescriptor,
        catalog,
        authenticate: () => Promise.resolve(identity),
        transport,
        audit,
        resolveCredential: () =>
          Promise.resolve({
            header: "authorization",
            value: "Bearer provider-token",
            rawValue: "provider-token",
          }),
        recoverCredential: () => Promise.resolve(null),
      });

      const response = await proxy(
        mcpRequest("tools/call", { name: "search_query", arguments: { q: "mcp" } }, 21),
      );
      const body = (await response.json()) as {
        result: { structuredContent: Record<string, unknown> };
      };

      expect(response.status).toBe(200);
      expect(body.result.structuredContent.error).toBe(error);
      expect(JSON.stringify(body)).not.toContain("sensitive provider detail");
      expect(audit.events).toMatchObject([
        {
          category: "tool_call",
          status: "error",
          event: "provider_failure",
          tool: "search_query",
          error,
        },
      ]);
      if (status === 429) {
        expect(response.headers.get("retry-after")).toBe("17");
        expect(body.result.structuredContent.retryAfter).toBe("17");
      }
    },
  );

  test("classifies Atlassian's opaque error as transient after identity validation succeeds", async () => {
    let validations = 0;
    const transport: GenericUpstreamTransport = {
      issueSession(session) {
        void session;
      },
      assertSession(sessionId, principalKey) {
        void sessionId;
        void principalKey;
      },
      send: () =>
        Promise.resolve(
          Response.json({
            jsonrpc: "2.0",
            id: 22,
            result: {
              isError: true,
              content: [{ type: "text", text: "We are having trouble completing this action" }],
            },
          }),
        ),
    };
    const proxy = createGenericMcpProxyHandler({
      descriptor: jiraDescriptor,
      catalog,
      authenticate: () => Promise.resolve(identity),
      transport,
      resolveCredential: () =>
        Promise.resolve({
          header: "authorization",
          value: "Bearer provider-token",
          rawValue: "provider-token",
        }),
      validateCredential: () => {
        validations += 1;
        return Promise.resolve("valid");
      },
    });

    const response = await proxy(
      mcpRequest("tools/call", { name: "search_query", arguments: { q: "mcp" } }, 22),
    );

    expect(validations).toBe(1);
    expect(await response.json()).toMatchObject({
      result: {
        isError: true,
        structuredContent: { error: "provider_unavailable" },
      },
    });
  });

  test("preserves a successful result that quotes Atlassian's opaque error text", async () => {
    let validations = 0;
    const providerResult = {
      jsonrpc: "2.0",
      id: 24,
      result: {
        content: [
          {
            type: "text",
            text: "The issue says: We are having trouble completing this action",
          },
        ],
      },
    };
    const transport: GenericUpstreamTransport = {
      issueSession(session) {
        void session;
      },
      assertSession(sessionId, principalKey) {
        void sessionId;
        void principalKey;
      },
      send: () => Promise.resolve(Response.json(providerResult)),
    };
    const proxy = createGenericMcpProxyHandler({
      descriptor: jiraDescriptor,
      catalog,
      authenticate: () => Promise.resolve(identity),
      transport,
      resolveCredential: () =>
        Promise.resolve({
          header: "authorization",
          value: "Bearer provider-token",
          rawValue: "provider-token",
        }),
      validateCredential: () => {
        validations += 1;
        return Promise.resolve("valid");
      },
    });

    const response = await proxy(
      mcpRequest("tools/call", { name: "search_query", arguments: { q: "mcp" } }, 24),
    );

    expect(validations).toBe(0);
    expect(await response.json()).toEqual(providerResult);
  });

  test("classifies Atlassian's access-verification error as permission denied for a valid credential", async () => {
    let validations = 0;
    const transport: GenericUpstreamTransport = {
      issueSession(session) {
        void session;
      },
      assertSession(sessionId, principalKey) {
        void sessionId;
        void principalKey;
      },
      send: () =>
        Promise.resolve(
          Response.json({
            jsonrpc: "2.0",
            id: 23,
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "We couldn't verify your access. Reconnecting and signing in again may resolve this issue.",
                },
              ],
            },
          }),
        ),
    };
    const proxy = createGenericMcpProxyHandler({
      descriptor: jiraDescriptor,
      catalog,
      authenticate: () => Promise.resolve(identity),
      transport,
      resolveCredential: () =>
        Promise.resolve({
          header: "authorization",
          value: "Bearer provider-token",
          rawValue: "provider-token",
        }),
      validateCredential: () => {
        validations += 1;
        return Promise.resolve("valid");
      },
    });

    const response = await proxy(
      mcpRequest("tools/call", { name: "search_query", arguments: { q: "mcp" } }, 23),
    );

    expect(validations).toBe(1);
    expect(await response.json()).toMatchObject({
      result: {
        isError: true,
        structuredContent: { error: "provider_permission_denied" },
      },
    });
  });

  test("renews and retries Atlassian's opaque error when identity validation rejects the token", async () => {
    const requests: (string | undefined)[] = [];
    const transport: GenericUpstreamTransport = {
      issueSession(session) {
        void session;
      },
      assertSession(sessionId, principalKey) {
        void sessionId;
        void principalKey;
      },
      send(request) {
        requests.push(request.credential?.rawValue);
        return Promise.resolve(
          requests.length === 1
            ? Response.json({
                jsonrpc: "2.0",
                id: 23,
                result: {
                  isError: true,
                  content: [{ type: "text", text: "We are having trouble completing this action" }],
                },
              })
            : Response.json({ jsonrpc: "2.0", id: 23, result: { content: [] } }),
        );
      },
    };
    const proxy = createGenericMcpProxyHandler({
      descriptor: jiraDescriptor,
      catalog,
      authenticate: () => Promise.resolve(identity),
      transport,
      resolveCredential: () =>
        Promise.resolve({
          header: "authorization",
          value: "Bearer rejected-token",
          rawValue: "rejected-token",
        }),
      validateCredential: () => Promise.resolve("invalid"),
      recoverCredential: () =>
        Promise.resolve({
          header: "authorization",
          value: "Bearer replacement-token",
          rawValue: "replacement-token",
        }),
    });

    const response = await proxy(
      mcpRequest("tools/call", { name: "search_query", arguments: { q: "mcp" } }, 23),
    );

    expect(response.status).toBe(200);
    expect(requests).toEqual(["rejected-token", "replacement-token"]);
    expect(await response.json()).toMatchObject({ result: { content: [] } });
  });
});

function handler(options: {
  transport: GenericUpstreamTransport;
  audit?: InMemoryAuditSink;
  policy?: YamlPolicy;
  credential?: { header: string; value: string } | null;
  resolveCredential?: () => Promise<{ header: string; value: string } | null>;
}) {
  return createGenericMcpProxyHandler({
    descriptor,
    catalog,
    authenticate: () => Promise.resolve(identity),
    transport: options.transport,
    policy: options.policy,
    audit: options.audit,
    resolveCredential:
      options.resolveCredential ?? (() => Promise.resolve(options.credential ?? null)),
  });
}

function mcpRequest(
  method: string,
  params: Record<string, unknown>,
  id: number | undefined,
): Request {
  return new Request("http://wrapper.test/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer hop1-secret",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
      "mcp-session-id": "test-session",
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }),
  });
}
