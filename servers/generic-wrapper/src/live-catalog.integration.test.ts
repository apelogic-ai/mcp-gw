import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { taskAuthority, withTaskAuthority } from "../../../test/support/task-authority-fixture";

import type { Hop1Identity } from "../../../shared/identity/hop1";
import { YamlPolicy } from "../../../shared/policy/policy";
import {
  parseGenericToolDecisions,
  type GenericLiveToolCatalog,
  type GenericWrapperDescriptor,
} from "./descriptor";
import { createGenericMcpProxyHandler } from "./proxy";
import { createHttpUpstreamTransport } from "./transport";

const identity: Hop1Identity = {
  profile: "fixture",
  issuer: "https://identity.example.com",
  subject: "subject-1",
  email: "user@example.com",
  claims: {},
};

const decisions: GenericLiveToolCatalog = parseGenericToolDecisions(
  {
    schemaVersion: "mcp-gateway.generic-tool-decisions/v1",
    catalogId: "jira-live-fixture",
    tools: [
      {
        name: "getIssue",
        disposition: "include",
        alias: "get_issue",
        actionClass: "read",
        operation: "jira.issue.get",
        scopes: ["read:jira:agent-interface"],
      },
      {
        name: "editIssue",
        disposition: "include",
        alias: "edit_issue",
        actionClass: "write",
        operation: "jira.issue.edit",
        scopes: ["write:jira:agent-interface"],
      },
      {
        name: "removedTool",
        disposition: "include",
        alias: "removed",
        actionClass: "read",
        operation: "jira.removed.get",
        scopes: ["read:jira:agent-interface"],
      },
      { name: "knownExcludedTool", disposition: "exclude", reason: "unsupported" },
    ],
  },
  "jira",
);

let fixture: Bun.Subprocess<"ignore", "pipe", "pipe">;
let upstreamUrl = "";

