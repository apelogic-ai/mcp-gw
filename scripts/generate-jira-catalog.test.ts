import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";

import { GITHUB_MCP_TOOL_NAMES } from "../servers/github-mcp/wrapper/src/catalog/github-mcp";
import {
  buildJiraCatalog,
  captureSha256,
  JIRA_CAPTURE_SCHEMA_VERSION,
  JIRA_DECISIONS_SCHEMA_VERSION,
  JIRA_MCP_UPSTREAM,
} from "./generate-jira-catalog";

const capture = {
  schemaVersion: JIRA_CAPTURE_SCHEMA_VERSION,
  provider: "jira",
  upstream: JIRA_MCP_UPSTREAM,
  capturedAt: "2026-10-07T00:00:00.000Z",
  pages: 2,
  tools: [
    {
      name: "getJiraIssue",
      description: "Get an issue.",
      inputSchema: {
        type: "object",
        properties: {
          cloudId: { type: "string", description: "Jira Cloud site URL." },
          issueKey: { type: "string" },
        },
        required: ["cloudId", "issueKey"],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "createJiraIssue",
      description: "Create an issue.",
      inputSchema: { type: "object", properties: { summary: { type: "string" } } },
      annotations: { readOnlyHint: false },
    },
    {
      name: "search",
      description: "Search Teamwork Graph.",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    },
  ],
};
const serializedCapture = `${JSON.stringify(capture, null, 2)}\n`;
const decisions = {
  schemaVersion: JIRA_DECISIONS_SCHEMA_VERSION,
  catalogId: "atlassian-rovo-v2@2026-10-07+fixture",
  captureSha256: captureSha256(serializedCapture),
  tools: [
    {
      name: "getJiraIssue",
      disposition: "include",
      alias: "get_issue",
      actionClass: "read",
      operation: "jira.issue.get",
      scopes: ["read:jira:agent-interface"],
    },
    {
      name: "createJiraIssue",
      disposition: "include",
      alias: "create_issue",
      actionClass: "write",
      operation: "jira.issue.create",
      scopes: ["write:jira:agent-interface"],
    },
    { name: "search", disposition: "exclude", reason: "credit_bearing_search" },
  ],
};

describe("Jira catalog generation", () => {
  test("uses a formatting-independent canonical capture digest", () => {
    expect(captureSha256(serializedCapture)).toBe(captureSha256(JSON.stringify(capture)));
  });

  test("keeps the checked-in Jira catalog synchronized with its captured provenance", async () => {
    const checkedInCapture = await Bun.file(
      "servers/generic-wrapper/catalog/jira/capture-v2-2026-10-07.json",
    ).text();
    const checkedInDecisions = parseYaml(
      await Bun.file("servers/generic-wrapper/catalog/jira/decisions.yaml").text(),
    ) as unknown;
    const checkedInCatalog = parseYaml(
      await Bun.file("deploy/k8s/chart/files/catalogs/jira.yaml").text(),
    ) as unknown;

    expect(
      buildJiraCatalog(
        JSON.parse(checkedInCapture) as unknown,
        checkedInDecisions,
        checkedInCapture,
      ),
    ).toEqual(checkedInCatalog);
  });

  test("does not collide with the GitHub wrapper catalog when federated", async () => {
    const checkedInCatalog = parseYaml(
      await Bun.file("deploy/k8s/chart/files/catalogs/jira.yaml").text(),
    ) as { tools: Array<{ alias?: string; name: string }> };
    const jiraNames = [
      ...checkedInCatalog.tools.map((tool) => `jira_${tool.alias ?? tool.name}`),
      "jira_oauth_status",
      "jira_oauth_start",
    ];
    const githubNames = new Set([
      ...GITHUB_MCP_TOOL_NAMES,
      "github_oauth_status",
      "github_oauth_start",
    ]);

    expect(jiraNames.filter((name) => githubNames.has(name))).toEqual([]);
    expect(new Set(jiraNames).size).toBe(jiraNames.length);
  });

  test("requires explicit decisions for the complete digest-pinned capture", () => {
    const catalog = buildJiraCatalog(capture, decisions, serializedCapture);

    expect(catalog.catalogId).toBe("atlassian-rovo-v2@2026-10-07+fixture");
    expect(catalog.tools.map((tool) => tool.alias)).toEqual(["create_issue", "get_issue"]);
    expect(catalog.tools).toMatchObject([
      {
        name: "createJiraIssue",
        grants: {
          actionClass: "write",
          operation: "jira.issue.create",
          scopes: ["write:jira:agent-interface"],
        },
      },
      {
        name: "getJiraIssue",
        inputSchema: {
          properties: { issueKey: { type: "string" } },
          required: ["issueKey"],
        },
        grants: {
          actionClass: "read",
          operation: "jira.issue.get",
          scopes: ["read:jira:agent-interface"],
        },
      },
    ]);
    expect(catalog.tools[1]?.inputSchema).not.toHaveProperty("properties.cloudId");
    expect(catalog.tools.some((tool) => tool.name === "search")).toBeFalse();
  });

  test("rejects a decision file for another capture", () => {
    expect(() =>
      buildJiraCatalog(capture, { ...decisions, captureSha256: "0".repeat(64) }, serializedCapture),
    ).toThrow("received sha256");
  });

  test("rejects captured tools without an explicit decision", () => {
    expect(() =>
      buildJiraCatalog(
        capture,
        { ...decisions, tools: decisions.tools.slice(0, 2) },
        serializedCapture,
      ),
    ).toThrow("tools without decisions: search");
  });

  test("cannot include the credit-bearing search fallback", () => {
    expect(() =>
      buildJiraCatalog(
        capture,
        {
          ...decisions,
          tools: [
            ...decisions.tools.slice(0, 2),
            {
              name: "search",
              disposition: "include",
              alias: "search",
              actionClass: "read",
              operation: "jira.rovo.search",
              scopes: ["search:jira:agent-interface"],
            },
          ],
        },
        serializedCapture,
      ),
    ).toThrow("credit-bearing Atlassian search tool");
  });

  test("rejects invalid scope grants", () => {
    const destructiveCapture = {
      ...capture,
      tools: [
        {
          name: "deleteJiraIssue",
          description: "Delete an issue.",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: false, destructiveHint: true },
        },
      ],
    };
    const serialized = `${JSON.stringify(destructiveCapture, null, 2)}\n`;
    const include = {
      ...decisions,
      captureSha256: captureSha256(serialized),
      tools: [
        {
          name: "deleteJiraIssue",
          disposition: "include",
          alias: "delete_issue",
          actionClass: "write",
          operation: "jira.issue.delete",
          scopes: ["delete:jira:agent-interface"],
        },
      ],
    };

    expect(() => buildJiraCatalog(destructiveCapture, include, serialized)).toThrow(
      "unsupported scope delete:jira:agent-interface",
    );
  });

  test("preserves upstream destructive annotations for included non-delete tools", () => {
    const destructiveCapture = {
      ...capture,
      tools: [
        {
          name: "dangerousMutation",
          description: "Mutate destructively.",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: false, destructiveHint: true },
        },
      ],
    };
    const serialized = `${JSON.stringify(destructiveCapture, null, 2)}\n`;
    const include = {
      ...decisions,
      captureSha256: captureSha256(serialized),
      tools: [
        {
          name: "dangerousMutation",
          disposition: "include",
          alias: "dangerous_mutation",
          actionClass: "write",
          operation: "jira.issue.mutate",
          scopes: ["write:jira:agent-interface"],
        },
      ],
    };

    expect(buildJiraCatalog(destructiveCapture, include, serialized).tools).toMatchObject([
      {
        alias: "dangerous_mutation",
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
    ]);
  });
});
