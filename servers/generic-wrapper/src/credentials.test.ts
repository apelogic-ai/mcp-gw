import { describe, expect, test } from "bun:test";

import type { Hop1Identity } from "../../../shared/identity/hop1";
import { createGenericCredentialResolver } from "./credentials";

const identity: Hop1Identity = {
  profile: "fixture",
  issuer: "https://identity.example.com",
  subject: "subject-1",
  email: "user@example.com",
  claims: {},
};

describe("generic wrapper credentials", () => {
  test("forwards no HOP-1 authorization in none mode", async () => {
    const resolver = createGenericCredentialResolver({ mode: "none" }, {});
    expect(await resolver.resolve({ identity, hop1Token: "hop1-secret", scopes: [] })).toBeNull();
  });

  test("reads a static API key only from the named environment variable", async () => {
    const resolver = createGenericCredentialResolver(
      { mode: "static_secret", env: "UPSTREAM_API_KEY", header: "x-api-key" },
      { UPSTREAM_API_KEY: "provider-secret" },
    );
    expect(await resolver.resolve({ identity, hop1Token: "hop1-secret", scopes: [] })).toEqual({
      header: "x-api-key",
      value: "provider-secret",
      rawValue: "provider-secret",
    });
  });

  test("exchanges the caller token without forwarding it to the MCP upstream", async () => {
    const requests: Request[] = [];
    const resolver = createGenericCredentialResolver(
      {
        mode: "token_exchange",
        endpoint: "https://identity.example.com/oauth/token",
        audience: "https://mcp.example.com",
        clientIdEnv: "TOKEN_EXCHANGE_CLIENT_ID",
        clientSecretEnv: "TOKEN_EXCHANGE_CLIENT_SECRET",
      },
      {
        TOKEN_EXCHANGE_CLIENT_ID: "wrapper-client",
        TOKEN_EXCHANGE_CLIENT_SECRET: "wrapper-secret",
      },
      {
        fetch: (input, init) => {
          requests.push(
            input instanceof Request
              ? new Request(input, init)
              : new Request(input.toString(), init),
          );
          return Promise.resolve(
            Response.json({
              access_token: "exchanged-provider-token",
              issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
              token_type: "Bearer",
              expires_in: 300,
            }),
          );
        },
      },
    );

    expect(
      await resolver.resolve({ identity, hop1Token: "hop1-secret", scopes: ["search.read"] }),
    ).toEqual({
      header: "authorization",
      value: "Bearer exchanged-provider-token",
      rawValue: "exchanged-provider-token",
    });
    const request = requests[0];
    expect(request?.headers.get("authorization")).toStartWith("Basic ");
    const body = await request?.text();
    expect(body).toContain("subject_token=hop1-secret");
    expect(body).not.toContain("wrapper-secret");
  });

  test("bounds exchanged-token cache entries", async () => {
    let exchanges = 0;
    const resolver = createGenericCredentialResolver(
      {
        mode: "token_exchange",
        endpoint: "https://identity.example.com/oauth/token",
        audience: "https://mcp.example.com",
      },
      {},
      {
        maxCacheEntries: 1,
        fetch: () => {
          exchanges += 1;
          return Promise.resolve(
            Response.json({
              access_token: `provider-token-${String(exchanges)}`,
              issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
              expires_in: 300,
            }),
          );
        },
      },
    );

    await resolver.resolve({ identity, hop1Token: "hop1-one", scopes: [] });
    await resolver.resolve({ identity, hop1Token: "hop1-two", scopes: [] });
    await resolver.resolve({ identity, hop1Token: "hop1-one", scopes: [] });

    expect(exchanges).toBe(3);
  });

  test("rejects a token exchange response with the wrong issued token type", async () => {
    const resolver = createGenericCredentialResolver(
      {
        mode: "token_exchange",
        endpoint: "https://identity.example.com/oauth/token",
        resource: "https://mcp.example.com",
      },
      {},
      {
        fetch: () =>
          Promise.resolve(
            Response.json({
              access_token: "wrong-kind",
              issued_token_type: "urn:ietf:params:oauth:token-type:refresh_token",
            }),
          ),
      },
    );

    await expect(
      resolver.resolve({ identity, hop1Token: "hop1-secret", scopes: [] }),
    ).rejects.toThrow("malformed");
  });
});
