import { describe, expect, test } from "bun:test";

import {
  ConstrainedDcrError,
  ConstrainedDcrRegistry,
  InMemoryDcrRegistrationStore,
  type ConstrainedDcrErrorCode,
  type DcrRegistrationStore,
} from "./dcr";

const validMetadata = {
  redirect_uris: ["https://client.example/callback"],
  grant_types: ["authorization_code"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
  client_name: "Example MCP Client",
  client_uri: "https://client.example",
};

describe("constrained dynamic client registration", () => {
  test("registers only a public authorization-code client and returns no credentials", async () => {
    const registry = createRegistry();

    const registration = await registry.register(validMetadata, { rateLimitKey: "198.51.100.10" });

    expect(registration).toEqual({
      client_id: "dynamic-client-1",
      client_id_issued_at: 1_700_000_000,
      redirect_uris: ["https://client.example/callback"],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "mcp",
      client_name: "Example MCP Client",
      client_uri: "https://client.example/",
    });
    expect(registration).not.toHaveProperty("client_secret");
    expect(registration).not.toHaveProperty("registration_access_token");
    expect(registration).not.toHaveProperty("registration_client_uri");
    expect(await registry.getClient(registration.client_id)).toMatchObject({
      client_name: "Example MCP Client",
      client_uri: "https://client.example/",
      registrationType: "dynamic",
    });
  });

  test("rejects unsupported grants, response types, and authentication methods", async () => {
    const attempts: unknown[] = [
      { ...validMetadata, grant_types: ["client_credentials"] },
      { ...validMetadata, grant_types: ["authorization_code", "refresh_token"] },
      { ...validMetadata, response_types: ["token"] },
      { ...validMetadata, token_endpoint_auth_method: "client_secret_basic" },
      { ...validMetadata, token_endpoint_auth_method: undefined },
    ];

    for (const [index, metadata] of attempts.entries()) {
      await expectDcrError(
        () => createRegistry().register(metadata, { rateLimitKey: `attempt-${String(index)}` }),
        "invalid_client_metadata",
      );
    }
  });

  test("requires exact HTTPS redirects and optionally permits loopback HTTP redirects", async () => {
    const rejected = [
      "http://client.example/callback",
      "https://client.example/callback#fragment",
      "https://user:password@client.example/callback",
      "https://127.0.0.1/callback",
      "http://192.168.1.4/callback",
      "custom-scheme://callback",
    ];

    for (const [index, redirectUri] of rejected.entries()) {
      await expectDcrError(
        () =>
          createRegistry().register(
            { ...validMetadata, redirect_uris: [redirectUri] },
            { rateLimitKey: `redirect-${String(index)}` },
          ),
        "invalid_redirect_uri",
      );
    }

    await expectDcrError(
      () =>
        createRegistry().register(
          { ...validMetadata, redirect_uris: ["http://127.0.0.1:49152/callback"] },
          { rateLimitKey: "loopback-disabled" },
        ),
      "invalid_redirect_uri",
    );

    const registry = createRegistry({ allowLoopbackRedirects: true });
    expect(
      (
        await registry.register(
          {
            ...validMetadata,
            redirect_uris: [
              "http://127.0.0.1:49152/callback",
              "http://[::1]:49153/callback",
              "http://localhost:49154/callback",
            ],
          },
          { rateLimitKey: "loopback-enabled" },
        )
      ).redirect_uris,
    ).toEqual([
      "http://127.0.0.1:49152/callback",
      "http://[::1]:49153/callback",
      "http://localhost:49154/callback",
    ]);
  });

  test("rejects malformed, unknown, and SSRF-prone metadata", async () => {
    const rejected: unknown[] = [
      null,
      [],
      { ...validMetadata, redirect_uris: [] },
      { ...validMetadata, redirect_uris: ["https://client.example/callback", 7] },
      { ...validMetadata, redirect_uris: ["https://client.example/callback"], extra: true },
      { ...validMetadata, client_name: "" },
      { ...validMetadata, contacts: ["not-an-email"] },
      { ...validMetadata, client_uri: "https://127.0.0.1/client" },
      { ...validMetadata, logo_uri: "https://169.254.169.254/latest/meta-data" },
      { ...validMetadata, logo_uri: "https://[::ffff:7f00:1]/latest/meta-data" },
      { ...validMetadata, policy_uri: "https://service.internal/policy" },
      { ...validMetadata, policy_uri: "https://metadata/policy" },
      { ...validMetadata, tos_uri: "http://public.example/terms" },
      { ...validMetadata, jwks_uri: "https://public.example/jwks.json" },
      { ...validMetadata, request_uris: ["https://public.example/request.jwt"] },
      { ...validMetadata, client_id: "existing-client" },
      { ...validMetadata, client_secret: "must-not-be-accepted" },
      { ...validMetadata, scope: "mcp admin" },
    ];

    for (const [index, metadata] of rejected.entries()) {
      await expectAnyDcrError(() =>
        createRegistry().register(metadata, { rateLimitKey: `metadata-${String(index)}` }),
      );
    }
  });

  test("persists redirect URIs exactly and requires S256 PKCE at authorization", async () => {
    const registry = createRegistry();
    const registration = await registry.register(
      {
        ...validMetadata,
        redirect_uris: ["https://client.example/callback?tenant=one"],
      },
      { rateLimitKey: "authorization" },
    );
    const request = {
      clientId: registration.client_id,
      redirectUri: "https://client.example/callback?tenant=one",
      codeChallenge: "A".repeat(43),
      codeChallengeMethod: "S256",
      requestedScopes: ["mcp"],
    };

    expect((await registry.validateAuthorizationRequest(request)).client_id).toBe(
      registration.client_id,
    );
    await expectDcrError(
      () =>
        registry.validateAuthorizationRequest({
          ...request,
          redirectUri: "https://client.example/callback?tenant=two",
        }),
      "invalid_redirect_uri",
    );
    await expectDcrError(
      () => registry.validateAuthorizationRequest({ ...request, codeChallengeMethod: "plain" }),
      "invalid_pkce",
    );
    await expectDcrError(
      () => registry.validateAuthorizationRequest({ ...request, codeChallenge: "short" }),
      "invalid_pkce",
    );
    await expectDcrError(
      () => registry.validateAuthorizationRequest({ ...request, requestedScopes: ["admin"] }),
      "invalid_scope",
    );
  });

  test("does not permit replay as a client-id mutation or metadata update", async () => {
    const registry = createRegistry();
    const registration = await registry.register(validMetadata, { rateLimitKey: "first" });

    await expectDcrError(
      () =>
        registry.register(
          {
            ...validMetadata,
            client_id: registration.client_id,
            redirect_uris: ["https://attacker.example/callback"],
          },
          { rateLimitKey: "replay" },
        ),
      "invalid_client_metadata",
    );
    expect((await registry.getClient(registration.client_id))?.redirect_uris).toEqual(
      validMetadata.redirect_uris,
    );
  });

  test("rate-limits attempts per caller and resets after the bounded window", async () => {
    let now = 1_700_000_000_000;
    const registry = createRegistry({
      now: () => now,
      maxRegistrationsPerWindow: 2,
      rateLimitWindowMs: 1_000,
    });

    await registry.register(validMetadata, { rateLimitKey: "caller-a" });
    await registry.register(validMetadata, { rateLimitKey: "caller-a" });
    await expectDcrError(
      () => registry.register(validMetadata, { rateLimitKey: "caller-a" }),
      "rate_limited",
      429,
    );

    await registry.register(validMetadata, { rateLimitKey: "caller-b" });
    now += 1_001;
    expect((await registry.register(validMetadata, { rateLimitKey: "caller-a" })).client_id).toBe(
      "dynamic-client-4",
    );
  });

  test("expires dynamic clients, bounds capacity, and never evicts static clients", async () => {
    let now = 1_700_000_000_000;
    const registry = createRegistry({
      now: () => now,
      maxDynamicClients: 2,
      dynamicClientTtlMs: 1_000,
      staticClients: [
        {
          clientId: "static-client",
          redirectUris: ["https://static.example/callback"],
          clientName: "Static Client",
        },
      ],
    });

    const first = await registry.register(validMetadata, { rateLimitKey: "one" });
    await registry.register(validMetadata, { rateLimitKey: "two" });
    await expectDcrError(
      () => registry.register(validMetadata, { rateLimitKey: "three" }),
      "registry_full",
      503,
    );
    expect((await registry.getClient("static-client"))?.registrationType).toBe("static");
    expect((await registry.getClient("static-client"))?.scope).toBe("mcp");

    now += 1_001;
    expect(await registry.getClient(first.client_id)).toBeNull();
    expect((await registry.register(validMetadata, { rateLimitKey: "three" })).client_id).toBe(
      "dynamic-client-4",
    );
    expect((await registry.getClient("static-client"))?.redirect_uris).toEqual([
      "https://static.example/callback",
    ]);
  });

  test("returns defensive copies of persisted registrations", async () => {
    const registry = createRegistry();
    const registered = await registry.register(validMetadata, { rateLimitKey: "copy" });
    registered.redirect_uris[0] = "https://attacker.example/callback";

    expect((await registry.getClient(registered.client_id))?.redirect_uris).toEqual([
      "https://client.example/callback",
    ]);
  });

  test("persists dynamic clients through an injectable asynchronous store", async () => {
    const store = new InMemoryDcrRegistrationStore();
    const writer = createRegistry({ store });
    const registered = await writer.register(validMetadata, { rateLimitKey: "writer" });
    const reader = createRegistry({ store });

    expect((await reader.getClient(registered.client_id))?.registrationType).toBe("dynamic");
    expect((await reader.getClient(registered.client_id))?.redirect_uris).toEqual(
      validMetadata.redirect_uris,
    );
  });
});

interface RegistryOverrides {
  allowLoopbackRedirects?: boolean;
  dynamicClientTtlMs?: number;
  maxDynamicClients?: number;
  maxRegistrationsPerWindow?: number;
  now?: () => number;
  rateLimitWindowMs?: number;
  staticClients?: {
    clientId: string;
    redirectUris: string[];
    clientName?: string;
  }[];
  store?: DcrRegistrationStore;
}

function createRegistry(overrides: RegistryOverrides = {}): ConstrainedDcrRegistry {
  let sequence = 0;
  return new ConstrainedDcrRegistry({
    allowLoopbackRedirects: overrides.allowLoopbackRedirects ?? false,
    dynamicClientTtlMs: overrides.dynamicClientTtlMs ?? 60_000,
    maxDynamicClients: overrides.maxDynamicClients ?? 20,
    maxRegistrationsPerWindow: overrides.maxRegistrationsPerWindow ?? 20,
    maxRateLimitKeys: 100,
    rateLimitWindowMs: overrides.rateLimitWindowMs ?? 60_000,
    staticClients: overrides.staticClients,
    store: overrides.store,
    now: overrides.now ?? (() => 1_700_000_000_000),
    generateClientId: () => `dynamic-client-${String(++sequence)}`,
  });
}

async function expectDcrError(
  action: () => Promise<unknown>,
  code: ConstrainedDcrErrorCode,
  httpStatus = 400,
): Promise<void> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConstrainedDcrError);
  expect((caught as ConstrainedDcrError).code).toBe(code);
  expect((caught as ConstrainedDcrError).httpStatus).toBe(httpStatus);
}

async function expectAnyDcrError(action: () => Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConstrainedDcrError);
}
