import { randomUUID } from "node:crypto";

import type { AuditSink } from "../audit/audit";
import type { Hop1Identity } from "../identity/hop1";
import { decryptSecret, encryptSecret } from "./crypto";
import type {
  ConnectionLifecycleMetric,
  ConnectionLifecycleMetricSink,
} from "./connection-metrics";
import type {
  ConnectionRecord,
  ConnectionStatusV1,
  CredentialGenerationRecord,
  DecryptedCredentialGeneration,
  DownstreamConnectionAdapter,
  IssuedCredentialGeneration,
  LifecycleErrorCategory,
  PendingCredentialCleanupRecord,
  ProviderCredentialEnvelope,
  ProviderRevocationResult,
  RefreshConnectionResult,
} from "./connection-types";
import { ProviderLifecycleError } from "./connection-types";
import { connectionWriteGuard, type OAuthConnectionStore } from "./store";

const CREDENTIAL_SCHEMA_VERSION = 1;
const DEFAULT_RENEWAL_SAFETY_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_TRANSIENT_RETRIES = 1;

export interface AuthorizationActivationGuard {
  generation?: number;
  locallyDisabled?: boolean;
  updatedAt?: Date;
}

export function isCompleteAuthorizationActivationGuard(
  guard: AuthorizationActivationGuard,
): boolean {
  return (
    guard.generation !== undefined &&
    guard.locallyDisabled !== undefined &&
    (guard.updatedAt !== undefined || (guard.generation === 0 && !guard.locallyDisabled))
  );
}

export function snapshotAuthorizationGuard(
  record: ConnectionRecord | null,
): AuthorizationActivationGuard {
  const syntheticAuthorization =
    record?.phase === "authorizing" &&
    record.generation === 0 &&
    !record.activeCredentialPresent &&
    !record.renewalCredentialPresent &&
    !record.localDisabledAt &&
    !record.displayAccountIdentity;
  if (!record || syntheticAuthorization) {
    return { generation: 0, locallyDisabled: false };
  }
  return {
    generation: record.generation,
    locallyDisabled: Boolean(record.localDisabledAt),
    updatedAt: record.updatedAt,
  };
}

export interface ConnectionLifecycleOptions {
  adapter: DownstreamConnectionAdapter;
  store: OAuthConnectionStore;
  credentialEncryptionKey: string;
  audit?: AuditSink;
  metrics?: ConnectionLifecycleMetricSink;
  now?: () => Date;
  renewalSafetyWindowMs?: number;
  transientRetries?: number;
}

export class ConnectionLifecycle {
  private readonly now: () => Date;
  private readonly renewalSafetyWindowMs: number;
  private readonly transientRetries: number;

  constructor(private readonly options: ConnectionLifecycleOptions) {
    this.now = options.now ?? (() => new Date());
    this.renewalSafetyWindowMs = options.renewalSafetyWindowMs ?? DEFAULT_RENEWAL_SAFETY_WINDOW_MS;
    this.transientRetries = options.transientRetries ?? DEFAULT_TRANSIENT_RETRIES;
  }

  get providerId() {
    return this.options.adapter.providerId;
  }

  async markAuthorizationStarted(
    identity: Hop1Identity,
    requiredScopes: string[],
    expiresAt: Date,
  ): Promise<void> {
    await this.options.store.markAuthorizing(
      this.providerId,
      identity.issuer,
      identity.subject,
      requiredScopes,
      expiresAt,
    );
  }

  clearAuthorization(identity: Pick<Hop1Identity, "issuer" | "subject">): Promise<void> {
    return this.options.store.clearAuthorizing(this.providerId, identity.issuer, identity.subject);
  }

