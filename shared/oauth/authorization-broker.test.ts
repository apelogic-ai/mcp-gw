import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, jwtVerify, SignJWT, type JWK } from "jose";

import {
  InMemoryAuthorizationBrokerStore,
  OAuthBroker,
  OAuthBrokerError,
  verifyGoogleIdentityToken,
  type AuthorizationTransactionRecord,
  type BrokerAuthorizationCodeRecord,
} from "./authorization-broker";

const NOW = 1_800_000_000_000;
const ISSUER = "https://auth.example.com";
const RESOURCE = "https://mcp.example.com/mcp";
const CLIENT_ID = "claude-public-client";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const GOOGLE_CLIENT_ID = "google-client-id.apps.googleusercontent.com";
const GOOGLE_CALLBACK = "https://auth.example.com/oauth/google/callback";
const VERIFIER = "v".repeat(64);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

let brokerPrivateKey: CryptoKey;
let brokerPublicJwk: JWK;
let googlePrivateKey: CryptoKey;
let googlePublicJwk: JWK;
let googlePssPrivateKey: CryptoKey;
let googlePssPublicJwk: JWK;
let previousBrokerPublicJwk: JWK;

beforeAll(async () => {
  const brokerKeys = await generateKeyPair("RS256");
  brokerPrivateKey = brokerKeys.privateKey;
  brokerPublicJwk = { ...(await exportJWK(brokerKeys.publicKey)), kid: "broker-key" };
  const googleKeys = await generateKeyPair("RS256");
  googlePrivateKey = googleKeys.privateKey;
  googlePublicJwk = { ...(await exportJWK(googleKeys.publicKey)), kid: "google-key" };
  const googlePssKeys = await generateKeyPair("PS256");
  googlePssPrivateKey = googlePssKeys.privateKey;
  googlePssPublicJwk = { ...(await exportJWK(googlePssKeys.publicKey)), kid: "google-pss-key" };
  const previousBrokerKeys = await generateKeyPair("RS256");
  previousBrokerPublicJwk = {
    ...(await exportJWK(previousBrokerKeys.publicKey)),
    kid: "previous-broker-key",
  };
});

function broker(
  store = new InMemoryAuthorizationBrokerStore(),
  exchangeGoogleCode?: (input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }) => Promise<{ idToken: string; accessToken?: string; refreshToken?: string }>,
): OAuthBroker {
  return new OAuthBroker({
    issuer: ISSUER,
    resource: RESOURCE,
    authorizationEndpoint: `${ISSUER}/authorize`,
    tokenEndpoint: `${ISSUER}/token`,
    jwksUri: `${ISSUER}/.well-known/jwks.json`,
    scopesSupported: ["mcp"],
    google: {
      clientId: GOOGLE_CLIENT_ID,
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      callbackUri: GOOGLE_CALLBACK,
      jwks: [googlePublicJwk],
    },
    signing: {
      algorithm: "RS256",
      keyId: "broker-key",
      privateKey: brokerPrivateKey,
      publicJwk: brokerPublicJwk,
    },
    clients: {
      get: (clientId) =>
        Promise.resolve(
          clientId === CLIENT_ID
            ? {
                clientId: CLIENT_ID,
                redirectUris: [REDIRECT_URI],
                scopes: ["mcp"],
              }
            : null,
        ),
    },
    store,
    exchangeGoogleCode:
      exchangeGoogleCode ??
      (() => Promise.reject(new Error("test must provide the Google exchange result"))),
    now: () => NOW,
  });
}

function authorizationRequest(overrides: Partial<Record<string, string>> = {}) {
  return {
    responseType: "code",
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    resource: RESOURCE,
    scope: "mcp",
    codeChallenge: CHALLENGE,
    codeChallengeMethod: "S256",
    state: "opaque-client-state",
    ...overrides,
  };
}

