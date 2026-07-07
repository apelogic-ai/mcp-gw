import { describe, expect, test } from "bun:test";

import type { Hop1Identity } from "../identity/hop1";
import { completeGoogleOAuth, GoogleOAuthError, startGoogleOAuth, type OAuthFetch } from "./google";
import { InMemoryOAuthStateStore, InMemoryOAuthTokenStore } from "./memory-store";
import { GoogleTokenBroker } from "./token-broker";

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
  tokenEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
};

const scopes = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/drive",
];

describe("Google OAuth consent flow", () => {
  test("builds an offline consent URL and stores CSRF state", async () => {
    const stateStore = new InMemoryOAuthStateStore();

    const started = await startGoogleOAuth({
      identity,
      scopes,
      config,
      stateStore,
      redirectAfter: "/after-auth",
    });

    const url = new URL(started.authorizationUrl);

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("login_hint")).toBe("user@example.com");
    expect(url.searchParams.get("scope")).toBe(scopes.join(" "));

    const state = url.searchParams.get("state");
    expect(state).toBeString();
    expect(await stateStore.consume(String(state))).toMatchObject({
      hop1Issuer: identity.issuer,
      hop1Subject: identity.subject,
      email: identity.email,
      requestedScopes: scopes,
      redirectAfter: "/after-auth",
    });
  });

  test("rejects an unknown OAuth state", async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const tokenStore = new InMemoryOAuthTokenStore();

    expect.assertions(2);
    try {
      await completeGoogleOAuth({
        identity,
        code: "code",
        state: "missing",
        config,
        stateStore,
        tokenStore,
        fetch: successFetch("user@example.com"),
      });
    } catch (error) {
      expect(error).toBeInstanceOf(GoogleOAuthError);
      expect((error as GoogleOAuthError).code).toBe("invalid_state");
    }
  });

  test("stores only an encrypted refresh token when Google email matches HOP-1 identity", async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const tokenStore = new InMemoryOAuthTokenStore();
    const started = await startGoogleOAuth({ identity, scopes, config, stateStore });

    await completeGoogleOAuth({
      identity,
      code: "auth-code",
      state: started.state,
      config,
      stateStore,
      tokenStore,
      fetch: successFetch("user@example.com"),
    });

    const account = await tokenStore.getAccount(identity.issuer, identity.subject);

    expect(account).not.toBeNull();
    expect(account?.email).toBe("user@example.com");
    expect(account?.scopesGranted).toEqual(scopes);
    expect(account?.encryptedRefreshToken).not.toContain("refresh-token");
  });

  test("recovers HOP-1 identity from OAuth state when callback has no bearer token", async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const tokenStore = new InMemoryOAuthTokenStore();
    const started = await startGoogleOAuth({ identity, scopes, config, stateStore });

    const completed = await completeGoogleOAuth({
      code: "auth-code",
      state: started.state,
      config,
      stateStore,
      tokenStore,
      fetch: successFetch("user@example.com"),
    });

    expect(completed.identity).toMatchObject({
      issuer: identity.issuer,
      subject: identity.subject,
      email: identity.email,
    });
    expect(await tokenStore.getAccount(identity.issuer, identity.subject)).toMatchObject({
      email: "user@example.com",
    });
  });

  test("rejects Google accounts that do not match the HOP-1 email", async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const tokenStore = new InMemoryOAuthTokenStore();
    const started = await startGoogleOAuth({ identity, scopes, config, stateStore });

    expect.assertions(2);
    try {
      await completeGoogleOAuth({
        identity,
        code: "auth-code",
        state: started.state,
        config,
        stateStore,
        tokenStore,
        fetch: successFetch("other@example.com"),
      });
    } catch (error) {
      expect(error).toBeInstanceOf(GoogleOAuthError);
      expect((error as GoogleOAuthError).code).toBe("email_mismatch");
    }
  });
});

