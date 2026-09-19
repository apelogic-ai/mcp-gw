# Google Workspace Policy

Google Workspace policy is enforced inside the Google MCP wrapper before the
wrapper looks up a Google access token or executes `gws`.

If no policy is configured, the wrapper allows all registered tools. Production
deployments should configure either a YAML policy, an OPA policy endpoint, or
both.

## YAML Policy

Set `GOOGLE_WORKSPACE_POLICY_FILE` to a YAML file path readable by the wrapper:

```env
GOOGLE_WORKSPACE_POLICY_FILE=/etc/mcp-gw/google-workspace-policy.yaml
```

Example:

```yaml
default: deny
rules:
  - effect: allow
    match:
      actionClass: read

  - effect: allow
    match:
      actionClass: write
      service:
        - docs
        - sheets
        - slides
        - drive

  - effect: approval_required
    reason: Destructive Google Workspace actions require approval
    match:
      actionClass: destructive
```

Global, non-overridable operation guardrails can be added to the same YAML file:

```yaml
default: allow
guardrails:
  deniedOperations:
    - calendar.events.delete
    - calendar.calendars.clear
    - calendar.calendars.delete
  outboundEmail:
    allowedRecipientDomains:
      - example.org
```

The three entries cover individual event deletion, clearing a calendar, and deleting a calendar.
They apply before ordered `rules` and before any OPA allow result, to curated tools, generated
tools, and `google_workspace_gws` calls alike. Operation names come from the pinned `gws` command
catalog. Unknown names, misspellings, and unsupported guardrail fields fail wrapper startup.
When guardrails are active, ambiguous command arguments fail closed.

`outboundEmail` restricts Gmail sends made through MCP-GW to the listed domains and their
subdomains. Entries must be lowercase ASCII DNS names, such as `example.org` or an IDN's
punycode form; no schemes, wildcards, or trailing dots. `example.org` matches
`team.example.org`, but not `badexample.org`. The restriction checks the effective `To`,
`Cc`, and `Bcc` recipients before token lookup or CLI execution. It applies equally to
generated `users.messages.send`, the `gmail +send` helper, and classified raw CLI calls.
The helper supports its documented `--to`, `--cc`, `--bcc`, `--subject`, `--body`, `--from`,
`--html`, `--attach`/`-a`, `--dry-run`, and `--draft` flags under this guardrail. Raw
`messages.send` requires a parseable base64url MIME `json.raw`; upload and alternate body
forms are denied, as are raw messages over 10 MiB. Malformed or ambiguous address/header forms
fail closed. Draft-ID sends and reply/reply-all/forward helpers are denied under this guardrail
because their final recipients depend on mutable provider state. The guard also blocks
indirect mail-producing operations whose recipients cannot be proven at dispatch time:
Apps Script `scripts.run`, forwarding-address creation and auto-forwarding changes, filter
creation, vacation-responder changes, and send-as creation/verification. Some of these
operations are blocked even when a particular invocation would be harmless; their effects
can depend on later provider state. This does **not** disable unrelated low-level GWS commands.

This policy governs only mail sent through MCP-GW. For a domain-wide restriction that also
applies outside MCP-GW, consider Google Workspace Admin's [Restrict delivery](https://knowledge.workspace.google.com/admin/gmail/advanced/restrict-email-messages-to-authorized-addresses-or-domains-only),
and review its broader effects on inbound mail and Google-service notifications.

The low-level `google_workspace_gws` tool remains available for classified commands. Its `scopes`
argument is retained for client compatibility but is **not** an authority assertion: MCP-GW now
derives the method's complete accepted-scope alternatives from its pinned catalog. Commands not
in that catalog are rejected until the catalog is updated. This includes free-form CLI
introspection commands that are not represented in the pinned catalog; a future CLI command
cannot silently bypass a hard guardrail.

Rule effects:

- `allow`: permit matching calls.
- `deny`: reject matching calls.
- `approval_required`: reject for now with an explicit approval-required error.

Match fields:

- `principal` or `principals`
- `tool` or `tools`
- `service` or `services`
- `actionClass` or `actionClasses`
- `scope` or `scopes`
- `operation` or `operations` (the server-resolved provider method, not a caller-supplied string)