  async activateAuthorizedGeneration(
    identity: Hop1Identity,
    requiredScopes: string[],
    issued: IssuedCredentialGeneration,
    guard?: AuthorizationActivationGuard,
  ): Promise<ConnectionStatusV1> {
    const provider = this.providerId;
    const candidate = this.credentialCustodyRecord(identity, {
      provider,
      generation: (guard?.generation ?? 0) + 1,
      credential: issued.credential,
      activeCredentialExpiresAt: issued.activeCredentialExpiresAt,
      renewalCredentialExpiresAt: issued.renewalCredentialExpiresAt,
      grantedScopes: issued.grantedScopes,
    });
    await this.acquireCredentialCustody(identity, candidate);
    let activationTransactionStarted = false;
    try {
      if (!issued.credential.activeCredential) {
        throw new ProviderLifecycleError(
          "Authorization response did not contain an active credential",
          "malformed_provider_response",
        );
      }
      if (
        this.options.adapter.capabilities.authorizationRequiresRenewalCredential &&
        !issued.credential.renewalCredential
      ) {
        throw new ProviderLifecycleError(
          "Authorization response did not contain a renewal credential",
          "malformed_provider_response",
        );
      }
      requireScopes(this.options.adapter, issued.grantedScopes, requiredScopes);
      let displayAccountIdentity = issued.displayAccountIdentity;
      let validatedAt = issued.validatedAt;
      if (this.options.adapter.capabilities.identityVerification && !validatedAt) {
        if (this.options.adapter.validateIdentity) {
          const validated = await this.options.adapter.validateIdentity(
            decryptCredentialCustody(candidate, this.options.credentialEncryptionKey),
            identity,
          );
          displayAccountIdentity = validated.displayAccountIdentity;
          validatedAt = this.now();
        } else {
          throw new ProviderLifecycleError(
            "Provider identity validation attestation is missing",
            "identity_mismatch",
          );
        }
      }
      activationTransactionStarted = true;
      await this.options.store.withConnectionLock(
        provider,
        identity.issuer,
        identity.subject,
        async (store) => {
          const current = await store.getConnection(provider, identity.issuer, identity.subject);
          if (
            guard !== undefined &&
            (!isCompleteAuthorizationActivationGuard(guard) ||
              (current?.generation ?? 0) !== guard.generation ||
              Boolean(current?.localDisabledAt) !== guard.locallyDisabled ||
              (guard.updatedAt !== undefined && !sameInstant(current?.updatedAt, guard.updatedAt)))
          ) {
            throw generationConflict();
          }
          if (
            current?.revocationState === "pending" ||
            current?.revocationState === "permanent_failure"
          ) {
            throw new ProviderLifecycleError(
              "Previous credential cleanup is unresolved",
              "generation_conflict",
            );
          }
          const existingGenerations = await store.listPrincipalCredentialGenerations(
            provider,
            identity.issuer,
            identity.subject,
          );
          if (
            existingGenerations.some(
              (record) =>
                record.id !== candidate.id &&
                (record.state === "cleanup_pending" ||
                  record.state === "cleanup_permanent_failure"),
            )
          ) {
            throw new ProviderLifecycleError(
              "Previous credential cleanup is unresolved",
              "generation_conflict",
            );
          }
          const now = this.now();
          const generation = (current?.generation ?? 0) + 1;
          const activeCandidate: CredentialGenerationRecord = {
            ...candidate,
            generation,
            state: "active",
            displayAccountIdentity,
            updatedAt: now,
          };
          if (!(await store.updateCredentialGeneration(activeCandidate, "candidate", 0))) {
            throw generationConflict();
          }
          const record: ConnectionRecord = {
            provider,
            hop1Issuer: identity.issuer,
            hop1Subject: identity.subject,
            displayAccountIdentity,
            encryptedCredentialEnvelope: encryptEnvelope(
              issued.credential,
              this.options.credentialEncryptionKey,
            ),
            credentialSchemaVersion: CREDENTIAL_SCHEMA_VERSION,
            credentialGenerationId: candidate.id,
            generation,
            requiredScopes: [...requiredScopes],
            grantedScopes: [...issued.grantedScopes],
            activeCredentialPresent: Boolean(issued.credential.activeCredential),
            renewalCredentialPresent: Boolean(issued.credential.renewalCredential),
            activeCredentialExpiresAt: issued.activeCredentialExpiresAt,
            renewalCredentialExpiresAt: issued.renewalCredentialExpiresAt,
            lastAuthorizedAt: now,
            lastValidatedAt: validatedAt,
            phase: "connected",
            revocationState: "none",
            createdAt: current?.createdAt ?? now,
            updatedAt: now,
            encryptedLegacyCredential: legacyCredential(
              provider,
              issued.credential,
              this.options.credentialEncryptionKey,
            ),
          };
          const saved = await store.saveConnection(record, connectionWriteGuard(current));
          if (!saved) throw generationConflict();
        },
      );
    } catch (error) {
      if (!activationTransactionStarted) {
        await this.cleanupCustodiedGeneration(identity, candidate);
        throw error;
      }
      let current: ConnectionRecord | null;
      try {
        current = await this.options.store.getConnection(
          provider,
          identity.issuer,
          identity.subject,
        );
      } catch {
        // The candidate remains durable. A later worker reconciles a rolled-back
        // candidate, while a committed active generation is never selected.
        throw error;
      }
      if (current?.credentialGenerationId !== candidate.id) {
        await this.cleanupCustodiedGeneration(identity, candidate);
        throw error;
      }
      if (current.localDisabledAt) throw generationConflict();
    }
    try {
      await this.options.store.clearAuthorizing(provider, identity.issuer, identity.subject);
    } catch {
      // Activation is already committed; an expired marker is harmless and must not revoke it.
    }
    await this.emit(identity, "authorize", "allow");
    return this.status(identity, requiredScopes);
  }

  async status(identity: Hop1Identity, requiredScopes: string[]): Promise<ConnectionStatusV1> {
    const startedAt = performance.now();
    const record = await this.options.store.getConnection(
      this.providerId,
      identity.issuer,
      identity.subject,
    );
    const status = statusFromRecord(record, requiredScopes, this.options.adapter, this.now());
    this.metric({
      name: "status_latency_ms",
      provider: this.providerId,
      value: performance.now() - startedAt,
    });
    this.metric({
      name: "connections_by_phase",
      provider: this.providerId,
      phase: status.phase,
      value: 1,
    });
    return status;
  }

  async getActiveCredential(identity: Hop1Identity, requiredScopes: string[]): Promise<string> {
    const record = await this.options.store.getConnection(
      this.providerId,
      identity.issuer,
      identity.subject,
    );
    if (!record || record.localDisabledAt) throw reauthorizationRequired();
    try {
      requireScopes(this.options.adapter, record.grantedScopes, requiredScopes);
    } catch {
      await this.renew(identity, requiredScopes, false, false, record.generation);
      throw reauthorizationRequired();
    }
    const generation = decryptGeneration(record, this.options.credentialEncryptionKey);
    if (
      generation.credential.activeCredential &&
      (!generation.activeCredentialExpiresAt ||
        generation.activeCredentialExpiresAt.getTime() >
          this.now().getTime() + this.renewalSafetyWindowMs)
    ) {
      return generation.credential.activeCredential;
    }

    const renewalResult = await this.renew(identity, requiredScopes, false);
    if (renewalResult === "reauthorization_required") throw reauthorizationRequired();
    const renewed = await this.options.store.getConnection(
      this.providerId,
      identity.issuer,
      identity.subject,
    );
    if (!renewed || renewed.localDisabledAt) throw reauthorizationRequired();
    const active = decryptGeneration(renewed, this.options.credentialEncryptionKey).credential
      .activeCredential;
    if (!active) throw reauthorizationRequired();
    return active;
  }

  async refresh(
    identity: Hop1Identity,
    requiredScopes: string[],
  ): Promise<RefreshConnectionResult> {
    const observed = await this.options.store.getConnection(
      this.providerId,
      identity.issuer,
      identity.subject,
    );
    const result = await this.renew(identity, requiredScopes, true, false, observed?.generation);
    return { result, status: await this.status(identity, requiredScopes) };
  }

  async recoverFromProviderAuthenticationFailure(
    identity: Hop1Identity,
    requiredScopes: string[],
    rejectedActiveCredential?: string,
  ): Promise<string | undefined> {
    const observed = await this.options.store.getConnection(
      this.providerId,
      identity.issuer,
      identity.subject,
    );
    if (!observed || observed.localDisabledAt) return undefined;
    if (rejectedActiveCredential) {
      const observedActive = decryptGeneration(observed, this.options.credentialEncryptionKey)
        .credential.activeCredential;
      if (observedActive && observedActive !== rejectedActiveCredential) return observedActive;
    }
    const result = await this.renew(identity, requiredScopes, false, true, observed.generation);
    if (result !== "refreshed" && result !== "already_fresh") return undefined;
    const current = await this.options.store.getConnection(
      this.providerId,
      identity.issuer,
      identity.subject,
    );
    if (!current || current.localDisabledAt) return undefined;
    return decryptGeneration(current, this.options.credentialEncryptionKey).credential
      .activeCredential;
  }

