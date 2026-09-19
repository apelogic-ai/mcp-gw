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

## Google Docs Positional Writes

Use `gws_docs_write` for a plain-text append to an existing document; the pinned helper places
text at the end of the body without a caller-supplied index. For a raw append through
`gws_docs_documents_batch_update`, prefer the API's end-of-segment location:

```json
{
  "params": { "documentId": "document-id" },
  "json": {
    "requests": [{ "insertText": { "endOfSegmentLocation": {}, "text": "New paragraph\n" } }]
  }
}
```

When an explicit `location.index` is necessary, fetch the current document structure first.
Google Docs indices and `endIndex` values are UTF-16 code-unit offsets; `endIndex` is exclusive,
not automatically a valid insertion position. In JavaScript, string `.length` counts UTF-16
code units. In Python, use `len(text.encode("utf-16-le")) // 2`, not `len(text)`, when adjusting
an index for inserted text containing emoji or other non-BMP characters. Do not apply a blanket
`endIndex - 1` rule to tables, headers, or multi-tab documents; choose a valid paragraph location
in the intended segment/tab.

Each `batchUpdate` request is applied in order, so an insert shifts later offsets even though
the batch succeeds or fails atomically. For multiple positional inserts, work from highest index
to lowest when locations are independent, or re-fetch/recalculate after each edit. If other users
may edit concurrently, use the Docs API's revision write control to reject a stale snapshot.

## Generic Passthrough

Use `google_workspace_gws` for raw commands in the pinned command catalog. Unclassified CLI
commands, including schema introspection, are not currently accepted by this tool.

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

The gateway derives OAuth scope requirements from the command catalog; the `scopes` argument is
retained for compatibility and does not grant authority. Prefer named tools for clearer schemas.

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
- Tool-specific `insufficient_scope`: inspect the method's accepted alternatives and the configured
  consent set; unrelated tools may remain usable.
- Opaque tool execution error: inspect the named tool's schema and request shape.
- Opaque Slides `batchUpdate` error: check `objectId` length first; Google rejects IDs shorter than
  5 characters.
