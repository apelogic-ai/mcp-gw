import { beforeAll, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

import {
  validateHop1Jwt,
  validateHop1JwtForIssuers,
  type IssuerProfile,
  Hop1ValidationError,
} from "./hop1";

let privateKey: CryptoKey;
let publicJwk: JWK;

const googleProfile: IssuerProfile = {
  name: "google",
  issuer: "https://accounts.google.com",
  audiences: ["mcp-gateway-dev"],
  emailClaim: "email",
};

const oktaProfile: IssuerProfile = {
  name: "okta",
  issuer: "https://client.okta.example/oauth2/default",
  audiences: ["mcp-gateway-dev"],
  emailClaim: "preferred_username",
  subjectClaim: "sub",
};

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = {
    ...(await exportJWK(pair.publicKey)),
    alg: "RS256",
    kid: "test-key",
    use: "sig",
  };
});

async function signToken(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

async function expectHop1Rejection(
  token: string,
  profile: IssuerProfile,
  expectedMessage?: string,
): Promise<void> {
  expect.assertions(expectedMessage ? 2 : 1);

  try {
    await validateHop1Jwt(token, profile, [publicJwk]);
  } catch (error) {
    expect(error).toBeInstanceOf(Hop1ValidationError);
    if (expectedMessage) {
      expect((error as Error).message).toContain(expectedMessage);
    }
  }
}

describe("HOP-1 JWT validation", () => {
  test("accepts a valid Google OIDC token and extracts email identity", async () => {
    const token = await signToken({
      iss: "https://accounts.google.com",
      aud: "mcp-gateway-dev",
      sub: "google-subject",
      email: "user@example.com",
    });

    const identity = await validateHop1Jwt(token, googleProfile, [publicJwk]);

    expect(identity).toEqual({
      issuer: "https://accounts.google.com",
      subject: "google-subject",
      email: "user@example.com",
      profile: "google",
      claims: identity.claims,
    });
    expect(identity.claims.email).toBe("user@example.com");
  });

  test("supports Okta-shaped claim mapping without changing callers", async () => {
    const token = await signToken({
      iss: "https://client.okta.example/oauth2/default",
      aud: "mcp-gateway-dev",
      sub: "okta-subject",
      preferred_username: "user@example.com",
    });

    const identity = await validateHop1Jwt(token, oktaProfile, [publicJwk]);

    expect(identity).toMatchObject({
      issuer: "https://client.okta.example/oauth2/default",
      subject: "okta-subject",
      email: "user@example.com",
      profile: "okta",
    });
  });

  test("accepts multiple issuer profiles concurrently", async () => {
    const token = await signToken({
      iss: "https://partner.example.com",
      aud: "mcp-gateway-dev",
      sub: "partner-user",
      email: "user@example.com",
    });

    const identity = await validateHop1JwtForIssuers(token, [
      { profile: googleProfile, jwks: [publicJwk] },
      {
        profile: {
          name: "partner",
          issuer: "https://partner.example.com",
          audiences: ["mcp-gateway-dev"],
          emailClaim: "email",
          subjectClaim: "sub",
        },
        jwks: [publicJwk],
      },
    ]);

    expect(identity).toMatchObject({
      profile: "partner",
      issuer: "https://partner.example.com",
      subject: "partner-user",
      email: "user@example.com",
    });
  });

  test("rejects the wrong issuer", async () => {
    const token = await signToken({
      iss: "https://evil.example",
      aud: "mcp-gateway-dev",
      sub: "subject",
      email: "user@example.com",
    });

    await expectHop1Rejection(token, googleProfile);
  });

  test("rejects the wrong audience", async () => {
    const token = await signToken({
      iss: "https://accounts.google.com",
      aud: "other-audience",
      sub: "subject",
      email: "user@example.com",
    });

    await expectHop1Rejection(token, googleProfile);
  });

  test("rejects tokens without an email claim", async () => {
    const token = await signToken({
      iss: "https://accounts.google.com",
      aud: "mcp-gateway-dev",
      sub: "subject",
    });

    await expectHop1Rejection(token, googleProfile, "JWT missing required email claim: email");
  });
});
