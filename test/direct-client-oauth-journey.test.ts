import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { decodeJwt, exportJWK, generateKeyPair, jwtVerify, SignJWT, type JWK } from "jose";

import {
  InMemoryAuthorizationBrokerStore,
  OAuthBroker,
  type BrokerClientRegistry,
  type GoogleTokenExchangeResult,
} from "../shared/oauth/authorization-broker";
import { ConstrainedDcrRegistry, InMemoryDcrRegistrationStore } from "../shared/oauth/dcr";
import { InMemoryOAuthStateStore, InMemoryOAuthTokenStore } from "../shared/oauth/memory-store";
import { createGithubMcpProxyHandler } from "../servers/github-mcp/wrapper/src/proxy";
import { createAuthorizationServerRouteHandler } from "../servers/google-workspace/wrapper/src/authorization-routes";
import { canonicalAuthorizationBrokerIssuer } from "../servers/google-workspace/wrapper/src/broker-runtime";
import {
  createRuntimeAuthenticator,
  createRuntimeWrapperHandler,
  type RuntimeTrustedIssuer,
} from "../servers/google-workspace/wrapper/src/runtime";

// End-to-end journey for a "direct MCP client" (the runbook's neutral term for a
// client that drives OAuth itself). It stitches the per-stage
// broker units into one flow: DCR registration -> /authorize consent -> upstream
// Google identity callback -> /token -> refresh after access-token expiry ->
// the renewed gateway token being accepted by the same runtime authenticator
// that guards /mcp. The DCR request is the exact Codex 0.147/RMCP 3 shape.

const NOW = 1_800_000_000_000;
const CONFIGURED_ISSUER = "https://auth.example.com/";
const ISSUER = canonicalAuthorizationBrokerIssuer(CONFIGURED_ISSUER);
const RESOURCE = "https://mcp.example.com/mcp";
const REDIRECT_URI = "http://127.0.0.1:49152/callback/abcDEF012_-x";
const GOOGLE_CLIENT_ID = "google-client-id.apps.googleusercontent.com";
const GOOGLE_CALLBACK = "https://auth.example.com/oauth/google/broker/callback";
const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const VERIFIER = "v".repeat(64);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const GOOGLE_SUBJECT = "google-subject";
const GOOGLE_EMAIL = "person@example.com";

// Secrets the upstream Google exchange hands back alongside the identity token.
// The security contract is that these MUST NOT reach the client, so the tests
// assert this exact marker never appears in the /token response.
const UPSTREAM_SECRET_MARKER = "must-not-leak-to-client";

let brokerPrivateKey: CryptoKey;
let brokerPublicJwk: JWK;
let googlePrivateKey: CryptoKey;
let googlePublicJwk: JWK;

beforeAll(async () => {
  const brokerKeys = await generateKeyPair("RS256");
  brokerPrivateKey = brokerKeys.privateKey;
  brokerPublicJwk = { ...(await exportJWK(brokerKeys.publicKey)), kid: "broker-key" };
  const googleKeys = await generateKeyPair("RS256");
  googlePrivateKey = googleKeys.privateKey;
  googlePublicJwk = { ...(await exportJWK(googleKeys.publicKey)), kid: "google-key" };
});

async function googleIdToken(nonce: string): Promise<string> {
  return new SignJWT({ email: GOOGLE_EMAIL, email_verified: true, nonce })
    .setProtectedHeader({ alg: "RS256", kid: "google-key" })
    .setIssuer("https://accounts.google.com")
    .setAudience(GOOGLE_CLIENT_ID)
    .setSubject(GOOGLE_SUBJECT)
    .setIssuedAt(Math.floor(NOW / 1000))
    .setExpirationTime(Math.floor(NOW / 1000) + 300)
    .sign(googlePrivateKey);
}

function unescapeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

