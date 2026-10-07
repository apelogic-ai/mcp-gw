import { describe, expect, test } from "bun:test";

import type { Hop1Identity } from "../../../shared/identity/hop1";
import {
  InMemoryOAuthStateStore,
  InMemoryOAuthTokenStore,
} from "../../../shared/oauth/memory-store";
import {
  GenericOAuthConnectionAdapter,
  completeGenericOAuth,
  createGenericOAuthRuntimeConfig,
  startGenericOAuth,
} from "./oauth";
import type { GenericOAuthCredentialDescriptor } from "./descriptor";

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
  revocationUrl: "https://identity.example.com/oauth/revoke",
  redirectUri: "https://gateway.example.com/oauth/search-provider/callback",
  scopes: ["search.read"],
  clientIdEnv: "OAUTH_CLIENT_ID",
  clientSecretEnv: "OAUTH_CLIENT_SECRET",
  encryptionKeyEnv: "OAUTH_TOKEN_ENCRYPTION_KEY",
  tokenStoreDsnEnv: "TOKEN_STORE_DSN",
  identity: {
    idField: "sub",
    emailField: "email",
    loginField: "preferred_username",
    emailVerifiedField: "email_verified",
  },
  authorizationParams: { access_type: "offline" },
  tokenEndpointAuthMethod: "client_secret_basic",
};

const env = {
  OAUTH_CLIENT_ID: "wrapper-client",
  OAUTH_CLIENT_SECRET: "wrapper-secret",
  OAUTH_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  JIRA_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  TOKEN_STORE_DSN: "postgresql://unused.example.com/oauth",
};

