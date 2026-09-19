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
stored `grantedScopes`; a previously poisoned row may also need guarded recovery.

For `renewal_expired` or `invalid_renewal_credential`, reconnect is normally needed. For
`transient_provider_failure` or `persistence_failure`, investigate provider availability and
datastore health first. An elapsed run time alone does not prove that the refresh token expired.

Never ask a user for an access token, refresh token, OAuth code, state value, or credential
envelope. Do not paste full provider errors or message payloads into tickets or logs.