async function googleIdToken(
  nonce: string,
  claims: Record<string, unknown> = {},
  options: { algorithm?: "RS256" | "PS256"; key?: CryptoKey } = {},
): Promise<string> {
  const { iss, aud, sub, exp, ...payload } = claims;
  return new SignJWT({
    email: "person@example.com",
    email_verified: true,
    nonce,
    ...payload,
  })
    .setProtectedHeader({
      alg: options.algorithm ?? "RS256",
      kid: options.algorithm === "PS256" ? "google-pss-key" : "google-key",
    })
    .setIssuer(typeof iss === "string" ? iss : "https://accounts.google.com")
    .setAudience(typeof aud === "string" || Array.isArray(aud) ? aud : GOOGLE_CLIENT_ID)
    .setSubject(typeof sub === "string" ? sub : "google-subject")
    .setIssuedAt(Math.floor(NOW / 1000))
    .setExpirationTime(typeof exp === "number" ? exp : Math.floor(NOW / 1000) + 300)
    .sign(options.key ?? googlePrivateKey);
}

describe("OAuthBroker authorization transaction", () => {
  test("keeps client state, broker-to-Google state, nonce, and broker code distinct", async () => {
    let exchangeInput: { code: string; codeVerifier: string; redirectUri: string } | undefined;
    let nonce = "";
    const instance = broker(undefined, async (input) => {
      exchangeInput = input;
      return {
        idToken: await googleIdToken(nonce),
        accessToken: "must-not-leak",
        refreshToken: "must-not-leak",
      };
    });

    const started = await instance.beginAuthorization(authorizationRequest());
    const googleUrl = new URL(started.authorizationUrl);
    const transactionState = googleUrl.searchParams.get("state") ?? "";
    nonce = googleUrl.searchParams.get("nonce") ?? "";

    expect(googleUrl.searchParams.get("redirect_uri")).toBe(GOOGLE_CALLBACK);
    expect(googleUrl.searchParams.get("response_type")).toBe("code");
    expect(googleUrl.searchParams.get("scope")).toBe("openid email");
    expect(googleUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(transactionState).not.toBe("opaque-client-state");
    expect(nonce).not.toBe(transactionState);

    const completed = await instance.completeGoogleAuthorization({
      transactionState,
      googleCode: "google-authorization-code",
    });
    const clientRedirect = new URL(completed.redirectUrl);

    expect(exchangeInput?.code).toBe("google-authorization-code");
    expect(exchangeInput?.redirectUri).toBe(GOOGLE_CALLBACK);
    expect(exchangeInput?.codeVerifier).toBeString();
    expect(clientRedirect.origin + clientRedirect.pathname).toBe(REDIRECT_URI);
    expect(clientRedirect.searchParams.get("state")).toBe("opaque-client-state");
    expect(clientRedirect.searchParams.get("code")).toBe(completed.authorizationCode);
    expect(completed.authorizationCode).not.toBe("google-authorization-code");
    expect(JSON.stringify(completed)).not.toContain("must-not-leak");
  });

  test("stores only hashes of broker transaction state and authorization codes", async () => {
    const store = new RecordingBrokerStore();
    let nonce = "";
    const instance = broker(store, async () => ({ idToken: await googleIdToken(nonce) }));

    const started = await instance.beginAuthorization(authorizationRequest());
    const googleUrl = new URL(started.authorizationUrl);
    const transactionState = googleUrl.searchParams.get("state") ?? "";
    nonce = googleUrl.searchParams.get("nonce") ?? "";
    expect(store.transaction?.stateHash).toBe(
      createHash("sha256").update(transactionState).digest("base64url"),
    );
    expect(JSON.stringify(store.transaction)).not.toContain(transactionState);
    expect(store.transaction?.clientState).toBe("opaque-client-state");

    const completed = await instance.completeGoogleAuthorization({
      transactionState,
      googleCode: "google-code",
    });
    expect(store.authorizationCode?.codeHash).toBe(
      createHash("sha256").update(completed.authorizationCode).digest("base64url"),
    );
    expect(JSON.stringify(store.authorizationCode)).not.toContain(completed.authorizationCode);
  });

  test.each([
    ["unknown client", { clientId: "unknown" }, "invalid_client"],
    ["wrong redirect", { redirectUri: "https://attacker.example/callback" }, "invalid_request"],
    ["wrong resource", { resource: "https://other.example/mcp" }, "invalid_target"],
    ["implicit response", { responseType: "token" }, "unsupported_response_type"],
    ["plain PKCE", { codeChallengeMethod: "plain" }, "invalid_request"],
    ["malformed challenge", { codeChallenge: "short" }, "invalid_request"],
    ["unapproved scope", { scope: "mcp admin" }, "invalid_scope"],
    ["missing client state", { state: "" }, "invalid_request"],
    ["oversized client state", { state: "x".repeat(1025) }, "invalid_request"],
  ])("rejects %s before redirecting", async (_name, overrides, error) => {
    await expectBrokerError(broker().beginAuthorization(authorizationRequest(overrides)), error);
  });

  test("turns Google denial into a client denial and consumes the transaction", async () => {
    const instance = broker();
    const started = await instance.beginAuthorization(authorizationRequest());
    const transactionState = new URL(started.authorizationUrl).searchParams.get("state") ?? "";

    const denied = await instance.denyGoogleAuthorization({
      transactionState,
      error: "access_denied",
    });
    const redirect = new URL(denied.redirectUrl);
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("state")).toBe("opaque-client-state");
    await expectBrokerError(
      instance.denyGoogleAuthorization({ transactionState, error: "access_denied" }),
      "invalid_request",
    );
  });

  test("rejects an expired transaction", async () => {
    let current = NOW;
    const instance = new OAuthBroker({
      ...brokerOptions(),
      now: () => current,
      transactionTtlSeconds: 30,
    });
    const started = await instance.beginAuthorization(authorizationRequest());
    const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";
    current += 31_000;
    await expectBrokerError(
      instance.completeGoogleAuthorization({ transactionState: state, googleCode: "code" }),
      "invalid_request",
    );
  });
});