  async disconnect(identity: Hop1Identity, requiredScopes: string[]): Promise<ConnectionStatusV1> {
    this.metric({ name: "disconnect_request", provider: this.providerId, value: 1 });
    let disabled: DecryptedCredentialGeneration | null;
    let disabledCustodyId: string | undefined;
    const detachedCleanup: CredentialGenerationRecord[] = [];
    try {
      disabled = await this.options.store.withConnectionLock(
        this.providerId,
        identity.issuer,
        identity.subject,
        async (store) => {
          const current = await store.getConnection(
            this.providerId,
            identity.issuer,
            identity.subject,
          );
          await store.clearAuthorizing(this.providerId, identity.issuer, identity.subject);
          const now = this.now();
          if (!current) {
            const tombstone: ConnectionRecord = {
              provider: this.providerId,
              hop1Issuer: identity.issuer,
              hop1Subject: identity.subject,
              displayAccountIdentity: identity.email,
              generation: 0,
              requiredScopes: [...requiredScopes],
              grantedScopes: [],
              activeCredentialPresent: false,
              renewalCredentialPresent: false,
              localDisabledAt: now,
              phase: "disconnected",
              revocationState: "complete",
              revocationCompletedAt: now,
              createdAt: now,
              updatedAt: now,
              encryptedLegacyCredential: encryptSecret(
                "credential-destroyed",
                this.options.credentialEncryptionKey,
              ),
            };
            const saved = await store.saveConnection(tombstone, connectionWriteGuard(null));
            if (!saved) throw generationConflict();
            await this.handoffPrincipalCredentialGenerations(store, identity, detachedCleanup);
            return null;
          }
          if (current.localDisabledAt) {
            const saved = await store.saveConnection(
              {
                ...current,
                phase:
                  current.revocationState === "pending"
                    ? "disconnected_with_provider_cleanup_pending"
                    : current.revocationState === "permanent_failure"
                      ? "unavailable"
                      : "disconnected",
                updatedAt: now,
              },
              connectionWriteGuard(current),
            );
            if (!saved) throw generationConflict();
            await this.handoffPrincipalCredentialGenerations(store, identity, detachedCleanup);
            return null;
          }
          const pending =
            this.options.adapter.capabilities.providerRevocation &&
            (current.activeCredentialPresent || current.renewalCredentialPresent);
          let credentialGenerationId = current.credentialGenerationId;
          if (pending && !credentialGenerationId) {
            const adopted = this.connectionCredentialCustodyRecord(current, "cleanup_pending");
            await store.saveCredentialGeneration(adopted);
            detachedCleanup.push(adopted);
            credentialGenerationId = adopted.id;
          }
          const next: ConnectionRecord = {
            ...current,
            credentialGenerationId,
            localDisabledAt: now,
            phase: pending ? "revocation_pending" : "disconnected",
            revocationState: pending ? "pending" : "complete",
            revocationStartedAt: pending ? now : undefined,
            revocationCompletedAt: pending ? undefined : now,
            updatedAt: now,
          };
          if (!pending) destroyCredentials(next, this.options.credentialEncryptionKey);
          const saved = await store.saveConnection(next, connectionWriteGuard(current));
          if (!saved) throw generationConflict();
          disabledCustodyId = credentialGenerationId;
          await this.handoffPrincipalCredentialGenerations(store, identity, detachedCleanup);
          return pending ? decryptGeneration(current, this.options.credentialEncryptionKey) : null;
        },
      );
    } catch (error) {
      if (error instanceof ProviderLifecycleError) throw error;
      await this.emit(identity, "disconnect", "error");
      throw new ProviderLifecycleError("Connection could not be disabled", "persistence_failure");
    }

    if (disabled) {
      const result = await this.revoke(disabled);
      const currentCustody = detachedCleanup.find((record) => record.id === disabledCustodyId);
      try {
        if (currentCustody) {
          await this.finalizeCredentialCleanup(identity, currentCustody, result);
        } else {
          await this.finalizeRevocation(identity, disabled.generation, result);
        }
      } catch (error) {
        if (error instanceof ProviderLifecycleError) throw error;
        await this.emit(identity, "disconnect", "error");
        throw new ProviderLifecycleError(
          "Provider cleanup result could not be persisted",
          "persistence_failure",
        );
      }
      if (result === "retryable_failure" || result === "permanent_failure") {
        await this.emit(
          identity,
          "disconnect_cleanup",
          "error",
          result === "retryable_failure"
            ? "transient_provider_failure"
            : "provider_configuration_error",
        );
      }
    }
    for (const record of detachedCleanup) {
      if (record.id !== disabledCustodyId) await this.retryCredentialGenerationCleanup(record);
    }
    await this.emit(identity, "disconnect", "allow");
    return this.status(identity, requiredScopes);
  }

  async retryPendingRevocation(identity: Hop1Identity): Promise<void> {
    const record = await this.options.store.getConnection(
      this.providerId,
      identity.issuer,
      identity.subject,
    );
    if (record?.revocationState !== "pending" || !record.localDisabledAt) return;
    let custody: CredentialGenerationRecord | null | undefined;
    if (!record.credentialGenerationId) {
      custody = await this.adoptPendingConnectionCleanup(identity);
      if (!custody) return;
    } else {
      const generations = await this.options.store.listPrincipalCredentialGenerations(
        this.providerId,
        identity.issuer,
        identity.subject,
      );
      custody = generations.find((generation) => generation.id === record.credentialGenerationId);
    }
    if (
      custody?.state !== "cleanup_pending" ||
      (custody.nextCleanupAttemptAt?.getTime() ?? 0) > this.now().getTime()
    ) {
      return;
    }
    await this.retryCredentialGenerationCleanup(custody);
  }

