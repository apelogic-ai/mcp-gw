# Jira Cloud provider

> **Warning:** The full `catalog.preset: jira` path is not currently supported
> with customer-managed Atlassian OAuth apps. Consent can succeed while hosted
> MCP data calls fail. Use `jira-read-only`, or `jira-read-write` when agents
> must also create and update issues. The chart refuses the full preset
> unless `catalog.experimental: true` explicitly opts in to this unsupported
> path.

MCP-GW can front Atlassian's hosted MCP server with a per-user Atlassian OAuth
2.0 (3LO) credential. Jira is opt-in and uses the descriptor-driven generic
wrapper with provider ID `jira`; enabling it does not change Google Workspace,
GitHub, or existing custom wrappers.

```text
MCP client --HOP-1--> AgentGateway --HOP-1--> generic wrapper (jira)
generic wrapper --per-user Atlassian bearer--> https://mcp.atlassian.com/v2/mcp?tools=all
```

The wrapper keeps only MCP-GW's allow/deny decisions, aliases, action classes,
operations, and scopes. On each authenticated `tools/list`, it fetches every
upstream page and combines current Atlassian descriptions and input schemas
with those local decisions. It never exposes a tool merely because Atlassian
adds it, and it does not copy Atlassian's catalog into this repository.

When a caller's HOP-1 token carries Task tool tuples, the wrapper lists and runs
only the Jira tools that Task approved. Each tuple names the provider `jira`, the
exposed tool, and its action class, for example `jira / jira_create_issue /
write`. A caller without Task tuples can use every tool that the preset and the
wrapper policy allow, so choose the preset and policy for the least restricted
caller that can reach the gateway.

## Prerequisites

- Jira Cloud. Jira Data Center is not supported by this provider.
- A dedicated confidential Atlassian OAuth 2.0 (3LO) app for MCP-GW. The same
  app may serve multiple deployments when every deployment's exact callback is
  registered in the Atlassian developer console.
- For the supported read-only preset, these app scopes:

  ```text
  read:jira-user
  read:jira-work
  offline_access
  ```

  MCP-GW requests `offline_access` during authorization so it can retain and
  rotate the refresh credential. The read-only preset does not request
  agent-interface write, delete, or manage scopes.

- For the read and write preset, the same scopes plus `write:jira-work`:

  ```text
  read:jira-user
  read:jira-work
  write:jira-work
  offline_access
  ```

- App **Sharing** enabled before accounts other than the app owner connect.
- Stable gateway egress addresses included in any Atlassian organization IP
  allowlist.
- PostgreSQL reachable by the wrapper and the chart's OAuth migration Job.

The API-token authentication toggle is unrelated to this OAuth 3LO path.

## Read and write preset

`catalog.preset: jira-read-write` lets agents create and update issues with each
user's own Jira connection. It uses the same direct Jira Cloud REST v3 path as
`jira-read-only` and keeps its three read tools unchanged. It adds:

| Tool                    | Action class | What it does                                                                                                                               |
| ----------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `jira_list_transitions` | read         | Lists the workflow transitions you can apply to an issue now.                                                                              |
| `jira_create_issue`     | write        | Creates an issue from a project key, an issue type name, a summary, and an optional plain-text description. Returns its ID, key, and link. |
| `jira_add_comment`      | write        | Adds a plain-text comment to an issue.                                                                                                     |
| `jira_transition_issue` | write        | Moves an issue through a transition from `jira_list_transitions`.                                                                          |
| `jira_update_issue`     | write        | Changes an issue's summary, description, or both. A new description replaces the old one.                                                  |
| `jira_assign_issue`     | write        | Assigns an issue to an account ID, or unassigns it with `null`. `jira_get_current_user` returns your own account ID.                       |

In both presets, `jira_get_issue` and `jira_search_issues` return each issue's
ID, key, summary, status, and assignee. The assignee is its account ID and
display name only, or `null` when the issue is unassigned, so an agent can check
`jira_assign_issue` against `jira_get_current_user`.

