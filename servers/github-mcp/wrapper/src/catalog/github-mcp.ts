import type { PolicyActionClass } from "../../../../../shared/policy/policy";

/** Exact tools/list contract from github-mcp-server v1.6.0 with GITHUB_TOOLSETS=all. */
export const GITHUB_MCP_CATALOG_ID = "github-mcp-server@1.6.0/all" as const;

export const GITHUB_MCP_TOOL_NAMES = [
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

export type GithubMcpToolName = (typeof GITHUB_MCP_TOOL_NAMES)[number];

export const GITHUB_MCP_READ_ONLY_TOOL_NAMES = [
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
] as const satisfies readonly GithubMcpToolName[];

const WRITE_ONLY_TOOL_NAMES = [
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
] as const satisfies readonly GithubMcpToolName[];

interface DynamicActionRule {
  selector: "method" | "action";
  values: Readonly<Record<string, "write" | "destructive">>;
}

const DYNAMIC_ACTION_RULES: Readonly<Partial<Record<GithubMcpToolName, DynamicActionRule>>> = {
  actions_run_trigger: {
    selector: "method",
    values: {
      run_workflow: "write",
      rerun_workflow_run: "write",
      rerun_failed_jobs: "write",
      cancel_workflow_run: "destructive",
      delete_workflow_run_logs: "destructive",
    },
  },
  discussion_comment_write: {
    selector: "method",
    values: {
      add: "write",
      reply: "write",
      update: "write",
      delete: "destructive",
      mark_answer: "write",
      unmark_answer: "write",
    },
  },
  label_write: {
    selector: "method",
    values: { create: "write", update: "write", delete: "destructive" },
  },
  manage_notification_subscription: {
    selector: "action",
    values: { ignore: "write", watch: "write", delete: "destructive" },
  },
  manage_repository_notification_subscription: {
    selector: "action",
    values: { ignore: "write", watch: "write", delete: "destructive" },
  },
  projects_write: {
    selector: "method",
    values: {
      add_project_item: "write",
      update_project_item: "write",
      delete_project_item: "destructive",
      create_project_status_update: "write",
      create_project: "write",
      create_iteration_field: "write",
    },
  },
  pull_request_review_write: {
    selector: "method",
    values: {
      create: "write",
      submit_pending: "write",
      delete_pending: "destructive",
      resolve_thread: "write",
      unresolve_thread: "write",
    },
  },
  sub_issue_write: {
    selector: "method",
    values: { add: "write", remove: "destructive", reprioritize: "write" },
  },
};

export interface GithubMcpToolGrant {
  provider: "github";
  resource: GithubMcpToolName;
  action: PolicyActionClass;
}

export interface GithubMcpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean | undefined;
  idempotentHint: boolean;
}

export interface GithubMcpToolDefinition {
  name: GithubMcpToolName;
  grantActions: readonly PolicyActionClass[];
  annotations: GithubMcpToolAnnotations;
}

const READ_ONLY_TOOLS = new Set<string>(GITHUB_MCP_READ_ONLY_TOOL_NAMES);
const WRITE_ONLY_TOOLS = new Set<string>(WRITE_ONLY_TOOL_NAMES);
const DYNAMIC_TOOLS = new Set<string>(Object.keys(DYNAMIC_ACTION_RULES));
const UPSTREAM_DESTRUCTIVE_HINT_TOOLS = new Set<string>([
  "actions_run_trigger",
  "delete_file",
  "discussion_comment_write",
  "projects_write",
]);

export const GITHUB_MCP_TOOLS: readonly GithubMcpToolDefinition[] = GITHUB_MCP_TOOL_NAMES.map(
  (name) => ({
    name,
    grantActions: grantActionsForTool(name),
    annotations: {
      readOnlyHint: READ_ONLY_TOOLS.has(name),
      destructiveHint: UPSTREAM_DESTRUCTIVE_HINT_TOOLS.has(name) ? true : undefined,
      idempotentHint: name === "assign_copilot_to_issue",
    },
  }),
);

const TOOL_DEFINITIONS = new Map(GITHUB_MCP_TOOLS.map((tool) => [tool.name, tool]));

export const GITHUB_MCP_TOOL_GRANTS: readonly GithubMcpToolGrant[] = [
  ...GITHUB_MCP_READ_ONLY_TOOL_NAMES.map((resource) => ({
    provider: "github" as const,
    resource,
    action: "read" as const,
  })),
  ...WRITE_ONLY_TOOL_NAMES.map((resource) => ({
    provider: "github" as const,
    resource,
    action: "write" as const,
  })),
  { provider: "github", resource: "delete_file", action: "destructive" },
  ...Object.keys(DYNAMIC_ACTION_RULES).flatMap((resource) => [
    {
      provider: "github" as const,
      resource: resource as GithubMcpToolName,
      action: "write" as const,
    },
    {
      provider: "github" as const,
      resource: resource as GithubMcpToolName,
      action: "destructive" as const,
    },
  ]),
];

const LOCAL_TOOL_ACTIONS: Readonly<Record<string, PolicyActionClass>> = {
  github_oauth_status: "read",
  github_oauth_start: "write",
};

export function classifyGithubToolAction(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): PolicyActionClass | undefined {
  const localAction = LOCAL_TOOL_ACTIONS[toolName];
  if (localAction) return localAction;
  if (READ_ONLY_TOOLS.has(toolName)) return "read";
  if (WRITE_ONLY_TOOLS.has(toolName)) return "write";
  if (toolName === "delete_file") return "destructive";

  const rule = DYNAMIC_ACTION_RULES[toolName as GithubMcpToolName];
  if (!rule) return undefined;
  const selector = args[rule.selector];
  return typeof selector === "string" ? rule.values[selector] : undefined;
}

export function isPinnedGithubTool(toolName: string): toolName is GithubMcpToolName {
  return TOOL_DEFINITIONS.has(toolName as GithubMcpToolName);
}

export function pinnedGithubToolAnnotationsMatch(toolName: string, annotations: unknown): boolean {
  if (!isRecord(annotations)) return false;
  const expected = TOOL_DEFINITIONS.get(toolName as GithubMcpToolName)?.annotations;
  return (
    expected !== undefined &&
    annotations.readOnlyHint === expected.readOnlyHint &&
    annotations.destructiveHint === expected.destructiveHint &&
    annotations.idempotentHint === expected.idempotentHint
  );
}

function grantActionsForTool(toolName: GithubMcpToolName): readonly PolicyActionClass[] {
  if (READ_ONLY_TOOLS.has(toolName)) return ["read"];
  if (WRITE_ONLY_TOOLS.has(toolName)) return ["write"];
  if (toolName === "delete_file") return ["destructive"];
  if (DYNAMIC_TOOLS.has(toolName)) return ["write", "destructive"];
  throw new Error(`missing GitHub MCP classification for ${toolName}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
