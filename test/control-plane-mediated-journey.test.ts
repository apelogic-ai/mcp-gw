import { beforeAll, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

import type { Hop1Identity } from "../shared/identity/hop1";
import { InMemoryOAuthStateStore, InMemoryOAuthTokenStore } from "../shared/oauth/memory-store";
import type { GoogleOAuthConfig } from "../shared/oauth/google";
import type { GoogleOAuthStatus } from "../servers/google-workspace/wrapper/src/google-workspace/registry";
import { createGoogleWorkspaceWrapperHandler } from "../servers/google-workspace/wrapper/src/app";
import { createOAuthRouteHandler } from "../servers/google-workspace/wrapper/src/oauth-routes";
import { createRuntimeAuthenticator } from "../servers/google-workspace/wrapper/src/runtime";
import { startGoogleOAuth } from "../shared/oauth/google";

// End-to-end journey for a "control-plane mediated client" (the runbook's neutral
// term for an external portal / agent platform that authenticates a user, mints a
// HOP-1 bearer token, and drives provider connection on the agent's behalf). The
// same HOP-1 principal is used to gate /mcp tools before and after connection, and
// isolation from other principals is asserted.

const RESOURCE = "https://mcp.example.com/mcp";
const CONTROL_PLANE_ISSUER = "https://idp.example.com";
const ENTERPRISE_ISSUER = "https://identity.example.com";
const AGENT_SUBJECT = "service-principal-agent-1";
const AGENT_EMAIL = "person@example.com";
const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/drive"];
const GOOGLE_HELPERS = ["google_oauth_status", "google_oauth_start"];

const oauthConfig: GoogleOAuthConfig = {
  clientId: "google-client-id",
  clientSecret: "google-client-secret",
  redirectUri: "https://mcp.example.com/oauth/google/callback",
  tokenEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
};

let controlPlanePrivateKey: CryptoKey;
let controlPlanePublicJwk: JWK;
let enterprisePrivateKey: CryptoKey;
let enterprisePublicJwk: JWK;

beforeAll(async () => {
  const controlPlaneKeys = await generateKeyPair("RS256");
  controlPlanePrivateKey = controlPlaneKeys.privateKey;
  controlPlanePublicJwk = {
    ...(await exportJWK(controlPlaneKeys.publicKey)),
    kid: "control-plane",
  };
  const enterpriseKeys = await generateKeyPair("RS256");
  enterprisePrivateKey = enterpriseKeys.privateKey;
  enterprisePublicJwk = { ...(await exportJWK(enterpriseKeys.publicKey)), kid: "enterprise" };
});

async function hop1Token(input: {
  key: CryptoKey;
  kid: string;
  issuer: string;
  subject: string;
  email: string;
}): Promise<string> {
  return new SignJWT({ email: input.email })
    .setProtectedHeader({ alg: "RS256", kid: input.kid })
    .setIssuer(input.issuer)
    .setAudience(RESOURCE)
    .setSubject(input.subject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(input.key);
}

// A HOP-2 token endpoint / userinfo stub so the provider connection runs fully
// in-memory. The refresh token stays server-side; the client never sees it.
function providerFetch(url: string): Promise<Response> {
  if (url.includes("oauth2.googleapis.com/token")) {
    return Promise.resolve(
      Response.json({
        access_token: "google-access-token",
        refresh_token: "server-held-refresh-token",
        expires_in: 3600,
        scope: GOOGLE_SCOPES.join(" "),
      }),
    );
  }
  return Promise.resolve(Response.json({ email: AGENT_EMAIL }));
}

describe("control-plane mediated provider connection journey", () => {
  test("connects a provider for a HOP-1 principal and gates /mcp tools by that principal", async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const tokenStore = new InMemoryOAuthTokenStore();

    // A real runtime authenticator trusting the control-plane issuer and a
    // distinct enterprise issuer, each validated against its own JWKS.
    const authenticate = createRuntimeAuthenticator({
      issuers: [
        {
          profile: {
            name: "control-plane",
            issuer: CONTROL_PLANE_ISSUER,
            audiences: [RESOURCE],
            allowedAlgorithms: ["RS256"],
            emailClaim: "email",
            subjectClaim: "sub",
          },
          jwksProvider: () => Promise.resolve([controlPlanePublicJwk]),
        },
        {
          profile: {
            name: "enterprise",
            issuer: ENTERPRISE_ISSUER,
            audiences: [RESOURCE],
            allowedAlgorithms: ["RS256"],
            emailClaim: "email",
            subjectClaim: "sub",
          },
          jwksProvider: () => Promise.resolve([enterprisePublicJwk]),
        },
      ],
    });

    // Per-request provider status resolved from the shared token store, keyed by
    // (provider, HOP-1 issuer, HOP-1 subject) — mirrors runtime.ts.
    const getOAuthStatus = async (identity: Hop1Identity): Promise<GoogleOAuthStatus> => {
      const account = await tokenStore.getAccount(identity.issuer, identity.subject, "google");
      if (!account || account.revokedAt) {
        return {
          connected: false,
          scopesRequired: GOOGLE_SCOPES,
          scopesGranted: [],
          missingScopes: GOOGLE_SCOPES,
        };
      }
      const missingScopes = GOOGLE_SCOPES.filter((scope) => !account.scopesGranted.includes(scope));
      return {
        connected: missingScopes.length === 0,
        email: account.email,
        scopesRequired: GOOGLE_SCOPES,
        scopesGranted: account.scopesGranted,
        missingScopes,
      };
    };

    const mcpHandler = createGoogleWorkspaceWrapperHandler({
      serverInfo: { name: "google-workspace-wrapper", version: "0.1.0" },
      authenticate,
      getOAuthStatus,
      startOAuth: (identity, redirectAfter) =>
        startGoogleOAuth({
          identity,
          scopes: GOOGLE_SCOPES,
          config: oauthConfig,
          stateStore,
          redirectAfter,
        }),
      tokenBroker: { getAccessToken: () => Promise.resolve("google-access-token") },
      executor: () => Promise.resolve({ ok: true }),
    });

    const providerRoutes = createOAuthRouteHandler({
      authenticate,
      config: oauthConfig,
      scopes: GOOGLE_SCOPES,
      stateStore,
      tokenStore,
      fetch: providerFetch,
    });

    const agentToken = await hop1Token({
      key: controlPlanePrivateKey,
      kid: "control-plane",
      issuer: CONTROL_PLANE_ISSUER,
      subject: AGENT_SUBJECT,
      email: AGENT_EMAIL,
    });

    // 1. Before provider connection, the HOP-1 principal sees only the provider
    //    OAuth helper tools on /mcp.
    expect(await mcpToolNames(mcpHandler, agentToken)).toEqual(GOOGLE_HELPERS);

    // 2. The control plane drives provider connection on the agent's behalf.
    const startResponse = await providerRoutes(
      new Request("https://mcp.example.com/oauth/google/start", {
        method: "POST",
        headers: {
          authorization: `Bearer ${agentToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ redirectAfter: "https://portal.example.com/connected" }),
      }),
    );
    expect(startResponse.status).toBe(200);
    const startBodyText = await startResponse.text();
    const startBody = JSON.parse(startBodyText) as { authorizationUrl?: string };
    const authorizationUrl = new URL(startBody.authorizationUrl ?? "");
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(authorizationUrl.searchParams.get("login_hint")).toBe(AGENT_EMAIL);
    const providerState = authorizationUrl.searchParams.get("state") ?? "";

    // Simulate Google's browser redirect into the provider callback (HOP-2). No
    // HOP-1 bearer is present; identity is recovered from the signed state.
    const callbackResponse = await providerRoutes(
      new Request(
        `https://mcp.example.com/oauth/google/callback?code=google-code&state=${providerState}`,
      ),
    );
    expect(callbackResponse.status).toBe(302);
    expect(callbackResponse.headers.get("location")).toBe("https://portal.example.com/connected");

    // 3a. After connection the full Google catalog is gated IN for that principal.
    const toolsAfter = await mcpToolNames(mcpHandler, agentToken);
    expect(toolsAfter.slice(0, 2)).toEqual(GOOGLE_HELPERS);
    expect(toolsAfter).toContain("google_drive_files_list");
    expect(toolsAfter.some((name) => name.startsWith("gws_"))).toBe(true);

    // 3b. The stored provider credential is keyed by the HOP-1 subject, and the
    //     refresh token is held encrypted server-side, never handed to the client.
    const storedAccount = await tokenStore.getAccount(
      CONTROL_PLANE_ISSUER,
      AGENT_SUBJECT,
      "google",
    );
    expect(storedAccount?.email).toBe(AGENT_EMAIL);
    expect(storedAccount?.encryptedRefreshToken).toBeString();
    expect(storedAccount?.encryptedRefreshToken).not.toBe("server-held-refresh-token");
    // Nothing the client received ever carried a provider refresh token.
    expect(startBodyText).not.toContain("server-held-refresh-token");
    expect(startBodyText).not.toContain("refresh_token");
    expect(authorizationUrl.searchParams.has("refresh_token")).toBe(false);

    // 3c. A DIFFERENT HOP-1 subject on the same issuer does not inherit the
    //     connection.
    const otherSubjectToken = await hop1Token({
      key: controlPlanePrivateKey,
      kid: "control-plane",
      issuer: CONTROL_PLANE_ISSUER,
      subject: "service-principal-agent-2",
      email: AGENT_EMAIL,
    });
    expect(await mcpToolNames(mcpHandler, otherSubjectToken)).toEqual(GOOGLE_HELPERS);
    expect(
      await tokenStore.getAccount(CONTROL_PLANE_ISSUER, "service-principal-agent-2", "google"),
    ).toBeNull();

    // 3d. A DIFFERENT trusted issuer with the SAME email is a distinct principal
    //     and does not inherit the connection either.
    const enterpriseToken = await hop1Token({
      key: enterprisePrivateKey,
      kid: "enterprise",
      issuer: ENTERPRISE_ISSUER,
      subject: AGENT_SUBJECT,
      email: AGENT_EMAIL,
    });
    expect(await mcpToolNames(mcpHandler, enterpriseToken)).toEqual(GOOGLE_HELPERS);
    expect(await tokenStore.getAccount(ENTERPRISE_ISSUER, AGENT_SUBJECT, "google")).toBeNull();
  });
});

async function mcpToolNames(
  handler: (request: Request) => Promise<Response>,
  token: string,
): Promise<string[]> {
  const response = await handler(
    new Request("https://mcp.example.com/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list" }),
    }),
  );
  const body = (await response.json()) as { result: { tools: { name: string }[] } };
  return body.result.tools.map((tool) => tool.name);
}
