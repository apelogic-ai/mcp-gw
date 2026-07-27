# gws MCP Tool Patterns

## Template-based Slides Deck

1. Find the template with `gws_drive_files_list`.
2. Copy the template with `gws_drive_files_copy`.
   - `params`: `{ "fileId": "<template-file-id>" }`
   - `json`: `{ "name": "<new deck title>" }`
3. Inspect the copied deck with `gws_slides_presentations_get`.
   - `params`: `{ "presentationId": "<new-presentation-id>" }`
4. Populate it with `gws_slides_presentations_batch_update`.
   - `params`: `{ "presentationId": "<new-presentation-id>" }`
   - `json`: `{ "requests": [...] }`

Slides `batchUpdate` object IDs must be at least 5 characters. Do not use short IDs such as `s5`
or `s5_t`; use stable IDs such as `slide_005`, `title_005`, and `body_005`.

If Slides calls fail after Drive copy succeeds, distinguish:

- API disabled: enable `slides.googleapis.com`.
- missing scope: reconnect the connector with `presentations` scopes.
- bad request: inspect the Slides `batchUpdate` request JSON, especially short or duplicate
  `objectId` values.

## Drive Copy

Use `gws_drive_files_copy` instead of creating a blank file when the goal is to preserve a template's
theme, sharing state, or internal document structure.

```json
{
  "params": { "fileId": "template-id" },
  "json": { "name": "New copy title" }
}
```

## Inline Drive Upload

The Google Workspace wrapper runs in a different filesystem from the agent. Do not pass an
agent-local path such as `/mnt/user-data/outputs/report.docx` through `upload`.

Base64-encode the content and call an upload-capable method such as `gws_drive_files_create`:

```json
{
  "json": {
    "name": "report.docx"
  },
  "uploadBase64": "<base64-encoded file bytes>",
  "uploadContentType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
}
```

The wrapper stages the decoded bytes in a private temporary file, invokes `gws`, and removes the
file afterward. Inline uploads are limited to 10 MiB after decoding. The legacy `upload` argument
addresses the MCP server filesystem, not the agent filesystem.

## Generic Passthrough

Use `google_workspace_gws` for raw CLI cases:

```json
{
  "argv": ["schema", "slides.presentations.batchUpdate"],
  "scopes": []
}
```

```json
{
  "argv": [
    "slides",
    "presentations",
    "get",
    "--params",
    "{\"presentationId\":\"presentation-id\"}"
  ],
  "scopes": ["https://www.googleapis.com/auth/presentations.readonly"]
}
```

Prefer named tools when available because they already know their generated scopes.

## Helper Commands

Helper tools expose the same helper command shape as `gws`.

```json
{
  "args": ["--to", "user@example.com", "--subject", "Hello", "--body", "Hi"]
}
```

The example above is for `gws_gmail_send`, which maps to:

```text
gws gmail +send --to user@example.com --subject Hello --body Hi
```

## Common Error Split

- Drive works, Slides fails: usually `slides.googleapis.com` disabled or missing presentations scope.
- Method exists but Claude says no tool: reconnect after a tool-catalog deploy.
- Tool exists but says reconnect required: OAuth consent scopes are narrower than the tool's scope.
- Opaque tool execution error: retry with the named schema/read tool or use raw passthrough with
  `schema <service.resource.method>` to validate request shape.
- Opaque Slides `batchUpdate` error: check `objectId` length first; Google rejects IDs shorter than
  5 characters.