describe("direct MCP client OAuth journey", () => {
  test("registers, authorizes, and renews an /mcp-accepted token after expiry", async () => {
    let current = NOW;
    // 1. Real broker backbone: in-memory transaction/code store plus a stubbed
    //    upstream Google exchange that returns a nonce-bound identity token and
    //    the provider secrets that must never leak downstream. The nonce is only
    //    known after the consent page is built, so the stub reads it lazily.
    let capturedGoogleNonce = "";
    const brokerStore = new InMemoryAuthorizationBrokerStore();
    const exchangeGoogleCode = async (): Promise<GoogleTokenExchangeResult> => ({
      idToken: await googleIdToken(capturedGoogleNonce),
      accessToken: UPSTREAM_SECRET_MARKER,
      refreshToken: UPSTREAM_SECRET_MARKER,
    });

    // A real constrained DCR registry exercises dynamic registration and also
    // backs the broker's client lookup, mirroring broker-runtime.ts wiring.
    const registry = new ConstrainedDcrRegistry({
      allowedScopes: ["mcp"],
      allowLoopbackRedirects: true,
      defaultScopes: ["mcp"],
      store: new InMemoryDcrRegistrationStore(),
    });
    const clients: BrokerClientRegistry = {
      get: async (clientId) => {
        const client = await registry.getClient(clientId);
        return client
          ? {
              clientId: client.client_id,
              redirectUris: client.redirect_uris,
              grantTypes: [...client.grant_types],
              scopes: client.scope?.split(" ").filter(Boolean) ?? [],
              clientName: client.client_name,
              clientUri: client.client_uri,
            }
          : null;
      },
    };

    const broker = new OAuthBroker({
      issuer: ISSUER,
      resource: RESOURCE,
      authorizationEndpoint: `${ISSUER}/authorize`,
      tokenEndpoint: `${ISSUER}/token`,
      jwksUri: `${ISSUER}/.well-known/jwks.json`,
      scopesSupported: ["mcp"],
      google: {
        clientId: GOOGLE_CLIENT_ID,
        authorizationEndpoint: GOOGLE_AUTHORIZATION_ENDPOINT,
        callbackUri: GOOGLE_CALLBACK,
        jwks: [googlePublicJwk],
      },
      signing: {
        algorithm: "RS256",
        keyId: "broker-key",
        privateKey: brokerPrivateKey,
        publicJwk: brokerPublicJwk,
      },
      clients,
      store: brokerStore,
      exchangeGoogleCode,
      now: () => current,
    });

    const routeOptions = {
      broker,
      registration: registry,
      googleCallbackUri: GOOGLE_CALLBACK,
      // Trivial always-"allowed" admission hooks so the rate-limit seams are
      // exercised without pulling in a durable store.
      registrationRateLimitKey: () => "test-caller",
      authorizationRateLimitKey: () => "test-caller",
      consumeAuthorizationAttempt: () => Promise.resolve<"allowed" | "limited">("allowed"),
    };
    const handler = createAuthorizationServerRouteHandler(routeOptions);

    // 2a. Authorization-server metadata discovery.
    const metadataResponse = await handler(
      new Request(`${ISSUER}/.well-known/oauth-authorization-server`),
    );
    expect(metadataResponse.status).toBe(200);
    const metadata = (await metadataResponse.json()) as Record<string, unknown>;
    expect(CONFIGURED_ISSUER.endsWith("/")).toBe(true);
    expect(metadata.issuer).toBe(ISSUER);
    expect(metadata.registration_endpoint).toBe(`${ISSUER}/register`);
    const resourceMetadataResponse = await handler(
      new Request("https://mcp.example.com/.well-known/oauth-protected-resource/mcp"),
    );
    expect(await resourceMetadataResponse.json()).toMatchObject({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
    });

    // 2b. Dynamic client registration (constrained DCR).
    const registerResponse = await handler(
      new Request(`${ISSUER}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: [REDIRECT_URI],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope: "mcp",
          client_name: "Codex",
        }),
      }),
    );
    expect(registerResponse.status).toBe(201);
    const registered = (await registerResponse.json()) as {
      client_id: string;
      token_endpoint_auth_method: string;
    };
    const clientId = registered.client_id;
    expect(clientId).toBeString();
    // Public client: no secret is ever issued.
    expect(registered.token_endpoint_auth_method).toBe("none");

    // 2c. /authorize with PKCE S256 renders the consent page carrying the
    //     broker-to-Google authorization URL (state + nonce live inside it).
    const authorizeUrl = new URL(`${ISSUER}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("resource", RESOURCE);
    authorizeUrl.searchParams.set("scope", "mcp");
    authorizeUrl.searchParams.set("code_challenge", CHALLENGE);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", "opaque-client-state");
    const authorizeResponse = await handler(new Request(authorizeUrl.toString()));
    expect(authorizeResponse.status).toBe(200);
    const consentHtml = await authorizeResponse.text();
    const consentMatch = /<a href="([^"]+)">Continue with Google<\/a>/u.exec(consentHtml);
    const googleAuthorizationUrl = new URL(unescapeHtml(consentMatch?.[1] ?? ""));
    expect(googleAuthorizationUrl.origin + googleAuthorizationUrl.pathname).toBe(
      GOOGLE_AUTHORIZATION_ENDPOINT,
    );
    const transactionState = googleAuthorizationUrl.searchParams.get("state") ?? "";
    capturedGoogleNonce = googleAuthorizationUrl.searchParams.get("nonce") ?? "";
    expect(transactionState).toBeString();
    expect(capturedGoogleNonce).toBeString();

    // 2d. Upstream Google callback: the broker verifies the nonce-bound identity
    //     token and redirects the client back with its own authorization code.
    const callbackUrl = new URL(GOOGLE_CALLBACK);
    callbackUrl.searchParams.set("state", transactionState);
    callbackUrl.searchParams.set("code", "google-authorization-code");
    const callbackResponse = await handler(new Request(callbackUrl.toString()));
    expect(callbackResponse.status).toBe(302);
    const clientRedirect = new URL(callbackResponse.headers.get("location") ?? "");
    expect(clientRedirect.origin + clientRedirect.pathname).toBe(REDIRECT_URI);
    expect(clientRedirect.searchParams.get("state")).toBe("opaque-client-state");
    const authorizationCode = clientRedirect.searchParams.get("code") ?? "";
    expect(authorizationCode).toBeString();

    // 2e. /token exchange with the PKCE verifier.
    const tokenResponse = await handler(tokenRequest(authorizationCode, clientId));
    expect(tokenResponse.status).toBe(200);
    const tokenBodyText = await tokenResponse.text();
    const tokenBody = JSON.parse(tokenBodyText) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      scope: string;
    };

    // 3. Security assertions.
    expect(tokenBody.token_type).toBe("Bearer");
    const accessToken = tokenBody.access_token;
    const payload = decodeJwt(accessToken);
    expect(payload.aud).toBe(RESOURCE);
    expect(payload.iss).toBe(ISSUER);
    expect(payload.sub).toBe(GOOGLE_SUBJECT);

    // No upstream Google access_token / refresh_token / id_token is echoed to the
    // client anywhere in the token response.
    expect(tokenBodyText).not.toContain(UPSTREAM_SECRET_MARKER);
    expect(tokenBody.refresh_token).toBeString();
    expect(tokenBody).not.toHaveProperty("id_token");
    // The gateway token is a fresh at+jwt, not a pass-through of Google's token.
    expect(payload.iss).not.toBe("https://accounts.google.com");

    // The broker authorization code is single-use: a replayed /token fails.
    const replayResponse = await handler(tokenRequest(authorizationCode, clientId));
    expect(replayResponse.status).toBe(400);
    const replayBody = (await replayResponse.json()) as { error: string };
    expect(replayBody.error).toBe("invalid_grant");

    // The broker-to-Google transaction is single-use: replaying the callback fails.
    const replayCallback = await handler(new Request(callbackUrl.toString()));
    expect(replayCallback.status).toBe(400);

    // 4. Close the loop: the issued token authenticates at the /mcp seam via the
    //    same runtime authenticator, built from the broker's issuer profile and
    //    published JWKS.
    const authenticate = createRuntimeAuthenticator({
      issuers: [brokerTrustedIssuer(broker.jwks().keys)],
    });
    const identity = await authenticate(accessToken);
    expect(identity.issuer).toBe(ISSUER);
    expect(identity.subject).toBe(GOOGLE_SUBJECT);
    expect(identity.email).toBe(GOOGLE_EMAIL);
    expect(identity.profile).toBe("mcp-oauth-broker");

    // 4b. Exercise the real /mcp request handlers, not just the authenticator.
    //     Neither provider is connected, so initialization succeeds and each
    //     wrapper exposes only its intended authentication/status surface.
    const googleHandler = createRuntimeWrapperHandler({
      config: {
        gwsBinary: "/unused-before-provider-consent",
        hop1Issuers: [],
        oauth: {
          clientId: GOOGLE_CLIENT_ID,
          clientSecret: "google-client-secret",
          redirectUri: "https://mcp.example.com/oauth/google/callback",
          tokenEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
        },
      },
      tokenStore: new InMemoryOAuthTokenStore(),
      issuers: [brokerTrustedIssuer(broker.jwks().keys)],
      providerOAuth: {
        scopes: ["https://www.googleapis.com/auth/drive"],
        stateStore: new InMemoryOAuthStateStore(),
      },
    });
    const githubHandler = createGithubMcpProxyHandler({
      upstreamUrl: "http://github-mcp:8082/mcp",
      authenticate,
      resolveGithubToken: () => Promise.resolve(undefined),
      getOAuthStatus: () =>
        Promise.resolve({
          connected: false,
          scopesRequired: ["user:email"],
          scopesGranted: [],
          missingScopes: ["user:email"],
        }),
      startOAuth: () =>
        Promise.resolve({ authorizationUrl: "https://github.com/login/oauth/authorize" }),
      githubScopes: ["user:email"],
      fetch: () => Promise.reject(new Error("upstream must not run before provider consent")),
    });

    await expectPreConsentMcpSurface(googleHandler, accessToken, [
      "google_oauth_status",
      "google_oauth_start",
    ]);
    await expectPreConsentMcpSurface(githubHandler, accessToken, [
      "github_oauth_status",
      "github_oauth_start",
    ]);

    const unknownKeys = await generateKeyPair("RS256");
    const invalidTokens = [
      await brokerAccessToken({ issuer: "https://wrong.example.com/oauth" }),
      await brokerAccessToken({ audience: "https://mcp.example.com/wrong" }),
      await brokerAccessToken({ privateKey: unknownKeys.privateKey, kid: "unknown-key" }),
      await brokerAccessToken({ expirationTime: "1 second ago", issuedAt: "2 minutes ago" }),
    ];
    for (const invalidToken of invalidTokens) {
      for (const wrapper of [googleHandler, githubHandler]) {
        const response = await mcpRequest(wrapper, invalidToken, {
          jsonrpc: "2.0",
          id: "invalid",
          method: "initialize",
        });
        expect(response.status).toBe(401);
      }
    }

    // 5. Codex/RMCP refreshes near expiry with the exact resource and granted
    //    scope, receives a rotated credential, and can use the renewed token.
    current += 301_000;
    expect(
      jwtVerify(accessToken, brokerPublicJwk, {
        issuer: ISSUER,
        audience: RESOURCE,
        algorithms: ["RS256"],
        currentDate: new Date(current),
      }),
    ).rejects.toThrow();
    const refreshResponse = await handler(refreshRequest(tokenBody.refresh_token, clientId));
    expect(refreshResponse.status).toBe(200);
    const refreshed = (await refreshResponse.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
    };
    expect(refreshed.refresh_token).toBeString();
    expect(refreshed.refresh_token).not.toBe(tokenBody.refresh_token);
    expect(refreshed.expires_in).toBe(300);
    expect(refreshed.scope).toBe("mcp");
    expect(decodeJwt(refreshed.access_token)).toMatchObject({
      aud: RESOURCE,
      iss: ISSUER,
      sub: GOOGLE_SUBJECT,
      email: GOOGLE_EMAIL,
      scope: "mcp",
    });
    const renewedIdentity = await authenticate(refreshed.access_token);
    expect(renewedIdentity.subject).toBe(GOOGLE_SUBJECT);

    const refreshReplay = await handler(refreshRequest(tokenBody.refresh_token, clientId));
    expect(refreshReplay.status).toBe(400);
    expect(await refreshReplay.json()).toMatchObject({ error: "invalid_grant" });
  });
});

