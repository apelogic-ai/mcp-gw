# Downstream provider connection lifecycle

MCP-GW owns one provider-neutral lifecycle for Google, GitHub, and future downstream providers.
Provider adapters own protocol details; shared code owns principal binding, durable generations, locking,
status, renewal, local disablement, cleanup retries, auditing, and response sanitization.

## API contract

All operations require the HOP-1 bearer identity except the provider callback, which consumes its exact
one-time authorization state.

| Operation                | Route                                     | Meaning                                                               |
| ------------------------ | ----------------------------------------- | --------------------------------------------------------------------- |
| Status                   | `GET /connections/{provider}/status`      | One datastore read; never decrypts credentials or calls the provider. |
| Refresh now              | `POST /connections/{provider}/refresh`    | Uses the same distributed renewal path as brokerage.                  |
| Authorize or reauthorize | `POST /connections/{provider}/authorize`  | Starts a state-bound interactive flow, including while connected.     |
| Disconnect               | `POST /connections/{provider}/disconnect` | Disables locally before any optional provider cleanup.                |

The normalized response contract is version `1`. It includes `phase`, the compatibility boolean
`connected`, account display identity, required/granted/missing scopes, nullable active and renewal
expiry, authorization/renewal/validation timestamps, and declared adapter capabilities. It never
contains provider credential material.

The `/oauth/google/*` and `/oauth/github/*` routes remain compatibility aliases during the migration
window. `/oauth/{provider}/refresh` is also available to older control-plane integrations.

Authorization state records are bound to one provider and capture the observed generation,
local-disable flag, and durable connection update time. Activation requires the complete snapshot and
compares it under the connection lock. States written by a pre-lifecycle replica without the guard are
rejected and the user must restart authorization. Disconnect invalidates only that provider's
unconsumed states, so it neither cancels another provider's flow nor permits an older callback to
reactivate the connection.

## Durable generations and concurrency

`oauth_accounts.connection_generation` identifies immutable credential material. New authorization
and renewal write an encrypted JSON envelope and normalized, non-secret metadata. Brokerage renews
inside a PostgreSQL transaction-scoped advisory lock keyed by provider plus HOP-1 issuer and subject,
then performs a compare-and-swap over the generation and the legacy `updated_at`/`revoked_at`
snapshot. The legacy fields are part of the guard because an older replica does not increment the new
generation column. Multiple replicas therefore cannot consume the same rotating renewal credential,
and a concurrent old-replica disconnect remains authoritative. An undurable replacement is never
returned.

The configurable default renewal safety window is five minutes. Unknown expiry remains `null`; it is
never invented.

## Disconnect and cleanup

Disconnect first persists `local_disabled_at`, which also dual-writes legacy `revoked_at`. All ordinary
brokerage refuses the generation from that point onward. Provider cleanup then normalizes to
`revoked`, `already_absent`, `not_supported`, `retryable_failure`, or `permanent_failure`.

Retryable cleanup remains encrypted but quarantined in
`disconnected_with_provider_cleanup_pending`. The per-process cleanup worker periodically retries
pending rows through the immutable generation guard. Successful or effectively complete cleanup
destroys both the normalized envelope and usable legacy credential. Cleanup of an old generation
cannot mutate a newer reauthorization.

A credential freshly issued by a provider can also lose its activation or renewal compare-and-swap.
MCP-GW immediately attempts to revoke that orphan. A retryable provider failure stores only an
encrypted envelope in `oauth_pending_credential_cleanup`; the same cleanup worker retries it until the
provider reports a terminal result. This keeps failed stale-callback cleanup durable across process
and replica restarts.

## Rolling migration and retirement

Migrations `005_provider_connection_lifecycle.sql` and
`006_provider_state_and_cleanup.sql` are forward-only and must run before the new binaries. Migration
`006` provider-binds new state rows and adds the durable orphan-cleanup queue without rewriting
already-applied migration `005`. The base Docker Compose stack runs the migration service after
PostgreSQL becomes healthy and starts the wrapper only after migration success, including when the
named database volume already exists. The nullable/defaulted lifecycle columns allow old binaries to
continue operating during a rolling deployment. New binaries dual-write `encrypted_refresh_token`
for one compatibility window:

- Google legacy rows are interpreted only as renewal credentials.
- GitHub legacy rows are interpreted only as non-expiring active credentials.
- Legacy rows are lazily normalized when authorization or renewal next writes a generation.
- A legacy credential that cannot produce a usable active credential becomes
  `reauthorization_required`; it is not silently discarded.

Retire the legacy column only in a later release after all replicas run the normalized model, pending
cleanup is empty, and telemetry confirms no legacy-only reads. That later release must first stop
dual-writing, then use a new migration to drop `encrypted_refresh_token`; applied migrations,
including `001`, `005`, and `006`, must never be edited after application.

## Adding a provider

Implement `DownstreamConnectionAdapter`, declare every capability explicitly, and add a harness
invocation to `test/provider-lifecycle-conformance.test.ts`. Capability-gated conformance covers
authorization operations, status without provider access, automatic and manual renewal, concurrent
single-flight, local disconnect, revocation, generation isolation, encryption, and sanitized output.

## Observability

`ConnectionLifecycle` accepts a `ConnectionLifecycleMetricSink`. The emitted metric records use only
bounded provider, phase, operation, outcome, and revocation-result dimensions; they never include a
principal, credential, authorization state, provider payload, or arbitrary error text. The contract
covers status latency and phase, renewal outcome and lock wait, reauthorization-required transitions,
disconnect requests, pending-cleanup age, and cleanup retry outcomes. Sink failures are isolated from
credential behavior.

Sanitized OAuth audit events cover authorization, refresh, local disconnect, and deferred provider
cleanup. Existing JSONL audit configuration remains the production sink; no provider response body or
credential material is included.
