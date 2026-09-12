import { describe, expect, test } from "bun:test";

import type { Hop1Identity } from "../../shared/identity/hop1";
import type { ConnectionLifecycle } from "../../shared/oauth/connection-lifecycle";
import type { DownstreamConnectionAdapter } from "../../shared/oauth/connection-types";
import type { OAuthConnectionStore } from "../../shared/oauth/store";

export interface ProviderLifecycleConformanceHarness {
  adapter: DownstreamConnectionAdapter;
  lifecycle: ConnectionLifecycle;
  store: OAuthConnectionStore;
  identity: Hop1Identity;
  requiredScopes: string[];
  expectedRenewedActiveCredential: string;
  authorize(expired?: boolean): Promise<void>;
  providerCalls(): number;
}

/**
 * Reusable behavioral contract for every downstream provider adapter. A new
 * adapter must add a harness invocation; capability-gated cases apply
 * automatically.
 */
export function defineProviderLifecycleConformance(
  name: string,
  createHarness: () => ProviderLifecycleConformanceHarness,
): void {
  describe(`${name} connection adapter conformance`, () => {
    test("declares executable operations for every advertised capability", () => {
      const { adapter } = createHarness();
      if (adapter.capabilities.interactiveAuthorization) {
        expect(typeof adapter.startAuthorization).toBe("function");
        expect(typeof adapter.completeAuthorization).toBe("function");
      }
      if (adapter.capabilities.automaticRenewal || adapter.capabilities.manualRenewal) {
        expect(typeof adapter.renew).toBe("function");
      }
      if (adapter.capabilities.providerValidation)
        expect(typeof adapter.validateIdentity).toBe("function");
      if (adapter.capabilities.providerRevocation) expect(typeof adapter.revoke).toBe("function");
    });

    test("reports truthful status without a provider call or credential leakage", async () => {
      const harness = createHarness();
      await harness.authorize();
      const status = await harness.lifecycle.status(harness.identity, harness.requiredScopes);
      expect(status).toMatchObject({
        version: "1",
        provider: harness.adapter.providerId,
        phase: "connected",
        connected: true,
      });
      expect(harness.providerCalls()).toBe(0);
      expect(JSON.stringify(status)).not.toContain("active-old");
      expect(JSON.stringify(status)).not.toContain("renewal-old");
      const stored = await harness.store.getConnection(
        harness.adapter.providerId,
        harness.identity.issuer,
        harness.identity.subject,
      );
      expect(stored?.encryptedCredentialEnvelope).toBeString();
      expect(JSON.stringify(stored)).not.toContain("active-old");
      expect(JSON.stringify(stored)).not.toContain("renewal-old");
    });

    test("isolates the immutable HOP-1 principal and reports missing scopes", async () => {
      const harness = createHarness();
      await harness.authorize();
      const other = { ...harness.identity, subject: `${harness.identity.subject}-other` };
      expect(await harness.lifecycle.status(other, harness.requiredScopes)).toMatchObject({
        phase: "disconnected",
        connected: false,
      });
      expect(
        harness.lifecycle.getActiveCredential(other, harness.requiredScopes),
      ).rejects.toBeInstanceOf(Error);
      expect(
        await harness.lifecycle.status(harness.identity, [
          ...harness.requiredScopes,
          "scope-that-was-not-granted",
        ]),
      ).toMatchObject({
        phase: "reauthorization_required",
        connected: false,
        missingScopes: ["scope-that-was-not-granted"],
      });
    });

    test("renews an expired generation once under concurrent brokerage", async () => {
      const harness = createHarness();
      if (!harness.adapter.capabilities.automaticRenewal) return;
      await harness.authorize(true);
      const active = await Promise.all([
        harness.lifecycle.getActiveCredential(harness.identity, harness.requiredScopes),
        harness.lifecycle.getActiveCredential(harness.identity, harness.requiredScopes),
      ]);
      expect(active).toEqual([
        harness.expectedRenewedActiveCredential,
        harness.expectedRenewedActiveCredential,
      ]);
      expect(harness.providerCalls()).toBe(1);
    });

    test("uses the same renewal path for user-initiated refresh", async () => {
      const harness = createHarness();
      if (!harness.adapter.capabilities.manualRenewal) return;
      await harness.authorize();
      expect(
        await harness.lifecycle.refresh(harness.identity, harness.requiredScopes),
      ).toMatchObject({ result: "refreshed", status: { connected: true } });
      expect(harness.providerCalls()).toBe(1);
    });

    test("makes disconnect locally effective and completes provider cleanup", async () => {
      const harness = createHarness();
      await harness.authorize();
      const status = await harness.lifecycle.disconnect(harness.identity, harness.requiredScopes);
      expect(status).toMatchObject({ phase: "disconnected", connected: false });
      expect(
        harness.lifecycle.getActiveCredential(harness.identity, harness.requiredScopes),
      ).rejects.toBeInstanceOf(Error);
      expect(harness.providerCalls()).toBe(harness.adapter.capabilities.providerRevocation ? 1 : 0);
      await harness.lifecycle.disconnect(harness.identity, harness.requiredScopes);
      expect(harness.providerCalls()).toBe(harness.adapter.capabilities.providerRevocation ? 1 : 0);
    });
  });
}
