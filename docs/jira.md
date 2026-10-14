# Jira Cloud provider

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

MCP-GW does not yet consume caller-specific Jira tool authority tuples from an
external control plane. Until [that boundary](https://github.com/apelogic-ai/mcp-gw/issues/128)
is enforced end to end, use `jira-read-only` unless an equivalent upstream
policy constrains every caller allowed to reach the gateway.

## Prerequisites

- Jira Cloud. Jira Data Center is not supported by this provider.
- A dedicated confidential Atlassian OAuth 2.0 (3LO) app for MCP-GW. The same
  app may serve multiple deployments when every deployment's exact callback is
  registered in the Atlassian developer console.
- For the recommended read-only preset, these app scopes:

  ```text
  read:jira-user
  read:jira-work
  read:jira:agent-interface
  search:jira:agent-interface
  ```

  Atlassian authorizes hosted MCP Jira data calls with the classic
  `read:jira-work` scope in addition to the agent-interface scopes.
  MCP-GW additionally requests `offline_access` during authorization so it can
  retain and rotate the refresh credential. The full `jira` preset additionally
  requires `write:jira:agent-interface`. Neither preset requests
  `delete:jira:agent-interface` or `manage:jira:agent-interface`.

- The organization's Rovo MCP access and Jira read/search permission groups
  enabled. Enable the write group only with the full preset. Keep delete/manage
  disabled for both presets.
- App **Sharing** enabled before accounts other than the app owner connect.
- Stable gateway egress addresses included in any Atlassian organization IP
  allowlist.
- PostgreSQL reachable by the wrapper and the chart's OAuth migration Job.

The API-token authentication toggle is unrelated to this OAuth 3LO path.

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
prefix, or the wrapper Service wholesale. Start from
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
encrypted credentials. Atlassian does not publish a 3LO token-revocation
endpoint. Removing the provider-side grant remains a user action under
Connected Apps or an administrator action by uninstalling the app.

## Catalog and policy boundary

[`decisions.yaml`](../servers/generic-wrapper/catalog/jira/decisions.yaml) is
the sole checked-in Jira catalog artifact. It contains an explicit include or
exclude decision for each tool reviewed by this project. Included decisions
carry the stable `jira_*` alias, action class, operation, and OAuth scopes; the
file intentionally contains no Atlassian-owned description or input schema.

At runtime, `tools/list` uses the caller's Jira credential to fetch every page
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

The chart points `catalog.preset: jira` at the decisions file bundled in the
generic-wrapper image. `catalog.preset: jira-read-only` applies an action-class
filter to the same file, needs no write scope, and rejects values that request
`write:jira:agent-interface`. Write tools are absent from
read-only discovery and direct calls fail as unknown tools before credential
lookup or upstream access. Both presets require provider ID `jira`, tool prefix
`jira`, and the exact Atlassian v2 `?tools=all` upstream.

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
- `provider_rate_limited` with a bounded `retryAfter` value when supplied;
- `provider_unavailable` for transient server failures and Atlassian's opaque
  "trouble completing this action" result when identity validation still
  succeeds.

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
