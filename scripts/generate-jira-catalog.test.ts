import { describe, expect, test } from "bun:test";

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
      inputSchema: { type: "object", properties: { issueKey: { type: "string" } } },
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
        grants: {
          actionClass: "read",
          operation: "jira.issue.get",
          scopes: ["read:jira:agent-interface"],
        },
      },
    ]);
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

  test("rejects tools that the upstream marks destructive", () => {
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

    expect(() => buildJiraCatalog(destructiveCapture, include, serialized)).toThrow(
      "is destructive upstream",
    );
  });
});
