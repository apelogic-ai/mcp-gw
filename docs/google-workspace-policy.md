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

An omitted `match` block matches every call.

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
      default: deny
      rules:
        - effect: allow
          match:
            actionClass: read
```

See `deploy/k8s/examples/values-google-policy.example.yaml`.

## Docker Compose

Set `GOOGLE_WORKSPACE_POLICY_FILE` and mount the policy file with a private
Compose override. Keep real org policy files in private deployment overlays when
they reveal internal service names, user groups, or operational rules.
