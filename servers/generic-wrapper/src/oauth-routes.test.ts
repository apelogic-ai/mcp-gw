import { describe, expect, test } from "bun:test";

import type { Hop1Identity } from "../../../shared/identity/hop1";
import {
  InMemoryOAuthStateStore,
  InMemoryOAuthTokenStore,
} from "../../../shared/oauth/memory-store";
import type { GenericOAuthCredentialDescriptor } from "./descriptor";
import { createGenericOAuthRuntimeConfig } from "./oauth";
import { createGenericOAuthRouteHandler } from "./oauth-routes";

const identity: Hop1Identity = {
  profile: "fixture",
  issuer: "https://identity.example.com",
  subject: "subject-1",
  email: "user@example.com",
  claims: {},
};
const descriptor: GenericOAuthCredentialDescriptor = {
  mode: "per_user_oauth",
  providerId: "search-provider",
  authorizationUrl: "https://identity.example.com/oauth/authorize",
  tokenUrl: "https://identity.example.com/oauth/token",
  userInfoUrl: "https://identity.example.com/oauth/userinfo",
  redirectUri: "https://gateway.example.com/oauth/search-provider/callback",
  scopes: ["search.read"],
  clientIdEnv: "OAUTH_CLIENT_ID",
  clientSecretEnv: "OAUTH_CLIENT_SECRET",
  encryptionKeyEnv: "OAUTH_TOKEN_ENCRYPTION_KEY",
  tokenStoreDsnEnv: "TOKEN_STORE_DSN",
  identity: { idField: "sub", emailField: "email", emailVerifiedField: "email_verified" },
};
const config = createGenericOAuthRuntimeConfig(descriptor, {
  OAUTH_CLIENT_ID: "wrapper-client",
  OAUTH_CLIENT_SECRET: "wrapper-secret",
  OAUTH_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
  TOKEN_STORE_DSN: "postgresql://unused.example.com/oauth",
});

describe("generic OAuth routes", () => {
  test.each(["/\\evil.example/x", "/\t/evil.example/x"])(
    "rejects a browser-normalized cross-origin redirect target %j before creating OAuth state",
    async (redirectAfter) => {
      const stateStore = new InMemoryOAuthStateStore();
      const handler = createGenericOAuthRouteHandler({
        authenticate: () => Promise.resolve(identity),
        config,
        tokenStore: new InMemoryOAuthTokenStore(),
        stateStore,
      });

      const response = await handler(
        new Request("https://gateway.example.com/connections/search-provider/authorize", {
          method: "POST",
          headers: { authorization: "Bearer hop1", "content-type": "application/json" },
          body: JSON.stringify({ redirectAfter }),
        }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "authorization_denied",
        code: "oauth_redirect_target_not_allowed",
      });
    },
  );

  test("uses exact provider routes and consumes a denied callback state", async () => {
    const tokenStore = new InMemoryOAuthTokenStore();
    const stateStore = new InMemoryOAuthStateStore();
    const handler = createGenericOAuthRouteHandler({
      authenticate: () => Promise.resolve(identity),
      config,
      tokenStore,
      stateStore,
    });
    const started = await handler(
      new Request("https://gateway.example.com/connections/search-provider/authorize", {
        method: "POST",
        headers: { authorization: "Bearer hop1", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(started.status).toBe(200);
    const authorization = (await started.json()) as { authorizationUrl: string };
    const state = new URL(authorization.authorizationUrl).searchParams.get("state");
    expect(state).toBeString();

    const denied = await handler(
      new Request(
        `https://gateway.example.com/oauth/search-provider/callback?error=access_denied&state=${encodeURIComponent(state ?? "")}`,
      ),
    );
    expect(denied.status).toBe(400);
    expect(await denied.json()).toEqual({
      error: "authorization_denied",
      code: "oauth_authorization_denied",
    });
    const replay = await handler(
      new Request(
        `https://gateway.example.com/oauth/search-provider/callback?error=access_denied&state=${encodeURIComponent(state ?? "")}`,
      ),
    );
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: "invalid_state", code: "oauth_state_invalid" });
  });

  test("returns stable unauthorized and not-found classifications", async () => {
    const handler = createGenericOAuthRouteHandler({
      authenticate: () => Promise.reject(new Error("invalid")),
      config,
      tokenStore: new InMemoryOAuthTokenStore(),
      stateStore: new InMemoryOAuthStateStore(),
    });
    const unauthorized = await handler(
      new Request("https://gateway.example.com/connections/search-provider/status"),
    );
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({
      error: "Unauthorized",
      code: "oauth_unauthorized",
    });
    const missing = await handler(
      new Request("https://gateway.example.com/oauth/other-provider/callback"),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found", code: "oauth_route_not_found" });
  });
});
