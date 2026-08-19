import { beforeAll, describe, expect, test } from "bun:test";

import { exportJWK, generateKeyPair, type JWK } from "jose";

import {
  createAuthorizationBrokerRuntime,
  exchangeGoogleAuthorizationCode,
} from "./broker-runtime";

let privateJwk: JWK;

beforeAll(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  privateJwk = {
    ...(await exportJWK(keys.privateKey)),
    kid: "active-key",
    alg: "RS256",
    use: "sig",
  };
});

describe("authorization broker runtime", () => {
  test("publishes coherent endpoints, enables constrained DCR, and trusts only public broker keys", async () => {
    const runtime = await createAuthorizationBrokerRuntime({
      config: {
        issuer: "https://auth.example.com",
        resource: "https://mcp.example.com/mcp",
        googleCallbackUri: "https://auth.example.com/oauth/google/broker/callback",
        signingJwksFile: "/mounted/signing-jwks.json",
        activeSigningKid: "active-key",
        scopes: ["mcp"],
        staticClients: [
          {
            clientId: "known-client",
            redirectUris: ["https://client.example.com/callback"],
            scopes: ["mcp"],
          },
        ],
        dcr: {},
      },
      google: {
        clientId: "google-client",
        clientSecret: "google-secret",
        redirectUri: "https://auth.example.com/oauth/google/callback",
        tokenEncryptionKey: Buffer.alloc(32, 1).toString("base64"),
      },
      queryClient: {
        query: () => Promise.reject(new Error("metadata must not access persistence")),
      },
      readSigningJwks: () => JSON.stringify({ keys: [privateJwk] }),
    });

    const metadataResponse = await runtime.handler(
      new Request("https://auth.example.com/.well-known/oauth-authorization-server"),
    );
    expect(await metadataResponse.json()).toMatchObject({
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
      registration_endpoint: "https://auth.example.com/register",
      jwks_uri: "https://auth.example.com/.well-known/jwks.json",
    });
    expect(runtime.publicPaths.has("/oauth/google/start")).toBe(false);
    expect(runtime.publicPaths.has("/oauth/google/broker/callback")).toBe(true);
    const trustedKeys = await runtime.issuer.jwksProvider();
    expect(trustedKeys).toHaveLength(1);
    expect(trustedKeys[0]).not.toHaveProperty("d");
    expect(runtime.issuer.profile).toMatchObject({
      issuer: "https://auth.example.com",
      audiences: ["https://mcp.example.com/mcp"],
      allowedAlgorithms: ["RS256"],
      subjectClaim: "sub",
    });
  });

  test("fails closed unless the active key is private RS256 signing material", async () => {
    let failure: unknown;
    try {
      await createAuthorizationBrokerRuntime({
        config: {
          issuer: "https://auth.example.com",
          resource: "https://mcp.example.com/mcp",
          googleCallbackUri: "https://auth.example.com/oauth/google/broker/callback",
          signingJwksFile: "/mounted/signing-jwks.json",
          activeSigningKid: "missing-key",
          scopes: ["mcp"],
          staticClients: [],
        },
        google: {
          clientId: "google-client",
          clientSecret: "google-secret",
          redirectUri: "https://auth.example.com/oauth/google/callback",
          tokenEncryptionKey: Buffer.alloc(32, 1).toString("base64"),
        },
        queryClient: { query: () => Promise.resolve({ rows: [] }) },
        readSigningJwks: () => JSON.stringify({ keys: [privateJwk] }),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "Active MCP broker key must be a private RS256 signing JWK",
    );
  });

  test("uses upstream client authentication but returns only the verified ID-token input", async () => {
    let requestBody = "";
    const result = await exchangeGoogleAuthorizationCode(
      {
        clientId: "google-client",
        clientSecret: "google-secret",
        redirectUri: "https://unused.example/callback",
        tokenEncryptionKey: Buffer.alloc(32, 1).toString("base64"),
      },
      {
        code: "google-code",
        codeVerifier: "verifier",
        redirectUri: "https://auth.example.com/oauth/google/broker/callback",
      },
      (_url, init) => {
        if (!(init?.body instanceof URLSearchParams)) {
          throw new Error("Expected form-encoded Google exchange body");
        }
        requestBody = init.body.toString();
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id_token: "signed-google-id-token",
              access_token: "must-not-leak",
              refresh_token: "must-not-leak",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      },
    );

    expect(result).toEqual({ idToken: "signed-google-id-token" });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(new URLSearchParams(requestBody).get("client_secret")).toBe("google-secret");
    expect(new URLSearchParams(requestBody).get("redirect_uri")).toBe(
      "https://auth.example.com/oauth/google/broker/callback",
    );
    expect(new URLSearchParams(requestBody).get("code_verifier")).toBe("verifier");
  });
});