describe("OAuthBroker authorization-code exchange", () => {
  test("issues a short-lived MCP-audience token and no provider credentials", async () => {
    let nonce = "";
    const instance = broker(undefined, async () => ({
      idToken: await googleIdToken(nonce),
      accessToken: "google-access-token",
      refreshToken: "google-refresh-token",
    }));
    const started = await instance.beginAuthorization(authorizationRequest());
    nonce = new URL(started.authorizationUrl).searchParams.get("nonce") ?? "";
    const completed = await instance.completeGoogleAuthorization({
      transactionState: new URL(started.authorizationUrl).searchParams.get("state") ?? "",
      googleCode: "google-code",
    });

    const response = await instance.exchangeAuthorizationCode({
      grantType: "authorization_code",
      code: completed.authorizationCode,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      resource: RESOURCE,
      codeVerifier: VERIFIER,
    });
    expect(response.accessToken).toBeString();
    expect(response).toMatchObject({
      tokenType: "Bearer",
      expiresIn: 300,
      scope: "mcp",
    });
    expect(JSON.stringify(response)).not.toContain("google-");

    const claims = await jwtVerify(response.accessToken, brokerPublicJwk, {
      issuer: ISSUER,
      audience: RESOURCE,
      algorithms: ["RS256"],
      currentDate: new Date(NOW),
    });
    expect(claims.payload).toMatchObject({
      sub: "google-subject",
      email: "person@example.com",
      email_verified: true,
      identity_provider: "google",
      scope: "mcp",
    });
    expect(claims.payload.exp).toBe(Math.floor(NOW / 1000) + 300);

    await expectBrokerError(
      instance.exchangeAuthorizationCode({
        grantType: "authorization_code",
        code: completed.authorizationCode,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        resource: RESOURCE,
        codeVerifier: VERIFIER,
      }),
      "invalid_grant",
    );
  });

  test.each([
    ["grant", { grantType: "refresh_token" }, "unsupported_grant_type"],
    ["client", { clientId: "other-client" }, "invalid_grant"],
    ["redirect", { redirectUri: "https://attacker.example/callback" }, "invalid_grant"],
    ["resource", { resource: "https://other.example/mcp" }, "invalid_target"],
    ["verifier", { codeVerifier: "x".repeat(64) }, "invalid_grant"],
  ])("rejects a mismatched %s", async (_name, overrides, error) => {
    let nonce = "";
    const instance = broker(undefined, async () => ({ idToken: await googleIdToken(nonce) }));
    const started = await instance.beginAuthorization(authorizationRequest());
    nonce = new URL(started.authorizationUrl).searchParams.get("nonce") ?? "";
    const completed = await instance.completeGoogleAuthorization({
      transactionState: new URL(started.authorizationUrl).searchParams.get("state") ?? "",
      googleCode: "google-code",
    });
    const request = {
      grantType: "authorization_code",
      code: completed.authorizationCode,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      resource: RESOURCE,
      codeVerifier: VERIFIER,
      ...overrides,
    };
    await expectBrokerError(instance.exchangeAuthorizationCode(request), error);
  });

  test("rejects an expired authorization code", async () => {
    let current = NOW;
    let nonce = "";
    const instance = new OAuthBroker({
      ...brokerOptions(async () => ({ idToken: await googleIdToken(nonce) })),
      now: () => current,
      authorizationCodeTtlSeconds: 30,
    });
    const started = await instance.beginAuthorization(authorizationRequest());
    nonce = new URL(started.authorizationUrl).searchParams.get("nonce") ?? "";
    const completed = await instance.completeGoogleAuthorization({
      transactionState: new URL(started.authorizationUrl).searchParams.get("state") ?? "",
      googleCode: "google-code",
    });
    current += 31_000;
    await expectBrokerError(
      instance.exchangeAuthorizationCode({
        grantType: "authorization_code",
        code: completed.authorizationCode,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        resource: RESOURCE,
        codeVerifier: VERIFIER,
      }),
      "invalid_grant",
    );
  });

  test("rejects a code when its dynamic client has expired before exchange", async () => {
    let active = true;
    let nonce = "";
    const instance = new OAuthBroker({
      ...brokerOptions(async () => ({ idToken: await googleIdToken(nonce) })),
      clients: {
        get: () =>
          Promise.resolve(
            active ? { clientId: CLIENT_ID, redirectUris: [REDIRECT_URI], scopes: ["mcp"] } : null,
          ),
      },
      now: () => NOW,
    });
    const started = await instance.beginAuthorization(authorizationRequest());
    nonce = new URL(started.authorizationUrl).searchParams.get("nonce") ?? "";
    const completed = await instance.completeGoogleAuthorization({
      transactionState: new URL(started.authorizationUrl).searchParams.get("state") ?? "",
      googleCode: "google-code",
    });
    active = false;

    await expectBrokerError(
      instance.exchangeAuthorizationCode({
        grantType: "authorization_code",
        code: completed.authorizationCode,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        resource: RESOURCE,
        codeVerifier: VERIFIER,
      }),
      "invalid_grant",
    );
  });
});