Every write tool needs `write:jira-work`, and `jira_list_transitions` needs
`read:jira-work`. The chart requires exactly the four scopes listed under
Prerequisites for this preset and refuses any other scope. The preset has no
delete, attachment, administration, or user-search tools, and it does not set
other fields. Plain text becomes one paragraph per line.

Jira still decides what each user may do. A write the user has no Jira project
permission for, such as creating, commenting on, transitioning, editing, or
assigning issues, fails with `provider_permission_denied` or
`provider_rejected`, depending on how Jira answers. `provider_rejected` also
covers an unknown issue, project, issue type, transition, or account.

Users who connected under `jira-read-only` must connect again after you switch
to this preset, so they can grant `write:jira-work`. Until they do,
`jira_oauth_status` reports `reauthorization_required` with
`write:jira-work` under `missingScopes`. Read tools keep working, and write tools
return `provider_oauth_required`.

If a write gets an expired credential, the wrapper renews it but does not send
the write again. The call returns `provider_retry_required`, so the agent can
check the issue before trying again.

Allow writes in the wrapper policy as well. A deny-by-default policy for this
preset:

```yaml
policy:
  yaml: |
    default: deny
    rules:
      - id: allow-read
        effect: allow
        match:
          actionClass: read
      - id: allow-write
        effect: allow
        match:
          actionClass: write
```

## Full preset (not currently supported)

The full `catalog.preset: jira` path targets Atlassian's hosted MCP service,
which currently rejects tokens issued through a customer-managed OAuth app.
Do not use it for a working deployment; use `jira-read-only` instead.

Keeping the full path available makes it possible to retest if Atlassian adds
custom-app support. That test-only setup requires `catalog.experimental: true`,
the read-only scopes plus `read:jira:agent-interface`,
`search:jira:agent-interface`, and `write:jira:agent-interface`, and the
organization's Rovo MCP read/search/write permission groups. Keep delete and
manage permissions disabled.

## Callback URLs

Use the exact callback registered for the app:

- fixed local main lane:
  `http://127.0.0.1:28080/oauth/jira/callback`;
- hosted environment:
  `https://<mcp-gateway-origin>/oauth/jira/callback`.

After changing an app callback, start a new authorization through
`jira_oauth_start`. An already-generated Atlassian authorize URL embeds its old
`redirect_uri` and cannot be repaired or reused.

For Kubernetes, publish only an exact `/oauth/jira/callback` match to the Jira
wrapper Service. Do not publish `/connections/jira/*`, `/oauth/jira/*` as a
prefix, or the wrapper Service wholesale. When the chart renders the shared
AgentGateway HTTPRoute, set
`agentgateway.gatewayApi.httpRoute.providerCallbacks.enabled=true` and the chart
adds exactly that callback rule for you. Otherwise, start from
[`jira-provider-callback.example.yaml`](../deploy/k8s/examples/jira-provider-callback.example.yaml).
The complete opt-in wrapper configuration is
[`values-jira.example.yaml`](../deploy/k8s/examples/values-jira.example.yaml);
replace its public origins, image digests, Secret name, and Jira site URL in the
environment's private values overlay.
The `connectionLifecycle.allowedCallers` selectors must match the actual
Gateway data-plane proxy Pods that deliver the callback; a Gateway controller
reference alone does not identify those Pods.

## Secrets and migrations

Create an existing Kubernetes Secret containing these keys:

```text
JIRA_OAUTH_CLIENT_ID
JIRA_OAUTH_CLIENT_SECRET
JIRA_TOKEN_ENCRYPTION_KEY
TOKEN_STORE_DSN
```

For the example values, create the existing Secret in the release namespace:

```bash
kubectl -n mcp-gateway create secret generic jira-oauth-runtime \
  --from-literal=JIRA_OAUTH_CLIENT_ID='<atlassian-client-id>' \
  --from-literal=JIRA_OAUTH_CLIENT_SECRET='<atlassian-client-secret>' \
  --from-literal=JIRA_TOKEN_ENCRYPTION_KEY='<base64-encoded-32-byte-key>' \
  --from-literal=TOKEN_STORE_DSN='<postgresql-dsn>'
```

