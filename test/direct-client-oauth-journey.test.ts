import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { decodeJwt, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

import {
  InMemoryAuthorizationBrokerStore,
  OAuthBroker,
  type BrokerClientRegistry,
  type GoogleTokenExchangeResult,
} from "../shared/oauth/authorization-broker";
import { ConstrainedDcrRegistry, InMemoryDcrRegistrationStore } from "../shared/oauth/dcr";
import { createAuthorizationServerRouteHandler } from "../servers/google-workspace/wrapper/src/authorization-routes";
import { createRuntimeAuthenticator } from "../servers/google-workspace/wrapper/src/runtime";

// End-to-end journey for a "direct MCP client" (the runbook's neutral term for a
// client that drives OAuth itself, Claude-style). It stitches the per-stage
// broker units into one flow: DCR registration -> /authorize consent -> upstream
// Google identity callback -> /token -> the issued gateway token being accepted
// by the same runtime authenticator that guards /mcp.

const NOW = 1_800_000_000_000;
const ISSUER = "https://auth.example.com";
const RESOURCE = "https://mcp.example.com/mcp";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
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
  test("registers, authorizes, exchanges a code, and produces an /mcp-accepted token", async () => {
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
      now: () => NOW,
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
    expect(metadata.issuer).toBe(ISSUER);
    expect(metadata.registration_endpoint).toBe(`${ISSUER}/register`);

    // 2b. Dynamic client registration (constrained DCR).
    const registerResponse = await handler(
      new Request(`${ISSUER}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: [REDIRECT_URI],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope: "mcp",
          client_name: "Direct MCP Client",
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
    expect(tokenBody).not.toHaveProperty("refresh_token");
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
      issuers: [
        {
          profile: {
            name: "mcp-oauth-broker",
            issuer: ISSUER,
            audiences: [RESOURCE],
            allowedAlgorithms: ["RS256"],
            emailClaim: "email",
            subjectClaim: "sub",
          },
          jwksProvider: () => Promise.resolve(broker.jwks().keys),
        },
      ],
    });
    const identity = await authenticate(accessToken);
    expect(identity.issuer).toBe(ISSUER);
    expect(identity.subject).toBe(GOOGLE_SUBJECT);
    expect(identity.email).toBe(GOOGLE_EMAIL);
    expect(identity.profile).toBe("mcp-oauth-broker");
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