describe("Google identity verification", () => {
  test("accepts the reviewed Google contract", async () => {
    const identity = await verifyGoogleIdentityToken(await googleIdToken("expected-nonce"), {
      clientId: GOOGLE_CLIENT_ID,
      expectedNonce: "expected-nonce",
      jwks: [googlePublicJwk],
      now: NOW,
    });
    expect(identity).toEqual({
      issuer: "https://accounts.google.com",
      subject: "google-subject",
      email: "person@example.com",
      emailVerified: true,
    });
  });

  test.each([
    ["issuer", { iss: "https://evil.example" }],
    ["legacy bare issuer", { iss: "accounts.google.com" }],
    ["audience", { aud: "different-client" }],
    ["authorized party", { azp: "different-client" }],
    ["nonce", { nonce: "wrong-nonce" }],
    ["subject", { sub: "" }],
    ["verified email", { email_verified: false }],
    ["email", { email: "" }],
    ["expiry", { exp: Math.floor(NOW / 1000) - 1 }],
  ])("rejects an invalid %s", async (_name, claims) => {
    await expectBrokerError(
      verifyGoogleIdentityToken(await googleIdToken("expected-nonce", claims), {
        clientId: GOOGLE_CLIENT_ID,
        expectedNonce: "expected-nonce",
        jwks: [googlePublicJwk],
        now: NOW,
      }),
      "invalid_grant",
    );
  });

  test("rejects a disallowed signing algorithm", async () => {
    const token = await googleIdToken(
      "expected-nonce",
      {},
      {
        algorithm: "PS256",
        key: googlePssPrivateKey,
      },
    );
    await expectBrokerError(
      verifyGoogleIdentityToken(token, {
        clientId: GOOGLE_CLIENT_ID,
        expectedNonce: "expected-nonce",
        jwks: [googlePssPublicJwk],
        now: NOW,
      }),
      "invalid_grant",
    );
  });

  test("rejects a token signed by an untrusted key", async () => {
    const token = await googleIdToken("expected-nonce", {}, { key: brokerPrivateKey });
    await expectBrokerError(
      verifyGoogleIdentityToken(token, {
        clientId: GOOGLE_CLIENT_ID,
        expectedNonce: "expected-nonce",
        jwks: [googlePublicJwk],
        now: NOW,
      }),
      "invalid_grant",
      "Google ID token verification failed",
    );
  });

  test("requires azp when a Google token has multiple audiences", async () => {
    const token = await googleIdToken("expected-nonce", {
      aud: [GOOGLE_CLIENT_ID, "another-audience"],
    });
    await expectBrokerError(
      verifyGoogleIdentityToken(token, {
        clientId: GOOGLE_CLIENT_ID,
        expectedNonce: "expected-nonce",
        jwks: [googlePublicJwk],
        now: NOW,
      }),
      "invalid_grant",
    );
  });

  test("requires an explicit expiration claim", async () => {
    const token = await new SignJWT({
      email: "person@example.com",
      email_verified: true,
      nonce: "expected-nonce",
    })
      .setProtectedHeader({ alg: "RS256", kid: "google-key" })
      .setIssuer("https://accounts.google.com")
      .setAudience(GOOGLE_CLIENT_ID)
      .setSubject("google-subject")
      .setIssuedAt(Math.floor(NOW / 1000))
      .sign(googlePrivateKey);
    await expectBrokerError(
      verifyGoogleIdentityToken(token, {
        clientId: GOOGLE_CLIENT_ID,
        expectedNonce: "expected-nonce",
        jwks: [googlePublicJwk],
        now: NOW,
      }),
      "invalid_grant",
    );
  });
});

