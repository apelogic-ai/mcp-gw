import { describe, expect, test } from "bun:test";

import type { AuditEvent } from "../../../../shared/audit/audit";
import type { Hop1Identity } from "../../../../shared/identity/hop1";
import {
  InMemoryOAuthStateStore,
  InMemoryOAuthTokenStore,
} from "../../../../shared/oauth/memory-store";
import type { OAuthFetch } from "../../../../shared/oauth/google";
import { createGitHubOAuthRouteHandler } from "./oauth-routes";

const identity: Hop1Identity = {
  profile: "burble",
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
    expect(await response.json()).toEqual({ error: "Unauthorized" });
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

    if (url.includes("/user/emails")) {
      return Promise.resolve(
        jsonResponse([{ email: "user@example.com", primary: true, verified: true }]),
      );
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