For ordinary Workspace catalog tools, `service` remains the exact provider authority key (`drive`,
`gmail`, `calendar`, and so on). “Google Workspace” can be used as a display grouping, but it is not
an authority value. OAuth connection controls are internal and are not selectable catalog grants.
The corrected semantic grant catalog is enabled only by the exact
`GOOGLE_WORKSPACE_GOVERNANCE_CATALOG=google-workspace-cli@0.22.5/visible-v1/actions-v1` pin;
operation guardrails and raw command classification apply independently of that pin.

An omitted `match` block matches every call.

For data tools, `match.scope`/`match.scopes` inspect the usable authorities in the connection's
freshly stored Google grant for that method—not the union of all scopes Google would accept. An
allow rule must cover **every** usable authority; a deny or approval rule matches if **any**
catalog-accepted alternative matches, preserving existing deny rules. For example, a `drive.file`
allow does not authorize a deletion carried by a broader `drive` grant, even when the token also
contains `drive.file`. The full method alternatives remain available to brokerage as
`scopeRequirement`; the usable granted scopes are
sent in `scopes` to YAML and OPA. If the stored grant changes after policy evaluation,
brokerage refuses to return the token, so the request must be retried under the new grant.

Unlabelled ordered YAML rules receive stable position-based diagnostic IDs (`yaml.rule.1`,
`yaml.rule.2`, and so on); an unlabelled default deny or approval uses `yaml.default`. Reordering
rules changes their derived IDs. Set explicit `id` fields if dashboards must survive reordering.

## OPA

OPA is optional and external. Set `OPA_POLICY_URL` when an organization wants to
delegate decisions to an Open Policy Agent service:

```env
OPA_POLICY_URL=http://opa:8181/v1/data/mcp/allow
```

The wrapper posts this shape:

```json
{
  "input": {
    "principal": "user@example.com",
    "tool": "google_drive_files_delete",
    "operation": "drive.files.delete",
    "service": "drive",
    "actionClass": "destructive",
    "scopes": ["https://www.googleapis.com/auth/drive"],
    "args": { "fileId": "file-123" }
  }
}
```

OPA should return:

```json
{
  "result": {
    "allow": false,
    "reason": "destructive actions disabled"
  }
}
```

For Gmail send operations, OPA receives the additive `outboundEmail` fact containing
normalized **domains only** and an empty `args` object. This deliberately removes raw MIME,
message bodies, and recipient addresses from the OPA request. Existing OPA rules that inspect
send arguments must migrate to the normalized fact. Global YAML guardrails are enforced
before OPA, and an OPA allow cannot override them.

It can also return:

```json
{
  "result": {
    "allow": false,
    "approval_required": true,
    "reason": "manager approval required"
  }
}
```

## Composition

When both YAML and OPA are configured, the most restrictive decision wins:

| YAML policy       | OPA policy        | Result            |
| ----------------- | ----------------- | ----------------- |
| deny              | allow             | deny              |
| allow             | deny              | deny              |
| approval_required | allow             | approval_required |
| allow             | approval_required | approval_required |
| allow             | allow             | allow             |

YAML denies are enforced locally and do not need an OPA round trip.

## Kubernetes

The Helm chart can render and mount the policy file:

```yaml
googleWorkspace:
  policy:
    enabled: true
    mountPath: /etc/mcp-gw/google-workspace-policy.yaml
    yaml: |
      default: allow
      guardrails:
        deniedOperations:
          - calendar.events.delete
          - calendar.calendars.clear
          - calendar.calendars.delete
        outboundEmail:
          allowedRecipientDomains:
            - example.org
```

See `deploy/k8s/examples/values-google-policy.example.yaml`.

## Docker Compose

Set `GOOGLE_WORKSPACE_POLICY_FILE` and mount the policy file with a private
Compose override. Keep real org policy files in private deployment overlays when
they reveal internal service names, user groups, or operational rules.

```yaml
services:
  google-workspace:
    environment:
      GOOGLE_WORKSPACE_POLICY_FILE: /etc/mcp-gw/google-workspace-policy.yaml
    volumes:
      - ./google-workspace-policy.yaml:/etc/mcp-gw/google-workspace-policy.yaml:ro
```

The mounted file can contain the same neutral `guardrails` example shown above.
