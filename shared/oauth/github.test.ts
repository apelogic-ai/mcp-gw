import { describe, expect, test } from "bun:test";

import type { Hop1Identity } from "../identity/hop1";
import { InMemoryOAuthStateStore, InMemoryOAuthTokenStore } from "./memory-store";
import {
  GitHubOAuthError,
  GitHubTokenBroker,
  completeGithubOAuth,
  revokeGithubOAuth,
  startGithubOAuth,
} from "./github";
import { encryptSecret } from "./crypto";

const identity: Hop1Identity = {
  profile: "test",
  issuer: "https://issuer.example.com",
  subject: "subject-1",
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
  tokenRevocationUrl: "https://api.github.example.com/applications/github-client/token",
};

describe("GitHub OAuth flow", () => {
  test("builds a consent URL and stores HOP-1 OAuth state", async () => {
    const stateStore = new InMemoryOAuthStateStore();

    const started = await startGithubOAuth({
      identity,
      scopes: ["repo", "read:org"],
      config,
      stateStore,
      redirectAfter: "/done",
    });

    const url = new URL(started.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://github.example.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("github-client");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("scope")).toBe("repo read:org");
    expect(url.searchParams.get("state")).toBe(started.state);

    const consumed = await stateStore.consume(started.state);
    expect(consumed?.hop1Issuer).toBe(identity.issuer);
    expect(consumed?.hop1Subject).toBe(identity.subject);
    expect(consumed?.email).toBe(identity.email);
    expect(consumed?.requestedScopes).toEqual(["repo", "read:org"]);
    expect(consumed?.redirectAfter).toBe("/done");
  });

  test("does not snapshot a previous synthetic authorization marker", async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const tokenStore = new InMemoryOAuthTokenStore();
    await startGithubOAuth({ identity, scopes: ["repo"], config, stateStore, tokenStore });
    const second = await startGithubOAuth({
      identity,
      scopes: ["repo"],
      config,
      stateStore,
      tokenStore,
    });

    await completeGithubOAuth({
      identity,
      code: "second-code",
      state: second.state,
      config,
      stateStore,
      tokenStore,
      fetch: (url) =>
        Promise.resolve(
          url === config.tokenUrl
            ? Response.json({ access_token: "active", scope: "repo" })
            : Response.json([{ email: identity.email, primary: true, verified: true }]),
        ),
    });
    expect(
      await tokenStore.getConnection("github", identity.issuer, identity.subject),
    ).toMatchObject({ generation: 1, phase: "connected" });
  });

  test("exchanges code, verifies GitHub email, and stores encrypted bearer token", async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const tokenStore = new InMemoryOAuthTokenStore();
    const started = await startGithubOAuth({
      identity,
      scopes: ["repo"],
      config,
      stateStore,
    });
    const seenRequests: { url: string; init?: RequestInit }[] = [];

    await completeGithubOAuth({
      identity,
      code: "oauth-code",
      state: started.state,
      config,
      stateStore,
      tokenStore,
      fetch: (url, init) => {
        seenRequests.push({ url, init });
        if (url === config.tokenUrl) {
          return Promise.resolve(
            Response.json({
              access_token: "github-user-token",
              scope: "repo,read:org",
            }),
          );
        }

        return Promise.resolve(
          Response.json([
            {
              email: "user@example.com",
              primary: true,
              verified: true,
            },
          ]),
        );
      },
    });

    expect(seenRequests[0]?.url).toBe(config.tokenUrl);
    expect(seenRequests[0]?.init?.headers).toEqual({
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(seenRequests[1]?.init?.headers).toEqual({
      accept: "application/vnd.github+json",
      authorization: "Bearer github-user-token",
    });

    const stored = await tokenStore.getAccount(identity.issuer, identity.subject, "github");
    expect(stored?.provider).toBe("github");
    expect(stored?.email).toBe(identity.email);
    expect(stored?.scopesGranted).toEqual(["repo", "read:org"]);
    expect(stored?.encryptedRefreshToken).not.toBe("github-user-token");
  });

  test("accepts a matching verified secondary email when the primary differs", async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const tokenStore = new InMemoryOAuthTokenStore();
    const started = await startGithubOAuth({
      identity,
      scopes: ["repo", "user:email"],
      config,
      stateStore,
    });

    await completeGithubOAuth({
      identity,
      code: "oauth-code",
      state: started.state,
      config,
      stateStore,
      tokenStore,
      fetch: (url) =>
        Promise.resolve(
          url === config.tokenUrl
            ? Response.json({ access_token: "github-user-token", scope: "repo,user:email" })
            : Response.json([
                { email: "primary@example.net", primary: true, verified: true },
                { email: "USER@example.com", primary: false, verified: true },
              ]),
        ),
    });

    const stored = await tokenStore.getAccount(identity.issuer, identity.subject, "github");
    expect(stored?.email).toBe(identity.email);
    expect(stored?.scopesGranted).toEqual(["repo", "user:email"]);
  });

  test("rejects a matching secondary email when it is unverified", async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const tokenStore = new InMemoryOAuthTokenStore();
    const started = await startGithubOAuth({
      identity,
      scopes: ["repo", "user:email"],
      config,
      stateStore,
    });
    const seenRequests: string[] = [];

    let error: unknown;
    try {
      await completeGithubOAuth({
        identity,
        code: "oauth-code",
        state: started.state,
        config,
        stateStore,
        tokenStore,
        fetch: (url) => {
          seenRequests.push(url);
          return Promise.resolve(
            url === config.tokenUrl
              ? Response.json({ access_token: "github-user-token", scope: "repo,user:email" })
              : Response.json([{ email: "user@example.com", primary: false, verified: false }]),
          );
        },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(GitHubOAuthError);
    expect((error as GitHubOAuthError).code).toBe("email_mismatch");
    expect(await tokenStore.getAccount(identity.issuer, identity.subject, "github")).toBeNull();
    expect(seenRequests).toContain(config.tokenRevocationUrl);
  });

  test("rejects a GitHub primary verified email that differs from HOP-1 and persists nothing", async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const tokenStore = new InMemoryOAuthTokenStore();
    const started = await startGithubOAuth({
      identity,
      scopes: ["repo"],
      config,
      stateStore,
    });
    const seenRequests: { url: string; init?: RequestInit }[] = [];

    let error: unknown;
    try {
      await completeGithubOAuth({
        identity,
        code: "oauth-code",
        state: started.state,
        config,
        stateStore,
        tokenStore,
        fetch: (url, init) => {
          seenRequests.push({ url, init });
          if (url === config.tokenUrl) {
            return Promise.resolve(
              Response.json({ access_token: "github-user-token", scope: "repo" }),
            );
          }
          if (url === config.tokenRevocationUrl) {
            return Promise.reject(new Error("revocation unavailable"));
          }

          return Promise.resolve(
            Response.json([{ email: "other@example.com", primary: true, verified: true }]),
          );
        },
      });
    } catch (caught) {
      error = caught;
    }

    const stored = await tokenStore.getAccount(identity.issuer, identity.subject, "github");
    expect(error).toBeInstanceOf(GitHubOAuthError);
    expect((error as GitHubOAuthError).code).toBe("email_mismatch");
    expect(stored).toBeNull();
    const revocationRequest = seenRequests[2];
    expect(revocationRequest?.url).toBe(config.tokenRevocationUrl);
    expect(revocationRequest?.init?.method).toBe("DELETE");
    expect(revocationRequest?.init?.headers).toEqual({
      accept: "application/vnd.github+json",
      authorization: `Basic ${Buffer.from("github-client:github-secret").toString("base64")}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    });
    expect(revocationRequest?.init?.body).toBe(
      JSON.stringify({ access_token: "github-user-token" }),
    );
    expect(revocationRequest?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("matches GitHub primary verified email to HOP-1 case-insensitively", async () => {
    const corporateIdentity = { ...identity, email: "User@Example.COM" };
    const stateStore = new InMemoryOAuthStateStore();
    const tokenStore = new InMemoryOAuthTokenStore();
    const started = await startGithubOAuth({
      identity: corporateIdentity,
      scopes: ["repo"],
      config,
      stateStore,
    });

    await completeGithubOAuth({
      identity: corporateIdentity,
      code: "oauth-code",
      state: started.state,
      config,
      stateStore,
      tokenStore,
      fetch: (url) =>
        Promise.resolve(
          url === config.tokenUrl
            ? Response.json({ access_token: "github-user-token", scope: "repo" })
            : Response.json([{ email: "user@example.com", primary: true, verified: true }]),
        ),
    });

    const stored = await tokenStore.getAccount(
      corporateIdentity.issuer,
      corporateIdentity.subject,
      "github",
    );
    expect(stored?.email).toBe(corporateIdentity.email);
  });

  test("rejects callback identities that differ from state issuer, subject, or email", async () => {
    const mismatches: Hop1Identity[] = [
      { ...identity, issuer: "https://other-issuer.example.com" },
      { ...identity, subject: "other-subject" },
      { ...identity, email: "other@example.com" },
    ];

    for (const mismatch of mismatches) {
      const stateStore = new InMemoryOAuthStateStore();
      const tokenStore = new InMemoryOAuthTokenStore();
      const started = await startGithubOAuth({
        identity,
        scopes: ["repo", "user:email"],
        config,
        stateStore,
      });
      let providerCalled = false;
      let error: unknown;

      try {
        await completeGithubOAuth({
          identity: mismatch,
          code: "oauth-code",
          state: started.state,
          config,
          stateStore,
          tokenStore,
          fetch: () => {
            providerCalled = true;
            return Promise.reject(new Error("provider must not be called"));
          },
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(GitHubOAuthError);
      expect((error as GitHubOAuthError).code).toBe("email_mismatch");
      expect(providerCalled).toBeFalse();
      expect(await tokenStore.getAccount(identity.issuer, identity.subject, "github")).toBeNull();
    }
  });

  test("consumes OAuth state once even when the callback is replayed", async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const tokenStore = new InMemoryOAuthTokenStore();
    const started = await startGithubOAuth({
      identity,
      scopes: ["repo"],
      config,
      stateStore,
    });
    const complete = () =>
      completeGithubOAuth({
        identity,
        code: "oauth-code",
        state: started.state,
        config,
        stateStore,
        tokenStore,
        fetch: (url) =>
          Promise.resolve(
            url === config.tokenUrl
              ? Response.json({ access_token: "github-user-token", scope: "repo" })
              : Response.json([{ email: "user@example.com", primary: true, verified: true }]),
          ),
      });

    await complete();
    let replayError: unknown;
    try {
      await complete();
    } catch (caught) {
      replayError = caught;
    }

    expect(replayError).toBeInstanceOf(GitHubOAuthError);
    expect((replayError as GitHubOAuthError).code).toBe("invalid_state");
  });
});

describe("GitHub token broker", () => {
  test("resolves a stored GitHub bearer token for the authenticated principal", async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const tokenStore = new InMemoryOAuthTokenStore();
    const started = await startGithubOAuth({
      identity,
      scopes: ["repo"],
      config,
      stateStore,
    });
    await completeGithubOAuth({
      identity,
      code: "oauth-code",
      state: started.state,
      config,
      stateStore,
      tokenStore,
      fetch: (url) =>
        Promise.resolve(
          url === config.tokenUrl
            ? Response.json({ access_token: "github-user-token", scope: "repo" })
            : Response.json([{ email: "user@example.com", primary: true, verified: true }]),
        ),
    });

    const broker = new GitHubTokenBroker({ config, tokenStore });

    expect(await broker.getAccessToken(identity, ["repo"])).toBe("github-user-token");
  });

  test("single-flights expiring token renewal and replaces GitHub's rotating credential", async () => {
    const tokenStore = new InMemoryOAuthTokenStore();
    const stateStore = new InMemoryOAuthStateStore();
    const started = await startGithubOAuth({ identity, scopes: ["repo"], config, stateStore });
    await completeGithubOAuth({
      identity,
      code: "auth-code",
      state: started.state,
      config,
      stateStore,
      tokenStore,
      fetch: (url) =>
        Promise.resolve(
          url === config.tokenUrl
            ? Response.json({
                access_token: "expiring-active",
                refresh_token: "rotating-renewal-1",
                expires_in: 3600,
                refresh_token_expires_in: 7200,
                scope: "repo",
              })
            : Response.json([{ email: identity.email, verified: true }]),
        ),
    });
    const current = await tokenStore.getConnection("github", identity.issuer, identity.subject);
    if (!current) throw new Error("expected GitHub connection");
    await tokenStore.saveConnection(
      { ...current, activeCredentialExpiresAt: new Date(Date.now() - 1) },
      current.generation,
    );
    let renewals = 0;
    let refreshBody = "";
    const broker = new GitHubTokenBroker({
      config,
      tokenStore,
      fetch: (_url, init) => {
        renewals += 1;
        refreshBody =
          init?.body instanceof URLSearchParams
            ? init.body.toString()
            : typeof init?.body === "string"
              ? init.body
              : "";
        return Promise.resolve(
          Response.json({
            access_token: "rotated-active",
            refresh_token: "rotating-renewal-2",
            expires_in: 3600,
            refresh_token_expires_in: 7200,
            scope: "repo",
          }),
        );
      },
    });

    expect(
      await Promise.all([
        broker.getAccessToken(identity, ["repo"]),
        broker.getAccessToken(identity, ["repo"]),
      ]),
    ).toEqual(["rotated-active", "rotated-active"]);
    expect(renewals).toBe(1);
    expect(refreshBody).toContain("refresh_token=rotating-renewal-1");
    expect(
      (await tokenStore.getConnection("github", identity.issuer, identity.subject))?.generation,
    ).toBe(2);
  });

  test("requires reauth when the stored token is missing requested scopes", async () => {
    const tokenStore = new InMemoryOAuthTokenStore();
    const broker = new GitHubTokenBroker({ config, tokenStore });

    let error: unknown;
    try {
      await broker.getAccessToken(identity, ["repo"]);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(GitHubOAuthError);
    expect((error as GitHubOAuthError).code).toBe("reauth_required");
    expect((error as GitHubOAuthError).message).toBe("GitHub account must be connected");
  });

  test("preserves a transient provider renewal classification", async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const tokenStore = new InMemoryOAuthTokenStore();
    const started = await startGithubOAuth({
      identity,
      scopes: ["repo"],
      config,
      stateStore,
    });
    await completeGithubOAuth({
      identity,
      code: "auth-code",
      state: started.state,
      config,
      stateStore,
      tokenStore,
      fetch: (url) =>
        Promise.resolve(
          url === config.tokenUrl
            ? Response.json({
                access_token: "active",
                refresh_token: "renewal",
                expires_in: 3600,
                refresh_token_expires_in: 7200,
                scope: "repo",
              })
            : Response.json([{ email: identity.email, verified: true }]),
        ),
    });
    const expired = await tokenStore.getConnection("github", identity.issuer, identity.subject);
    if (!expired) throw new Error("expected GitHub connection");
    await tokenStore.saveConnection(
      { ...expired, activeCredentialExpiresAt: new Date(Date.now() - 1) },
      expired.generation,
    );

    const broker = new GitHubTokenBroker({
      config,
      tokenStore,
      fetch: () => Promise.resolve(new Response(null, { status: 503 })),
    });
    expect(broker.getAccessToken(identity, ["repo"])).rejects.toMatchObject({
      category: "transient_provider_failure",
    });
    expect(
      await tokenStore.getConnection("github", identity.issuer, identity.subject),
    ).toMatchObject({
      phase: "unavailable",
      lifecycleErrorCategory: "transient_provider_failure",
    });
  });

  test("classifies an untyped token-store failure as persistence failure", () => {
    const tokenStore = new InMemoryOAuthTokenStore();
    tokenStore.getConnection = () => Promise.reject(new Error("database unavailable"));
    const broker = new GitHubTokenBroker({ config, tokenStore });

    expect(broker.getAccessToken(identity, ["repo"])).rejects.toMatchObject({
      category: "persistence_failure",
    });
  });
});

describe("GitHub OAuth disconnect", () => {
  test("disables locally before issuing a bounded provider revocation request", async () => {
    const tokenStore = new InMemoryOAuthTokenStore();
    const accessToken = "gho_disconnect_access_token";
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
    const requests: { url: string; init?: RequestInit }[] = [];

    await revokeGithubOAuth({
      identity,
      config,
      tokenStore,
      fetch: (url, init) => {
        requests.push({ url, init });
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(config.tokenRevocationUrl);
    expect(requests[0]?.init?.method).toBe("DELETE");
    expect(requests[0]?.init?.headers).toEqual({
      accept: "application/vnd.github+json",
      authorization: `Basic ${Buffer.from("github-client:github-secret").toString("base64")}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    });
    expect(requests[0]?.init?.body).toBe(JSON.stringify({ access_token: accessToken }));
    expect(requests[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(
      (await tokenStore.getAccount(identity.issuer, identity.subject, "github"))?.revokedAt,
    ).toBeInstanceOf(Date);
  });

  test("disables locally and quarantines the credential when GitHub cleanup is retryable", async () => {
    const tokenStore = new InMemoryOAuthTokenStore();
    const accessToken = "gho_disconnect_access_token";
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

    await revokeGithubOAuth({
      identity,
      config,
      tokenStore,
      fetch: () => Promise.resolve(Response.json({ error: accessToken }, { status: 500 })),
    });

    expect(
      (await tokenStore.getAccount(identity.issuer, identity.subject, "github"))?.revokedAt,
    ).toBeInstanceOf(Date);
    const connection = await tokenStore.getConnection("github", identity.issuer, identity.subject);
    expect(connection).toMatchObject({
      phase: "disconnected_with_provider_cleanup_pending",
      revocationState: "pending",
    });
    expect(JSON.stringify(connection)).not.toContain(accessToken);
  });

  test("keeps a permanent provider cleanup failure locally disabled", async () => {
    const tokenStore = new InMemoryOAuthTokenStore();
    await tokenStore.saveAccount({
      provider: "github",
      hop1Issuer: identity.issuer,
      hop1Subject: identity.subject,
      email: identity.email,
      scopesGranted: ["repo"],
      encryptedRefreshToken: encryptSecret(
        "gho_disconnect_access_token",
        config.tokenEncryptionKey,
      ),
      createdAt: new Date("2026-08-22T00:00:00.000Z"),
      updatedAt: new Date("2026-08-22T00:00:00.000Z"),
    });

    await revokeGithubOAuth({
      identity,
      config,
      tokenStore,
      fetch: () => Promise.resolve(Response.json({ status: "unexpected" })),
    });

    expect(
      (await tokenStore.getAccount(identity.issuer, identity.subject, "github"))?.revokedAt,
    ).toBeInstanceOf(Date);
    expect(
      await tokenStore.getConnection("github", identity.issuer, identity.subject),
    ).toMatchObject({ phase: "unavailable", revocationState: "permanent_failure" });
  });
});
