import { describe, expect, test } from "bun:test";

import {
  GITHUB_MCP_CATALOG_ID,
  GITHUB_MCP_READ_ONLY_TOOL_NAMES,
  GITHUB_MCP_TOOL_GRANTS,
  GITHUB_MCP_TOOL_NAMES,
  classifyGithubToolAction,
  listStableGithubTools,
  parseGithubMcpToolsets,
} from "./github-mcp";

const EXPECTED_TOOL_NAMES = [
  "actions_get",
  "actions_list",
  "actions_run_trigger",
  "add_comment_to_pending_review",
  "add_issue_comment",
  "add_reply_to_pull_request_comment",
  "assign_copilot_to_issue",
  "create_branch",
  "create_gist",
  "create_or_update_file",
  "create_pull_request",
  "create_repository",
  "delete_file",
  "discussion_comment_write",
  "dismiss_notification",
  "fork_repository",
  "get_code_quality_finding",
  "get_code_scanning_alert",
  "get_commit",
  "get_dependabot_alert",
  "get_discussion",
  "get_discussion_comments",
  "get_file_contents",
  "get_gist",
  "get_global_security_advisory",
  "get_job_logs",
  "get_label",
  "get_latest_release",
  "get_me",
  "get_notification_details",
  "get_release_by_tag",
  "get_repository_tree",
  "get_secret_scanning_alert",
  "get_tag",
  "get_team_members",
  "get_teams",
  "issue_read",
  "issue_write",
  "label_write",
  "list_branches",
  "list_code_scanning_alerts",
  "list_commits",
  "list_dependabot_alerts",
  "list_discussion_categories",
  "list_discussions",
  "list_gists",
  "list_global_security_advisories",
  "list_issue_fields",
  "list_issue_types",
  "list_issues",
  "list_label",
  "list_notifications",
  "list_org_repository_security_advisories",
  "list_pull_requests",
  "list_releases",
  "list_repository_collaborators",
  "list_repository_security_advisories",
  "list_secret_scanning_alerts",
  "list_starred_repositories",
  "list_tags",
  "manage_notification_subscription",
  "manage_repository_notification_subscription",
  "mark_all_notifications_read",
  "merge_pull_request",
  "projects_get",
  "projects_list",
  "projects_write",
  "pull_request_read",
  "pull_request_review_write",
  "push_files",
  "request_copilot_review",
  "search_code",
  "search_commits",
  "search_issues",
  "search_orgs",
  "search_pull_requests",
  "search_repositories",
  "search_users",
  "star_repository",
  "sub_issue_write",
  "unstar_repository",
  "update_gist",
  "update_pull_request",
  "update_pull_request_branch",
] as const;

const EXPECTED_READ_ONLY_TOOLS = [
  "actions_get",
  "actions_list",
  "get_code_quality_finding",
  "get_code_scanning_alert",
  "get_commit",
  "get_dependabot_alert",
  "get_discussion",
  "get_discussion_comments",
  "get_file_contents",
  "get_gist",
  "get_global_security_advisory",
  "get_job_logs",
  "get_label",
  "get_latest_release",
  "get_me",
  "get_notification_details",
  "get_release_by_tag",
  "get_repository_tree",
  "get_secret_scanning_alert",
  "get_tag",
  "get_team_members",
  "get_teams",
  "issue_read",
  "list_branches",
  "list_code_scanning_alerts",
  "list_commits",
  "list_dependabot_alerts",
  "list_discussion_categories",
  "list_discussions",
  "list_gists",
  "list_global_security_advisories",
  "list_issue_fields",
  "list_issue_types",
  "list_issues",
  "list_label",
  "list_notifications",
  "list_org_repository_security_advisories",
  "list_pull_requests",
  "list_releases",
  "list_repository_collaborators",
  "list_repository_security_advisories",
  "list_secret_scanning_alerts",
  "list_starred_repositories",
  "list_tags",
  "projects_get",
  "projects_list",
  "pull_request_read",
  "search_code",
  "search_commits",
  "search_issues",
  "search_orgs",
  "search_pull_requests",
  "search_repositories",
  "search_users",
] as const;

const EXPECTED_WRITE_ONLY_TOOLS = [
  "add_comment_to_pending_review",
  "add_issue_comment",
  "add_reply_to_pull_request_comment",
  "assign_copilot_to_issue",
  "create_branch",
  "create_gist",
  "create_or_update_file",
  "create_pull_request",
  "create_repository",
  "dismiss_notification",
  "fork_repository",
  "issue_write",
  "mark_all_notifications_read",
  "merge_pull_request",
  "push_files",
  "request_copilot_review",
  "star_repository",
  "unstar_repository",
  "update_gist",
  "update_pull_request",
  "update_pull_request_branch",
] as const;

const MIXED_TOOL_CASES = [
  {
    name: "actions_run_trigger",
    selector: "method",
    write: ["run_workflow", "rerun_workflow_run", "rerun_failed_jobs"],
    destructive: ["cancel_workflow_run", "delete_workflow_run_logs"],
  },
  {
    name: "discussion_comment_write",
    selector: "method",
    write: ["add", "reply", "update", "mark_answer", "unmark_answer"],
    destructive: ["delete"],
  },
  {
    name: "label_write",
    selector: "method",
    write: ["create", "update"],
    destructive: ["delete"],
  },
  {
    name: "manage_notification_subscription",
    selector: "action",
    write: ["ignore", "watch"],
    destructive: ["delete"],
  },
  {
    name: "manage_repository_notification_subscription",
    selector: "action",
    write: ["ignore", "watch"],
    destructive: ["delete"],
  },
  {
    name: "projects_write",
    selector: "method",
    write: [
      "add_project_item",
      "update_project_item",
      "create_project_status_update",
      "create_project",
      "create_iteration_field",
    ],
    destructive: ["delete_project_item"],
  },
  {
    name: "pull_request_review_write",
    selector: "method",
    write: ["create", "submit_pending", "resolve_thread", "unresolve_thread"],
    destructive: ["delete_pending"],
  },
  {
    name: "sub_issue_write",
    selector: "method",
    write: ["add", "reprioritize"],
    destructive: ["remove"],
  },
] as const;

