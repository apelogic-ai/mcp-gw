---
name: gws-mcp
description: Use when an agent is working with the mcp-gw Google Workspace MCP connector, especially generated gws_* tools, google_workspace_gws passthrough, Google Drive/Docs/Slides/Gmail/Calendar/Sheets/Chat/People/Classroom/Forms/Keep/Meet/Events/Script/Model Armor operations, OAuth scope failures, API-disabled errors, or template-based Workspace workflows.
---

# Google Workspace MCP

Use the named `gws_*` tools first. Use `google_workspace_gws` for raw CLI control over commands
in the pinned catalog. Unknown commands are rejected until the catalog is updated.

## Tool Shapes

Generated Discovery tools are named:

```text
gws_<service>_<resource>_<method>
gws_<service>_<resource>_<subresource>_<method>
```

Examples:

```text
gws_drive_files_copy
gws_slides_presentations_batch_update
gws_gmail_users_messages_list
gws_chat_spaces_messages_create
```

Discovery tool arguments:

- `params`: object passed to `gws --params`.
- `json`: object passed to `gws --json`.
- `format`: optional `json`, `table`, `yaml`, or `csv`.
- `pageAll`, `pageLimit`, `pageDelay`: pagination flags.
- `dryRun`: maps to `--dry-run`.
- `uploadBase64`: base64-encoded content transferred to the wrapper for media upload.
- `uploadContentType`, `output`, `sanitize`: matching `gws` flags.
- `upload`: advanced path inside the MCP server filesystem, not the agent's filesystem. Remote
  clients should use `uploadBase64`.
- `extraArgs`: advanced raw arguments appended after generated flags.

Helper tools are named:

```text
gws_<service>_<helper-name-without-plus>
```

Examples:

```text
gws_gmail_send
gws_drive_upload
gws_calendar_agenda
gws_workflow_meeting_prep
```

Helper tools take `args`, an array of CLI arguments after the helper command.

Raw passthrough:

```text
google_workspace_gws
```

Use `argv` for arguments after the `gws` binary. The `scopes` field remains in the schema for
compatibility, but the gateway derives the actual requirement from the pinned command catalog;
the caller cannot declare its own authority. Prefer named tools for clearer schemas.

## Google Docs Writes

For plain-text append, use `gws_docs_write` (`args: ["--document", ID, "--text", TEXT]`); it
handles the append position. For raw `gws_docs_documents_batch_update` positional writes, read
the [Docs index recipe](references/tool-patterns.md#google-docs-positional-writes) before
constructing indices. This is guidance for raw API calls, not a claim that the append helper
has an index bug.

## Failure Diagnosis

- `insufficient_scope` on one tool: its accepted scope alternatives are not in the current grant.
  Other Google tools can remain usable. Ask for reauthorization only after the deployment's
  configured consent scopes include a suitable alternative.
- `connected: false` with `missingScopes: []`: inspect `phase` and `errorCategory` from
  `google_oauth_status`; an empty missing-scope list does not prove credentials are usable.
- `API not enabled`: the Google Cloud project must enable that API, for example `slides.googleapis.com`.
- Validation errors mentioning `--params` or `--json`: fix the `params` or `json` object shape.
- Upload path not found: do not pass an agent-local path through `upload`; encode the file and pass
  it through `uploadBase64`. Inline uploads are limited to 10 MiB after decoding.
- Empty/stale Claude tool list: disconnect/reconnect after backend tool-surface changes.

For common recipes and examples, read `references/tool-patterns.md`.