describe("Google token broker", () => {
  test("treats broad read/write Workspace scopes as satisfying narrower tool scopes", async () => {
    const tokenStore = new InMemoryOAuthTokenStore();
    const stateStore = new InMemoryOAuthStateStore();
    const compactScopes = [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/presentations",
      "https://www.googleapis.com/auth/tasks",
      "https://www.googleapis.com/auth/meetings.space.created",
    ];
    const started = await startGoogleOAuth({
      identity,
      scopes: compactScopes,
      config,
      stateStore,
    });
    await completeGoogleOAuth({
      identity,
      code: "auth-code",
      state: started.state,
      config,
      stateStore,
      tokenStore,
      fetch: successFetchWithScopes("user@example.com", compactScopes),
    });

    const broker = new GoogleTokenBroker({
      config,
      tokenStore,
      fetch: () =>
        Promise.resolve(
          jsonResponse({
            access_token: "access-token",
            expires_in: 3600,
            scope: compactScopes.join(" "),
          }),
        ),
    });

    const accessToken = await broker.getAccessToken(identity, [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.metadata.readonly",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/calendar.events.readonly",
      "https://www.googleapis.com/auth/documents.readonly",
      "https://www.googleapis.com/auth/spreadsheets.readonly",
      "https://www.googleapis.com/auth/presentations.readonly",
      "https://www.googleapis.com/auth/tasks.readonly",
    ]);

    expect(accessToken).toBe("access-token");
  });

  test("does not treat compact Meet write scope as satisfying Meet readonly", async () => {
    const tokenStore = new InMemoryOAuthTokenStore();
    const stateStore = new InMemoryOAuthStateStore();
    const compactMeetScopes = [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/meetings.space.created",
    ];
    const started = await startGoogleOAuth({
      identity,
      scopes: compactMeetScopes,
      config,
      stateStore,
    });
    await completeGoogleOAuth({
      identity,
      code: "auth-code",
      state: started.state,
      config,
      stateStore,
      tokenStore,
      fetch: successFetchWithScopes("user@example.com", compactMeetScopes),
    });

    const broker = new GoogleTokenBroker({
      config,
      tokenStore,
      fetch: () =>
        Promise.resolve(
          jsonResponse({
            access_token: "access-token",
            expires_in: 3600,
            scope: compactMeetScopes.join(" "),
          }),
        ),
    });

    expect.assertions(2);
    try {
      await broker.getAccessToken(identity, [
        "https://www.googleapis.com/auth/meetings.space.readonly",
      ]);
    } catch (error) {
      expect(error).toBeInstanceOf(GoogleOAuthError);
      expect((error as GoogleOAuthError).code).toBe("reauth_required");
    }
  });

  test("deduplicates concurrent refreshes and returns cached access tokens", async () => {
    const tokenStore = new InMemoryOAuthTokenStore();
    const stateStore = new InMemoryOAuthStateStore();
    const started = await startGoogleOAuth({ identity, scopes, config, stateStore });
    await completeGoogleOAuth({
      identity,
      code: "auth-code",
      state: started.state,
      config,
      stateStore,
      tokenStore,
      fetch: successFetch("user@example.com"),
    });

    let refreshCalls = 0;
    const broker = new GoogleTokenBroker({
      config,
      tokenStore,
      fetch: async () => {
        refreshCalls += 1;
        await Bun.sleep(10);
        return jsonResponse({
          access_token: `access-${String(refreshCalls)}`,
          expires_in: 3600,
          scope: scopes.join(" "),
        });
      },
    });

    const [first, second, third] = await Promise.all([
      broker.getAccessToken(identity, scopes),
      broker.getAccessToken(identity, scopes),
      broker.getAccessToken(identity, scopes),
    ]);
    const cached = await broker.getAccessToken(identity, scopes);

    expect(first).toBe("access-1");
    expect(second).toBe("access-1");
    expect(third).toBe("access-1");
    expect(cached).toBe("access-1");
    expect(refreshCalls).toBe(1);
  });

  test("marks an account revoked when Google returns invalid_grant", async () => {
    const tokenStore = new InMemoryOAuthTokenStore();
    const stateStore = new InMemoryOAuthStateStore();
    const started = await startGoogleOAuth({ identity, scopes, config, stateStore });
    await completeGoogleOAuth({
      identity,
      code: "auth-code",
      state: started.state,
      config,
      stateStore,
      tokenStore,
      fetch: successFetch("user@example.com"),
    });

    const broker = new GoogleTokenBroker({
      config,
      tokenStore,
      fetch: () => Promise.resolve(jsonResponse({ error: "invalid_grant" }, 400)),
    });

    expect.assertions(3);
    try {
      await broker.getAccessToken(identity, scopes);
    } catch (error) {
      expect(error).toBeInstanceOf(GoogleOAuthError);
      expect((error as GoogleOAuthError).code).toBe("reauth_required");
      expect(
        (await tokenStore.getAccount(identity.issuer, identity.subject))?.revokedAt,
      ).toBeDate();
    }
  });
});

function successFetch(email: string): OAuthFetch {
  return successFetchWithScopes(email, scopes);
}

function successFetchWithScopes(email: string, grantedScopes: string[]): OAuthFetch {
  return (url) => {
    if (url.includes("oauth2.googleapis.com/token")) {
      return Promise.resolve(
        jsonResponse({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
          scope: grantedScopes.join(" "),
        }),
      );
    }

    return Promise.resolve(jsonResponse({ email }));
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}
