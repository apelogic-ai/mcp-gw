import { describe, expect, test } from "bun:test";

import type { Hop1Identity } from "../identity/hop1";
import { ConnectionLifecycle } from "./connection-lifecycle";
import { InMemoryConnectionLifecycleMetricSink } from "./connection-metrics";
import type {
  DecryptedCredentialGeneration,
  DownstreamConnectionAdapter,
  ProviderConnectionCapabilities,
  ProviderRevocationResult,
  RenewedCredentialGeneration,
  ValidatedProviderIdentity,
} from "./connection-types";
import { ProviderLifecycleError } from "./connection-types";
import { InMemoryOAuthTokenStore } from "./memory-store";
import { encryptSecret } from "./crypto";
import { connectionWriteGuard } from "./store";

const key = Buffer.alloc(32, 7).toString("base64");
const identity: Hop1Identity = {
  profile: "test",
  issuer: "https://issuer.example.com",
  subject: "subject-1",
  email: "user@example.com",
  claims: {},
};
const scopes = ["read", "write"];

const capabilities: ProviderConnectionCapabilities = {
  interactiveAuthorization: true,
  activeCredentialExpiry: true,
  automaticRenewal: true,
  manualRenewal: true,
  rotatingRenewalCredential: true,
  providerValidation: true,
  providerRevocation: true,
  scopeReporting: true,
  identityVerification: true,
};

class FixtureAdapter implements DownstreamConnectionAdapter {
  readonly providerId = "github" as const;
  readonly capabilities = { ...capabilities };
  renewCalls = 0;
  revokeCalls = 0;
  renewal?: (credential: DecryptedCredentialGeneration) => Promise<RenewedCredentialGeneration>;
  revocation?: (credential: DecryptedCredentialGeneration) => Promise<ProviderRevocationResult>;
  validation?: (
    credential: DecryptedCredentialGeneration,
    expected: Hop1Identity,
  ) => Promise<ValidatedProviderIdentity>;

  async renew(credential: DecryptedCredentialGeneration): Promise<RenewedCredentialGeneration> {
    this.renewCalls += 1;
    return this.renewal
      ? this.renewal(credential)
      : {
          credential: {
            activeCredential: `active-${String(this.renewCalls)}`,
            renewalCredential: `renewal-${String(this.renewCalls)}`,
          },
          activeCredentialExpiresAt: new Date(Date.now() + 3_600_000),
        };
  }

  async revoke(credential: DecryptedCredentialGeneration): Promise<ProviderRevocationResult> {
    this.revokeCalls += 1;
    return this.revocation ? this.revocation(credential) : "revoked";
  }

  validateIdentity(
    credential: DecryptedCredentialGeneration,
    expected: Hop1Identity,
  ): Promise<ValidatedProviderIdentity> {
    return this.validation
      ? this.validation(credential, expected)
      : Promise.resolve({ displayAccountIdentity: expected.email });
  }
}

