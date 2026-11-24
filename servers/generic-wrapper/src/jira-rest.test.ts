import { describe, expect, test } from "bun:test";

import { loadGenericToolCatalog, type GenericWrapperDescriptor } from "./descriptor";
import { JIRA_REST_CATALOG_IDS, createJiraRestToolExecutor } from "./jira-rest";
import { toolErrorBody } from "../../../test/support/tool-error";

const descriptor: GenericWrapperDescriptor = {
  schemaVersion: "mcp-gateway.generic-wrapper/v1",
  name: "jira",
  toolPrefix: "jira",
  catalogPath: "/app/servers/generic-wrapper/catalog/jira/read-only.yaml",
  lifecycleRoutes: true,
  hideToolsUntilConnected: false,
  lifecycleToolNames: { start: "oauth_start", status: "oauth_status" },
  upstream: { transport: "http", url: "https://mcp.atlassian.com/v2/mcp?tools=all" },
  credential: {
    mode: "per_user_oauth",
    providerId: "jira",
    authorizationUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    userInfoUrl: "https://api.atlassian.com/oauth/token/accessible-resources",
    redirectUri: "http://127.0.0.1:28080/oauth/jira/callback",
    scopes: ["read:jira-user", "read:jira-work", "offline_access"],
    clientIdEnv: "JIRA_OAUTH_CLIENT_ID",
    clientSecretEnv: "JIRA_OAUTH_CLIENT_SECRET",
    encryptionKeyEnv: "JIRA_TOKEN_ENCRYPTION_KEY",
    tokenStoreDsnEnv: "TOKEN_STORE_DSN",
    identity: { mode: "atlassian_jira_asserted_email", siteUrl: "https://site.atlassian.net" },
  },
  serverInfo: { name: "jira-wrapper", version: "1" },
  sessions: { maxTotal: 4, maxPerPrincipal: 2, idleTtlMs: 60_000 },
};

const catalog = loadGenericToolCatalog(
  "servers/generic-wrapper/catalog/jira/read-only.yaml",
  "jira",
);
const credential = {
  header: "authorization",
  value: "Bearer secret-token",
  rawValue: "secret-token",
};

function tool(name: string) {
  const found = catalog.tools.find((entry) => entry.exposedName === name);
  if (!found) throw new Error(`Missing test tool ${name}`);
  return found;
}