function tokenRequest(code: string, clientId: string): Request {
  return new Request(`${ISSUER}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      resource: RESOURCE,
      code_verifier: VERIFIER,
    }).toString(),
  });
}

function refreshRequest(refreshToken: string, clientId: string): Request {
  return new Request(`${ISSUER}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      resource: RESOURCE,
      scope: "mcp",
    }).toString(),
  });
}

function brokerTrustedIssuer(jwks: JWK[]): RuntimeTrustedIssuer {
  return {
    profile: {
      name: "mcp-oauth-broker",
      issuer: ISSUER,
      audiences: [RESOURCE],
      allowedAlgorithms: ["RS256"],
      emailClaim: "email",
      subjectClaim: "sub",
    },
    jwksProvider: () => Promise.resolve(jwks),
  };
}

async function brokerAccessToken(
  overrides: {
    issuer?: string;
    audience?: string;
    privateKey?: CryptoKey;
    kid?: string;
    issuedAt?: string;
    expirationTime?: string;
  } = {},
): Promise<string> {
  return new SignJWT({ email: GOOGLE_EMAIL, scope: "mcp" })
    .setProtectedHeader({ alg: "RS256", kid: overrides.kid ?? "broker-key", typ: "at+jwt" })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? RESOURCE)
    .setSubject(GOOGLE_SUBJECT)
    .setIssuedAt(overrides.issuedAt ?? "1 minute ago")
    .setExpirationTime(overrides.expirationTime ?? "5 minutes")
    .sign(overrides.privateKey ?? brokerPrivateKey);
}

async function expectPreConsentMcpSurface(
  handler: (request: Request) => Promise<Response>,
  accessToken: string,
  expectedTools: string[],
): Promise<void> {
  const initialize = await mcpRequest(handler, accessToken, {
    jsonrpc: "2.0",
    id: "initialize",
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {} },
  });
  expect(initialize.status).toBe(200);
  expect(await initialize.json()).toMatchObject({
    jsonrpc: "2.0",
    id: "initialize",
    result: { capabilities: { tools: {} } },
  });

  const tools = await mcpRequest(handler, accessToken, {
    jsonrpc: "2.0",
    id: "tools",
    method: "tools/list",
  });
  expect(tools.status).toBe(200);
  const body = (await tools.json()) as { result: { tools: { name: string }[] } };
  expect(body.result.tools.map((tool) => tool.name)).toEqual(expectedTools);
}

function mcpRequest(
  handler: (request: Request) => Promise<Response>,
  accessToken: string,
  body: unknown,
): Promise<Response> {
  return handler(
    new Request("http://wrapper/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify(body),
    }),
  );
}
