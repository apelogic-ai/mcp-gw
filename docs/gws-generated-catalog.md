# Generated gws Catalog

Date: 2026-07-07

The Google Workspace wrapper includes a checked-in catalog generated from the pinned
`@googleworkspace/cli@0.22.5` service registry and Google Discovery documents.

The raw generated catalog is filtered before it is exposed to MCP clients. Filtering keeps the
default public connector surface small enough for current remote MCP clients and avoids product
families that require broader admin or non-core consent.

Visible surface:

- Curated MCP tools: 27
- Visible generated MCP tools: 253
- Total visible tools: 280

Visible service families:

```text
calendar
docs
drive
gmail
gws
meet
sheets
slides
tasks
workflow
```

Excluded by default:

```text
admin / directory
chat
classroom
cloud platform / modelarmor
contacts / people
forms
keep
groups
Apps Script
user profile detail scopes
overlong generated tool names rejected by common remote MCP clients
```

Visible helper commands:

```text
gmail +send
gmail +reply
gmail +reply-all
gmail +forward
gmail +triage
gmail +watch
gmail +read
sheets +append
sheets +read
docs +write
drive +upload
calendar +insert
calendar +agenda
workflow +standup-report
workflow +meeting-prep
workflow +email-to-task
workflow +weekly-digest
```

## OAuth Scopes

The default consent set is compact and uses broad read/write scopes for the visible product
families:

```text
openid
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/drive
https://www.googleapis.com/auth/gmail.modify
https://www.googleapis.com/auth/calendar
https://www.googleapis.com/auth/documents
https://www.googleapis.com/auth/spreadsheets
https://www.googleapis.com/auth/presentations
https://www.googleapis.com/auth/tasks
https://www.googleapis.com/auth/meetings.space.created
```

The token broker treats those broad scopes as satisfying narrower readonly scopes where Google
documents that relationship. The limited Meet write scope does not satisfy Meet readonly; generated
Meet readonly tools may require a deployment-specific scope override and reconnect.

Deployments can override `GOOGLE_OAUTH_SCOPES` with a comma/space-separated set. If the override is
narrower than the visible tools need, affected tools return reconnect/scope errors.