describe("Jira REST tools", () => {
  test("logs one sanitized structured line for successful and refused upstream calls", async () => {
    const logs: string[] = [];
    const responses = [
      Response.json({ issues: [{ id: "response-account-id", fields: {} }] }),
      Response.json({ error: "sensitive-response-body" }, { status: 403 }),
    ];
    const execute = createJiraRestToolExecutor(
      descriptor,
      (input) => {
        const url = input instanceof Request ? input.url : input.toString();
        return Promise.resolve(
          url.endsWith("/accessible-resources")
            ? Response.json([{ id: "sensitive-cloud-id", url: "https://site.atlassian.net" }])
            : (responses.shift() ?? new Response(null, { status: 500 })),
        );
      },
      (line) => logs.push(line),
    );
    const search = tool("jira_search_issues");
    const arguments_ = { jql: "project = SENSITIVE_QUERY", maxResults: 2 };

    expect(
      await execute({ id: 1, tool: search, arguments: arguments_, credential }),
    ).toHaveProperty("status", 200);
    expect(logs).toHaveLength(1);
    expect(
      await execute({ id: 2, tool: search, arguments: arguments_, credential }),
    ).toHaveProperty("status", 403);
    expect(logs).toHaveLength(2);

    const events = logs.map(parseLogLine);
    expect(events[0]).toMatchObject({
      type: "mcp_gw_jira_upstream_request",
      tool: "jira_search_issues",
      status: 200,
      errorClass: "none",
    });
    expect(events[1]).toMatchObject({
      type: "mcp_gw_jira_upstream_request",
      tool: "jira_search_issues",
      status: 403,
      errorClass: "provider_permission_denied",
    });
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(
        ["durationMs", "errorClass", "requestId", "status", "tool", "type"].sort(),
      );
      expect(typeof event.durationMs).toBe("number");
      expect(String(event.requestId)).toMatch(/^[0-9a-f-]{36}$/);
    }
    for (const line of logs) {
      expect(line).not.toContain("secret-token");
      expect(line).not.toContain("SENSITIVE_QUERY");
      expect(line).not.toContain("sensitive-response-body");
      expect(line).not.toContain("response-account-id");
      expect(line).not.toContain("sensitive-cloud-id");
    }
  });

  test("binds all three tools to the configured cloud and returns only fixed fields", async () => {
    const requests: Request[] = [];
    const execute = createJiraRestToolExecutor(descriptor, (input, init) => {
      const request =
        input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
      requests.push(request);
      if (request.url.endsWith("/accessible-resources")) {
        return Promise.resolve(
          Response.json([{ id: "cloud-123", url: "https://site.atlassian.net/", extra: "drop" }]),
        );
      }
      if (request.url.includes("/myself")) {
        return Promise.resolve(
          Response.json({ accountId: "a1", displayName: "User", active: true, secret: "drop" }),
        );
      }
      const issue = {
        id: "10001",
        key: "EX-1",
        fields: {
          summary: "Example",
          status: { id: "1", name: "Open", extra: "drop" },
          issuetype: { id: "2", name: "Task" },
          priority: { id: "3", name: "Medium" },
          labels: ["safe"],
          updated: "2026-10-14T00:00:00Z",
          description: "drop",
        },
        extra: "drop",
      };
      return Promise.resolve(
        Response.json(request.url.includes("/search/jql") ? { issues: [issue] } : issue),
      );
    });

    const calls = [
      ["jira_get_current_user", {}],
      ["jira_search_issues", { jql: "project = EX", maxResults: 2 }],
      ["jira_get_issue", { issueKey: "EX-1" }],
      ["jira_get_issue", { issueKey: "10001" }],
    ] as const;
    for (const [name, args] of calls) {
      const response = await execute({ id: 1, tool: tool(name), arguments: args, credential });
      const text = await response.text();
      expect(text).not.toContain("secret-token");
      expect(text).not.toContain("drop");
    }

    expect(requests.map((request) => request.url)).toEqual([
      "https://api.atlassian.com/oauth/token/accessible-resources",
      "https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/myself",
      "https://api.atlassian.com/oauth/token/accessible-resources",
      "https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/search/jql?jql=project+%3D+EX&maxResults=2&fields=summary%2Cstatus",
      "https://api.atlassian.com/oauth/token/accessible-resources",
      "https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/issue/EX-1?fields=summary%2Cstatus",
      "https://api.atlassian.com/oauth/token/accessible-resources",
      "https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/issue/10001?fields=summary%2Cstatus",
    ]);
    expect(
      requests.every((request) => request.headers.get("authorization") === "Bearer secret-token"),
    ).toBeTrue();
  });

  test("refuses caller routing fields before REST and fails closed on site resolution", async () => {
    let calls = 0;
    const issueTool = tool("jira_get_issue");
    const noRouting = createJiraRestToolExecutor(descriptor, () => {
      calls += 1;
      return Promise.resolve(
        Response.json([
          { id: "cloud-1", url: "https://site.atlassian.net" },
          { id: "cloud-2", url: "https://site.atlassian.net/" },
        ]),
      );
    });
    const refused = await noRouting({
      id: 2,
      tool: issueTool,
      arguments: {
        issueKey: "EX-1",
        cloudId: "other",
        site: "other",
        host: "evil.example",
        path: "/rest/api/3/issue/EX-1",
        url: "https://evil.example",
      },
      credential,
    });
    expect(await toolErrorBody(refused)).toMatchObject({
      result: { structuredContent: { error: "invalid_arguments" } },
    });
    expect(calls).toBe(0);

    for (const issueKey of ["..", ".", "ABC-1/../x", "abc"]) {
      const invalidIssue = await noRouting({
        id: 3,
        tool: issueTool,
        arguments: { issueKey },
        credential,
      });
      expect(await toolErrorBody(invalidIssue)).toMatchObject({
        result: { structuredContent: { error: "invalid_arguments" } },
      });
    }
    expect(calls).toBe(0);

    const search = tool("jira_search_issues");
    const unbounded = await noRouting({
      id: 3,
      tool: search,
      arguments: { jql: "order by created DESC" },
      credential,
    });
    expect(await toolErrorBody(unbounded)).toMatchObject({
      result: {
        content: [{ text: "JQL must include a search restriction" }],
        structuredContent: { error: "unbounded_jql" },
      },
    });
    expect(calls).toBe(0);

    expect(
      noRouting({ id: 4, tool: issueTool, arguments: { issueKey: "EX-1" }, credential }),
    ).rejects.toThrow("Configured Jira site is not authorized");
    expect(calls).toBe(1);

    let missingCalls = 0;
    const missingSite = createJiraRestToolExecutor(descriptor, () => {
      missingCalls += 1;
      return Promise.resolve(
        Response.json([{ id: "other-cloud", url: "https://other.atlassian.net" }]),
      );
    });
    expect(
      missingSite({ id: 5, tool: issueTool, arguments: { issueKey: "EX-1" }, credential }),
    ).rejects.toThrow("Configured Jira site is not authorized");
    expect(missingCalls).toBe(1);
  });
});

function parseLogLine(line: string): Record<string, unknown> {
  const value: unknown = JSON.parse(line);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a structured Jira request log line");
  }
  return value as Record<string, unknown>;
}

