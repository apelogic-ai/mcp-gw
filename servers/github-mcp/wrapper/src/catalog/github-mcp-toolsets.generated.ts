// Generated from github-mcp-server v1.6.0 source metadata at
// ghcr.io/github/github-mcp-server@sha256:2b0c48b070f61e9d3969269ead600f62d00fb237b60ac849ef3d166ee7de9ad3.
// Keep this map aligned with the pinned catalog conformance fixture.

export const GITHUB_MCP_DEFAULT_TOOLSETS = [
  "context",
  "copilot",
  "issues",
  "pull_requests",
  "repos",
  "users",
] as const;

export const GITHUB_MCP_TOOLSET_TOOL_NAMES = {
  actions: ["actions_get", "actions_list", "actions_run_trigger", "get_job_logs"],
  code_quality: ["get_code_quality_finding"],
  code_security: ["get_code_scanning_alert", "list_code_scanning_alerts"],
  context: ["get_me", "get_team_members", "get_teams"],
  copilot: ["assign_copilot_to_issue", "request_copilot_review"],
  dependabot: ["get_dependabot_alert", "list_dependabot_alerts"],
  discussions: [
    "discussion_comment_write",
    "get_discussion",
    "get_discussion_comments",
    "list_discussion_categories",
    "list_discussions",
  ],
  gists: ["create_gist", "get_gist", "list_gists", "update_gist"],
  git: ["get_repository_tree"],
  issues: [
    "add_issue_comment",
    "get_label",
    "issue_read",
    "issue_write",
    "list_issue_fields",
    "list_issue_types",
    "list_issues",
    "search_issues",
    "sub_issue_write",
  ],
  labels: ["get_label", "label_write", "list_label"],
  notifications: [
    "dismiss_notification",
    "get_notification_details",
    "list_notifications",
    "manage_notification_subscription",
    "manage_repository_notification_subscription",
    "mark_all_notifications_read",
  ],
  orgs: ["search_orgs"],
  projects: ["projects_get", "projects_list", "projects_write"],
  pull_requests: [
    "add_comment_to_pending_review",
    "add_reply_to_pull_request_comment",
    "create_pull_request",
    "list_pull_requests",
    "merge_pull_request",
    "pull_request_read",
    "pull_request_review_write",
    "search_pull_requests",
    "update_pull_request",
    "update_pull_request_branch",
  ],
  repos: [
    "create_branch",
    "create_or_update_file",
    "create_repository",
    "delete_file",
    "fork_repository",
    "get_commit",
    "get_file_contents",
    "get_latest_release",
    "get_release_by_tag",
    "get_tag",
    "list_branches",
    "list_commits",
    "list_releases",
    "list_repository_collaborators",
    "list_tags",
    "push_files",
    "search_code",
    "search_commits",
    "search_repositories",
  ],
  secret_protection: ["get_secret_scanning_alert", "list_secret_scanning_alerts"],
  security_advisories: [
    "get_global_security_advisory",
    "list_global_security_advisories",
    "list_org_repository_security_advisories",
    "list_repository_security_advisories",
  ],
  stargazers: ["list_starred_repositories", "star_repository", "unstar_repository"],
  users: ["search_users"],
} as const;

export type GithubMcpToolsetName = keyof typeof GITHUB_MCP_TOOLSET_TOOL_NAMES;

export const GITHUB_MCP_TOOLSET_NAMES = Object.freeze(
  Object.keys(GITHUB_MCP_TOOLSET_TOOL_NAMES) as GithubMcpToolsetName[],
);