describe("provider-neutral connection lifecycle", () => {
  test("returns truthful sanitized status without decrypting the credential envelope", async () => {
    const store = new InMemoryOAuthTokenStore();
    const adapter = new FixtureAdapter();
    const lifecycle = fixtureLifecycle(store, adapter);
    await authorize(lifecycle, "active-1", "renewal-1");
    const record = await store.getConnection("github", identity.issuer, identity.subject);
    if (!record) throw new Error("expected authorized connection");
    await store.saveConnection(
      { ...record, encryptedCredentialEnvelope: "not-ciphertext" },
      connectionWriteGuard(record),
    );

    const status = await lifecycle.status(identity, scopes);
    expect(status).toMatchObject({
      version: "1",
      provider: "github",
      phase: "connected",
      connected: true,
      account: { displayName: identity.email },
      requiredScopes: scopes,
      grantedScopes: scopes,
    });
    expect(JSON.stringify(status)).not.toContain("active-1");
    expect(JSON.stringify(status)).not.toContain("renewal-1");
  });

  test("isolates connection state by immutable HOP-1 issuer and subject", async () => {
    const store = new InMemoryOAuthTokenStore();
    const lifecycle = fixtureLifecycle(store, new FixtureAdapter());
    await authorize(lifecycle, "active-1", "renewal-1");
    const other = { ...identity, subject: "different-subject" };
    expect(await lifecycle.status(other, scopes)).toMatchObject({
      phase: "disconnected",
      connected: false,
    });
    expect(lifecycle.getActiveCredential(other, scopes)).rejects.toBeInstanceOf(Error);
  });

  test("single-flights rotating renewal across lifecycle instances sharing storage", async () => {
    const store = new InMemoryOAuthTokenStore();
    const adapter = new FixtureAdapter();
    adapter.renewal = async () => {
      await Bun.sleep(10);
      return {
        credential: { activeCredential: "active-2", renewalCredential: "renewal-2" },
        activeCredentialExpiresAt: new Date(Date.now() + 3_600_000),
      };
    };
    const first = fixtureLifecycle(store, adapter);
    const second = fixtureLifecycle(store, adapter);
    await authorize(first, "expired-active", "renewal-1", new Date(Date.now() - 1));

    const tokens = await Promise.all([
      first.getActiveCredential(identity, scopes),
      second.getActiveCredential(identity, scopes),
      first.getActiveCredential(identity, scopes),
    ]);

    expect(tokens).toEqual(["active-2", "active-2", "active-2"]);
    expect(adapter.renewCalls).toBe(1);
    expect(
      (await store.getConnection("github", identity.issuer, identity.subject))?.generation,
    ).toBe(2);
  });

  test("makes concurrent user refresh requests idempotent for one observed generation", async () => {
    const store = new InMemoryOAuthTokenStore();
    const adapter = new FixtureAdapter();
    adapter.renewal = async () => {
      await Bun.sleep(10);
      return {
        credential: { activeCredential: "active-2", renewalCredential: "renewal-2" },
        activeCredentialExpiresAt: new Date(Date.now() + 3_600_000),
      };
    };
    const lifecycle = fixtureLifecycle(store, adapter);
    await authorize(lifecycle, "active-1", "renewal-1");

    const refreshed = await Promise.all([
      lifecycle.refresh(identity, scopes),
      lifecycle.refresh(identity, scopes),
      lifecycle.refresh(identity, scopes),
    ]);
    expect(refreshed.map(({ result }) => result).sort()).toEqual([
      "already_fresh",
      "already_fresh",
      "refreshed",
    ]);
    expect(adapter.renewCalls).toBe(1);
  });

  test("converges concurrent authentication failures on one replacement generation", async () => {
    const store = new InMemoryOAuthTokenStore();
    const adapter = new FixtureAdapter();
    adapter.renewal = async () => {
      await Bun.sleep(10);
      return {
        credential: { activeCredential: "active-2", renewalCredential: "renewal-2" },
        activeCredentialExpiresAt: new Date(Date.now() + 3_600_000),
      };
    };
    const lifecycle = fixtureLifecycle(store, adapter);
    await authorize(lifecycle, "rejected-active", "renewal-1");

    expect(
      await Promise.all([
        lifecycle.recoverFromProviderAuthenticationFailure(identity, scopes, "rejected-active"),
        lifecycle.recoverFromProviderAuthenticationFailure(identity, scopes, "rejected-active"),
      ]),
    ).toEqual(["active-2", "active-2"]);
    expect(adapter.renewCalls).toBe(1);
  });

  test("turns an invalid renewal credential into reauthorization_required", async () => {
    const store = new InMemoryOAuthTokenStore();
    const adapter = new FixtureAdapter();
    adapter.renewal = () =>
      Promise.reject(new ProviderLifecycleError("invalid renewal", "invalid_renewal_credential"));
    const lifecycle = fixtureLifecycle(store, adapter);
    await authorize(lifecycle, "expired-active", "bad-renewal", new Date(Date.now() - 1));

    expect(lifecycle.getActiveCredential(identity, scopes)).rejects.toBeInstanceOf(Error);
    expect(await lifecycle.status(identity, scopes)).toMatchObject({
      phase: "reauthorization_required",
      connected: false,
      errorCategory: "invalid_renewal_credential",
    });
  });

  test("denies brokerage before provider cleanup and quarantines retryable cleanup", async () => {
    const store = new InMemoryOAuthTokenStore();
    const adapter = new FixtureAdapter();
    let finishRevocation = (result: ProviderRevocationResult): void => {
      throw new Error(`revocation resolver was not initialized: ${result}`);
    };
    const providerResult = new Promise<ProviderRevocationResult>((resolve) => {
      finishRevocation = resolve;
    });
    adapter.revocation = () => providerResult;
    const lifecycle = fixtureLifecycle(store, adapter);
    await authorize(lifecycle, "active-1", "renewal-1");

    const disconnecting = lifecycle.disconnect(identity, scopes);
    while (adapter.revokeCalls === 0) await Bun.sleep(1);
    expect(lifecycle.getActiveCredential(identity, scopes)).rejects.toBeInstanceOf(Error);
    expect(await lifecycle.status(identity, scopes)).toMatchObject({
      phase: "revocation_pending",
      connected: false,
    });

    finishRevocation("retryable_failure");
    await disconnecting;
    expect(await lifecycle.status(identity, scopes)).toMatchObject({
      phase: "disconnected_with_provider_cleanup_pending",
      connected: false,
    });
  });

  test("blocks reauthorization until old-generation cleanup is terminal", async () => {
    const store = new InMemoryOAuthTokenStore();
    const adapter = new FixtureAdapter();
    let finishRevocation = (result: ProviderRevocationResult): void => {
      throw new Error(`revocation resolver was not initialized: ${result}`);
    };
    adapter.revocation = (generation) =>
      generation.credential.activeCredential === "old-active"
        ? new Promise<ProviderRevocationResult>((resolve) => {
            finishRevocation = resolve;
          })
        : Promise.resolve("revoked");
    const lifecycle = fixtureLifecycle(store, adapter);
    await authorize(lifecycle, "old-active", "old-renewal");
    const disconnecting = lifecycle.disconnect(identity, scopes);
    while (adapter.revokeCalls === 0) await Bun.sleep(1);

    expect(authorize(lifecycle, "new-active", "new-renewal")).rejects.toMatchObject({
      category: "generation_conflict",
    });
    finishRevocation("retryable_failure");
    await disconnecting;

    expect(await lifecycle.status(identity, scopes)).toMatchObject({
      phase: "disconnected_with_provider_cleanup_pending",
      connected: false,
    });
  });

  test("completed cleanup cannot be regressed by a concurrent failed attempt", async () => {
    const store = new InMemoryOAuthTokenStore();
    const adapter = new FixtureAdapter();
    adapter.revocation = () => Promise.resolve("retryable_failure");
    const lifecycle = fixtureLifecycle(store, adapter);
    await authorize(lifecycle, "active-1", "renewal-1");
    await lifecycle.disconnect(identity, scopes);

    const finishAttempts: ((result: ProviderRevocationResult) => void)[] = [];
    adapter.revocation = () =>
      new Promise<ProviderRevocationResult>((resolve) => {
        finishAttempts.push(resolve);
      });
    const successfulAttempt = lifecycle.retryPendingRevocation(identity);
    const failedAttempt = lifecycle.retryPendingRevocation(identity);
    while (finishAttempts.length < 2) await Bun.sleep(1);

    finishAttempts[0]?.("revoked");
    await successfulAttempt;
    finishAttempts[1]?.("retryable_failure");
    await failedAttempt;

    const record = await store.getConnection("github", identity.issuer, identity.subject);
    expect(record).toMatchObject({ phase: "disconnected", revocationState: "complete" });
    expect(record?.encryptedCredentialEnvelope).toBeUndefined();
  });

  test("background cleanup retries pending provider revocation idempotently", async () => {
    const store = new InMemoryOAuthTokenStore();
    const adapter = new FixtureAdapter();
    adapter.revocation = () => Promise.resolve("retryable_failure");
    const lifecycle = fixtureLifecycle(store, adapter);
    await authorize(lifecycle, "active-1", "renewal-1");
    await lifecycle.disconnect(identity, scopes);
    adapter.revocation = () => Promise.resolve("already_absent");

    expect(await lifecycle.retryPendingRevocations()).toBe(1);
    expect(await lifecycle.retryPendingRevocations()).toBe(0);
    const record = await store.getConnection("github", identity.issuer, identity.subject);
    expect(record).toMatchObject({ phase: "disconnected", revocationState: "complete" });
    expect(record?.encryptedCredentialEnvelope).toBeUndefined();
  });

  test("never returns an undurable renewed generation", async () => {
    const store = new InMemoryOAuthTokenStore();
    const adapter = new FixtureAdapter();
    const lifecycle = fixtureLifecycle(store, adapter);
    await authorize(lifecycle, "expired-active", "renewal-1", new Date(Date.now() - 1));
    const save = store.saveConnection.bind(store);
    store.saveConnection = (record, expectedGeneration) =>
      record.generation === 2
        ? Promise.reject(new Error("persistence unavailable"))
        : save(record, expectedGeneration);

    expect(lifecycle.getActiveCredential(identity, scopes)).rejects.toThrow(
      "persistence unavailable",
    );
    expect(adapter.renewCalls).toBe(1);
    expect(
      (await store.getConnection("github", identity.issuer, identity.subject))?.generation,
    ).toBe(1);
  });

  test("does not revoke a generation whose commit succeeded but acknowledgement was lost", async () => {
    const store = new InMemoryOAuthTokenStore();
    const adapter = new FixtureAdapter();
    const lifecycle = fixtureLifecycle(store, adapter);
    const lock = store.withConnectionLock.bind(store);
    let loseAcknowledgement = true;
    store.withConnectionLock = async (provider, issuer, subject, operation) => {
      const result = await lock(provider, issuer, subject, operation);
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new Error("commit acknowledgement lost");
      }
      return result;
    };

    expect(await authorize(lifecycle, "committed-active", "committed-renewal")).toMatchObject({
      phase: "connected",
      connected: true,
    });
    expect(adapter.revokeCalls).toBe(0);
    expect(
      await store.listPrincipalCredentialGenerations("github", identity.issuer, identity.subject),
    ).toMatchObject([{ state: "active" }]);
  });

  test("returns refresh_not_supported according to declared capabilities", async () => {
    const store = new InMemoryOAuthTokenStore();
    const adapter = new FixtureAdapter();
    Object.assign(adapter.capabilities, {
      automaticRenewal: false,
      manualRenewal: false,
      rotatingRenewalCredential: false,
    });
    adapter.renew = undefined as never;
    const lifecycle = fixtureLifecycle(store, adapter);
    await authorize(lifecycle, "static-active", "");
    expect(await lifecycle.refresh(identity, scopes)).toMatchObject({
      result: "refresh_not_supported",
      status: { connected: true },
    });
  });

  test("marks a rejected non-renewable active credential for reauthorization", async () => {
    const store = new InMemoryOAuthTokenStore();
    const adapter = new FixtureAdapter();
    Object.assign(adapter.capabilities, {
      automaticRenewal: false,
      manualRenewal: false,
      rotatingRenewalCredential: false,
    });
    adapter.renew = undefined as never;
    const lifecycle = fixtureLifecycle(store, adapter);
    await lifecycle.activateAuthorizedGeneration(identity, scopes, {
      credential: { activeCredential: "legacy-active" },
      displayAccountIdentity: identity.email,
      grantedScopes: scopes,
      activeCredentialExpiresAt: new Date(Date.now() - 1),
      validatedAt: new Date(),
    });

    expect(await lifecycle.status(identity, scopes)).toMatchObject({
      phase: "reauthorization_required",
      connected: false,
    });
    expect(
      await lifecycle.recoverFromProviderAuthenticationFailure(identity, scopes),
    ).toBeUndefined();
    expect(await lifecycle.status(identity, scopes)).toMatchObject({
      phase: "reauthorization_required",
      connected: false,
      errorCategory: "invalid_active_credential",
    });
  });

  test("prefers a newer legacy write during a mixed-version rolling deployment", async () => {
    const store = new InMemoryOAuthTokenStore();
    const lifecycle = fixtureLifecycle(store, new FixtureAdapter());
    await authorize(lifecycle, "normalized-active", "normalized-renewal");
    const legacyWriteAt = new Date(Date.now() + 1_000);
    await store.saveAccount({
      provider: "github",
      hop1Issuer: identity.issuer,
      hop1Subject: identity.subject,
      email: identity.email,
      scopesGranted: scopes,
      encryptedRefreshToken: encryptSecret("newer-legacy-active", key),
      createdAt: legacyWriteAt,
      updatedAt: legacyWriteAt,
    });

    expect(await lifecycle.getActiveCredential(identity, scopes)).toBe("newer-legacy-active");
    expect(
      (await store.getConnection("github", identity.issuer, identity.subject))
        ?.encryptedCredentialEnvelope,
    ).toBeUndefined();
  });

  test("emits only bounded lifecycle metrics without principal or credential labels", async () => {
    const store = new InMemoryOAuthTokenStore();
    const adapter = new FixtureAdapter();
    const metrics = new InMemoryConnectionLifecycleMetricSink();
    const lifecycle = new ConnectionLifecycle({
      adapter,
      store,
      credentialEncryptionKey: key,
      metrics,
    });
    await authorize(lifecycle, "sensitive-active", "sensitive-renewal", new Date(Date.now() - 1));
    metrics.metrics.length = 0;

    await lifecycle.getActiveCredential(identity, scopes);
    await lifecycle.status(identity, scopes);
    adapter.revocation = () => Promise.resolve("retryable_failure");
    await lifecycle.disconnect(identity, scopes);
    adapter.revocation = () => Promise.resolve("revoked");
    await lifecycle.retryPendingRevocations();

    expect(new Set(metrics.metrics.map((metric) => metric.name))).toEqual(
      new Set([
        "renewal_lock_wait_ms",
        "renewal_outcome",
        "status_latency_ms",
        "connections_by_phase",
        "disconnect_request",
        "pending_provider_cleanup_age_ms",
        "provider_cleanup_retry_outcome",
      ]),
    );
    const serialized = JSON.stringify(metrics.metrics);
    expect(serialized).not.toContain(identity.subject);
    expect(serialized).not.toContain(identity.email);
    expect(serialized).not.toContain("sensitive-");
  });

  test("retains a disconnected generation beneath authorizing and activates its successor", async () => {
    const store = new InMemoryOAuthTokenStore();
    const lifecycle = fixtureLifecycle(store, new FixtureAdapter());
    await authorize(lifecycle, "old-active", "old-renewal");
    await lifecycle.disconnect(identity, scopes);
    await lifecycle.markAuthorizationStarted(
      identity,
      scopes,
      new Date(Date.now() + 10 * 60 * 1000),
    );

    expect(await lifecycle.status(identity, scopes)).toMatchObject({
      phase: "authorizing",
      connected: false,
    });
    await authorize(lifecycle, "new-active", "new-renewal");

    expect(await lifecycle.getActiveCredential(identity, scopes)).toBe("new-active");
    expect(
      (await store.getConnection("github", identity.issuer, identity.subject))?.generation,
    ).toBe(2);
  });

  test("rejects an authorization completion whose observed generation was disconnected", async () => {
    const store = new InMemoryOAuthTokenStore();
    const adapter = new FixtureAdapter();
    const revokedActiveCredentials: (string | undefined)[] = [];
    adapter.revocation = (generation) => {
      revokedActiveCredentials.push(generation.credential.activeCredential);
      return Promise.resolve("revoked");
    };
    const lifecycle = fixtureLifecycle(store, adapter);
    await authorize(lifecycle, "old-active", "old-renewal");
    const observed = await store.getConnection("github", identity.issuer, identity.subject);
    if (!observed) throw new Error("expected connected generation");
    await lifecycle.disconnect(identity, scopes);

    let activationError: unknown;
    try {
      await lifecycle.activateAuthorizedGeneration(
        identity,
        scopes,
        {
          credential: {
            activeCredential: "stale-callback-active",
            renewalCredential: "stale-callback-renewal",
          },
          displayAccountIdentity: identity.email,
          grantedScopes: scopes,
          validatedAt: new Date(),
        },
        {
          generation: observed.generation,
          locallyDisabled: false,
          updatedAt: observed.updatedAt,
        },
      );
    } catch (error) {
      activationError = error;
    }
    expect(activationError).toMatchObject({ category: "generation_conflict" });
    expect(revokedActiveCredentials).toEqual(["old-active", "stale-callback-active"]);
    expect(await lifecycle.status(identity, scopes)).toMatchObject({
      phase: "disconnected",
      connected: false,
    });
  });

  test("takes custody before authorization validation and terminally cleans rejected tokens", async () => {
    const store = new InMemoryOAuthTokenStore();
    const adapter = new FixtureAdapter();
    const revoked: (string | undefined)[] = [];
    adapter.validation = () =>
      Promise.reject(new ProviderLifecycleError("wrong account", "identity_mismatch"));
    adapter.revocation = (generation) => {
      revoked.push(generation.credential.activeCredential);
      return Promise.resolve("revoked");
    };
    const lifecycle = fixtureLifecycle(store, adapter);

    expect(
      lifecycle.activateAuthorizedGeneration(identity, scopes, {
        credential: {
          activeCredential: "rejected-active",
          renewalCredential: "rejected-renewal",
        },
        displayAccountIdentity: identity.email,
        grantedScopes: scopes,
      }),
    ).rejects.toMatchObject({ category: "identity_mismatch" });

    const generations = await store.listPrincipalCredentialGenerations(
      "github",
      identity.issuer,
      identity.subject,
    );
    expect(revoked).toEqual(["rejected-active"]);
    expect(generations).toHaveLength(1);
    expect(generations[0]).toMatchObject({
      state: "cleanup_complete",
      encryptedCredentialEnvelope: undefined,
      cleanupAttempts: 1,
    });
    expect(await store.getConnection("github", identity.issuer, identity.subject)).toBeNull();
  });

  test("takes custody of partial authorization responses before rejecting them", async () => {
    const store = new InMemoryOAuthTokenStore();
    const revoked: (string | undefined)[] = [];
    const adapter: DownstreamConnectionAdapter = {
      providerId: "google",
      capabilities: {
        ...capabilities,
        rotatingRenewalCredential: false,
        authorizationRequiresRenewalCredential: true,
      },
      revoke: (generation) => {
        revoked.push(generation.credential.activeCredential);
        return Promise.resolve("revoked");
      },
    };
    const lifecycle = new ConnectionLifecycle({ adapter, store, credentialEncryptionKey: key });

    expect(
      lifecycle.activateAuthorizedGeneration(identity, scopes, {
        credential: { activeCredential: "partial-access" },
        displayAccountIdentity: identity.email,
        grantedScopes: scopes,
        validatedAt: new Date(),
      }),
    ).rejects.toMatchObject({ category: "malformed_provider_response" });

    expect(revoked).toEqual(["partial-access"]);
    expect(
      await store.listPrincipalCredentialGenerations("google", identity.issuer, identity.subject),
    ).toMatchObject([{ state: "cleanup_complete", encryptedCredentialEnvelope: undefined }]);
  });

  test("never revokes an inherited renewal credential after renewal persistence fails", async () => {
    const store = new InMemoryOAuthTokenStore();
    const revoked: DecryptedCredentialGeneration[] = [];
    const adapter: DownstreamConnectionAdapter = {
      providerId: "google",
      capabilities: {
        ...capabilities,
        rotatingRenewalCredential: false,
        authorizationRequiresRenewalCredential: true,
      },
      renew: () =>
        Promise.resolve({
          credential: { activeCredential: "new-access" },
          grantedScopes: scopes,
          activeCredentialExpiresAt: new Date(Date.now() + 3_600_000),
        }),
      revoke: (generation) => {
        revoked.push(generation);
        return Promise.resolve("revoked");
      },
    };
    const lifecycle = new ConnectionLifecycle({ adapter, store, credentialEncryptionKey: key });
    await lifecycle.activateAuthorizedGeneration(identity, scopes, {
      credential: { activeCredential: "expired-access", renewalCredential: "durable-refresh" },
      displayAccountIdentity: identity.email,
      grantedScopes: scopes,
      activeCredentialExpiresAt: new Date(Date.now() - 1),
      validatedAt: new Date(),
    });
    const save = store.saveConnection.bind(store);
    store.saveConnection = (record, guard) =>
      record.generation === 2 ? Promise.reject(new Error("commit failed")) : save(record, guard);

    expect(lifecycle.getActiveCredential(identity, scopes)).rejects.toThrow("commit failed");
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.credential).toEqual({ activeCredential: "new-access" });
    expect(revoked[0]?.credential.renewalCredential).toBeUndefined();
    expect(
      (await store.getConnection("google", identity.issuer, identity.subject))?.generation,
    ).toBe(1);
  });

  test("retains permanent cleanup failures for operator recovery", async () => {
    const store = new InMemoryOAuthTokenStore();
    const adapter = new FixtureAdapter();
    adapter.validation = () =>
      Promise.reject(new ProviderLifecycleError("wrong account", "identity_mismatch"));
    adapter.revocation = () => Promise.resolve("permanent_failure");
    const lifecycle = fixtureLifecycle(store, adapter);

    expect(
      lifecycle.activateAuthorizedGeneration(identity, scopes, {
        credential: { activeCredential: "orphan", renewalCredential: "orphan-renewal" },
        displayAccountIdentity: identity.email,
        grantedScopes: scopes,
      }),
    ).rejects.toMatchObject({ category: "identity_mismatch" });

    expect(
      await store.listPrincipalCredentialGenerations("github", identity.issuer, identity.subject),
    ).toMatchObject([
      {
        state: "cleanup_permanent_failure",
        cleanupAttempts: 1,
        lastCleanupErrorCategory: "provider_configuration_error",
      },
    ]);
  });

  test("reclaims stale candidates left by a crash before validation", async () => {
    const store = new InMemoryOAuthTokenStore();
    const adapter = new FixtureAdapter();
    const now = new Date("2026-09-12T18:00:00.000Z");
    await store.saveCredentialGeneration({
      id: "crashed-candidate",
      provider: "github",
      hop1Issuer: identity.issuer,
      hop1Subject: identity.subject,
      displayAccountIdentity: identity.email,
      encryptedCredentialEnvelope: encryptSecret(
        JSON.stringify({ activeCredential: "crashed-active" }),
        key,
      ),
      credentialSchemaVersion: 1,
      generation: 1,
      state: "candidate",
      grantedScopes: scopes,
      cleanupAttempts: 0,
      createdAt: new Date(now.getTime() - 11 * 60 * 1000),
      updatedAt: new Date(now.getTime() - 11 * 60 * 1000),
    });
    const lifecycle = new ConnectionLifecycle({
      adapter,
      store,
      credentialEncryptionKey: key,
      now: () => now,
    });

    expect(await lifecycle.retryPendingRevocations()).toBe(1);
    expect(adapter.revokeCalls).toBe(1);
    expect(
      await store.listPrincipalCredentialGenerations("github", identity.issuer, identity.subject),
    ).toMatchObject([{ state: "cleanup_complete", encryptedCredentialEnvelope: undefined }]);
  });

  test("durably retries cleanup for credentials issued to a stale callback", async () => {
    const store = new InMemoryOAuthTokenStore();
    const adapter = new FixtureAdapter();
    const revokedActiveCredentials: (string | undefined)[] = [];
    adapter.revocation = (generation) => {
      revokedActiveCredentials.push(generation.credential.activeCredential);
      return Promise.resolve(
        generation.credential.activeCredential === "stale-callback-active"
          ? "retryable_failure"
          : "revoked",
      );
    };
    let now = new Date();
    const lifecycle = new ConnectionLifecycle({
      adapter,
      store,
      credentialEncryptionKey: key,
      now: () => now,
    });
    await authorize(lifecycle, "old-active", "old-renewal");
    const observed = await store.getConnection("github", identity.issuer, identity.subject);
    if (!observed) throw new Error("expected connected generation");
    await lifecycle.disconnect(identity, scopes);

    expect(
      lifecycle.activateAuthorizedGeneration(
        identity,
        scopes,
        {
          credential: {
            activeCredential: "stale-callback-active",
            renewalCredential: "stale-callback-renewal",
          },
          displayAccountIdentity: identity.email,
          grantedScopes: scopes,
          validatedAt: new Date(),
        },
        {
          generation: observed.generation,
          locallyDisabled: false,
          updatedAt: observed.updatedAt,
        },
      ),
    ).rejects.toMatchObject({ category: "generation_conflict" });
    expect(
      (
        await store.listPrincipalCredentialGenerations("github", identity.issuer, identity.subject)
      ).filter((record) => record.state === "cleanup_pending"),
    ).toHaveLength(1);

    adapter.revocation = (generation) => {
      revokedActiveCredentials.push(generation.credential.activeCredential);
      return Promise.resolve("revoked");
    };
    now = new Date(now.getTime() + 5_001);
    expect(await lifecycle.retryPendingRevocations()).toBe(1);
    expect(
      (
        await store.listPrincipalCredentialGenerations("github", identity.issuer, identity.subject)
      ).filter((record) => record.state === "cleanup_pending"),
    ).toHaveLength(0);
    expect(revokedActiveCredentials).toEqual([
      "old-active",
      "stale-callback-active",
      "stale-callback-active",
    ]);
  });

  test("rejects incomplete activation guards and cleans up their issued credentials", async () => {
    const store = new InMemoryOAuthTokenStore();
    const adapter = new FixtureAdapter();
    const revokedActiveCredentials: (string | undefined)[] = [];
    adapter.revocation = (generation) => {
      revokedActiveCredentials.push(generation.credential.activeCredential);
      return Promise.resolve("revoked");
    };
    const lifecycle = fixtureLifecycle(store, adapter);
    await authorize(lifecycle, "current-active", "current-renewal");
    const current = await store.getConnection("github", identity.issuer, identity.subject);
    if (!current) throw new Error("expected connected generation");

    expect(
      lifecycle.activateAuthorizedGeneration(
        identity,
        scopes,
        {
          credential: { activeCredential: "guardless-active" },
          displayAccountIdentity: identity.email,
          grantedScopes: scopes,
          validatedAt: new Date(),
        },
        { generation: current.generation, locallyDisabled: false },
      ),
    ).rejects.toMatchObject({ category: "generation_conflict" });
    expect(revokedActiveCredentials).toEqual(["guardless-active"]);
    expect(await lifecycle.getActiveCredential(identity, scopes)).toBe("current-active");
  });

  test("legacy disconnect wins an in-flight renewal CAS and the issued token is revoked", async () => {
    const store = new InMemoryOAuthTokenStore();
    const adapter = new FixtureAdapter();
    let finishRenewal = (value: RenewedCredentialGeneration): void => {
      void value;
      throw new Error("renewal resolver was not initialized");
    };
    adapter.renewal = () =>
      new Promise<RenewedCredentialGeneration>((resolve) => {
        finishRenewal = resolve;
      });
    const revokedActiveCredentials: (string | undefined)[] = [];
    adapter.revocation = (generation) => {
      revokedActiveCredentials.push(generation.credential.activeCredential);
      return Promise.resolve("revoked");
    };
    const lifecycle = fixtureLifecycle(store, adapter);
    await authorize(lifecycle, "expired-active", "renewal-1", new Date(Date.now() - 1));

    const renewing = lifecycle.getActiveCredential(identity, scopes);
    while (adapter.renewCalls === 0) await Bun.sleep(1);
    const legacyDisconnectAt = new Date(Date.now() + 1_000);
    await store.markRevoked(identity.issuer, identity.subject, legacyDisconnectAt, "github");
    finishRenewal({
      credential: {
        activeCredential: "rejected-renewed-active",
        renewalCredential: "rejected-renewed-renewal",
      },
      activeCredentialExpiresAt: new Date(Date.now() + 3_600_000),
    });

    expect(renewing).rejects.toMatchObject({ category: "generation_conflict" });
    expect(revokedActiveCredentials).toEqual(["rejected-renewed-active"]);
    expect(await lifecycle.status(identity, scopes)).toMatchObject({
      phase: "disconnected",
      connected: false,
    });
  });

  test("persists a disabled generation-zero tombstone when disconnect sees no record", async () => {
    const store = new InMemoryOAuthTokenStore();
    const lifecycle = fixtureLifecycle(store, new FixtureAdapter());

    expect(await lifecycle.disconnect(identity, scopes)).toMatchObject({
      phase: "disconnected",
      connected: false,
    });
    const tombstone = await store.getConnection("github", identity.issuer, identity.subject);
    expect(tombstone).toMatchObject({
      generation: 0,
      phase: "disconnected",
      revocationState: "complete",
    });
    expect(tombstone?.localDisabledAt).toBeInstanceOf(Date);
    expect(
      lifecycle.activateAuthorizedGeneration(
        identity,
        scopes,
        {
          credential: {
            activeCredential: "late-callback-active",
            renewalCredential: "late-callback-renewal",
          },
          displayAccountIdentity: identity.email,
          grantedScopes: scopes,
          validatedAt: new Date(),
        },
        { generation: 0, locallyDisabled: false },
      ),
    ).rejects.toMatchObject({ category: "generation_conflict" });
  });

  test("continues pending cleanup after one row cannot be processed", async () => {
    const store = new InMemoryOAuthTokenStore();
    const adapter = new FixtureAdapter();
    adapter.revocation = () => Promise.resolve("retryable_failure");
    const lifecycle = fixtureLifecycle(store, adapter);
    const secondIdentity = { ...identity, subject: "subject-2", email: "second@example.com" };
    await authorize(lifecycle, "first-active", "first-renewal");
    await lifecycle.activateAuthorizedGeneration(secondIdentity, scopes, {
      credential: { activeCredential: "second-active", renewalCredential: "second-renewal" },
      displayAccountIdentity: secondIdentity.email,
      grantedScopes: scopes,
      validatedAt: new Date(),
    });
    await lifecycle.disconnect(identity, scopes);
    await lifecycle.disconnect(secondIdentity, scopes);
    const malformed = await store.getConnection("github", identity.issuer, identity.subject);
    if (!malformed) throw new Error("expected first pending connection");
    await store.saveConnection(
      { ...malformed, encryptedCredentialEnvelope: "not-an-envelope" },
      connectionWriteGuard(malformed),
    );
    adapter.revocation = () => Promise.resolve("revoked");

    expect(await lifecycle.retryPendingRevocations()).toBe(2);
    expect(
      await store.getConnection("github", secondIdentity.issuer, secondIdentity.subject),
    ).toMatchObject({ phase: "disconnected", revocationState: "complete" });
    expect(await store.getConnection("github", identity.issuer, identity.subject)).toMatchObject({
      revocationState: "pending",
    });
  });

  test("does not fail disconnect when the cleanup audit sink rejects", async () => {
    const store = new InMemoryOAuthTokenStore();
    const adapter = new FixtureAdapter();
    adapter.revocation = () => Promise.resolve("retryable_failure");
    const lifecycle = new ConnectionLifecycle({
      adapter,
      store,
      credentialEncryptionKey: key,
      audit: { emit: () => Promise.reject(new Error("audit disk full")) },
    });
    await authorize(lifecycle, "active", "renewal");

    expect(await lifecycle.disconnect(identity, scopes)).toMatchObject({
      phase: "disconnected_with_provider_cleanup_pending",
      connected: false,
    });
  });
});

function fixtureLifecycle(
  store: InMemoryOAuthTokenStore,
  adapter: DownstreamConnectionAdapter,
): ConnectionLifecycle {
  return new ConnectionLifecycle({ adapter, store, credentialEncryptionKey: key });
}

function authorize(
  lifecycle: ConnectionLifecycle,
  activeCredential: string,
  renewalCredential: string,
  activeCredentialExpiresAt = new Date(Date.now() + 3_600_000),
): Promise<unknown> {
  return lifecycle.activateAuthorizedGeneration(identity, scopes, {
    credential: { activeCredential, renewalCredential },
    displayAccountIdentity: identity.email,
    grantedScopes: scopes,
    activeCredentialExpiresAt,
    renewalCredentialExpiresAt: new Date(Date.now() + 7_200_000),
    validatedAt: new Date(),
  });
}