  async retryPendingRevocations(limit = 25): Promise<number> {
    const pending = await this.options.store.listConnectionsPendingRevocation(
      this.providerId,
      limit,
    );
    for (const record of pending) {
      this.metric({
        name: "pending_provider_cleanup_age_ms",
        provider: this.providerId,
        value: Math.max(0, this.now().getTime() - record.updatedAt.getTime()),
      });
      const identity: Hop1Identity = {
        profile: "provider-cleanup-worker",
        issuer: record.hop1Issuer,
        subject: record.hop1Subject,
        email: record.displayAccountIdentity,
        claims: {},
      };
      try {
        await this.retryPendingRevocation(identity);
      } catch (error) {
        this.metric({
          name: "provider_cleanup_retry_outcome",
          provider: this.providerId,
          outcome: "processing_failure",
          value: 1,
        });
        await this.emit(
          identity,
          "disconnect_cleanup_retry",
          "error",
          lifecycleCategory(error) ?? "persistence_failure",
        );
      }
    }
    const queued = await this.options.store.listPendingCredentialCleanups(this.providerId, limit);
    for (const record of queued) {
      await this.retryPendingCredentialCleanup(record);
    }
    const generations = await this.options.store.listCredentialGenerationsForCleanup(
      this.providerId,
      limit,
      this.now(),
    );
    for (const record of generations) {
      await this.retryCredentialGenerationCleanup(record);
    }
    return pending.length + queued.length + generations.length;
  }

  private async renew(
    identity: Hop1Identity,
    requiredScopes: string[],
    manual: boolean,
    credentialKnownInvalid = false,
    observedGeneration?: number,
  ): Promise<RefreshConnectionResult["result"]> {
    const operation = manual ? "manual" : "automatic";
    const lockStartedAt = performance.now();
    let rejectedIssuedGeneration: CredentialGenerationRecord | undefined;
    try {
      const result = await this.options.store.withConnectionLock(
        this.providerId,
        identity.issuer,
        identity.subject,
        async (store) => {
          this.metric({
            name: "renewal_lock_wait_ms",
            provider: this.providerId,
            operation,
            value: performance.now() - lockStartedAt,
          });
          let current = await store.getConnection(
            this.providerId,
            identity.issuer,
            identity.subject,
          );
          if (!current || current.localDisabledAt) return "reauthorization_required";
          if (observedGeneration !== undefined && current.generation !== observedGeneration) {
            return "already_fresh";
          }
          try {
            requireScopes(this.options.adapter, current.grantedScopes, requiredScopes);
          } catch {
            await this.persistReauthorizationRequired(store, current, "insufficient_scope");
            return "reauthorization_required";
          }

          const decrypted = decryptGeneration(current, this.options.credentialEncryptionKey);
          const expiresAt = decrypted.activeCredentialExpiresAt?.getTime();
          const fresh =
            !credentialKnownInvalid &&
            decrypted.credential.activeCredential !== undefined &&
            (expiresAt === undefined ||
              expiresAt > this.now().getTime() + this.renewalSafetyWindowMs);
          if (!manual && fresh) return "already_fresh";
          if (manual && fresh && !decrypted.credential.renewalCredential) {
            return "refresh_not_supported";
          }
          const renewalSupported = manual
            ? this.options.adapter.capabilities.manualRenewal
            : this.options.adapter.capabilities.automaticRenewal;
          if (!this.options.adapter.renew || !renewalSupported) {
            if (manual) return "refresh_not_supported";
            if (!fresh) {
              await this.persistReauthorizationRequired(
                store,
                current,
                "invalid_active_credential",
              );
              return "reauthorization_required";
            }
            return "refresh_not_supported";
          }
          const renew = this.options.adapter.renew.bind(this.options.adapter);
          if (
            decrypted.renewalCredentialExpiresAt &&
            decrypted.renewalCredentialExpiresAt.getTime() <= this.now().getTime()
          ) {
            await this.persistReauthorizationRequired(store, current, "renewal_expired");
            return "reauthorization_required";
          }

          try {
            const renewed = await retryTransient(
              () => renew(decrypted),
              this.options.adapter.capabilities.rotatingRenewalCredential
                ? 0
                : this.transientRetries,
            );
            rejectedIssuedGeneration = this.credentialCustodyRecord(identity, {
              provider: this.providerId,
              generation: current.generation + 1,
              credential: renewed.credential,
              activeCredentialExpiresAt: renewed.activeCredentialExpiresAt,
              renewalCredentialExpiresAt: renewed.renewalCredentialExpiresAt,
              grantedScopes: renewed.grantedScopes ?? current.grantedScopes,
            });
            await this.acquireCredentialCustody(identity, rejectedIssuedGeneration);
            if (!renewed.credential.activeCredential) {
              throw new ProviderLifecycleError(
                "Renewal response did not contain an active credential",
                "malformed_provider_response",
              );
            }
            if (
              this.options.adapter.capabilities.rotatingRenewalCredential &&
              !renewed.credential.renewalCredential
            ) {
              throw new ProviderLifecycleError(
                "Rotating renewal response did not contain a replacement credential",
                "malformed_provider_response",
              );
            }
            requireScopes(
              this.options.adapter,
              renewed.grantedScopes ?? current.grantedScopes,
              requiredScopes,
            );
            const now = this.now();
            const nextCredential = mergeRotatedCredential(decrypted.credential, renewed.credential);
            const activeCustody: CredentialGenerationRecord = {
              ...rejectedIssuedGeneration,
              encryptedCredentialEnvelope: encryptEnvelope(
                nextCredential,
                this.options.credentialEncryptionKey,
              ),
              state: "active",
              updatedAt: now,
            };
            if (!(await store.updateCredentialGeneration(activeCustody, "candidate", 0))) {
              throw generationConflict();
            }
            const next: ConnectionRecord = {
              ...current,
              encryptedCredentialEnvelope: encryptEnvelope(
                nextCredential,
                this.options.credentialEncryptionKey,
              ),
              credentialSchemaVersion: CREDENTIAL_SCHEMA_VERSION,
              credentialGenerationId: rejectedIssuedGeneration.id,
              generation: current.generation + 1,
              grantedScopes: renewed.grantedScopes ?? current.grantedScopes,
              activeCredentialPresent: Boolean(nextCredential.activeCredential),
              renewalCredentialPresent: Boolean(nextCredential.renewalCredential),
              activeCredentialExpiresAt: renewed.activeCredentialExpiresAt,
              renewalCredentialExpiresAt:
                renewed.renewalCredentialExpiresAt ?? current.renewalCredentialExpiresAt,
              lastRenewedAt: now,
              lastValidatedAt: renewed.validatedAt ?? current.lastValidatedAt,
              phase: "connected",
              lifecycleErrorCategory: undefined,
              updatedAt: now,
              encryptedLegacyCredential: legacyCredential(
                current.provider,
                nextCredential,
                this.options.credentialEncryptionKey,
              ),
            };
            const saved = await store.saveConnection(next, connectionWriteGuard(current));
            if (!saved) {
              const latest = await store.getConnection(
                this.providerId,
                identity.issuer,
                identity.subject,
              );
              if (latest && latest.generation !== current.generation) return "already_fresh";
              throw generationConflict();
            }
            current = next;
            return "refreshed";
          } catch (error) {
            const category = lifecycleCategory(error);
            if (category && isPermanentRenewalFailure(category)) {
              await this.persistReauthorizationRequired(store, current, category);
              return "reauthorization_required";
            }
            if (!fresh && category && category !== "persistence_failure") {
              const saved = await store.saveConnection(
                {
                  ...current,
                  phase: "unavailable",
                  lifecycleErrorCategory: category,
                  updatedAt: this.now(),
                },
                connectionWriteGuard(current),
              );
              if (!saved) throw generationConflict();
            }
            throw error;
          }
        },
      );
      if (rejectedIssuedGeneration) {
        if (result === "refreshed") {
          rejectedIssuedGeneration = undefined;
        } else {
          const rejected = rejectedIssuedGeneration;
          rejectedIssuedGeneration = undefined;
          await this.cleanupCustodiedGeneration(identity, rejected);
        }
      }
      this.metric({
        name: "renewal_outcome",
        provider: this.providerId,
        operation,
        outcome: result,
        value: 1,
      });
      if (result === "reauthorization_required") {
        this.metric({
          name: "reauthorization_required_transition",
          provider: this.providerId,
          value: 1,
        });
        await this.emit(identity, "reauthorization_required", "deny");
      }
      await this.emit(
        identity,
        `renewal.${operation}`,
        result === "reauthorization_required" ? "deny" : "allow",
      );
      return result;
    } catch (error) {
      if (rejectedIssuedGeneration) {
        const rejected = rejectedIssuedGeneration;
        rejectedIssuedGeneration = undefined;
        let current: ConnectionRecord | null;
        try {
          current = await this.options.store.getConnection(
            this.providerId,
            identity.issuer,
            identity.subject,
          );
        } catch {
          // Preserve the candidate for durable reconciliation when COMMIT outcome
          // cannot be observed safely.
          throw error;
        }
        if (current?.credentialGenerationId !== rejected.id) {
          await this.cleanupCustodiedGeneration(identity, rejected);
        }
      }
      this.metric({
        name: "renewal_outcome",
        provider: this.providerId,
        operation,
        outcome: "failure",
        value: 1,
      });
      await this.emit(
        identity,
        `renewal.${operation}`,
        "error",
        lifecycleCategory(error) ?? "provider_configuration_error",
      );
      throw error;
    }
  }

