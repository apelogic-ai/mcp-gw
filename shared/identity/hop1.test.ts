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
let disallowedPrivateKey: CryptoKey;
let disallowedPublicJwk: JWK;

const fixtureProfile: IssuerProfile = {
  name: "fixture-primary",
  issuer: "https://identity.example.com",
  audiences: ["mcp-gateway-dev"],
  allowedAlgorithms: ["EdDSA"],
  emailClaim: "email",
};

const alternateProfile: IssuerProfile = {
  name: "fixture-alternate",
  issuer: "https://alternate.identity.example.com",
  audiences: ["mcp-gateway-dev"],
  allowedAlgorithms: ["EdDSA"],
  emailClaim: "preferred_username",
  subjectClaim: "sub",
};

beforeAll(async () => {
  const pair = await generateKeyPair("EdDSA", { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = {
    ...(await exportJWK(pair.publicKey)),
    alg: "EdDSA",
    kid: "test-key",
    use: "sig",
  };
  const disallowedPair = await generateKeyPair("RS256", { extractable: true });
  disallowedPrivateKey = disallowedPair.privateKey;
  disallowedPublicJwk = {
    ...(await exportJWK(disallowedPair.publicKey)),
    kid: "disallowed-key",
    use: "sig",
  };
});

async function signToken(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: "test-key" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

async function expectHop1Rejection(
  token: string,
  profile: IssuerProfile,
  expectedMessage?: string,
  jwks: JWK[] = [publicJwk],
): Promise<void> {
  expect.assertions(expectedMessage ? 2 : 1);

  try {
    await validateHop1Jwt(token, profile, jwks);
  } catch (error) {
    expect(error).toBeInstanceOf(Hop1ValidationError);
    if (expectedMessage) {
      expect((error as Error).message).toContain(expectedMessage);
    }
  }
}

describe("HOP-1 JWT validation", () => {
  test("accepts a valid token from a generic configured issuer", async () => {
    const token = await signToken({
      iss: fixtureProfile.issuer,
      aud: "mcp-gateway-dev",
      sub: "fixture-subject",
      email: "user@example.com",
    });

    const identity = await validateHop1Jwt(token, fixtureProfile, [publicJwk]);

    expect(identity).toEqual({
      issuer: fixtureProfile.issuer,
      subject: "fixture-subject",
      email: "user@example.com",
      profile: fixtureProfile.name,
      claims: identity.claims,
    });
    expect(identity.claims.email).toBe("user@example.com");
  });

  test("supports alternate claim mapping without changing callers", async () => {
    const token = await signToken({
      iss: alternateProfile.issuer,
      aud: "mcp-gateway-dev",
      sub: "okta-subject",
      preferred_username: "user@example.com",
    });

    const identity = await validateHop1Jwt(token, alternateProfile, [publicJwk]);

    expect(identity).toMatchObject({
      issuer: alternateProfile.issuer,
      subject: "okta-subject",
      email: "user@example.com",
      profile: alternateProfile.name,
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
      { profile: fixtureProfile, jwks: [publicJwk] },
      {
        profile: {
          name: "partner",
          issuer: "https://partner.example.com",
          audiences: ["mcp-gateway-dev"],
          allowedAlgorithms: ["EdDSA"],
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

  test("rejects a valid signature made with an algorithm outside the issuer allowlist", async () => {
    const token = await new SignJWT({
      iss: fixtureProfile.issuer,
      aud: "mcp-gateway-dev",
      sub: "subject",
      email: "user@example.com",
    })
      .setProtectedHeader({ alg: "RS256", kid: "disallowed-key" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(disallowedPrivateKey);

    await expectHop1Rejection(token, fixtureProfile, undefined, [disallowedPublicJwk]);
  });

  test("rejects the wrong issuer", async () => {
    const token = await signToken({
      iss: "https://evil.example",
      aud: "mcp-gateway-dev",
      sub: "subject",
      email: "user@example.com",
    });

    await expectHop1Rejection(token, fixtureProfile);
  });

  test("rejects the wrong audience", async () => {
    const token = await signToken({
      iss: fixtureProfile.issuer,
      aud: "other-audience",
      sub: "subject",
      email: "user@example.com",
    });

    await expectHop1Rejection(token, fixtureProfile);
  });

  test("rejects tokens without an email claim", async () => {
    const token = await signToken({
      iss: fixtureProfile.issuer,
      aud: "mcp-gateway-dev",
      sub: "subject",
    });

    await expectHop1Rejection(token, fixtureProfile, "JWT missing required email claim: email");
  });
});
