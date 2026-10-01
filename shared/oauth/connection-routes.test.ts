import { describe, expect, test } from "bun:test";

import type { Hop1Identity } from "../identity/hop1";
import { ConnectionLifecycle } from "./connection-lifecycle";
import {
  ConnectionRouteError,
  connectionErrorResponse,
  createConnectionRouteHandler,
} from "./connection-routes";
import {
  ProviderLifecycleError,
  type DecryptedCredentialGeneration,
  type DownstreamConnectionAdapter,
  type RenewedCredentialGeneration,
  type ValidatedProviderIdentity,
} from "./connection-types";
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
    accountIdentityReporting: true,
  };
  renewCalls = 0;

  renew(): Promise<RenewedCredentialGeneration> {
    this.renewCalls += 1;
    return Promise.resolve({
      credential: { activeCredential: "active-2", renewalCredential: "renewal-2" },
      grantedScopes: ["repo"],
      activeCredentialExpiresAt: new Date(Date.now() + 3_600_000),
    });
  }

  revoke(): Promise<"revoked"> {
    return Promise.resolve("revoked");
  }

  validateIdentity(
    _credential: DecryptedCredentialGeneration,
    expected: Hop1Identity,
  ): Promise<ValidatedProviderIdentity> {
    return Promise.resolve({
      displayAccountIdentity: expected.email,
      providerAccount: { id: "123456", login: "octocat" },
    });
  }
}

describe("generic connection routes", () => {
  test("maps every lifecycle category to a stable response code", async () => {
    const cases = [
      ["authorization_denied", 400, "oauth_authorization_denied"],
      ["identity_mismatch", 400, "oauth_identity_mismatch"],
      ["generation_conflict", 409, "oauth_generation_conflict"],
      ["invalid_active_credential", 409, "oauth_invalid_active_credential"],
      ["invalid_renewal_credential", 409, "oauth_invalid_renewal_credential"],
      ["renewal_expired", 409, "oauth_renewal_expired"],
      ["insufficient_scope", 409, "oauth_insufficient_scope"],
      ["transient_provider_failure", 503, "oauth_provider_unavailable"],
      ["provider_configuration_error", 503, "oauth_provider_configuration_error"],
      ["malformed_provider_response", 503, "oauth_provider_response_malformed"],
      ["persistence_failure", 503, "oauth_persistence_failure"],
    ] as const;

    for (const [category, status, code] of cases) {
      const response = connectionErrorResponse(new ProviderLifecycleError("private", category));
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: category, code });
    }

    const override = connectionErrorResponse(
      new ConnectionRouteError(
        "private",
        "authorization_denied",
        "oauth_redirect_target_not_allowed",
      ),
    );
    expect(await override.json()).toEqual({
      error: "authorization_denied",
      code: "oauth_redirect_target_not_allowed",
    });
  });

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
    const statusBody = (await status.json()) as Record<string, unknown>;
    expect(typeof statusBody.activeCredentialExpiresAt).toBe("string");
    expect(typeof statusBody.lastAuthorizedAt).toBe("string");
    expect(typeof statusBody.lastValidatedAt).toBe("string");
    expect(typeof statusBody.statusUpdatedAt).toBe("string");
    expect(statusBody).toEqual({
      version: "1",
      provider: "github",
      phase: "connected",
      connected: true,
      account: { displayName: identity.email },
      requiredScopes: ["repo"],
      grantedScopes: ["repo"],
      missingScopes: [],
      activeCredentialPresent: true,
      renewalCredentialPresent: true,
      activeCredentialExpiresAt: statusBody.activeCredentialExpiresAt,
      renewalCredentialExpiresAt: null,
      lastAuthorizedAt: statusBody.lastAuthorizedAt,
      lastRenewedAt: null,
      lastValidatedAt: statusBody.lastValidatedAt,
      statusUpdatedAt: statusBody.statusUpdatedAt,
      capabilities: new RouteAdapter().capabilities,
    });

    const statusV2 = await handler(
      new Request("https://mcp.example/connections/github/status", {
        headers: {
          ...headers,
          accept: "application/vnd.apelogic.connection-status.v2+json",
        },
      }),
    );
    expect(await statusV2.json()).toMatchObject({
      version: "2",
      provider: "github",
      account: {
        provider: "github",
        displayName: identity.email,
        id: "123456",
        login: "octocat",
      },
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
      status: {
        version: "1",
        phase: "connected",
        connected: true,
        account: { displayName: identity.email },
      },
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
    expect(await response.json()).toEqual({
      error: "Unauthorized",
      code: "oauth_unauthorized",
    });
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

  test("preserves a valid static credential when manual refresh is unsupported", async () => {
    const adapter = new RouteAdapter();
    const lifecycle = new ConnectionLifecycle({
      adapter,
      store: new InMemoryOAuthTokenStore(),
      credentialEncryptionKey: key,
    });
    await lifecycle.activateAuthorizedGeneration(identity, ["repo"], {
      credential: { activeCredential: "static-active" },
      displayAccountIdentity: identity.email,
      grantedScopes: ["repo"],
      validatedAt: new Date(),
    });
    const handler = createConnectionRouteHandler({
      authenticate: () => Promise.resolve(identity),
      lifecycle,
      requiredScopes: ["repo"],
      startAuthorization: () => Promise.resolve({ authorizationUrl: "unused" }),
    });

    const response = await handler(
      new Request("https://mcp.example/connections/github/refresh", {
        method: "POST",
        headers: { authorization: "Bearer hop1" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: "refresh_not_supported",
      status: { phase: "connected", connected: true },
    });
    expect(adapter.renewCalls).toBe(0);
    expect(await lifecycle.getActiveCredential(identity, ["repo"])).toBe("static-active");
  });

  test("sanitizes unexpected connection-store failures", async () => {
    const cases = [
      { method: "GET", action: "status" },
      { method: "POST", action: "refresh" },
      { method: "POST", action: "disconnect" },
      { method: "POST", action: "authorize" },
    ];

    for (const route of cases) {
      const store = new InMemoryOAuthTokenStore();
      if (route.action === "authorize") {
        store.markAuthorizing = () => Promise.reject(new Error("database unavailable"));
      } else {
        store.getConnection = () => Promise.reject(new Error("database unavailable"));
      }
      const lifecycle = new ConnectionLifecycle({
        adapter: new RouteAdapter(),
        store,
        credentialEncryptionKey: key,
      });
      const handler = createConnectionRouteHandler({
        authenticate: () => Promise.resolve(identity),
        lifecycle,
        requiredScopes: ["repo"],
        startAuthorization: () =>
          Promise.resolve({ authorizationUrl: "https://provider.example/authorize" }),
      });

      const response = await handler(
        new Request(`https://mcp.example/connections/github/${route.action}`, {
          method: route.method,
          headers: { authorization: "Bearer hop1" },
        }),
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "persistence_failure",
        code: "oauth_persistence_failure",
      });
    }
  });
});