describe("OAuth metadata", () => {
  test("publishes coherent authorization-server, protected-resource, and public JWKS metadata", () => {
    const instance = new OAuthBroker({
      ...brokerOptions(),
      signing: {
        ...brokerOptions().signing,
        verificationJwks: [
          { ...previousBrokerPublicJwk, alg: "RS256", use: "sig" },
          { ...brokerPublicJwk, d: "must-be-removed" },
        ],
      },
    });
    expect(instance.authorizationServerMetadata()).toEqual({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/.well-known/jwks.json`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });
    expect(instance.protectedResourceMetadata()).toEqual({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp"],
    });
    const [jwk, previous] = instance.jwks().keys;
    expect(jwk).toMatchObject({ kid: "broker-key", alg: "RS256", use: "sig" });
    expect(jwk?.d).toBeUndefined();
    expect(previous).toMatchObject({ kid: "previous-broker-key", alg: "RS256", use: "sig" });
    expect(instance.jwks().keys).toHaveLength(2);
    expect(instance.jwks().keys.every((key) => key.d === undefined)).toBe(true);
  });

  test.each([
    ["issuer", { issuer: "http://auth.example.com" }],
    ["private issuer", { issuer: "https://localhost" }],
    ["authorization endpoint", { authorizationEndpoint: "https://other.example.com/authorize" }],
    ["token endpoint", { tokenEndpoint: "http://auth.example.com/token" }],
    ["JWKS URI", { jwksUri: "https://other.example.com/jwks" }],
    [
      "Google endpoint",
      {
        google: {
          clientId: GOOGLE_CLIENT_ID,
          authorizationEndpoint: "https://evil.example/authorize",
          callbackUri: GOOGLE_CALLBACK,
          jwks: [googlePublicJwk],
        },
      },
    ],
    [
      "noncanonical Google endpoint",
      {
        google: {
          clientId: GOOGLE_CLIENT_ID,
          authorizationEndpoint: "https://accounts.google.com/not-the-oauth-endpoint",
          callbackUri: GOOGLE_CALLBACK,
          jwks: [googlePublicJwk],
        },
      },
    ],
    [
      "Google callback",
      {
        google: {
          clientId: GOOGLE_CLIENT_ID,
          authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
          callbackUri: "https://other.example.com/callback",
          jwks: [googlePublicJwk],
        },
      },
    ],
  ])("fails closed for an incoherent public %s configuration", (_name, override) => {
    expect(() => new OAuthBroker({ ...brokerOptions(), ...override })).toThrow();
  });
});

function brokerOptions(
  exchangeGoogleCode: (input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }) => Promise<{ idToken: string }> = () => Promise.reject(new Error("unused")),
) {
  return {
    issuer: ISSUER,
    resource: RESOURCE,
    authorizationEndpoint: `${ISSUER}/authorize`,
    tokenEndpoint: `${ISSUER}/token`,
    jwksUri: `${ISSUER}/.well-known/jwks.json`,
    scopesSupported: ["mcp"],
    google: {
      clientId: GOOGLE_CLIENT_ID,
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      callbackUri: GOOGLE_CALLBACK,
      jwks: [googlePublicJwk],
    },
    signing: {
      algorithm: "RS256" as const,
      keyId: "broker-key",
      privateKey: brokerPrivateKey,
      publicJwk: brokerPublicJwk,
    },
    clients: {
      get: (clientId: string) =>
        Promise.resolve(
          clientId === CLIENT_ID
            ? { clientId: CLIENT_ID, redirectUris: [REDIRECT_URI], scopes: ["mcp"] }
            : null,
        ),
    },
    store: new InMemoryAuthorizationBrokerStore(),
    exchangeGoogleCode,
  };
}

class RecordingBrokerStore extends InMemoryAuthorizationBrokerStore {
  transaction?: AuthorizationTransactionRecord;
  authorizationCode?: BrokerAuthorizationCodeRecord;

  override saveTransaction(record: AuthorizationTransactionRecord): Promise<void> {
    this.transaction = structuredClone(record);
    return super.saveTransaction(record);
  }

  override saveAuthorizationCode(record: BrokerAuthorizationCodeRecord): Promise<void> {
    this.authorizationCode = structuredClone(record);
    return super.saveAuthorizationCode(record);
  }
}

async function expectBrokerError(
  operation: Promise<unknown>,
  code: string,
  message?: string,
): Promise<void> {
  try {
    await operation;
    throw new Error("Expected OAuth broker operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(OAuthBrokerError);
    expect(error).toMatchObject({ code, ...(message === undefined ? {} : { message }) });
  }
}
