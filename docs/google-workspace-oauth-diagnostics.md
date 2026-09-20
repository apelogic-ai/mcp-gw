# Google Workspace OAuth diagnostics

When a tool reports an OAuth error, obtain the affected principal's `google_oauth_status` result
or authenticated `GET /connections/google/status` response. These status reads do not decrypt
credentials or contact Google. Record the first failing tool and approximate time, then compare
`phase`, `errorCategory`, `activeCredentialExpiresAt`, `renewalCredentialPresent`,
`renewalCredentialExpiresAt`, and `lastRenewedAt`. The compatibility endpoint
`GET /oauth/google/status` now includes the same diagnostic fields alongside its original keys.

`connected: false` and `missingScopes: []` are not contradictory: the stored scopes may be complete
while the credential has expired or the lifecycle is marked `reauthorization_required`. Read
`phase` and `errorCategory` before deciding on a reconnect. A tool-specific `insufficient_scope`
error does not imply that other tools or the whole Google connection are unusable. If the status
itself reports `insufficient_scope`, compare the deployment's configured consent set with the
stored `grantedScopes`. A row poisoned by the older per-tool scope bug is repaired on the next
credential request only if the full configured consent set is present and usable credential
material remains; a status read never performs that repair.

For `renewal_expired` or `invalid_renewal_credential`, reconnect is normally needed. For
`transient_provider_failure` or `persistence_failure`, investigate provider availability and
datastore health first. An elapsed run time alone does not prove that the refresh token expired.

The wrapper emits `mcp_gw_connection_diagnostic` JSON lines to stdout for status latency,
renewal attempts/outcomes, phase transitions, provider authentication rejections, cleanup, and
tool-scope or policy denials. A tool error's `diagnosticId` can be used to find its matching
events. These events contain bounded categories and catalog operation names, never tokens,
principal identity, recipient addresses, arguments, provider response bodies, or MIME. The
`connections_by_phase` event is an observation made during a status read, **not** a gauge of all
database rows.
Policy-denial events report the resolved catalog operation (including classified low-level
`google_workspace_gws` calls) and the matching YAML rule ID, when available. Unlabelled YAML
rules use position-based IDs; the default decision uses `yaml.default`.

Never ask a user for an access token, refresh token, OAuth code, state value, or credential
envelope. Do not paste full provider errors or message payloads into tickets or logs.
