import { describe, expect, test } from "bun:test";

import type { Hop1Identity } from "../../../../shared/identity/hop1";
import { InMemoryAuditSink } from "../../../../shared/audit/audit";
import {
  InMemoryOAuthStateStore,
  InMemoryOAuthTokenStore,
} from "../../../../shared/oauth/memory-store";
import { createOAuthRouteHandler } from "./oauth-routes";

const identity: Hop1Identity = {
  profile: "google",
  issuer: "https://accounts.google.com",
  subject: "google-subject",
  email: "user@example.com",
  claims: {},
};

const config = {
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "https://dev.example.com/oauth/google/callback",
  tokenEncryptionKey: Buffer.alloc(32, 3).toString("base64"),
};

const scopes = ["openid", "https://www.googleapis.com/auth/userinfo.email"];

describe("OAuth route handler", () => {
  test("redirects authenticated users to Google consent", async () => {
    const handler = createOAuthRouteHandler({
      authenticate: () => Promise.resolve(identity),
      config,
      scopes,
      stateStore: new InMemoryOAuthStateStore(),
      tokenStore: new InMemoryOAuthTokenStore(),
    });

    const response = await handler(
      new Request("https://dev.example.com/oauth/google/start?redirect_after=/done", {
        headers: { authorization: "Bearer hop1" },
      }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toStartWith(
      "https://accounts.google.com/o/oauth2/v2/auth?",
    );
  });

  test("starts Google consent for headless clients with a JSON response", async () => {
    const handler = createOAuthRouteHandler({
      authenticate: () => Promise.resolve(identity),
      config,
      scopes,
      stateStore: new InMemoryOAuthStateStore(),
      tokenStore: new InMemoryOAuthTokenStore(),
    });

    const response = await handler(
      new Request("https://dev.example.com/oauth/google/start", {
        method: "POST",
        headers: {
          authorization: "Bearer hop1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ redirectAfter: "https://partner.example.com/oauth/google/done" }),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.authorizationUrl).toBeString();
    const authorizationUrl = new URL(String(body.authorizationUrl));
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(authorizationUrl.searchParams.get("state")).toBeString();
    expect(authorizationUrl.searchParams.get("login_hint")).toBe(identity.email);
  });

  test("rejects start requests without bearer auth", async () => {
    const handler = createOAuthRouteHandler({
      authenticate: () => Promise.resolve(identity),
      config,
      scopes,
      stateStore: new InMemoryOAuthStateStore(),
      tokenStore: new InMemoryOAuthTokenStore(),
    });

    const response = await handler(new Request("https://dev.example.com/oauth/google/start"));

    expect(response.status).toBe(401);
  });

  test("completes callback and redirects to stored redirect target", async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const tokenStore = new InMemoryOAuthTokenStore();
    const audit = new InMemoryAuditSink();
    const handler = createOAuthRouteHandler({
      authenticate: () => Promise.resolve(identity),
      config,
      scopes,
      stateStore,
      tokenStore,
      audit,
      fetch: successFetch,
    });

    const start = await handler(
      new Request("https://dev.example.com/oauth/google/start?redirect_after=/done", {
        headers: { authorization: "Bearer hop1" },
      }),
    );
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const callback = await handler(
      new Request(`https://dev.example.com/oauth/google/callback?code=code&state=${state ?? ""}`, {
        headers: { authorization: "Bearer hop1" },
      }),
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/done");
    expect(await tokenStore.getAccount(identity.issuer, identity.subject)).toMatchObject({
      email: "user@example.com",
    });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]?.category).toBe("oauth");
    expect(audit.events[0]?.principal).toBe("user@example.com");
    expect(audit.events[0]?.event).toBe("connect");
    expect(audit.events[0]?.status).toBe("allow");
  });

  test("completes callback without bearer auth by recovering identity from state", async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const tokenStore = new InMemoryOAuthTokenStore();
    const audit = new InMemoryAuditSink();
    const handler = createOAuthRouteHandler({
      authenticate: () => Promise.resolve(identity),
      config,
      scopes,
      stateStore,
      tokenStore,
      audit,
      fetch: successFetch,
    });

    const start = await handler(
      new Request("https://dev.example.com/oauth/google/start?redirect_after=/done", {
        headers: { authorization: "Bearer hop1" },
      }),
    );
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const callback = await handler(
      new Request(`https://dev.example.com/oauth/google/callback?code=code&state=${state ?? ""}`),
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/done");
    expect(await tokenStore.getAccount(identity.issuer, identity.subject)).toMatchObject({
      email: "user@example.com",
    });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]?.principal).toBe("user@example.com");
  });

  test("renders a success page when callback has no stored redirect target", async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const handler = createOAuthRouteHandler({
      authenticate: () => Promise.resolve(identity),
      config,
      scopes,
      stateStore,
      tokenStore: new InMemoryOAuthTokenStore(),
      fetch: successFetch,
    });

    const start = await handler(
      new Request("https://dev.example.com/oauth/google/start", {
        headers: { authorization: "Bearer hop1" },
      }),
    );
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const callback = await handler(
      new Request(`https://dev.example.com/oauth/google/callback?code=code&state=${state ?? ""}`),
    );

    expect(callback.status).toBe(200);
    expect(callback.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await callback.text();
    expect(html).toContain("<h1>Google Workspace connected</h1>");
    expect(html).toContain("You can close this tab and return to your MCP client.");
  });

  test("reports connection status and disconnects", async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const tokenStore = new InMemoryOAuthTokenStore();
    const handler = createOAuthRouteHandler({
      authenticate: () => Promise.resolve(identity),
      config,
      scopes,
      stateStore,
      tokenStore,
      fetch: successFetch,
    });

    const statusBefore = await handler(
      new Request("https://dev.example.com/oauth/google/status", {
        headers: { authorization: "Bearer hop1" },
      }),
    );
    expect(await statusBefore.json()).toEqual({ connected: false });

    const start = await handler(
      new Request("https://dev.example.com/oauth/google/start", {
        headers: { authorization: "Bearer hop1" },
      }),
    );
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    await handler(
      new Request(`https://dev.example.com/oauth/google/callback?code=code&state=${state ?? ""}`, {
        headers: { authorization: "Bearer hop1" },
      }),
    );

    const statusAfter = await handler(
      new Request("https://dev.example.com/oauth/google/status", {
        headers: { authorization: "Bearer hop1" },
      }),
    );
    expect(await statusAfter.json()).toEqual({
      connected: true,
      email: "user@example.com",
      scopesRequired: scopes,
      scopesGranted: scopes,
      missingScopes: [],
    });

    const disconnect = await handler(
      new Request("https://dev.example.com/oauth/google/disconnect", {
        method: "POST",
        headers: { authorization: "Bearer hop1" },
      }),
    );
    expect(disconnect.status).toBe(204);
  });

  test("reports missing consent scopes before treating Google as connected", async () => {
    const tokenStore = new InMemoryOAuthTokenStore();
    await tokenStore.saveAccount({
      provider: "google",
      hop1Issuer: identity.issuer,
      hop1Subject: identity.subject,
      email: identity.email,
      scopesGranted: ["openid"],
      encryptedRefreshToken: "encrypted",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const handler = createOAuthRouteHandler({
      authenticate: () => Promise.resolve(identity),
      config,
      scopes,
      stateStore: new InMemoryOAuthStateStore(),
      tokenStore,
    });

    const response = await handler(
      new Request("https://dev.example.com/oauth/google/status", {
        headers: { authorization: "Bearer hop1" },
      }),
    );

    expect(await response.json()).toEqual({
      connected: false,
      email: "user@example.com",
      scopesRequired: scopes,
      scopesGranted: ["openid"],
      missingScopes: ["https://www.googleapis.com/auth/userinfo.email"],
    });
  });
});

function successFetch(url: string): Promise<Response> {
  if (url.includes("oauth2.googleapis.com/token")) {
    return Promise.resolve(
      jsonResponse({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
        scope: scopes.join(" "),
      }),
    );
  }

  return Promise.resolve(jsonResponse({ email: "user@example.com" }));
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}
