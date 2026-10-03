import { describe, expect, test } from "bun:test";

import { InMemoryAuditSink } from "../../../shared/audit/audit";
import type { Hop1Identity } from "../../../shared/identity/hop1";
import { YamlPolicy } from "../../../shared/policy/policy";
import type { GenericToolCatalog, GenericWrapperDescriptor } from "./descriptor";
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