Use the environment's secret reconciler instead of this imperative command
when GitOps owns Secrets. Never put the literal values in Helm values.

`JIRA_TOKEN_ENCRYPTION_KEY` is a 32-byte key encoded as base64. Generate one,
for example, with:

```bash
openssl rand -base64 32
```

Do not commit the output. Put it in the environment's secret manager and keep
the same key while encrypted Jira credentials remain in the token store.

Enable `oauthMigrations` and point its `secretKeyRef` at the same PostgreSQL DSN
key before enabling the wrapper. The migration hook runs before install or
upgrade; the Jira wrapper does not create its schema at runtime.

## Identity binding

The provider uses a named Atlassian-only identity mode. It:

1. obtains the resources visible to the token from the pinned Atlassian
   `accessible-resources` endpoint;
2. selects the exact configured Jira site URL;
3. calls that site's `/rest/api/3/myself` through `api.atlassian.com`;
4. requires an active account with non-empty `accountId` and `emailAddress`;
5. requires the normalized Atlassian email to exactly match the HOP-1 email.

This is not a general unverified-email switch. The configuration is accepted
only for provider ID `jira` and the pinned first-party resource endpoint.

The configured `credential.identity.siteUrl` is also the authoritative site for
every Jira data tool. MCP-GW removes upstream `cloudId` fields from the public
tool schemas and injects the resolved configured site into upstream calls. A
caller cannot select or override another Jira site.

If Jira profile visibility prevents the app from receiving `emailAddress`, the
connection fails closed with an identity error. Fix the account/app visibility
contract; do not weaken HOP-1 binding.

## Connecting and disconnecting

An authenticated MCP client uses:

- `jira_oauth_status` to inspect the provider-neutral connection status;
- `jira_oauth_start` to obtain the Atlassian consent URL.

The callback consumes single-use state, exchanges the code using
`client_secret_post`, takes durable custody of every returned credential, and
activates it only after the identity checks succeed. Access tokens renew
silently with serialized, rotating-refresh-token custody.

Disconnect immediately disables the local connection and destroys its
encrypted credentials. Jira connection status advertises the `disconnect`
action so clients do not have to assume that a generic provider supports it.
Atlassian does not publish a 3LO token-revocation
endpoint. Removing the provider-side grant remains a user action under
Connected Apps or an administrator action by uninstalling the app.

## Catalog and policy boundary

[`decisions.yaml`](../servers/generic-wrapper/catalog/jira/decisions.yaml) is
the sole checked-in Jira catalog artifact. It contains an explicit include or
exclude decision for each tool reviewed by this project. Included decisions
carry the stable `jira_*` alias, action class, operation, and OAuth scopes; the
file intentionally contains no Atlassian-owned description or input schema.

For the full `jira` preset, `tools/list` uses the caller's Jira credential to fetch every page
from the exact v2 `?tools=all` endpoint. MCP-GW intersects that live list with
included decisions, applies stable aliases, removes the caller-controlled
`cloudId` field, and returns the current upstream description and schema. A new
upstream tool remains hidden until it has a decision. A decided tool removed by
Atlassian disappears from discovery. Direct calls to undecided tools are
rejected before credential resolution or upstream access.

The default catalog excludes:

- the generic Rovo `search` tool and Teamwork Graph/Rovo Search operations that
  may consume Rovo credits;
- delete, attachment, administration, Confluence, and Jira Service Management
  operations;
- generic execute/discover operations.

JQL search is distinct from generic Rovo search. It is governed by
`search:jira:agent-interface` and may be included under a stable `jira_*`
alias. Included writes are classified as `write`.

Live discovery is deliberately not cached. Each `tools/list` obtains a complete
fresh set and therefore consumes provider request quota, so clients should not
poll discovery unnecessarily. A prior successful response is never served after
the upstream fails or changes. If the caller is not connected, the response contains only
`jira_oauth_status` and `jira_oauth_start` plus a sanitized authorization
status in `_meta`. If upstream discovery fails or times out, it contains only
those helpers plus `Upstream tool discovery is unavailable`; provider bodies
are not returned.