describe("pinned GitHub MCP tool catalog", () => {
  test("matches the complete v1.6.0 all-toolsets unrestricted runtime surface", () => {
    expect(GITHUB_MCP_CATALOG_ID).toBe("github-mcp-server@1.6.0/all");
    expect(GITHUB_MCP_TOOL_NAMES).toEqual(EXPECTED_TOOL_NAMES);
    expect(new Set(GITHUB_MCP_TOOL_NAMES).size).toBe(84);
    expect(GITHUB_MCP_READ_ONLY_TOOL_NAMES).toEqual(EXPECTED_READ_ONLY_TOOLS);
  });

  test("derives exact stable catalogs from the configured pinned toolsets", () => {
    expect(listStableGithubTools(parseGithubMcpToolsets("default"), undefined)).toHaveLength(44);
    expect(
      listStableGithubTools(
        parseGithubMcpToolsets(
          "default,actions,code_security,discussions,notifications,orgs,projects",
        ),
        GITHUB_MCP_CATALOG_ID,
      ),
    ).toHaveLength(65);
    expect(listStableGithubTools(parseGithubMcpToolsets("all"), undefined)).toHaveLength(84);
    expect(
      listStableGithubTools(parseGithubMcpToolsets("actions,gists"), undefined).map(
        (tool) => tool.name,
      ),
    ).toEqual([
      "actions_get",
      "actions_list",
      "actions_run_trigger",
      "create_gist",
      "get_gist",
      "get_job_logs",
      "list_gists",
      "update_gist",
    ]);
  });

  test("uses the shipped bundle selection, expands default, and fails closed for drift", () => {
    expect(parseGithubMcpToolsets(undefined)).toEqual([
      "context",
      "copilot",
      "issues",
      "pull_requests",
      "repos",
      "users",
      "actions",
      "code_security",
      "discussions",
      "notifications",
      "orgs",
      "projects",
    ]);
    expect(parseGithubMcpToolsets("repos,default,repos")).toEqual([
      "repos",
      "context",
      "copilot",
      "issues",
      "pull_requests",
      "users",
    ]);
    expect(() => parseGithubMcpToolsets("default,future_toolset")).toThrow(
      "unsupported toolset future_toolset",
    );
    expect(() => parseGithubMcpToolsets(",,")).toThrow("must enable at least one");
  });

  test("publishes every canonical grant, including both actions for mixed tools", () => {
    const expected = [
      ...EXPECTED_READ_ONLY_TOOLS.map((resource) => ({
        provider: "github" as const,
        resource,
        action: "read" as const,
      })),
      ...EXPECTED_WRITE_ONLY_TOOLS.map((resource) => ({
        provider: "github" as const,
        resource,
        action: "write" as const,
      })),
      {
        provider: "github" as const,
        resource: "delete_file" as const,
        action: "destructive" as const,
      },
      ...MIXED_TOOL_CASES.flatMap(({ name: resource }) => [
        { provider: "github" as const, resource, action: "write" as const },
        { provider: "github" as const, resource, action: "destructive" as const },
      ]),
    ];

    expect(GITHUB_MCP_TOOL_GRANTS).toEqual(expected);
    expect(new Set(GITHUB_MCP_TOOL_GRANTS.map((grant) => JSON.stringify(grant))).size).toBe(92);
  });

  test("classifies every fixed-action catalog tool", () => {
    for (const toolName of EXPECTED_READ_ONLY_TOOLS) {
      expect(classifyGithubToolAction(toolName, {})).toBe("read");
    }
    for (const toolName of EXPECTED_WRITE_ONLY_TOOLS) {
      expect(classifyGithubToolAction(toolName, {})).toBe("write");
    }
    expect(classifyGithubToolAction("delete_file", {})).toBe("destructive");
  });

  test("classifies every exact selector of mixed-action tools", () => {
    for (const tool of MIXED_TOOL_CASES) {
      for (const value of tool.write) {
        expect(classifyGithubToolAction(tool.name, { [tool.selector]: value })).toBe("write");
      }
      for (const value of tool.destructive) {
        expect(classifyGithubToolAction(tool.name, { [tool.selector]: value })).toBe("destructive");
      }
      expect(classifyGithubToolAction(tool.name, {})).toBeUndefined();
      expect(classifyGithubToolAction(tool.name, { [tool.selector]: "unknown" })).toBeUndefined();
      expect(classifyGithubToolAction(tool.name, { [tool.selector]: 42 })).toBeUndefined();
    }
  });

  test("keeps wrapper OAuth controls outside the selectable grant catalog", () => {
    const resources = GITHUB_MCP_TOOL_GRANTS.map((grant) => grant.resource as string);
    expect(resources).not.toContain("github_oauth_status");
    expect(resources).not.toContain("github_oauth_start");
    expect(classifyGithubToolAction("github_oauth_status", {})).toBe("read");
    expect(classifyGithubToolAction("github_oauth_start", {})).toBe("write");
  });

  test("fails closed for unknown tools", () => {
    expect(classifyGithubToolAction("totally_new_tool", {})).toBeUndefined();
  });
});
