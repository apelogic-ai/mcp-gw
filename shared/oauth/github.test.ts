import { describe, expect, test } from "bun:test";

import type { Hop1Identity } from "../identity/hop1";
import { InMemoryOAuthStateStore, InMemoryOAuthTokenStore } from "./memory-store";
import {
  GitHubOAuthError,
  GitHubTokenBroker,
  completeGithubOAuth,
  startGithubOAuth,
} from "./github";

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
});