To check drift after connecting a dedicated test account, run:

```bash
bun run catalog:check:oauth -- --descriptor /absolute/path/to/jira-descriptor.yaml
```

The command stores nothing. It reports upstream tools without a decision and
decisions whose upstream tool disappeared, and exits nonzero on either class of
drift. It is a manual authenticated check rather than a scheduled public CI job
because it requires a live per-user Jira credential.

The chart points `catalog.preset: jira` at the live decisions file bundled in
the generic-wrapper image. `catalog.preset: jira-read-only` instead uses a
static three-tool catalog backed by Jira Cloud REST v3: current user, JQL issue
search, and issue lookup. It requests only `read:jira-user`, `read:jira-work`,
and `offline_access`. The other read aliases and all writes are absent, and
direct calls fail before credential lookup or provider access.
`catalog.preset: jira-read-write` uses the static catalog in
[`read-write.yaml`](../servers/generic-wrapper/catalog/jira/read-write.yaml)
described under [Read and write preset](#read-and-write-preset). All presets
require provider ID `jira` and tool prefix `jira`.

For a deny-by-default wrapper policy, an `actionClass: read` allow rule permits
read/search tools and the `jira_oauth_status` and `jira_oauth_start` lifecycle
helpers. A decided write tool is refused locally with `Tool call denied by
policy`. Disconnect is the authenticated `POST /connections/jira/disconnect`
control route, not an MCP tool, and is not governed by data-tool policy.

```yaml
policy:
  yaml: |
    default: deny
    rules:
      - id: allow-read-only
        effect: allow
        match:
          actionClass: read
```

## Provider failures and quotas

The wrapper returns stable, sanitized result categories for Atlassian failures:

- `provider_oauth_required` after an invalid credential cannot be recovered;
- `provider_retry_required` when a write credential was renewed but MCP-GW did
  not automatically replay the write;
- `provider_permission_denied` for provider authorization failures;
- `provider_rejected` when Jira refuses the request itself (HTTP 400, 404, 409,
  or 422), for example an unknown issue or issue type;
- `provider_rate_limited` with a bounded `retryAfter` value when supplied;
- `provider_unavailable` for transient server failures and Atlassian's opaque
  "trouble completing this action" result when identity validation still
  succeeds.

Each error is a tool result with `isError: true`. Its `structuredContent` has
the category in `error` and a short explanation in `message`. The same
explanation is also the text content, because some MCP clients show the model
only `structuredContent`. Policy refusals (`policy_denied`), unapproved Task
tools (`task_tool_not_approved`), and invalid arguments use the same shape.

Provider response bodies, tokens, issue content, cloud IDs, and site IDs are not
copied into those errors or audit records. Live v2 responses have advertised a
250-request server window, but Atlassian does not document its ownership
dimension. Treat response headers as authoritative and do not describe this as
a per-site hourly quota.

If `jira_oauth_status` is connected with no missing scopes but Jira data tools
return `provider_permission_denied`, do not reconnect first. Confirm that the
organization has enabled Rovo MCP access and the Jira read, write, and search
permission groups for the account and site. These controls are separate from
the 3LO app scopes and apply immediately; reconnect only if the OAuth grant
itself is missing a required scope.

## Atlassian references

- [OAuth 2.0 (3LO) apps](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/)
- [Rovo MCP supported tools and scopes](https://developer.atlassian.com/cloud/rovo-mcp/guides/supported-tools/)
- [Rovo MCP organization controls](https://support.atlassian.com/security-and-access-policies/docs/control-atlassian-mcp-server-settings/)
- [Rovo MCP permission groups](https://support.atlassian.com/security-and-access-policies/docs/configure-atlassian-mcp-server-permissions/)
- [Manage connected third-party apps](https://support.atlassian.com/security-and-access-policies/docs/manage-your-users-third-party-apps/)
