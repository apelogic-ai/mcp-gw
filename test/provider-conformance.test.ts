import { describe, expect, test } from "bun:test";

import type { Hop1Identity } from "../shared/identity/hop1";
import { InMemoryOAuthTokenStore } from "../shared/oauth/memory-store";
import type { OAuthProvider, OAuthTokenStore } from "../shared/oauth/store";
import { listStableGithubTools } from "../servers/github-mcp/wrapper/src/catalog/github-mcp";
import { createGithubMcpProxyHandler } from "../servers/github-mcp/wrapper/src/proxy";
import { createGoogleWorkspaceRegistry } from "../servers/google-workspace/wrapper/src/google-workspace/registry";

const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/drive"];
const GITHUB_SCOPES = ["repo"];
const GOOGLE_HELPERS = ["google_oauth_status", "google_oauth_start"];
const GITHUB_HELPERS = ["github_oauth_status", "github_oauth_start"];

const brokerIdentity: Hop1Identity = {
  profile: "mcp-broker",
  issuer: "https://mcp.example.com",
  subject: "google:stable-user-123",
  email: "person@example.com",
  claims: {},
};

describe("provider lifecycle conformance", () => {
  test("keeps both provider catalogs stable while grants change independently", async () => {
    const store = new InMemoryOAuthTokenStore();

    const googleBefore = await googleToolNames(store, brokerIdentity);
    const githubBefore = await githubToolNames(store, brokerIdentity);
    expect(googleBefore.slice(0, 2)).toEqual(GOOGLE_HELPERS);
    expect(googleBefore).toContain("google_drive_files_list");
    expect(githubBefore).toEqual([
      ...GITHUB_HELPERS,
      ...listStableGithubTools(["repos"], undefined).map((tool) => tool.name),
    ]);

    await saveGrant(store, "google", brokerIdentity, GOOGLE_SCOPES);

    const googleAfterGoogleConsent = await googleToolNames(store, brokerIdentity);
    expect(googleAfterGoogleConsent.slice(0, 2)).toEqual(GOOGLE_HELPERS);
    expect(googleAfterGoogleConsent).toContain("google_drive_files_list");
    expect(await googleToolNames(store, brokerIdentity)).toEqual(googleBefore);
    expect(await githubToolNames(store, brokerIdentity)).toEqual(githubBefore);

    await saveGrant(store, "github", brokerIdentity, GITHUB_SCOPES);

    const googleAfterBothConsents = await googleToolNames(store, brokerIdentity);
    expect(googleAfterBothConsents.slice(0, 2)).toEqual(GOOGLE_HELPERS);
    expect(googleAfterBothConsents).toContain("google_drive_files_list");
    expect(googleAfterBothConsents).toEqual(googleBefore);
    expect(await githubToolNames(store, brokerIdentity)).toEqual(githubBefore);
  });

  test("does not link broker and alternate trusted-issuer principals by matching email", async () => {
    const store = new InMemoryOAuthTokenStore();
    const alternateIdentity: Hop1Identity = {
      profile: "enterprise-control-plane",
      issuer: "https://identity.example.com",
      subject: "stable-user-123",
      email: brokerIdentity.email,
      claims: {},
    };

    await saveGrant(store, "google", brokerIdentity, GOOGLE_SCOPES);
    await saveGrant(store, "github", brokerIdentity, GITHUB_SCOPES);

    expect(await googleToolNames(store, brokerIdentity)).toContain("google_drive_files_list");
    expect(await githubToolNames(store, brokerIdentity)).toContain("get_file_contents");

    expect(await googleToolNames(store, alternateIdentity)).toEqual(
      await googleToolNames(store, brokerIdentity),
    );
    expect(await githubToolNames(store, alternateIdentity)).toEqual(
      await githubToolNames(store, brokerIdentity),
    );
    expect(
      await store.getAccount(alternateIdentity.issuer, alternateIdentity.subject, "google"),
    ).toBeNull();
    expect(
      await store.getAccount(alternateIdentity.issuer, alternateIdentity.subject, "github"),
    ).toBeNull();
  });
});

async function saveGrant(
  store: OAuthTokenStore,
  provider: OAuthProvider,
  identity: Hop1Identity,
  scopes: string[],
): Promise<void> {
  const now = new Date("2026-08-19T00:00:00.000Z");
  await store.saveAccount({
    provider,
    hop1Issuer: identity.issuer,
    hop1Subject: identity.subject,
    email: identity.email,
    scopesGranted: scopes,
    encryptedRefreshToken: "fixture-encrypted-provider-credential",
    createdAt: now,
    updatedAt: now,
  });
}

async function googleToolNames(store: OAuthTokenStore, identity: Hop1Identity): Promise<string[]> {
  const account = await store.getAccount(identity.issuer, identity.subject, "google");
  const missingScopes = missingRequiredScopes(GOOGLE_SCOPES, account?.scopesGranted ?? []);
  const registry = createGoogleWorkspaceRegistry({
    identity,
    oauth: {
      status: {
        connected: Boolean(account && !account.revokedAt && missingScopes.length === 0),
        email: account?.email,
        scopesRequired: GOOGLE_SCOPES,
        scopesGranted: account?.scopesGranted ?? [],
        missingScopes,
      },
      startOAuth: () =>
        Promise.resolve({ authorizationUrl: "https://accounts.google.com/fixture-consent" }),
    },
    tokenBroker: {
      getAccessToken: () => Promise.resolve("fixture-google-access-token"),
    },
    executor: () => Promise.resolve({ ok: true }),
  });

  return registry.listTools().map((tool) => tool.name);
}

async function githubToolNames(store: OAuthTokenStore, identity: Hop1Identity): Promise<string[]> {
  const handler = createGithubMcpProxyHandler({
    upstreamUrl: "http://github-mcp.fixture/mcp",
    githubToolsets: ["repos"],
    authenticate: () => Promise.resolve(identity),
    getOAuthStatus: async (requestIdentity) => {
      const account = await store.getAccount(
        requestIdentity.issuer,
        requestIdentity.subject,
        "github",
      );
      const missingScopes = missingRequiredScopes(GITHUB_SCOPES, account?.scopesGranted ?? []);
      return {
        connected: Boolean(account && !account.revokedAt && missingScopes.length === 0),
        email: account?.email,
        scopesRequired: GITHUB_SCOPES,
        scopesGranted: account?.scopesGranted ?? [],
        missingScopes,
      };
    },
    resolveGithubToken: async (requestIdentity) => {
      const account = await store.getAccount(
        requestIdentity.issuer,
        requestIdentity.subject,
        "github",
      );
      const missingScopes = missingRequiredScopes(GITHUB_SCOPES, account?.scopesGranted ?? []);
      return account && !account.revokedAt && missingScopes.length === 0
        ? "fixture-github-access-token"
        : undefined;
    },
    fetch: () =>
      Promise.reject(new Error("OAuth-backed tools/list must not reach GitHub MCP upstream")),
  });
  const response = await handler(
    new Request("https://mcp.example.com/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer fixture-hop1-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list" }),
    }),
  );
  const body = (await response.json()) as { result: { tools: { name: string }[] } };
  return body.result.tools.map((tool) => tool.name);
}

function missingRequiredScopes(required: string[], granted: string[]): string[] {
  const grantedSet = new Set(granted);
  return required.filter((scope) => !grantedSet.has(scope));
}
