import { describe, expect, test } from "bun:test";

import { loadGenericToolCatalog, type GenericWrapperDescriptor } from "./descriptor";
import { createJiraRestToolExecutor } from "./jira-rest";

const descriptor: GenericWrapperDescriptor = {
  schemaVersion: "mcp-gateway.generic-wrapper/v1",
  name: "jira",
  toolPrefix: "jira",
  catalogPath: "/app/servers/generic-wrapper/catalog/jira/read-only.yaml",
  lifecycleRoutes: true,
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
    expect(await refused.json()).toMatchObject({
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
      expect(await invalidIssue.json()).toMatchObject({
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
    expect(await unbounded.json()).toMatchObject({
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