describe("generic per-user OAuth", () => {
  test("builds a standard authorization request from non-secret provider configuration", async () => {
    const adapter = new GenericOAuthConnectionAdapter(
      createGenericOAuthRuntimeConfig(descriptor, env),
    );
    const started = await adapter.startAuthorization({
      identity,
      scopes: descriptor.scopes,
      state: "opaque-state",
    });
    const url = new URL(started.authorizationUrl);

    expect(url.origin + url.pathname).toBe(descriptor.authorizationUrl);
    expect(url.searchParams.get("client_id")).toBe("wrapper-client");
    expect(url.searchParams.get("redirect_uri")).toBe(descriptor.redirectUri);
    expect(url.searchParams.get("scope")).toBe("search.read");
    expect(url.searchParams.get("state")).toBe("opaque-state");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.toString()).not.toContain("wrapper-secret");
  });

  test("takes durable lifecycle custody and brokers the validated provider token", async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const tokenStore = new InMemoryOAuthTokenStore();
    const requests: Request[] = [];
    const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request =
        input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
      requests.push(request);
      if (request.url === descriptor.tokenUrl) {
        return Promise.resolve(
          Response.json({
            access_token: "provider-access",
            refresh_token: "provider-refresh",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "search.read",
          }),
        );
      }
      if (request.url === descriptor.userInfoUrl) {
        expect(request.headers.get("authorization")).toBe("Bearer provider-access");
        return Promise.resolve(
          Response.json({
            sub: "provider-account-1",
            email: "user@example.com",
            email_verified: true,
            preferred_username: "example-user",
          }),
        );
      }
      throw new Error(`Unexpected request: ${request.url}`);
    };
    const config = createGenericOAuthRuntimeConfig(descriptor, env);
    const started = await startGenericOAuth({
      identity,
      config,
      stateStore,
      tokenStore,
      fetch,
    });
    await completeGenericOAuth({
      code: "authorization-code",
      state: started.state,
      config,
      stateStore,
      tokenStore,
      fetch,
    });

    expect(
      await config.lifecycle(tokenStore, fetch).getActiveCredential(identity, ["search.read"]),
    ).toBe("provider-access");
    expect(
      await config.lifecycle(tokenStore, fetch).status(identity, ["search.read"]),
    ).toMatchObject({
      provider: "search-provider",
      phase: "connected",
      connected: true,
      account: {
        id: "provider-account-1",
        login: "example-user",
        displayName: "user@example.com",
      },
    });
    expect(requests.filter((request) => request.url === descriptor.tokenUrl)).toHaveLength(1);
  });

  test("rejects a provider identity that does not match the HOP-1 email", () => {
    const adapter = new GenericOAuthConnectionAdapter(
      createGenericOAuthRuntimeConfig(descriptor, env),
      (input) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url === descriptor.userInfoUrl) {
          return Promise.resolve(
            Response.json({
              sub: "other-account",
              email: "other@example.com",
              email_verified: true,
            }),
          );
        }
        return Promise.resolve(Response.json({ access_token: "provider-access" }));
      },
    );

    expect(
      adapter.validateIdentity(
        {
          provider: "search-provider",
          generation: 1,
          credential: { activeCredential: "provider-access" },
          grantedScopes: ["search.read"],
        },
        identity,
      ),
    ).rejects.toMatchObject({ category: "identity_mismatch" });
  });

  test("trusts only the configured active Jira site's asserted identity", async () => {
    const jiraDescriptor: GenericOAuthCredentialDescriptor = {
      ...descriptor,
      providerId: "jira",
      authorizationUrl: "https://auth.atlassian.com/authorize",
      tokenUrl: "https://auth.atlassian.com/oauth/token",
      userInfoUrl: "https://api.atlassian.com/oauth/token/accessible-resources",
      redirectUri: "http://127.0.0.1:28080/oauth/jira/callback",
      scopes: [
        "read:jira-user",
        "read:jira:agent-interface",
        "write:jira:agent-interface",
        "search:jira:agent-interface",
        "offline_access",
      ],
      encryptionKeyEnv: "JIRA_TOKEN_ENCRYPTION_KEY",
      identity: {
        mode: "atlassian_jira_asserted_email",
        siteUrl: "https://example.atlassian.net",
      },
      authorizationParams: { audience: "api.atlassian.com", prompt: "consent" },
      tokenEndpointAuthMethod: "client_secret_post",
    };
    const requests: Request[] = [];
    const adapter = new GenericOAuthConnectionAdapter(
      createGenericOAuthRuntimeConfig(jiraDescriptor, env),
      (input, init) => {
        const request =
          input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
        requests.push(request);
        if (request.url === jiraDescriptor.userInfoUrl) {
          return Promise.resolve(
            Response.json([
              { id: "other-cloud", url: "https://other.atlassian.net", name: "Other" },
              { id: "cloud-123", url: "https://example.atlassian.net/", name: "Example" },
            ]),
          );
        }
        if (request.url === "https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/myself") {
          return Promise.resolve(
            Response.json({
              accountId: "account-123",
              emailAddress: " USER@example.com ",
              active: true,
            }),
          );
        }
        throw new Error(`Unexpected request: ${request.url}`);
      },
    );

    expect(
      await adapter.validateIdentity(
        {
          provider: "jira",
          generation: 1,
          credential: { activeCredential: "jira-access" },
          grantedScopes: jiraDescriptor.scopes,
        },
        identity,
      ),
    ).toEqual({
      displayAccountIdentity: "USER@example.com",
      providerAccount: { id: "account-123" },
    });
    expect(requests).toHaveLength(2);
    expect(
      requests.every((request) => request.headers.get("authorization") === "Bearer jira-access"),
    ).toBe(true);
  });

  test("rejects inactive, wrong-site, and email-mismatched Jira identities", () => {
    const jiraDescriptor: GenericOAuthCredentialDescriptor = {
      ...descriptor,
      providerId: "jira",
      userInfoUrl: "https://api.atlassian.com/oauth/token/accessible-resources",
      redirectUri: "https://gateway.example.com/oauth/jira/callback",
      identity: {
        mode: "atlassian_jira_asserted_email",
        siteUrl: "https://example.atlassian.net",
      },
    };
    const generation = {
      provider: "jira",
      generation: 1,
      credential: { activeCredential: "jira-access" },
      grantedScopes: ["read:jira-user"],
    };

    const wrongSite = new GenericOAuthConnectionAdapter(
      createGenericOAuthRuntimeConfig(jiraDescriptor, env),
      () => Promise.resolve(Response.json([{ id: "cloud-1", url: "https://other.atlassian.net" }])),
    );
    expect(wrongSite.validateIdentity(generation, identity)).rejects.toMatchObject({
      category: "identity_mismatch",
    });

    for (const profile of [
      { accountId: "account-1", emailAddress: "other@example.com", active: true },
      { accountId: "account-1", emailAddress: "user@example.com", active: false },
    ]) {
      const adapter = new GenericOAuthConnectionAdapter(
        createGenericOAuthRuntimeConfig(jiraDescriptor, env),
        (input) => {
          const url = input instanceof Request ? input.url : input.toString();
          return Promise.resolve(
            url === jiraDescriptor.userInfoUrl
              ? Response.json([{ id: "cloud-1", url: "https://example.atlassian.net" }])
              : Response.json(profile),
          );
        },
      );
      expect(adapter.validateIdentity(generation, identity)).rejects.toMatchObject({
        category: "identity_mismatch",
      });
    }
  });
});