beforeAll(async () => {
  fixture = Bun.spawn(
    [process.execPath, "servers/generic-wrapper/test-fixtures/live-catalog-mcp-server.ts"],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  void new Response(fixture.stderr).text();
  const reader = fixture.stdout.getReader();
  let output = "";
  while (!output.includes("\n")) {
    const next = await reader.read();
    if (next.done) throw new Error("live catalog fixture exited before publishing its URL");
    output += new TextDecoder().decode(next.value, { stream: true });
  }
  const ready = JSON.parse(output.slice(0, output.indexOf("\n"))) as { url: string };
  upstreamUrl = ready.url;
});

afterAll(async () => {
  fixture.kill();
  await fixture.exited;
});

describe("generic wrapper live tool discovery", () => {
  test("filters every live page through decisions without caching vendor metadata", async () => {
    let failDiscovery = false;
    const proxy = liveHandler({
      resolveCredential: () =>
        Promise.resolve({
          header: "authorization",
          value: failDiscovery ? "Bearer fail-token" : "Bearer provider-token",
          rawValue: failDiscovery ? "fail-token" : "provider-token",
        }),
    });
    const sessionId = await initialize(proxy);

    const listed = await proxy(mcpRequest("tools/list", {}, 2, sessionId));
    const listedBody = (await listed.json()) as {
      result: { tools: Record<string, unknown>[] };
    };
    expect(listedBody.result.tools.map((tool) => tool.name)).toEqual([
      "jira_oauth_status",
      "jira_oauth_start",
      "jira_get_issue",
      "jira_edit_issue",
    ]);
    const getIssue = listedBody.result.tools.find((tool) => tool.name === "jira_get_issue");
    expect(getIssue).toMatchObject({
      description: "Get an issue using the live upstream schema.",
      inputSchema: {
        properties: { issueKey: { type: "string" } },
        required: ["issueKey"],
      },
      annotations: { readOnlyHint: true },
    });
    expect(JSON.stringify(getIssue)).not.toContain("cloudId");
    expect(JSON.stringify(listedBody)).not.toContain("newUndecidedTool");
    expect(JSON.stringify(listedBody)).not.toContain("jira_removed");

    const called = await proxy(
      mcpRequest(
        "tools/call",
        { name: "jira_get_issue", arguments: { issueKey: "EXAMPLE-1" } },
        3,
        sessionId,
      ),
    );
    expect(await called.text()).toContain("called:getIssue");

    const undecided = await proxy(
      mcpRequest("tools/call", { name: "jira_new_undecided_tool", arguments: {} }, 4, sessionId),
    );
    expect(await undecided.json()).toEqual({
      jsonrpc: "2.0",
      id: 4,
      error: { code: -32601, message: "Unsupported MCP tool: jira_new_undecided_tool" },
    });

    failDiscovery = true;
    const unavailable = await proxy(mcpRequest("tools/list", {}, 5, sessionId));
    const unavailableBody = (await unavailable.json()) as {
      result: { tools: { name: string }[]; _meta: Record<string, unknown> };
    };
    expect(unavailableBody).toMatchObject({
      jsonrpc: "2.0",
      id: 5,
      result: {
        _meta: {
          "mcp-gw/catalog": {
            status: "unavailable",
            error: "Upstream tool discovery is unavailable",
          },
        },
      },
    });
    expect(unavailableBody.result.tools.map((tool) => tool.name)).toEqual([
      "jira_oauth_status",
      "jira_oauth_start",
    ]);
  });

  test("resolves the credential exactly once per tools/list when hideToolsUntilConnected is on", async () => {
    let calls = 0;
    const proxy = liveHandler({
      hideToolsUntilConnected: true,
      resolveCredential: () => {
        calls += 1;
        return Promise.resolve({
          header: "authorization",
          value: "Bearer provider-token",
          rawValue: "provider-token",
        });
      },
    });

    const sessionId = await initialize(proxy);
    const listed = await proxy(mcpRequest("tools/list", {}, 2, sessionId));
    const names = (
      (await listed.json()) as { result: { tools: { name: string }[] } }
    ).result.tools.map((tool) => tool.name);

    expect(names).toContain("jira_get_issue");
    expect(calls).toBe(1);
  });

  test("intersects live Jira discovery with exact Task-approved tools", async () => {
    const proxy = liveHandler({
      identity: {
        ...identity,
        claims: withTaskAuthority({
          ...taskAuthority,
          tools: [{ provider: "jira", resource: "jira_get_issue", action: "read" }],
        }),
      },
      resolveCredential: () =>
        Promise.resolve({
          header: "authorization",
          value: "Bearer provider-token",
          rawValue: "provider-token",
        }),
    });
    const sessionId = await initialize(proxy);

    const listed = await proxy(mcpRequest("tools/list", {}, 20, sessionId));
    const listedBody = (await listed.json()) as { result: { tools: { name: string }[] } };
    expect(listedBody.result.tools.map((tool) => tool.name)).toEqual([
      "jira_oauth_status",
      "jira_oauth_start",
      "jira_get_issue",
    ]);

    const allowed = await proxy(
      mcpRequest(
        "tools/call",
        { name: "jira_get_issue", arguments: { issueKey: "EXAMPLE-1" } },
        21,
        sessionId,
      ),
    );
    expect(await allowed.text()).toContain("called:getIssue");

    const denied = await proxy(
      mcpRequest(
        "tools/call",
        { name: "jira_edit_issue", arguments: { issueKey: "EXAMPLE-1" } },
        22,
        sessionId,
      ),
    );
    expect(await denied.json()).toMatchObject({
      result: {
        isError: true,
        content: [{ type: "text", text: "Tool is not approved for this Task" }],
        structuredContent: { error: "task_tool_not_approved" },
      },
    });
  });

  test("keeps lifecycle controls usable under read-only policy and denies writes plainly", async () => {
    const proxy = liveHandler({
      policy: new YamlPolicy({
        default: "deny",
        rules: [{ effect: "allow", match: { actionClass: "read" } }],
      }),
      resolveCredential: () =>
        Promise.resolve({
          header: "authorization",
          value: "Bearer provider-token",
          rawValue: "provider-token",
        }),
    });
    const sessionId = await initialize(proxy);

    for (const name of ["jira_oauth_status", "jira_oauth_start"]) {
      const response = await proxy(
        mcpRequest("tools/call", { name, arguments: {} }, name, sessionId),
      );
      const result = (await response.json()) as { result?: { isError?: boolean } };
      expect(result.result?.isError).not.toBeTrue();
    }
    const denied = await proxy(
      mcpRequest(
        "tools/call",
        { name: "jira_edit_issue", arguments: { issueKey: "EXAMPLE-1" } },
        8,
        sessionId,
      ),
    );
    expect(await denied.json()).toMatchObject({
      result: {
        isError: true,
        content: [{ type: "text", text: "Tool call denied by policy" }],
        structuredContent: { error: "policy_denied" },
      },
    });
  });
});

function liveHandler(options: {
  resolveCredential: () => Promise<{
    header: string;
    value: string;
    rawValue: string;
  }>;
  policy?: YamlPolicy;
  identity?: Hop1Identity;
  hideToolsUntilConnected?: boolean;
}): (request: Request) => Promise<Response> {
  const upstream = { transport: "http" as const, url: upstreamUrl };
  const descriptor: GenericWrapperDescriptor = {
    schemaVersion: "mcp-gateway.generic-wrapper/v1",
    name: "jira",
    toolPrefix: "jira",
    catalogPath: "/app/servers/generic-wrapper/catalog/jira/decisions.yaml",
    lifecycleRoutes: true,
    hideToolsUntilConnected: options.hideToolsUntilConnected ?? false,
    lifecycleToolNames: { start: "oauth_start", status: "oauth_status" },
    upstream,
    credential: {
      mode: "per_user_oauth",
      providerId: "jira",
      authorizationUrl: "https://auth.atlassian.com/authorize",
      tokenUrl: "https://auth.atlassian.com/oauth/token",
      userInfoUrl: "https://api.atlassian.com/oauth/token/accessible-resources",
      redirectUri: "http://127.0.0.1:28080/oauth/jira/callback",
      scopes: [
        "read:jira-user",
        "read:jira:agent-interface",
        "write:jira:agent-interface",
        "offline_access",
      ],
      clientIdEnv: "JIRA_OAUTH_CLIENT_ID",
      clientSecretEnv: "JIRA_OAUTH_CLIENT_SECRET",
      encryptionKeyEnv: "JIRA_TOKEN_ENCRYPTION_KEY",
      tokenStoreDsnEnv: "TOKEN_STORE_DSN",
      identity: {
        mode: "atlassian_jira_asserted_email",
        siteUrl: "https://example.atlassian.net",
      },
    },
    serverInfo: { name: "jira-wrapper", version: "1.0.0" },
    sessions: { maxTotal: 16, maxPerPrincipal: 4, idleTtlMs: 60_000 },
  };
  return createGenericMcpProxyHandler({
    descriptor,
    catalog: decisions,
    authenticate: () => Promise.resolve(options.identity ?? identity),
    resolveCredential: options.resolveCredential,
    transport: createHttpUpstreamTransport(upstream, {
      serverInfo: descriptor.serverInfo,
      maxSessions: 16,
      maxSessionsPerPrincipal: 4,
      sessionIdleTtlMs: 60_000,
    }),
    policy: options.policy,
    requireCredential: true,
    oauth: {
      providerId: "jira",
      status: () => Promise.resolve({ connected: false }),
      start: () => Promise.resolve({ authorizationUrl: "https://auth.example/authorize" }),
    },
  });
}

async function initialize(handler: (request: Request) => Promise<Response>): Promise<string> {
  const response = await handler(
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
  const sessionId = response.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("wrapper did not issue a session");
  return sessionId;
}

function mcpRequest(
  method: string,
  params: Record<string, unknown>,
  id: string | number,
  sessionId?: string,
): Request {
  return new Request("http://wrapper.test/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer hop1-token",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}
