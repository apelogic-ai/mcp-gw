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
} from "./connection-types";
import { ProviderLifecycleError } from "./connection-types";
import { InMemoryOAuthTokenStore } from "./memory-store";
import { encryptSecret } from "./crypto";

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
}

describe("provider-neutral connection lifecycle", () => {
  test("returns truthful sanitized status without decrypting the credential envelope", async () => {
    const store = new InMemoryOAuthTokenStore();
    const adapter = new FixtureAdapter();
    const lifecycle = fixtureLifecycle(store, adapter);
    await authorize(lifecycle, "active-1", "renewal-1");
    const record = await store.getConnection("github", identity.issuer, identity.subject);
    if (!record) throw new Error("expected authorized connection");
    await store.saveConnection({ ...record, encryptedCredentialEnvelope: "not-ciphertext" }, 1);

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

  test("old-generation cleanup cannot disable a concurrently reauthorized generation", async () => {
    const store = new InMemoryOAuthTokenStore();
    const adapter = new FixtureAdapter();
    let finishRevocation = (result: ProviderRevocationResult): void => {
      throw new Error(`revocation resolver was not initialized: ${result}`);
    };
    adapter.revocation = () =>
      new Promise<ProviderRevocationResult>((resolve) => {
        finishRevocation = resolve;
      });
    const lifecycle = fixtureLifecycle(store, adapter);
    await authorize(lifecycle, "old-active", "old-renewal");
    const disconnecting = lifecycle.disconnect(identity, scopes);
    while (adapter.revokeCalls === 0) await Bun.sleep(1);

    await authorize(lifecycle, "new-active", "new-renewal");
    finishRevocation("revoked");
    await disconnecting;

    expect(await lifecycle.getActiveCredential(identity, scopes)).toBe("new-active");
    expect(await lifecycle.status(identity, scopes)).toMatchObject({
      phase: "connected",
      connected: true,
    });
    expect(
      (await store.getConnection("github", identity.issuer, identity.subject))?.generation,
    ).toBe(2);
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
    const lifecycle = fixtureLifecycle(store, new FixtureAdapter());
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
    expect(await lifecycle.status(identity, scopes)).toMatchObject({
      phase: "disconnected",
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
