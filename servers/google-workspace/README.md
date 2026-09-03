# Google Workspace MCP wrapper

This backend exposes Google Workspace tools through the shared gateway.

Current implementation status:

- HOP-1 identity validation supports one or more issuer profiles.
- HOP-2 per-user Google OAuth stores encrypted refresh tokens in Postgres.
- The request-scoped tool registry obtains scoped Google access tokens before invoking `gws`.
- The catalog includes curated Google Workspace tools plus `google_workspace_gws`, a raw `gws`
  passthrough for dynamic Discovery methods, helper commands, schema introspection, pagination,
  dry-run, uploads/downloads, and future CLI/API additions.
- The default visible generated catalog is filtered to Drive, Gmail, Calendar, Docs, Sheets, Slides,
  Tasks, limited Meet, and workflow helpers.
- `GOOGLE_OAUTH_SCOPES` can replace the default compact consent scope set when a deployment
  intentionally enables a broader or narrower surface.

## Governed catalog contract

The selectable provider catalog is
`google-workspace-cli@0.22.5/visible-v1/actions-v1`: exactly 280 grants (110 `read`, 120 `write`,
and 50 `destructive`). Its canonical grant-list digest is
`sha256:3e333e2776e9686279c357f78b362c12e727692fa3f96121d78d7cb0ab76e482`.

Enable it explicitly with
`GOOGLE_WORKSPACE_GOVERNANCE_CATALOG=google-workspace-cli@0.22.5/visible-v1/actions-v1`.
With that variable absent, the wrapper retains its legacy tools/list, annotations, action classes,
and policy inputs unchanged. Any other catalog ID is rejected at startup.

Every ordinary tool is authorized as `{ provider: <tool service>, resource: <tool name>, action:
<action class> }`. The existing service values (`drive`, `gmail`, `calendar`, and so on) remain the
authority key; “Google Workspace” is only a display grouping. The `google_oauth_status` and
`google_oauth_start` controls are internal connection operations and are not part of the 280
selectable grants.

Per-service provider grants remain valid. Opting into the catalog requires reissuing only grants for
operations reclassified from `write` to `destructive`; existing authority is not silently
reinterpreted.

## Full `gws` passthrough

Use `google_workspace_gws` when a client needs an upstream CLI capability that does not have a
dedicated ergonomic MCP tool yet.

Input:

- `argv`: arguments after the `gws` binary, for example
  `["slides", "presentations", "get", "--params", "{\"presentationId\":\"...\"}"]`.
- `scopes`: Google OAuth scopes required for that exact command.

The tool returns raw stdout so it can represent JSON, NDJSON, YAML, CSV, helper output, and schema
output without lossy parsing. It is marked destructive because it can run any CLI operation; clients
should keep it approval-gated.

The passthrough rejects scopes for product families excluded from the default public surface, such
as Admin, Chat, Classroom, Cloud Platform, contacts/directory, Forms, Keep, Groups, Apps Script, and
user-profile-detail scopes. Fork or reconfigure the wrapper deliberately if those products are part
of your deployment.

## Agent Skill

The bundle ships an agent-facing companion skill at `servers/google-workspace/skills/gws-mcp`.
Install or expose it to MCP clients that support skills so agents learn the generated `gws_*` naming
pattern, helper `args` shape, raw passthrough fallback, scope/reconnect behavior, and common
Workspace recipes such as template-based Slides generation.
