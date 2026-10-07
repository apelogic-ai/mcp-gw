# Jira Cloud provider

MCP-GW can front Atlassian's hosted MCP server with a per-user Atlassian OAuth
2.0 (3LO) credential. Jira is opt-in and uses the descriptor-driven generic
wrapper with provider ID `jira`; enabling it does not change Google Workspace,
GitHub, or existing custom wrappers.

```text
MCP client --HOP-1--> AgentGateway --HOP-1--> generic wrapper (jira)
generic wrapper --per-user Atlassian bearer--> https://mcp.atlassian.com/v2/mcp?tools=all
```

The wrapper publishes only the checked-in `jira_*` catalog. It never exposes an
upstream tool merely because Atlassian adds it.

## Prerequisites

- Jira Cloud. Jira Data Center is not supported by this provider.
- A dedicated confidential Atlassian OAuth 2.0 (3LO) app for each environment.
  Atlassian apps accept one callback URL, so do not reuse one app between local
  development and a hosted deployment.
- These app scopes:

  ```text
  read:jira-user
  read:jira:agent-interface
  write:jira:agent-interface
  search:jira:agent-interface
  ```

  MCP-GW additionally requests `offline_access` during authorization so it can
  retain and rotate the refresh credential. It does not request
  `delete:jira:agent-interface` or `manage:jira:agent-interface`.

- The organization's Rovo MCP access and Jira read/write/search permission
  groups enabled. Keep delete/manage disabled for the default catalog.
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

The catalog is captured from every paginated `tools/list` page at the exact v2
`?tools=all` endpoint through MCP-GW's own connected credential. Generation is
digest-bound and requires an explicit include or exclude decision for every
captured tool.

The default catalog excludes:

- the generic Rovo `search` tool and Teamwork Graph/Rovo Search operations that
  may consume Rovo credits;
- delete, attachment, administration, Confluence, and Jira Service Management
  operations;
- generic execute/discover operations.

JQL search is distinct from generic Rovo search. It is governed by
`search:jira:agent-interface` and may be included under a stable `jira_*`
alias. Included writes are classified as `write`; destructive tools are not
accepted by the generator.

To refresh the catalog for a future release:

1. connect the dedicated test account through `jira_oauth_start`;
2. capture all pages without printing credentials:

   ```bash
   bun run catalog:capture:oauth -- \
     --descriptor /absolute/path/to/jira-descriptor.yaml \
     --output /private/path/jira-tools-capture.json
   ```

3. review every upstream tool and update the decision file;
4. generate the pinned catalog:

   ```bash
   bun run catalog:generate:jira -- \
     --capture /private/path/jira-tools-capture.json \
     --decisions /path/to/jira-catalog-decisions.yaml \
     --output /path/to/jira-catalog.yaml
   ```

The capture command stops if Atlassian exposes only the credit-bearing
`search` fallback. A digest mismatch or an undecided tool also stops generation.

## Provider failures and quotas

The wrapper returns stable, sanitized result categories for Atlassian failures:

- `provider_oauth_required` after an invalid credential cannot be recovered;
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

## Atlassian references

- [OAuth 2.0 (3LO) apps](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/)
- [Rovo MCP supported tools and scopes](https://developer.atlassian.com/cloud/rovo-mcp/guides/supported-tools/)
- [Rovo MCP organization controls](https://support.atlassian.com/security-and-access-policies/docs/control-atlassian-mcp-server-settings/)
- [Rovo MCP permission groups](https://support.atlassian.com/security-and-access-policies/docs/configure-atlassian-mcp-server-permissions/)
- [Manage connected third-party apps](https://support.atlassian.com/security-and-access-policies/docs/manage-your-users-third-party-apps/)
