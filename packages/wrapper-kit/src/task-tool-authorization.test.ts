import { describe, expect, test } from "bun:test";
import {
  taskAuthority,
  taskClaims,
  withTaskAuthority,
} from "../../../test/support/task-authority-fixture";

import {
  parseTaskToolAuthorization,
  readTaskToolAuthorizationOptions,
} from "./task-tool-authorization";

describe("Task tool authorization", () => {
  test("accepts only an exact provider, resource, and action tuple from a Mint v3 Task token", () => {
    const authorization = parseTaskToolAuthorization(taskClaims);

    expect(authorization.restricted).toBe(true);
    expect(
      authorization.allows({ provider: "github", resource: "list_commits", action: "read" }),
    ).toBe(true);
    expect(
      authorization.allows({ provider: "github", resource: "get_commit", action: "read" }),
    ).toBe(false);
    expect(
      authorization.allows({ provider: "github", resource: "list_commits", action: "write" }),
    ).toBe(false);
    expect(
      authorization.allows({ provider: "gitlab", resource: "list_commits", action: "read" }),
    ).toBe(false);
  });

  test("fails closed when a Task token omits, empties, or malforms the tool claim", () => {
    const variants = [
      withTaskAuthority({ ...taskAuthority, tools: undefined }),
      withTaskAuthority({ ...taskAuthority, tools: [] }),
      withTaskAuthority({ ...taskAuthority, tools: "github:list_commits:read" }),
      withTaskAuthority({
        ...taskAuthority,
        tools: [{ provider: "github", resource: "list_commits" }],
      }),
    ];

    for (const claims of variants) {
      const authorization = parseTaskToolAuthorization(claims);
      expect(authorization.restricted).toBe(true);
      expect(
        authorization.allows({ provider: "github", resource: "list_commits", action: "read" }),
      ).toBe(false);
    }
  });

  test("leaves interactive tokens unrestricted and limits the connection-status bridge", () => {
    const interactive = parseTaskToolAuthorization({
      iss: "https://identity.example.com",
      sub: "user-123",
      email: "alice@example.com",
    });
    const connectionStatus = parseTaskToolAuthorization(
      withTaskAuthority(connectionStatusClaims("github")),
    );

    expect(interactive.restricted).toBe(false);
    expect(interactive.allowsConnectionHelpers).toBe(true);
    expect(connectionStatus.restricted).toBe(true);
    expect(connectionStatus.allowsConnectionHelpers).toBe(false);
    expect(
      connectionStatus.allows({
        provider: "github",
        resource: "provider-control",
        action: "status",
      }),
    ).toBe(true);
    expect(
      connectionStatus.allows({ provider: "github", resource: "list_commits", action: "read" }),
    ).toBe(false);
    for (const authority of [
      { ...connectionStatusClaims(), service: "other-service" },
      { ...connectionStatusClaims(), tools: [] },
      {
        ...connectionStatusClaims(),
        tools: [{ provider: "github", resource: "provider-control", action: "start" }],
      },
    ]) {
      expect(parseTaskToolAuthorization(withTaskAuthority(authority)).restricted).toBe(true);
    }
  });

  test("binds connection-status authority to exactly the requested provider", () => {
    const github = parseTaskToolAuthorization(withTaskAuthority(connectionStatusClaims("github")));
    const jira = parseTaskToolAuthorization(withTaskAuthority(connectionStatusClaims("jira")));
    const githubStatus = {
      provider: "github",
      resource: "provider-control",
      action: "status",
    };
    const jiraStatus = {
      provider: "jira",
      resource: "provider-control",
      action: "status",
    };

    expect(github.allows(githubStatus)).toBe(true);
    expect(github.allows(jiraStatus)).toBe(false);
    expect(jira.allows(jiraStatus)).toBe(true);
    expect(jira.allows(githubStatus)).toBe(false);
  });

  test("the temporary compatibility opt-out applies only to a missing tool claim", () => {
    const missing = withTaskAuthority({ ...taskAuthority, tools: undefined });
    const malformed = withTaskAuthority({
      ...taskAuthority,
      tools: [{ provider: "github" }],
    });

    expect(
      parseTaskToolAuthorization(missing, { allowLegacyUnscopedTaskTokens: true }).restricted,
    ).toBe(false);
    expect(
      parseTaskToolAuthorization(malformed, { allowLegacyUnscopedTaskTokens: true }).restricted,
    ).toBe(true);
  });

  test("older claim versions fail closed even when they carry tool approvals", () => {
    for (const version of [1, 2]) {
      const authorization = parseTaskToolAuthorization(
        withTaskAuthority({ ...taskAuthority, version }),
        { allowLegacyUnscopedTaskTokens: true },
      );
      expect(authorization.restricted).toBe(true);
      expect(
        authorization.allows({ provider: "github", resource: "list_commits", action: "read" }),
      ).toBe(false);
    }
  });

  test("reads the legacy opt-out strictly and defaults to enforcement", () => {
    expect(readTaskToolAuthorizationOptions({})).toEqual({
      allowLegacyUnscopedTaskTokens: false,
    });
    expect(
      readTaskToolAuthorizationOptions({
        MCP_GW_ALLOW_LEGACY_UNSCOPED_TASK_TOKENS: "true",
      }),
    ).toEqual({ allowLegacyUnscopedTaskTokens: true });
    expect(() =>
      readTaskToolAuthorizationOptions({
        MCP_GW_ALLOW_LEGACY_UNSCOPED_TASK_TOKENS: "yes",
      }),
    ).toThrow("must be true or false");
  });
});

function connectionStatusClaims(provider = "github"): Record<string, unknown> {
  return {
    acting_as: "service_for_user",
    service: ["ste", "ward-apiserver"].join(""),
    purpose: "provider_connection_status",
    tools: [{ provider, resource: "provider-control", action: "status" }],
    version: 3,
  };
}
