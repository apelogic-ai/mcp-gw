import { describe, expect, spyOn, test } from "bun:test";

import type { AuditEvent } from "../../../../shared/audit/audit";
import type { Hop1Identity } from "../../../../shared/identity/hop1";
import {
  InMemoryOAuthStateStore,
  InMemoryOAuthTokenStore,
} from "../../../../shared/oauth/memory-store";
import { encryptSecret } from "../../../../shared/oauth/crypto";
import { startGithubOAuth } from "../../../../shared/oauth/github";
import type { OAuthFetch } from "../../../../shared/oauth/google";
import { createGitHubOAuthRouteHandler } from "./oauth-routes";

const identity: Hop1Identity = {
  profile: "portal",
  issuer: "https://issuer.example.com",
  subject: "user-1",
  email: "user@example.com",
  claims: {},
};

const config = {
  clientId: "github-client",
  clientSecret: "github-secret",
  redirectUri: "https://mcp.example.com/oauth/github/callback",
  tokenEncryptionKey: Buffer.alloc(32, 1).toString("base64"),
  authorizationUrl: "https://github.example.com/login/oauth/authorize",
  tokenUrl: "https://github.example.com/login/oauth/access_token",
  userUrl: "https://api.github.example.com/user",
  userEmailsUrl: "https://api.github.example.com/user/emails",
};