  private async persistReauthorizationRequired(
    store: OAuthConnectionStore,
    current: ConnectionRecord,
    category: LifecycleErrorCategory,
  ): Promise<void> {
    const saved = await store.saveConnection(
      {
        ...current,
        phase: "reauthorization_required",
        lifecycleErrorCategory: category,
        updatedAt: this.now(),
      },
      connectionWriteGuard(current),
    );
    if (!saved) throw generationConflict();
  }

  private async revoke(
    generation: DecryptedCredentialGeneration,
  ): Promise<ProviderRevocationResult> {
    if (!this.options.adapter.revoke) return "not_supported";
    try {
      return await this.options.adapter.revoke(generation);
    } catch (error) {
      return lifecycleCategory(error) === "transient_provider_failure"
        ? "retryable_failure"
        : "permanent_failure";
    }
  }

  private async handoffPrincipalCredentialGenerations(
    store: OAuthConnectionStore,
    identity: Hop1Identity,
    output: CredentialGenerationRecord[],
  ): Promise<void> {
    const records = await store.listPrincipalCredentialGenerations(
      this.providerId,
      identity.issuer,
      identity.subject,
    );
    for (const record of records) {
      if (record.state !== "active" && record.state !== "candidate") continue;
      const pending: CredentialGenerationRecord = {
        ...record,
        state: "cleanup_pending",
        updatedAt: this.now(),
      };
      if (await store.updateCredentialGeneration(pending, record.state, record.cleanupAttempts)) {
        output.push(pending);
      }
    }
  }

  private async finalizeCredentialCleanup(
    identity: Hop1Identity,
    record: CredentialGenerationRecord,
    result: ProviderRevocationResult,
  ): Promise<boolean> {
    const complete =
      result === "revoked" || result === "already_absent" || result === "not_supported";
    const attempts = record.cleanupAttempts + 1;
    const next: CredentialGenerationRecord = {
      ...record,
      state: complete
        ? "cleanup_complete"
        : result === "permanent_failure"
          ? "cleanup_permanent_failure"
          : "cleanup_pending",
      encryptedCredentialEnvelope: complete ? undefined : record.encryptedCredentialEnvelope,
      encryptedLegacyCredential: complete ? undefined : record.encryptedLegacyCredential,
      cleanupAttempts: attempts,
      nextCleanupAttemptAt:
        result === "retryable_failure"
          ? new Date(this.now().getTime() + cleanupBackoffMs(attempts))
          : undefined,
      lastCleanupErrorCategory:
        result === "retryable_failure"
          ? "transient_provider_failure"
          : result === "permanent_failure"
            ? "provider_configuration_error"
            : undefined,
      updatedAt: this.now(),
    };
    return this.options.store.withConnectionLock(
      this.providerId,
      identity.issuer,
      identity.subject,
      async (store) => {
        if (
          !(await store.updateCredentialGeneration(next, "cleanup_pending", record.cleanupAttempts))
        ) {
          return false;
        }
        await this.finalizeRevocationInStore(store, identity, record.generation, result, record.id);
        return true;
      },
    );
  }

