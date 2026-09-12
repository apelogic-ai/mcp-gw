import { describe, expect, test } from "bun:test";

import type { Hop1Identity } from "../identity/hop1";
import { ConnectionLifecycle } from "./connection-lifecycle";
import { createConnectionRouteHandler } from "./connection-routes";
import type { DownstreamConnectionAdapter, RenewedCredentialGeneration } from "./connection-types";
import { InMemoryOAuthTokenStore } from "./memory-store";

const key = Buffer.alloc(32, 9).toString("base64");
const identity: Hop1Identity = {
  profile: "test",
  issuer: "https://issuer.example.com",
  subject: "principal",
  email: "user@example.com",
  claims: {},
};

class RouteAdapter implements DownstreamConnectionAdapter {
  readonly providerId = "github" as const;
  readonly capabilities = {
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

  renew(): Promise<RenewedCredentialGeneration> {
    return Promise.resolve({
      credential: { activeCredential: "active-2", renewalCredential: "renewal-2" },
      grantedScopes: ["repo"],
      activeCredentialExpiresAt: new Date(Date.now() + 3_600_000),
    });
  }

  revoke(): Promise<"revoked"> {
    return Promise.resolve("revoked");
  }
}

describe("generic connection routes", () => {
  test("supports status, refresh, reauthorization while connected, and disconnect", async () => {
    const lifecycle = new ConnectionLifecycle({
      adapter: new RouteAdapter(),
      store: new InMemoryOAuthTokenStore(),
      credentialEncryptionKey: key,
    });
    await lifecycle.activateAuthorizedGeneration(identity, ["repo"], {
      credential: { activeCredential: "active-1", renewalCredential: "renewal-1" },
      displayAccountIdentity: identity.email,
      grantedScopes: ["repo"],
      activeCredentialExpiresAt: new Date(Date.now() + 3_600_000),
      validatedAt: new Date(),
    });
    let authorizeCalls = 0;
    const handler = createConnectionRouteHandler({
      authenticate: () => Promise.resolve(identity),
      lifecycle,
      requiredScopes: ["repo"],
      startAuthorization: (_principal, redirectAfter) => {
        authorizeCalls += 1;
        return Promise.resolve({
          authorizationUrl: `https://provider.example/authorize?return=${redirectAfter ?? ""}`,
        });
      },
    });
    const headers = { authorization: "Bearer hop1", "content-type": "application/json" };

    const status = await handler(
      new Request("https://mcp.example/connections/github/status", { headers }),
    );
    expect(await status.json()).toMatchObject({
      version: "1",
      provider: "github",
      phase: "connected",
      connected: true,
    });

    const authorize = await handler(
      new Request("https://mcp.example/connections/github/authorize", {
        method: "POST",
        headers,
        body: JSON.stringify({ redirectAfter: "/connections" }),
      }),
    );
    expect(await authorize.json()).toEqual({
      authorizationUrl: "https://provider.example/authorize?return=/connections",
    });
    expect(authorizeCalls).toBe(1);
    expect((await lifecycle.status(identity, ["repo"])).connected).toBe(true);

    const refresh = await handler(
      new Request("https://mcp.example/connections/github/refresh", {
        method: "POST",
        headers,
      }),
    );
    expect(await refresh.json()).toMatchObject({
      result: "refreshed",
      status: { phase: "connected", connected: true },
    });
    expect(await lifecycle.getActiveCredential(identity, ["repo"])).toBe("active-2");

    const disconnect = await handler(
      new Request("https://mcp.example/connections/github/disconnect", {
        method: "POST",
        headers,
      }),
    );
    expect(await disconnect.json()).toMatchObject({ phase: "disconnected", connected: false });
  });

  test("never accepts an unauthenticated principal", async () => {
    const lifecycle = new ConnectionLifecycle({
      adapter: new RouteAdapter(),
      store: new InMemoryOAuthTokenStore(),
      credentialEncryptionKey: key,
    });
    const handler = createConnectionRouteHandler({
      authenticate: () => Promise.reject(new Error("invalid bearer")),
      lifecycle,
      requiredScopes: ["repo"],
      startAuthorization: () => Promise.resolve({ authorizationUrl: "unused" }),
    });
    const response = await handler(new Request("https://mcp.example/connections/github/status"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  test("reports authorizing for a disconnected principal after authorization starts", async () => {
    const lifecycle = new ConnectionLifecycle({
      adapter: new RouteAdapter(),
      store: new InMemoryOAuthTokenStore(),
      credentialEncryptionKey: key,
    });
    const handler = createConnectionRouteHandler({
      authenticate: () => Promise.resolve(identity),
      lifecycle,
      requiredScopes: ["repo"],
      startAuthorization: () =>
        Promise.resolve({ authorizationUrl: "https://provider.example/authorize" }),
    });
    const headers = { authorization: "Bearer hop1" };
    await handler(
      new Request("https://mcp.example/connections/github/authorize", {
        method: "POST",
        headers,
      }),
    );

    const status = await handler(
      new Request("https://mcp.example/connections/github/status", { headers }),
    );
    const body = (await status.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      phase: "authorizing",
      connected: false,
    });
    expect(body.account).toBeUndefined();
  });
});