describe("Jira REST write tools", () => {
  const writeDescriptor: GenericWrapperDescriptor = {
    ...descriptor,
    catalogPath: "/app/servers/generic-wrapper/catalog/jira/read-write.yaml",
    credential: {
      ...descriptor.credential,
      scopes: ["read:jira-user", "read:jira-work", "write:jira-work", "offline_access"],
    } as GenericWrapperDescriptor["credential"],
  };
  const writeCatalog = loadGenericToolCatalog(
    "servers/generic-wrapper/catalog/jira/read-write.yaml",
    "jira",
  );

  function writeTool(name: string) {
    const found = writeCatalog.tools.find((entry) => entry.exposedName === name);
    if (!found) throw new Error(`Missing test tool ${name}`);
    return found;
  }

  interface RecordedRequest {
    method: string;
    url: string;
    contentType: string | null;
    body: unknown;
  }

  function recordingExecutor(reply: (request: Request) => Response) {
    const requests: RecordedRequest[] = [];
    const execute = createJiraRestToolExecutor(writeDescriptor, async (input, init) => {
      const request =
        input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
      if (request.url.endsWith("/accessible-resources")) {
        return Response.json([{ id: "cloud-123", url: "https://site.atlassian.net/" }]);
      }
      const text = await request.clone().text();
      requests.push({
        method: request.method,
        url: request.url,
        contentType: request.headers.get("content-type"),
        body: text ? JSON.parse(text) : undefined,
      });
      expect(request.headers.get("authorization")).toBe("Bearer secret-token");
      expect(request.redirect).toBe("error");
      return reply(request);
    });
    return { execute, requests };
  }

  async function structured(response: Response): Promise<unknown> {
    const body = (await response.json()) as { result?: { structuredContent?: unknown } };
    return body.result?.structuredContent;
  }

  const base = "https://api.atlassian.com/ex/jira/cloud-123/rest/api/3";

  test("sends each write to the configured site and returns only what the agent needs next", async () => {
    const { execute, requests } = recordingExecutor((request) => {
      if (request.method === "POST" && request.url === `${base}/issue`) {
        return Response.json(
          { id: "10002", key: "EX-2", self: `${base}/issue/10002`, extra: "drop" },
          { status: 201 },
        );
      }
      if (request.method === "POST" && request.url.endsWith("/comment")) {
        return Response.json(
          { id: "20001", self: "drop", author: { emailAddress: "drop" } },
          { status: 201 },
        );
      }
      if (request.method === "GET" && request.url.endsWith("/transitions")) {
        return Response.json({
          expand: "drop",
          transitions: [
            {
              id: "31",
              name: "Done",
              to: { id: "3", name: "Done", self: "drop" },
              hasScreen: false,
              fields: { secret: "drop" },
            },
          ],
        });
      }
      return new Response(null, { status: 204 });
    });

    const calls: [string, Record<string, unknown>, unknown][] = [
      [
        "jira_create_issue",
        { projectKey: "EX", issueType: "Task", summary: "New work", description: "One\n\nTwo" },
        { id: "10002", key: "EX-2", url: "https://site.atlassian.net/browse/EX-2" },
      ],
      [
        "jira_add_comment",
        { issueKey: "EX-2", body: "Looks good" },
        { issueKey: "EX-2", commentId: "20001" },
      ],
      [
        "jira_list_transitions",
        { issueKey: "EX-2" },
        { transitions: [{ id: "31", name: "Done", to: { id: "3", name: "Done" } }] },
      ],
      [
        "jira_transition_issue",
        { issueKey: "EX-2", transitionId: "31" },
        { issueKey: "EX-2", transitionId: "31" },
      ],
      [
        "jira_update_issue",
        { issueKey: "EX-2", summary: "Renamed" },
        { issueKey: "EX-2", updatedFields: ["summary"] },
      ],
      [
        "jira_assign_issue",
        { issueKey: "EX-2", accountId: "557058:abc-123" },
        { issueKey: "EX-2", accountId: "557058:abc-123" },
      ],
      [
        "jira_assign_issue",
        { issueKey: "EX-2", accountId: null },
        { issueKey: "EX-2", accountId: null },
      ],
    ];
    for (const [name, args, expected] of calls) {
      const response = await execute({ id: 9, tool: writeTool(name), arguments: args, credential });
      const text = await response.clone().text();
      expect(text).not.toContain("secret-token");
      expect(text).not.toContain("drop");
      expect(text).not.toContain("cloud-123");
      expect(await structured(response)).toEqual(expected);
    }

    const paragraph = (text: string) => ({
      type: "paragraph",
      content: [{ type: "text", text }],
    });
    expect(requests).toEqual([
      {
        method: "POST",
        url: `${base}/issue`,
        contentType: "application/json",
        body: {
          fields: {
            project: { key: "EX" },
            issuetype: { name: "Task" },
            summary: "New work",
            description: {
              type: "doc",
              version: 1,
              content: [paragraph("One"), { type: "paragraph" }, paragraph("Two")],
            },
          },
        },
      },
      {
        method: "POST",
        url: `${base}/issue/EX-2/comment`,
        contentType: "application/json",
        body: { body: { type: "doc", version: 1, content: [paragraph("Looks good")] } },
      },
      { method: "GET", url: `${base}/issue/EX-2/transitions`, contentType: null, body: undefined },
      {
        method: "POST",
        url: `${base}/issue/EX-2/transitions`,
        contentType: "application/json",
        body: { transition: { id: "31" } },
      },
      {
        method: "PUT",
        url: `${base}/issue/EX-2`,
        contentType: "application/json",
        body: { fields: { summary: "Renamed" } },
      },
      {
        method: "PUT",
        url: `${base}/issue/EX-2/assignee`,
        contentType: "application/json",
        body: { accountId: "557058:abc-123" },
      },
      {
        method: "PUT",
        url: `${base}/issue/EX-2/assignee`,
        contentType: "application/json",
        body: { accountId: null },
      },
    ]);
  });

  test("replaces the whole description when an update sends one", async () => {
    const { execute, requests } = recordingExecutor(() => new Response(null, { status: 204 }));
    const response = await execute({
      id: 10,
      tool: writeTool("jira_update_issue"),
      arguments: { issueKey: "10002", summary: "S", description: "D" },
      credential,
    });

    expect(await structured(response)).toEqual({
      issueKey: "10002",
      updatedFields: ["summary", "description"],
    });
    expect(requests[0]?.body).toEqual({
      fields: {
        summary: "S",
        description: {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: "D" }] }],
        },
      },
    });
  });

  test("refuses invalid or extra write arguments before any provider request", async () => {
    let calls = 0;
    const execute = createJiraRestToolExecutor(writeDescriptor, () => {
      calls += 1;
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const refusals: [string, Record<string, unknown>][] = [
      ["jira_create_issue", { projectKey: "EX", issueType: "Task" }],
      ["jira_create_issue", { projectKey: "ex", issueType: "Task", summary: "S" }],
      ["jira_create_issue", { projectKey: "EX", issueType: " ", summary: "S" }],
      ["jira_create_issue", { projectKey: "EX", issueType: "Task", summary: "x".repeat(256) }],
      ["jira_create_issue", { projectKey: "EX", issueType: "Task", summary: "S", cloudId: "x" }],
      [
        "jira_create_issue",
        { projectKey: "EX", issueType: "Task", summary: "S", fields: { labels: ["x"] } },
      ],
      ["jira_add_comment", { issueKey: "EX-1" }],
      ["jira_add_comment", { issueKey: "../x", body: "B" }],
      ["jira_add_comment", { issueKey: "EX-1", body: "x".repeat(32_001) }],
      ["jira_list_transitions", { issueKey: "EX-1/../x" }],
      ["jira_transition_issue", { issueKey: "EX-1", transitionId: "abc" }],
      ["jira_transition_issue", { issueKey: "EX-1", transitionId: 31 }],
      ["jira_update_issue", { issueKey: "EX-1" }],
      ["jira_update_issue", { issueKey: "EX-1", summary: "S", priority: { name: "High" } }],
      ["jira_update_issue", { issueKey: "EX-1", summary: "" }],
      ["jira_assign_issue", { issueKey: "EX-1" }],
      ["jira_assign_issue", { issueKey: "EX-1", accountId: "a b" }],
      ["jira_assign_issue", { issueKey: "EX-1", accountId: 7 }],
    ];
    for (const [name, args] of refusals) {
      const response = await execute({
        id: 11,
        tool: writeTool(name),
        arguments: args,
        credential,
      });
      expect({ name, args, result: await structured(response) }).toEqual({
        name,
        args,
        result: { error: "invalid_arguments", message: "Invalid tool arguments" },
      });
    }
    expect(calls).toBe(0);
  });

  test("returns a sanitized failure for a refused write without copying the provider body", async () => {
    const { execute } = recordingExecutor(() =>
      Response.json({ errorMessages: ["secret detail"] }, { status: 400 }),
    );
    const response = await execute({
      id: 12,
      tool: writeTool("jira_add_comment"),
      arguments: { issueKey: "EX-1", body: "B" },
      credential,
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
  });
});

test("serves both shipped Jira REST catalogs and no other", () => {
  const ids = ["read-only", "read-write"].map(
    (name) =>
      loadGenericToolCatalog(`servers/generic-wrapper/catalog/jira/${name}.yaml`, "jira").catalogId,
  );

  expect([...JIRA_REST_CATALOG_IDS].sort()).toEqual(ids.sort());
});