  private credentialCustodyRecord(
    identity: Hop1Identity,
    generation: DecryptedCredentialGeneration,
  ): CredentialGenerationRecord {
    const now = this.now();
    return {
      id: randomUUID(),
      provider: generation.provider,
      hop1Issuer: identity.issuer,
      hop1Subject: identity.subject,
      displayAccountIdentity: identity.email,
      encryptedCredentialEnvelope: encryptEnvelope(
        generation.credential,
        this.options.credentialEncryptionKey,
      ),
      credentialSchemaVersion: CREDENTIAL_SCHEMA_VERSION,
      generation: generation.generation,
      state: "candidate",
      grantedScopes: [...generation.grantedScopes],
      activeCredentialExpiresAt: generation.activeCredentialExpiresAt,
      renewalCredentialExpiresAt: generation.renewalCredentialExpiresAt,
      cleanupAttempts: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  private connectionCredentialCustodyRecord(
    connection: ConnectionRecord,
    state: CredentialGenerationRecord["state"],
  ): CredentialGenerationRecord {
    const now = this.now();
    return {
      id: randomUUID(),
      provider: connection.provider,
      hop1Issuer: connection.hop1Issuer,
      hop1Subject: connection.hop1Subject,
      displayAccountIdentity: connection.displayAccountIdentity,
      encryptedCredentialEnvelope: connection.encryptedCredentialEnvelope,
      encryptedLegacyCredential: connection.encryptedLegacyCredential,
      credentialSchemaVersion: connection.credentialSchemaVersion ?? CREDENTIAL_SCHEMA_VERSION,
      generation: connection.generation,
      state,
      grantedScopes: [...connection.grantedScopes],
      activeCredentialExpiresAt: connection.activeCredentialExpiresAt,
      renewalCredentialExpiresAt: connection.renewalCredentialExpiresAt,
      cleanupAttempts: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  private adoptPendingConnectionCleanup(
    identity: Hop1Identity,
  ): Promise<CredentialGenerationRecord | null> {
    return this.options.store.withConnectionLock(
      this.providerId,
      identity.issuer,
      identity.subject,
      async (store) => {
        const current = await store.getConnection(
          this.providerId,
          identity.issuer,
          identity.subject,
        );
        if (current?.revocationState !== "pending" || !current.localDisabledAt) return null;
        if (current.credentialGenerationId) {
          const generations = await store.listPrincipalCredentialGenerations(
            this.providerId,
            identity.issuer,
            identity.subject,
          );
          return (
            generations.find((generation) => generation.id === current.credentialGenerationId) ??
            null
          );
        }
        const custody = this.connectionCredentialCustodyRecord(current, "cleanup_pending");
        await store.saveCredentialGeneration(custody);
        const saved = await store.saveConnection(
          { ...current, credentialGenerationId: custody.id, updatedAt: this.now() },
          connectionWriteGuard(current),
        );
        if (!saved) throw generationConflict();
        return custody;
      },
    );
  }

  private async acquireCredentialCustody(
    identity: Hop1Identity,
    candidate: CredentialGenerationRecord,
  ): Promise<void> {
    try {
      await this.options.store.saveCredentialGeneration(candidate);
    } catch {
      const result = await this.revoke(
        decryptCredentialCustody(candidate, this.options.credentialEncryptionKey),
      );
      await this.emit(
        identity,
        "credential_custody_failure",
        "error",
        result === "retryable_failure" ? "transient_provider_failure" : "persistence_failure",
      );
      throw new ProviderLifecycleError(
        "Issued credential custody could not be persisted",
        "persistence_failure",
      );
    }
  }

  private async cleanupCustodiedGeneration(
    identity: Hop1Identity,
    candidate: CredentialGenerationRecord,
  ): Promise<void> {
    const pending: CredentialGenerationRecord = {
      ...candidate,
      state: "cleanup_pending",
      updatedAt: this.now(),
    };
    let queued = await this.options.store.updateCredentialGeneration(
      pending,
      "candidate",
      candidate.cleanupAttempts,
    );
    if (!queued) {
      queued = await this.options.store.updateCredentialGeneration(
        pending,
        "active",
        candidate.cleanupAttempts,
      );
    }
    if (!queued) return;

    const result = await this.revoke(
      decryptCredentialCustody(pending, this.options.credentialEncryptionKey),
    );
    await this.finalizeCredentialCleanup(identity, pending, result);
    if (result === "retryable_failure" || result === "permanent_failure") {
      await this.emit(
        identity,
        "issued_credential_cleanup",
        "error",
        result === "retryable_failure"
          ? "transient_provider_failure"
          : "provider_configuration_error",
      );
    }
  }

  private async finalizeRevocation(
    identity: Hop1Identity,
    generation: number,
    result: ProviderRevocationResult,
    credentialGenerationId?: string,
  ): Promise<void> {
    await this.options.store.withConnectionLock(
      this.providerId,
      identity.issuer,
      identity.subject,
      (store) =>
        this.finalizeRevocationInStore(store, identity, generation, result, credentialGenerationId),
    );
  }

  private async finalizeRevocationInStore(
    store: OAuthConnectionStore,
    identity: Hop1Identity,
    generation: number,
    result: ProviderRevocationResult,
    credentialGenerationId?: string,
  ): Promise<void> {
    const current = await store.getConnection(this.providerId, identity.issuer, identity.subject);
    if (
      current?.generation !== generation ||
      !current.localDisabledAt ||
      current.revocationState !== "pending" ||
      (credentialGenerationId !== undefined &&
        current.credentialGenerationId !== credentialGenerationId)
    ) {
      return;
    }
    const now = this.now();
    const complete =
      result === "revoked" || result === "already_absent" || result === "not_supported";
    const next: ConnectionRecord = {
      ...current,
      phase: complete
        ? "disconnected"
        : result === "retryable_failure"
          ? "disconnected_with_provider_cleanup_pending"
          : "unavailable",
      revocationState: complete
        ? "complete"
        : result === "retryable_failure"
          ? "pending"
          : "permanent_failure",
      revocationCompletedAt: complete ? now : undefined,
      lifecycleErrorCategory:
        result === "retryable_failure"
          ? "transient_provider_failure"
          : result === "permanent_failure"
            ? "provider_configuration_error"
            : undefined,
      updatedAt: now,
    };
    if (complete) destroyCredentials(next, this.options.credentialEncryptionKey);
    const saved = await store.saveConnection(next, connectionWriteGuard(current));
    if (!saved) throw generationConflict();
  }

  private async retryPendingCredentialCleanup(
    record: PendingCredentialCleanupRecord,
  ): Promise<void> {
    const identity: Hop1Identity = {
      profile: "provider-cleanup-worker",
      issuer: record.hop1Issuer,
      subject: record.hop1Subject,
      email: record.displayAccountIdentity,
      claims: {},
    };
    this.metric({
      name: "pending_provider_cleanup_age_ms",
      provider: this.providerId,
      value: Math.max(0, this.now().getTime() - record.updatedAt.getTime()),
    });
    try {
      const generation: CredentialGenerationRecord = {
        ...record,
        state: "cleanup_pending",
        cleanupAttempts: 0,
      };
      await this.options.store.saveCredentialGeneration(generation);
      await this.options.store.deletePendingCredentialCleanup(record.id);
      await this.retryCredentialGenerationCleanup(generation);
    } catch (error) {
      this.metric({
        name: "provider_cleanup_retry_outcome",
        provider: this.providerId,
        outcome: "processing_failure",
        value: 1,
      });
      await this.emit(
        identity,
        "issued_credential_cleanup_retry",
        "error",
        lifecycleCategory(error) ?? "persistence_failure",
      );
    }
  }

  private async retryCredentialGenerationCleanup(
    record: CredentialGenerationRecord,
  ): Promise<void> {
    const identity: Hop1Identity = {
      profile: "provider-cleanup-worker",
      issuer: record.hop1Issuer,
      subject: record.hop1Subject,
      email: record.displayAccountIdentity,
      claims: {},
    };
    this.metric({
      name: "pending_provider_cleanup_age_ms",
      provider: this.providerId,
      value: Math.max(0, this.now().getTime() - record.updatedAt.getTime()),
    });
    try {
      if (record.state === "candidate") {
        const pending: CredentialGenerationRecord = {
          ...record,
          state: "cleanup_pending",
          updatedAt: this.now(),
        };
        if (
          !(await this.options.store.updateCredentialGeneration(
            pending,
            "candidate",
            record.cleanupAttempts,
          ))
        ) {
          return;
        }
        record = pending;
      }
    } catch (error) {
      await this.emit(
        identity,
        "issued_credential_cleanup_retry",
        "error",
        lifecycleCategory(error) ?? "persistence_failure",
      );
      return;
    }

    let generation: DecryptedCredentialGeneration;
    try {
      generation = decryptCredentialCustody(record, this.options.credentialEncryptionKey);
    } catch (error) {
      try {
        await this.finalizeCredentialCleanup(identity, record, "permanent_failure");
      } catch {
        // Leave the pending record intact if the atomic terminal transition fails.
      }
      await this.emit(
        identity,
        "issued_credential_cleanup_retry",
        "error",
        lifecycleCategory(error) ?? "provider_configuration_error",
      );
      return;
    }

    const result = await this.revoke(generation);
    try {
      if (!(await this.finalizeCredentialCleanup(identity, record, result))) return;
      this.metric({
        name: "provider_cleanup_retry_outcome",
        provider: this.providerId,
        outcome: result,
        value: 1,
      });
      if (result === "retryable_failure" || result === "permanent_failure") {
        await this.emit(
          identity,
          "issued_credential_cleanup_retry",
          "error",
          result === "retryable_failure"
            ? "transient_provider_failure"
            : "provider_configuration_error",
        );
      }
    } catch (error) {
      await this.emit(
        identity,
        "issued_credential_cleanup_retry",
        "error",
        lifecycleCategory(error) ?? "persistence_failure",
      );
    }
  }

  private async emit(
    identity: Hop1Identity,
    action: string,
    status: "allow" | "deny" | "error",
    error?: LifecycleErrorCategory,
  ): Promise<void> {
    try {
      await this.options.audit?.emit({
        ts: this.now().toISOString(),
        category: "oauth",
        principal: identity.email,
        event: `${this.providerId}.${action}`,
        status,
        ...(error ? { error } : {}),
      });
    } catch {
      // Auditing must not make a credential generation usable or unusable.
    }
  }

  private metric(metric: ConnectionLifecycleMetric): void {
    try {
      this.options.metrics?.record(metric);
    } catch {
      // Observability must never change credential lifecycle behavior.
    }
  }
}

function statusFromRecord(
  record: ConnectionRecord | null,
  requiredScopes: string[],
  adapter: DownstreamConnectionAdapter,
  now: Date,
): ConnectionStatusV1 {
  if (!record) return disconnectedStatus(adapter, requiredScopes);
  const missingScopes = requiredScopes.filter(
    (scope) => !scopesSatisfied(adapter, record.grantedScopes, [scope]),
  );
  let phase = record.phase;
  if (record.phase === "authorizing") {
    phase = "authorizing";
  } else if (record.localDisabledAt) {
    phase =
      record.revocationState === "pending"
        ? record.phase
        : record.revocationState === "permanent_failure"
          ? "unavailable"
          : "disconnected";
  } else if (missingScopes.length > 0) {
    phase = "reauthorization_required";
  } else if (
    (!record.activeCredentialPresent && !record.renewalCredentialPresent) ||
    (!record.activeCredentialPresent &&
      (!adapter.capabilities.automaticRenewal ||
        (record.renewalCredentialExpiresAt &&
          record.renewalCredentialExpiresAt.getTime() <= now.getTime()))) ||
    (record.activeCredentialExpiresAt &&
      record.activeCredentialExpiresAt.getTime() <= now.getTime() &&
      (!adapter.capabilities.automaticRenewal ||
        !record.renewalCredentialPresent ||
        (record.renewalCredentialExpiresAt &&
          record.renewalCredentialExpiresAt.getTime() <= now.getTime())))
  ) {
    phase = "reauthorization_required";
  }
  const connected = !record.localDisabledAt && phase === "connected" && missingScopes.length === 0;
  return {
    version: "1",
    provider: adapter.providerId,
    phase,
    connected,
    ...(record.displayAccountIdentity
      ? { account: { displayName: record.displayAccountIdentity } }
      : {}),
    requiredScopes: [...requiredScopes],
    grantedScopes: [...record.grantedScopes],
    missingScopes,
    activeCredentialExpiresAt: iso(record.activeCredentialExpiresAt),
    renewalCredentialExpiresAt: iso(record.renewalCredentialExpiresAt),
    lastAuthorizedAt: iso(record.lastAuthorizedAt),
    lastRenewedAt: iso(record.lastRenewedAt),
    lastValidatedAt: iso(record.lastValidatedAt),
    capabilities: { ...adapter.capabilities },
    errorCategory: record.lifecycleErrorCategory,
  };
}

function disconnectedStatus(
  adapter: DownstreamConnectionAdapter,
  requiredScopes: string[],
): ConnectionStatusV1 {
  return {
    version: "1",
    provider: adapter.providerId,
    phase: "disconnected",
    connected: false,
    requiredScopes: [...requiredScopes],
    grantedScopes: [],
    missingScopes: [...requiredScopes],
    activeCredentialExpiresAt: null,
    renewalCredentialExpiresAt: null,
    lastAuthorizedAt: null,
    lastRenewedAt: null,
    lastValidatedAt: null,
    capabilities: { ...adapter.capabilities },
  };
}

function decryptGeneration(record: ConnectionRecord, key: string): DecryptedCredentialGeneration {
  let credential: ProviderCredentialEnvelope;
  if (record.encryptedCredentialEnvelope) {
    if (record.credentialSchemaVersion !== CREDENTIAL_SCHEMA_VERSION) {
      throw new ProviderLifecycleError(
        "Credential envelope version is unsupported",
        "provider_configuration_error",
      );
    }
    try {
      credential = JSON.parse(
        decryptSecret(record.encryptedCredentialEnvelope, key),
      ) as ProviderCredentialEnvelope;
    } catch {
      throw new ProviderLifecycleError(
        "Credential envelope could not be opened",
        "provider_configuration_error",
      );
    }
  } else {
    const legacy = decryptSecret(record.encryptedLegacyCredential, key);
    credential =
      record.provider === "google"
        ? { renewalCredential: legacy, legacyRepresentation: "google_refresh_token" }
        : { activeCredential: legacy, legacyRepresentation: "github_access_token" };
  }
  return {
    provider: record.provider,
    generation: record.generation,
    credential,
    activeCredentialExpiresAt: record.activeCredentialExpiresAt,
    renewalCredentialExpiresAt: record.renewalCredentialExpiresAt,
    grantedScopes: [...record.grantedScopes],
  };
}

function decryptCredentialCustody(
  record: CredentialGenerationRecord,
  key: string,
): DecryptedCredentialGeneration {
  if (record.credentialSchemaVersion !== CREDENTIAL_SCHEMA_VERSION) {
    throw new ProviderLifecycleError(
      "Credential envelope version is unsupported",
      "provider_configuration_error",
    );
  }
  let credential: ProviderCredentialEnvelope;
  try {
    if (record.encryptedCredentialEnvelope) {
      credential = JSON.parse(
        decryptSecret(record.encryptedCredentialEnvelope, key),
      ) as ProviderCredentialEnvelope;
    } else if (record.encryptedLegacyCredential) {
      const legacy = decryptSecret(record.encryptedLegacyCredential, key);
      credential =
        record.provider === "google"
          ? { renewalCredential: legacy, legacyRepresentation: "google_refresh_token" }
          : { activeCredential: legacy, legacyRepresentation: "github_access_token" };
    } else {
      throw new Error("credential material is absent");
    }
  } catch {
    throw new ProviderLifecycleError(
      "Credential envelope could not be opened",
      "provider_configuration_error",
    );
  }
  return {
    provider: record.provider,
    generation: record.generation,
    credential,
    activeCredentialExpiresAt: record.activeCredentialExpiresAt,
    renewalCredentialExpiresAt: record.renewalCredentialExpiresAt,
    grantedScopes: [...record.grantedScopes],
  };
}

function cleanupBackoffMs(attempts: number): number {
  return Math.min(60 * 60 * 1000, 5_000 * 2 ** Math.min(attempts - 1, 10));
}

function encryptEnvelope(credential: ProviderCredentialEnvelope, key: string): string {
  return encryptSecret(JSON.stringify(credential), key);
}

function legacyCredential(
  provider: "google" | "github",
  credential: ProviderCredentialEnvelope,
  key: string,
): string {
  const value = provider === "google" ? credential.renewalCredential : credential.activeCredential;
  return encryptSecret(typeof value === "string" ? value : "credential-unavailable", key);
}

function destroyCredentials(record: ConnectionRecord, key: string): void {
  record.encryptedCredentialEnvelope = undefined;
  record.credentialSchemaVersion = undefined;
  record.activeCredentialPresent = false;
  record.renewalCredentialPresent = false;
  record.encryptedLegacyCredential = encryptSecret("credential-destroyed", key);
}

function mergeRotatedCredential(
  previous: ProviderCredentialEnvelope,
  replacement: ProviderCredentialEnvelope,
): ProviderCredentialEnvelope {
  return {
    ...previous,
    ...replacement,
    renewalCredential: replacement.renewalCredential ?? previous.renewalCredential,
  };
}

function requireScopes(
  adapter: DownstreamConnectionAdapter,
  granted: string[],
  required: string[],
): void {
  if (!scopesSatisfied(adapter, granted, required)) {
    throw new ProviderLifecycleError("Required provider scope is missing", "insufficient_scope");
  }
}

function scopesSatisfied(
  adapter: DownstreamConnectionAdapter,
  granted: string[],
  required: string[],
): boolean {
  return adapter.hasRequiredScopes
    ? adapter.hasRequiredScopes(granted, required)
    : required.every((scope) => granted.includes(scope));
}

async function retryTransient<T>(operation: () => Promise<T>, retries: number): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (lifecycleCategory(error) !== "transient_provider_failure" || attempt >= retries) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(100 * 2 ** attempt, 1_000)));
    }
  }
}

function lifecycleCategory(error: unknown): LifecycleErrorCategory | undefined {
  return error instanceof ProviderLifecycleError ? error.category : undefined;
}

function isPermanentRenewalFailure(category: LifecycleErrorCategory | undefined): boolean {
  return (
    category === "invalid_renewal_credential" ||
    category === "renewal_expired" ||
    category === "identity_mismatch" ||
    category === "insufficient_scope"
  );
}

function reauthorizationRequired(): ProviderLifecycleError {
  return new ProviderLifecycleError(
    "Provider connection requires reauthorization",
    "invalid_active_credential",
  );
}

function generationConflict(): ProviderLifecycleError {
  return new ProviderLifecycleError("Connection generation changed", "generation_conflict");
}

function iso(value: Date | undefined): string | null {
  return value?.toISOString() ?? null;
}

function sameInstant(left: Date | undefined, right: Date): boolean {
  return left?.getTime() === right.getTime();
}