describe("GitHub OAuth routes", () => {
  test("starts OAuth from GET and redirects to GitHub", async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const handler = createGitHubOAuthRouteHandler({
      authenticate: () => Promise.resolve(identity),
      config,
      scopes: ["repo", "read:org"],
      stateStore,
      tokenStore: new InMemoryOAuthTokenStore(),
    });

    const response = await handler(
      new Request("https://mcp.example.com/oauth/github/start?redirect_after=/done", {
        headers: { authorization: "Bearer hop1" },
      }),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://github.example.com");
    expect(location.searchParams.get("client_id")).toBe("github-client");
    expect(location.searchParams.get("scope")).toBe("repo read:org");
    expect(location.searchParams.get("login")).toBe("user@example.com");
    expect(location.searchParams.get("state")).toBeTruthy();
  });

  test("starts OAuth from POST and returns an authorization URL", async () => {
    const handler = createGitHubOAuthRouteHandler({
      authenticate: () => Promise.resolve(identity),
      config,
      scopes: ["repo"],
      stateStore: new InMemoryOAuthStateStore(),
      tokenStore: new InMemoryOAuthTokenStore(),
      redirectAfterAllowedOrigins: ["https://client.example.com"],
    });

    const response = await handler(
      new Request("https://mcp.example.com/oauth/github/start", {
        method: "POST",
        headers: {
          authorization: "Bearer hop1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ redirectAfter: "https://client.example.com/done" }),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { authorizationUrl: string };
    expect(body.authorizationUrl).toContain("https://github.example.com/login/oauth/authorize");
    expect(body.authorizationUrl).toContain("scope=repo");
  });

  test("rejects an unallowlisted remote redirect target before it creates OAuth state", async () => {
    const stateStore = new CountingStateStore();
    const handler = createGitHubOAuthRouteHandler({
      authenticate: () => Promise.resolve(identity),
      config,
      scopes: ["repo"],
      stateStore,
      tokenStore: new InMemoryOAuthTokenStore(),
      redirectAfterAllowedOrigins: ["https://admin.example.com"],
    });

    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const response = await handler(
        new Request(
          "https://mcp.example.com/oauth/github/start?redirect_after=https%3A%2F%2Fevil.example.com%2Fcallback",
          { headers: { authorization: "Bearer hop1" } },
        ),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "OAuth redirect target is not allowed",
        code: "oauth_redirect_target_not_allowed",
      });
      expect(stateStore.saveCalls).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]?.[0]);
      expect(line).toContain("github_oauth_request_failed");
      expect(line).toContain("code=oauth_redirect_target_not_allowed");
      expect(line).toContain("status=400");
      expect(line).toContain("route=/oauth/github/start");
      expect(line).toMatch(/subject_hash=[0-9a-f]{64}/);
      expect(line).toContain('redirect_origin="https://evil.example.com"');
      expect(line).not.toContain("/callback");
      expect(line).not.toContain(identity.subject);
      expect(line).not.toContain(identity.email);
    } finally {
      warn.mockRestore();
    }
  });

  test("returns and logs stable codes for every compatibility-route 4xx branch", async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const tokenStore = new InMemoryOAuthTokenStore();
    const denied = await startGithubOAuth({
      identity,
      scopes: ["repo"],
      config,
      stateStore,
      tokenStore,
    });
    const handler = createGitHubOAuthRouteHandler({
      authenticate: (token) =>
        token === "hop1" ? Promise.resolve(identity) : Promise.reject(new Error("bad bearer")),
      config,
      scopes: ["repo"],
      stateStore,
      tokenStore,
    });
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const cases = [
        {
          request: new Request(
            "https://mcp.example.com/oauth/github/callback?state=present-but-no-code",
          ),
          status: 400,
          code: "oauth_callback_parameters_missing",
        },
        {
          request: new Request("https://mcp.example.com/oauth/github/callback"),
          status: 400,
          code: "oauth_callback_parameters_missing",
        },
        {
          request: new Request(
            `https://mcp.example.com/oauth/github/callback?state=${denied.state}&error=access_denied`,
          ),
          status: 400,
          code: "oauth_authorization_denied",
        },
        {
          request: new Request(
            "https://mcp.example.com/oauth/github/callback?state=unknown&code=code",
          ),
          status: 400,
          code: "oauth_state_invalid",
        },
        {
          request: new Request("https://mcp.example.com/oauth/github/status"),
          status: 401,
          code: "oauth_unauthorized",
        },
        {
          request: new Request("https://mcp.example.com/oauth/github/private-token-123", {
            headers: { authorization: "Bearer hop1" },
          }),
          status: 404,
          code: "oauth_route_not_found",
        },
      ] as const;

      for (const item of cases) {
        const response = await handler(item.request);
        expect(response.status).toBe(item.status);
        expect(await response.json()).toMatchObject({ code: item.code });
      }

      expect(warn).toHaveBeenCalledTimes(cases.length);
      for (const [index, item] of cases.entries()) {
        expect(String(warn.mock.calls[index]?.[0])).toContain(`code=${item.code}`);
      }
      const unknownRouteLine = String(warn.mock.calls.at(-1)?.[0]);
      expect(unknownRouteLine).toContain("route=/oauth/github/<unknown>");
      expect(unknownRouteLine).not.toContain("private-token-123");
    } finally {
      warn.mockRestore();
    }
  });

  test("returns and logs stable codes for connection-route failures", async () => {
    const handler = createGitHubOAuthRouteHandler({
      authenticate: () => Promise.resolve(identity),
      config,
      scopes: ["repo"],
      stateStore: new InMemoryOAuthStateStore(),
      tokenStore: new InMemoryOAuthTokenStore(),
      redirectAfterAllowedOrigins: ["https://admin.example.com"],
    });
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const response = await handler(
        new Request("https://mcp.example.com/connections/github/authorize", {
          method: "POST",
          headers: {
            authorization: "Bearer hop1",
            "content-type": "application/json",
          },
          body: JSON.stringify({ redirectAfter: "https://evil.example.com/private/path" }),
        }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "authorization_denied",
        code: "oauth_redirect_target_not_allowed",
      });
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]?.[0]);
      expect(line).toContain("route=/connections/github/authorize");
      expect(line).toContain("code=oauth_redirect_target_not_allowed");
      expect(line).toContain('redirect_origin="https://evil.example.com"');
      expect(line).not.toContain("/private/path");
    } finally {
      warn.mockRestore();
    }
  });

  test("classifies and logs malformed connection JSON without exposing its body", async () => {
    const privateBody = '{"redirectAfter":"https://private.example/path","secret":"value"';
    const handler = createGitHubOAuthRouteHandler({
      authenticate: () => Promise.resolve(identity),
      config,
      scopes: ["repo"],
      stateStore: new InMemoryOAuthStateStore(),
      tokenStore: new InMemoryOAuthTokenStore(),
    });
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const response = await handler(
        new Request("https://mcp.example.com/connections/github/authorize", {
          method: "POST",
          headers: {
            authorization: "Bearer hop1",
            "content-type": "application/json",
          },
          body: privateBody,
        }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "invalid_request",
        code: "oauth_invalid_request",
      });
      const line = String(warn.mock.calls[0]?.[0]);
      expect(line).toContain("code=oauth_invalid_request");
      expect(line).not.toContain("private.example");
      expect(line).not.toContain("secret");
    } finally {
      warn.mockRestore();
    }
  });

  test("classifies and logs a sanitized callback completion failure", async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const tokenStore = new InMemoryOAuthTokenStore();
    const started = await startGithubOAuth({
      identity,
      scopes: ["repo"],
      config,
      stateStore,
      tokenStore,
    });
    const handler = createGitHubOAuthRouteHandler({
      authenticate: () => Promise.reject(new Error("callback must use state")),
      config,
      scopes: ["repo"],
      stateStore,
      tokenStore,
      fetch: () => Promise.resolve(Response.json({ private: "provider detail" }, { status: 500 })),
    });
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const response = await handler(
        new Request(
          `https://mcp.example.com/oauth/github/callback?code=private-code&state=${started.state}`,
        ),
      );

      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: "GitHub OAuth callback could not be completed",
        code: "oauth_callback_failed",
      });
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]?.[0]);
      expect(line).toContain("code=oauth_callback_failed");
      expect(line).toMatch(/subject_hash=[0-9a-f]{64}/);
      expect(line).not.toContain("private-code");
      expect(line).not.toContain(started.state);
      expect(line).not.toContain("provider detail");
    } finally {
      warn.mockRestore();
    }
  });

  test("rejects a scheme-relative or backslash-normalized redirect target", async () => {
    const handler = createGitHubOAuthRouteHandler({
      authenticate: () => Promise.resolve(identity),
      config,
      scopes: ["repo"],
      stateStore: new InMemoryOAuthStateStore(),
      tokenStore: new InMemoryOAuthTokenStore(),
    });

    for (const redirectAfter of ["//evil.example.com/callback", "/\\evil.example.com/callback"]) {
      const response = await handler(
        new Request(
          `https://mcp.example.com/oauth/github/start?redirect_after=${encodeURIComponent(redirectAfter)}`,
          { headers: { authorization: "Bearer hop1" } },
        ),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "OAuth redirect target is not allowed",
        code: "oauth_redirect_target_not_allowed",
      });
    }
  });

  test("allows an exact configured remote redirect origin and preserves its path", async () => {
    const handler = createGitHubOAuthRouteHandler({
      authenticate: () => Promise.resolve(identity),
      config,
      scopes: ["repo"],
      stateStore: new InMemoryOAuthStateStore(),
      tokenStore: new InMemoryOAuthTokenStore(),
      redirectAfterAllowedOrigins: ["https://admin.example.com"],
    });

    const response = await handler(
      new Request(
        "https://mcp.example.com/oauth/github/start?redirect_after=https%3A%2F%2Fadmin.example.com%2Fconnections%3Fprovider%3Dgithub",
        { headers: { authorization: "Bearer hop1" } },
      ),
    );

    expect(response.status).toBe(302);
  });

  test("completes callback without bearer auth by recovering identity from state", async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const tokenStore = new InMemoryOAuthTokenStore();
    const audit = new MemoryAuditSink();
    const handler = createGitHubOAuthRouteHandler({
      authenticate: () => Promise.resolve(identity),
      config,
      scopes: ["repo", "read:org"],
      stateStore,
      tokenStore,
      audit,
      fetch: githubOAuthFetch(),
    });

    const start = await handler(
      new Request("https://mcp.example.com/oauth/github/start?redirect_after=/done", {
        headers: { authorization: "Bearer hop1" },
      }),
    );
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const callback = await handler(
      new Request(`https://mcp.example.com/oauth/github/callback?code=code&state=${state ?? ""}`),
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/done");
    expect(audit.events).toMatchObject([
      {
        category: "oauth",
        principal: "user@example.com",
        event: "github.connect",
        status: "allow",
      },
    ]);

    const account = await tokenStore.getAccount(identity.issuer, identity.subject, "github");
    expect(account).toMatchObject({
      provider: "github",
      email: "user@example.com",
      scopesGranted: ["repo", "read:org"],
    });
  });

  test("never authenticates a browser callback and consumes its state exactly once", async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const tokenStore = new InMemoryOAuthTokenStore();
    const started = await startGithubOAuth({
      identity,
      scopes: ["repo"],
      config,
      stateStore,
      tokenStore,
    });
    let authenticateCalls = 0;
    let providerCalls = 0;
    const handler = createGitHubOAuthRouteHandler({
      authenticate: () => {
        authenticateCalls += 1;
        return Promise.reject(new Error("browser callback must not authenticate a bearer"));
      },
      config,
      scopes: ["repo"],
      stateStore,
      tokenStore,
      fetch: (url) => {
        providerCalls += 1;
        return Promise.resolve(
          url.includes("/login/oauth/access_token")
            ? jsonResponse({ access_token: "gho_access", scope: "repo" })
            : url.endsWith("/user")
              ? jsonResponse({ id: 123456, login: "octocat" })
              : jsonResponse([{ email: identity.email, verified: true }]),
        );
      },
    });
    const callbackUrl = `https://mcp.example.com/oauth/github/callback?code=code&state=${started.state}`;

    const callback = await handler(new Request(callbackUrl));
    expect(callback.status).toBe(200);
    expect(authenticateCalls).toBe(0);
    expect(providerCalls).toBe(3);
    expect(await tokenStore.getAccount(identity.issuer, identity.subject, "github")).not.toBeNull();

    const replay = await handler(new Request(callbackUrl));
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({
      error: "OAuth state is invalid or expired",
      code: "oauth_state_invalid",
    });
    expect(authenticateCalls).toBe(0);
    expect(providerCalls).toBe(3);
  });

  test("rejects an unknown callback state without authenticating or contacting GitHub", async () => {
    let authenticateCalls = 0;
    let providerCalls = 0;
    const handler = createGitHubOAuthRouteHandler({
      authenticate: () => {
        authenticateCalls += 1;
        return Promise.resolve(identity);
      },
      config,
      scopes: ["repo"],
      stateStore: new InMemoryOAuthStateStore(),
      tokenStore: new InMemoryOAuthTokenStore(),
      fetch: () => {
        providerCalls += 1;
        return Promise.reject(new Error("GitHub must not be called"));
      },
    });

    const response = await handler(
      new Request("https://mcp.example.com/oauth/github/callback?code=code&state=unknown-state"),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "OAuth state is invalid or expired",
      code: "oauth_state_invalid",
    });
    expect(authenticateCalls).toBe(0);
    expect(providerCalls).toBe(0);
  });

  test("consumes a denied provider callback state and returns a sanitized response", async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const tokenStore = new InMemoryOAuthTokenStore();
    const started = await startGithubOAuth({
      identity,
      scopes: ["repo"],
      config,
      stateStore,
      tokenStore,
    });
    const handler = createGitHubOAuthRouteHandler({
      authenticate: () => Promise.reject(new Error("callback must not authenticate a bearer")),
      config,
      scopes: ["repo"],
      stateStore,
      tokenStore,
    });
    const callbackUrl =
      `https://mcp.example.com/oauth/github/callback?state=${started.state}` +
      "&error=access_denied&error_description=the+user%27s+private+reason";

    const denied = await handler(new Request(callbackUrl));
    expect(denied.status).toBe(400);
    expect(await denied.json()).toEqual({
      error: "GitHub authorization was not completed",
      code: "oauth_authorization_denied",
    });

    const replay = await handler(new Request(callbackUrl));
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({
      error: "OAuth state is invalid or expired",
      code: "oauth_state_invalid",
    });
  });

  test("rejects an OAuth callback for a different GitHub email without persisting it", async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const tokenStore = new InMemoryOAuthTokenStore();
    const audit = new MemoryAuditSink();
    const handler = createGitHubOAuthRouteHandler({
      authenticate: () => Promise.resolve(identity),
      config,
      scopes: ["repo"],
      stateStore,
      tokenStore,
      audit,
      fetch: (url) =>
        Promise.resolve(
          url.includes("/login/oauth/access_token")
            ? jsonResponse({ access_token: "gho_access", scope: "repo" })
            : url.endsWith("/user")
              ? jsonResponse({ id: 123456, login: "octocat" })
              : jsonResponse([{ email: "different@example.com", primary: true, verified: true }]),
        ),
    });

    const start = await handler(
      new Request("https://mcp.example.com/oauth/github/start", {
        headers: { authorization: "Bearer hop1" },
      }),
    );
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const callbackUrl = `https://mcp.example.com/oauth/github/callback?code=code&state=${state ?? ""}`;

    const callback = await handler(new Request(callbackUrl));

    expect(callback.status).toBe(400);
    expect(await callback.json()).toEqual({
      error: "GitHub account identity does not match authenticated user",
      code: "oauth_identity_mismatch",
    });
    expect(await tokenStore.getAccount(identity.issuer, identity.subject, "github")).toBeNull();
    expect(audit.events).toHaveLength(0);

    const replay = await handler(new Request(callbackUrl));
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({
      error: "OAuth state is invalid or expired",
      code: "oauth_state_invalid",
    });
  });

  test("renders a success page when callback has no stored redirect target", async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const handler = createGitHubOAuthRouteHandler({
      authenticate: () => Promise.resolve(identity),
      config,
      scopes: ["repo"],
      stateStore,
      tokenStore: new InMemoryOAuthTokenStore(),
      fetch: githubOAuthFetch(),
    });

    const start = await handler(
      new Request("https://mcp.example.com/oauth/github/start", {
        headers: { authorization: "Bearer hop1" },
      }),
    );
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const callback = await handler(
      new Request(`https://mcp.example.com/oauth/github/callback?code=code&state=${state ?? ""}`),
    );

    expect(callback.status).toBe(200);
    expect(callback.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await callback.text();
    expect(html).toContain("<h1>GitHub connected</h1>");
    expect(html).toContain("You can close this tab and return to your MCP client.");
  });

  test("reports connection status and disconnects GitHub account", async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const tokenStore = new InMemoryOAuthTokenStore();
    const handler = createGitHubOAuthRouteHandler({
      authenticate: () => Promise.resolve(identity),
      config,
      scopes: ["repo", "read:org"],
      stateStore,
      tokenStore,
      fetch: githubOAuthFetch(),
    });

    const disconnected = await handler(
      new Request("https://mcp.example.com/oauth/github/status", {
        headers: { authorization: "Bearer hop1" },
      }),
    );
    expect(await disconnected.json()).toEqual({ connected: false });

    const start = await handler(
      new Request("https://mcp.example.com/oauth/github/start", {
        headers: { authorization: "Bearer hop1" },
      }),
    );
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    await handler(
      new Request(`https://mcp.example.com/oauth/github/callback?code=code&state=${state ?? ""}`),
    );

    const connected = await handler(
      new Request("https://mcp.example.com/oauth/github/status", {
        headers: { authorization: "Bearer hop1" },
      }),
    );
    expect(await connected.json()).toEqual({
      connected: true,
      email: "user@example.com",
      scopesRequired: ["repo", "read:org"],
      scopesGranted: ["repo", "read:org"],
      missingScopes: [],
    });

    const canonical = await handler(
      new Request("https://mcp.example.com/connections/github/status", {
        headers: { authorization: "Bearer hop1" },
      }),
    );
    expect(await canonical.json()).toMatchObject({
      version: "1",
      provider: "github",
      connected: true,
      account: { displayName: "user@example.com" },
    });

    const canonicalV2 = await handler(
      new Request("https://mcp.example.com/connections/github/status", {
        headers: {
          authorization: "Bearer hop1",
          accept: "application/vnd.apelogic.connection-status.v2+json",
        },
      }),
    );
    expect(await canonicalV2.json()).toMatchObject({
      version: "2",
      provider: "github",
      connected: true,
      account: { provider: "github", id: "123456", login: "octocat" },
    });

    const compatibilityV2 = await handler(
      new Request("https://mcp.example.com/oauth/github/status", {
        headers: {
          authorization: "Bearer hop1",
          accept: "application/vnd.apelogic.connection-status.v2+json",
        },
      }),
    );
    expect(await compatibilityV2.json()).toMatchObject({
      version: "2",
      connected: true,
      account: { provider: "github", id: "123456", login: "octocat" },
    });

    const compatibilityRefresh = await handler(
      new Request("https://mcp.example.com/oauth/github/refresh", {
        method: "POST",
        headers: { authorization: "Bearer hop1" },
      }),
    );
    const compatibilityRefreshBody = (await compatibilityRefresh.json()) as {
      result?: unknown;
      status?: { version?: unknown; account?: unknown };
    };
    expect(compatibilityRefreshBody.result).toBe("refresh_not_supported");
    expect(compatibilityRefreshBody.status?.version).toBe("1");
    expect(compatibilityRefreshBody.status?.account).toEqual({
      displayName: "user@example.com",
    });

    const disconnect = await handler(
      new Request("https://mcp.example.com/oauth/github/disconnect", {
        method: "POST",
        headers: { authorization: "Bearer hop1" },
      }),
    );
    expect(disconnect.status).toBe(204);

    const afterDisconnect = await handler(
      new Request("https://mcp.example.com/oauth/github/status", {
        headers: { authorization: "Bearer hop1" },
      }),
    );
    expect(await afterDisconnect.json()).toEqual({ connected: false });
  });

  test("disables locally and reports sanitized pending cleanup when GitHub rejects disconnect", async () => {
    const tokenStore = new InMemoryOAuthTokenStore();
    const accessToken = "gho_disconnect_access_token";
    const audit = new MemoryAuditSink();
    await tokenStore.saveAccount({
      provider: "github",
      hop1Issuer: identity.issuer,
      hop1Subject: identity.subject,
      email: identity.email,
      scopesGranted: ["repo"],
      encryptedRefreshToken: encryptSecret(accessToken, config.tokenEncryptionKey),
      createdAt: new Date("2026-08-22T00:00:00.000Z"),
      updatedAt: new Date("2026-08-22T00:00:00.000Z"),
    });
    const handler = createGitHubOAuthRouteHandler({
      authenticate: () => Promise.resolve(identity),
      config,
      scopes: ["repo"],
      stateStore: new InMemoryOAuthStateStore(),
      tokenStore,
      audit,
      fetch: () => Promise.resolve(Response.json({ error: accessToken }, { status: 500 })),
    });

    const response = await handler(
      new Request("https://mcp.example.com/oauth/github/disconnect", {
        method: "POST",
        headers: { authorization: "Bearer hop1" },
      }),
    );

    expect(response.status).toBe(204);
    const responseBody = await response.text();
    expect(responseBody).toBe("");
    expect(
      (await tokenStore.getAccount(identity.issuer, identity.subject, "github"))?.revokedAt,
    ).toBeInstanceOf(Date);
    expect(
      await tokenStore.getConnection("github", identity.issuer, identity.subject),
    ).toMatchObject({ phase: "disconnected_with_provider_cleanup_pending" });
    expect(audit.events).toHaveLength(2);
    expect(audit.events[0]).toMatchObject({
      category: "oauth",
      principal: identity.email,
      event: "github.disconnect_cleanup",
      status: "error",
      error: "transient_provider_failure",
    });
    expect(JSON.stringify({ response: responseBody, audit: audit.events })).not.toContain(
      accessToken,
    );
  });

  test("reports a sanitized disconnect failure when local revocation persistence fails after GitHub accepts it", async () => {
    const tokenStore = new InMemoryOAuthTokenStore();
    const accessToken = "gho_disconnect_access_token";
    const audit = new MemoryAuditSink();
    await tokenStore.saveAccount({
      provider: "github",
      hop1Issuer: identity.issuer,
      hop1Subject: identity.subject,
      email: identity.email,
      scopesGranted: ["repo"],
      encryptedRefreshToken: encryptSecret(accessToken, config.tokenEncryptionKey),
      createdAt: new Date("2026-08-22T00:00:00.000Z"),
      updatedAt: new Date("2026-08-22T00:00:00.000Z"),
    });
    const saveConnection = tokenStore.saveConnection.bind(tokenStore);
    let persistenceCalls = 0;
    tokenStore.saveConnection = (record, expectedGeneration) => {
      persistenceCalls += 1;
      return persistenceCalls === 2
        ? Promise.reject(new Error(`database failed for ${accessToken}`))
        : saveConnection(record, expectedGeneration);
    };
    let providerRevocationCalls = 0;
    const handler = createGitHubOAuthRouteHandler({
      authenticate: () => Promise.resolve(identity),
      config,
      scopes: ["repo"],
      stateStore: new InMemoryOAuthStateStore(),
      tokenStore,
      audit,
      fetch: () => {
        providerRevocationCalls += 1;
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });

    const response = await handler(
      new Request("https://mcp.example.com/oauth/github/disconnect", {
        method: "POST",
        headers: { authorization: "Bearer hop1" },
      }),
    );

    expect(response.status).toBe(503);
    expect(providerRevocationCalls).toBe(1);
    const responseBody = await response.json();
    expect(responseBody).toEqual({
      error: "persistence_failure",
      code: "oauth_persistence_failure",
    });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      category: "oauth",
      principal: identity.email,
      event: "github.disconnect",
      status: "error",
    });
    expect(JSON.stringify({ response: responseBody, audit: audit.events })).not.toContain(
      accessToken,
    );
  });

  test("requires authenticated HOP-1 identity for non-callback routes", async () => {
    const handler = createGitHubOAuthRouteHandler({
      authenticate: () => Promise.reject(new Error("bad token")),
      config,
      scopes: ["repo"],
      stateStore: new InMemoryOAuthStateStore(),
      tokenStore: new InMemoryOAuthTokenStore(),
    });

    const response = await handler(new Request("https://mcp.example.com/oauth/github/status"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Unauthorized",
      code: "oauth_unauthorized",
    });
  });

  test("maps datastore failures on compatibility connection routes", async () => {
    const tokenStore = new InMemoryOAuthTokenStore();
    tokenStore.getConnection = () => Promise.reject(new Error("postgres unavailable"));
    const handler = createGitHubOAuthRouteHandler({
      authenticate: () => Promise.resolve(identity),
      config,
      scopes: ["repo"],
      stateStore: new InMemoryOAuthStateStore(),
      tokenStore,
    });

    for (const [path, method] of [
      ["/oauth/github/start", "GET"],
      ["/oauth/github/status", "GET"],
      ["/oauth/github/refresh", "POST"],
      ["/oauth/github/disconnect", "POST"],
    ] as const) {
      const response = await handler(
        new Request(`https://mcp.example.com${path}`, {
          method,
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

function githubOAuthFetch(): OAuthFetch {
  return (url) => {
    if (url.includes("/login/oauth/access_token")) {
      return Promise.resolve(
        jsonResponse({
          access_token: "gho_access",
          scope: "repo,read:org",
        }),
      );
    }

    if (url.endsWith("/user")) {
      return Promise.resolve(jsonResponse({ id: 123456, login: "octocat" }));
    }

    if (url.includes("/user/emails")) {
      return Promise.resolve(
        jsonResponse([{ email: "user@example.com", primary: true, verified: true }]),
      );
    }

    if (url.includes("/applications/")) {
      return Promise.resolve(new Response(null, { status: 204 }));
    }

    return Promise.resolve(jsonResponse({ error: "not found" }, 404));
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

class MemoryAuditSink {
  readonly events: AuditEvent[] = [];

  emit(event: AuditEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

class CountingStateStore extends InMemoryOAuthStateStore {
  saveCalls = 0;

  override save(record: Parameters<InMemoryOAuthStateStore["save"]>[0]): Promise<void> {
    this.saveCalls += 1;
    return super.save(record);
  }
}
