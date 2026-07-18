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

  test("stores GitHub accounts whose primary email differs from HOP-1 email", async () => {
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
      fetch: (url) => {
        if (url === config.tokenUrl) {
          return Promise.resolve(
            Response.json({ access_token: "github-user-token", scope: "repo" }),
          );
        }

        return Promise.resolve(
          Response.json([{ email: "other@example.com", primary: true, verified: true }]),
        );
      },
    });

    const stored = await tokenStore.getAccount(identity.issuer, identity.subject, "github");
    expect(stored?.email).toBe("other@example.com");
    expect(stored?.hop1Subject).toBe(identity.subject);
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
