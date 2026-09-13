import type { Hop1Identity } from "../shared/identity/hop1";
import { ConnectionLifecycle } from "../shared/oauth/connection-lifecycle";
import { InMemoryOAuthTokenStore } from "../shared/oauth/memory-store";
import {
  GitHubConnectionAdapter,
  GoogleConnectionAdapter,
} from "../shared/oauth/provider-adapters";
import { defineProviderLifecycleConformance } from "./support/provider-lifecycle-conformance";

const key = Buffer.alloc(32, 5).toString("base64");
const identity: Hop1Identity = {
  profile: "conformance",
  issuer: "https://issuer.example.com",
  subject: "subject",
  email: "user@example.com",
  claims: {},
};

defineProviderLifecycleConformance("Google", () => {
  let calls = 0;
  const store = new InMemoryOAuthTokenStore();
  const adapter = new GoogleConnectionAdapter(
    {
      clientId: "google-client",
      clientSecret: "google-secret",
      redirectUri: "https://mcp.example/oauth/google/callback",
      tokenEncryptionKey: key,
      tokenUrl: "https://provider.example/google/token",
      userInfoUrl: "https://provider.example/google/userinfo",
      revocationUrl: "https://provider.example/google/revoke",
    },
    (url) => {
      calls += 1;
      return Promise.resolve(
        url.endsWith("/revoke")
          ? new Response(null, { status: 200 })
          : Response.json({
              access_token: "google-active-new",
              expires_in: 3600,
              scope: "scope-a scope-b",
            }),
      );
    },
  );
  const lifecycle = new ConnectionLifecycle({
    adapter,
    store,
    credentialEncryptionKey: key,
  });
  return {
    adapter,
    lifecycle,
    store,
    identity,
    requiredScopes: ["scope-a", "scope-b"],
    expectedRenewedActiveCredential: "google-active-new",
    providerCalls: () => calls,
    authorize: (expired = false) =>
      lifecycle
        .activateAuthorizedGeneration(identity, ["scope-a", "scope-b"], {
          credential: {
            activeCredential: "active-old",
            renewalCredential: "renewal-old",
          },
          displayAccountIdentity: identity.email,
          grantedScopes: ["scope-a", "scope-b"],
          activeCredentialExpiresAt: new Date(Date.now() + (expired ? -1 : 3_600_000)),
          validatedAt: new Date(),
        })
        .then(() => undefined),
  };
});

defineProviderLifecycleConformance("GitHub", () => {
  let calls = 0;
  const store = new InMemoryOAuthTokenStore();
  const adapter = new GitHubConnectionAdapter(
    {
      clientId: "github-client",
      clientSecret: "github-secret",
      redirectUri: "https://mcp.example/oauth/github/callback",
      tokenEncryptionKey: key,
      tokenUrl: "https://provider.example/github/token",
      userEmailsUrl: "https://provider.example/github/emails",
      tokenRevocationUrl: "https://provider.example/github/revoke",
    },
    (_url, init) => {
      calls += 1;
      return Promise.resolve(
        init?.method === "DELETE"
          ? new Response(null, { status: 204 })
          : Response.json({
              access_token: "github-active-new",
              refresh_token: "github-renewal-new",
              expires_in: 3600,
              refresh_token_expires_in: 7200,
              scope: "repo read:org",
            }),
      );
    },
  );
  const lifecycle = new ConnectionLifecycle({
    adapter,
    store,
    credentialEncryptionKey: key,
  });
  return {
    adapter,
    lifecycle,
    store,
    identity,
    requiredScopes: ["repo", "read:org"],
    expectedRenewedActiveCredential: "github-active-new",
    providerCalls: () => calls,
    authorize: (expired = false) =>
      lifecycle
        .activateAuthorizedGeneration(identity, ["repo", "read:org"], {
          credential: {
            activeCredential: "active-old",
            renewalCredential: "renewal-old",
          },
          displayAccountIdentity: identity.email,
          grantedScopes: ["repo", "read:org"],
          activeCredentialExpiresAt: new Date(Date.now() + (expired ? -1 : 3_600_000)),
          renewalCredentialExpiresAt: new Date(Date.now() + 7_200_000),
          validatedAt: new Date(),
        })
        .then(() => undefined),
  };
});
