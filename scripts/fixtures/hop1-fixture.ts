#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

interface Args {
  port: number;
  issuer: string;
  audience: string;
  tokenFile: string;
  email: string;
}

const args = parseArgs(process.argv.slice(2));
const keyPair = await generateKeyPair("RS256", { extractable: true });
const wrongAlgorithmKeyPair = await generateKeyPair("ES256", { extractable: true });
const invalidKeyPair = await generateKeyPair("RS256");
const publicJwk = await exportJWK(keyPair.publicKey);
const wrongAlgorithmPublicJwk = await exportJWK(wrongAlgorithmKeyPair.publicKey);
const kid = "local-hop1";
const jwks = {
  keys: [
    {
      ...publicJwk,
      kid,
      alg: "RS256",
      use: "sig",
    },
    {
      ...wrongAlgorithmPublicJwk,
      kid: "wrong-algorithm-key",
      alg: "ES256",
      use: "sig",
    },
  ],
};

const token = await signToken({});
const expiredToken = await signToken({ expirationTime: Math.floor(Date.now() / 1000) - 60 });
const missingExpirationToken = await signToken({ omitExpiration: true });
const wrongIssuerToken = await signToken({ issuer: `${args.issuer}/wrong` });
const wrongAudienceToken = await signToken({ audience: `${args.audience}/wrong` });
const invalidSignatureToken = await signToken({ privateKey: invalidKeyPair.privateKey });
const wrongAlgorithmToken = await signToken({
  algorithm: "ES256",
  kid: "wrong-algorithm-key",
  privateKey: wrongAlgorithmKeyPair.privateKey,
});
const notBeforeToken = await signToken({ notBefore: Math.floor(Date.now() / 1000) + 300 });

await Promise.all([
  writeFile(args.tokenFile, token, "utf8"),
  writeFile(`${args.tokenFile}.expired`, expiredToken, "utf8"),
  writeFile(`${args.tokenFile}.missing-expiration`, missingExpirationToken, "utf8"),
  writeFile(`${args.tokenFile}.wrong-issuer`, wrongIssuerToken, "utf8"),
  writeFile(`${args.tokenFile}.wrong-audience`, wrongAudienceToken, "utf8"),
  writeFile(`${args.tokenFile}.invalid-signature`, invalidSignatureToken, "utf8"),
  writeFile(`${args.tokenFile}.wrong-algorithm`, wrongAlgorithmToken, "utf8"),
  writeFile(`${args.tokenFile}.not-before`, notBeforeToken, "utf8"),
]);

Bun.serve({
  port: args.port,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/jwks.json") {
      return Response.json(jwks);
    }

    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: args.issuer,
        token_endpoint: `${args.issuer}/token`,
        jwks_uri: `${args.issuer}/.well-known/jwks.json`,
        grant_types_supported: ["client_credentials"],
      });
    }

    if (request.method === "POST" && url.pathname === "/token") {
      return Response.json({
        access_token: token,
        token_type: "Bearer",
        expires_in: 600,
      });
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`HOP-1 fixture listening on ${args.issuer}`);

interface TokenOverrides {
  algorithm?: "RS256" | "ES256";
  audience?: string;
  expirationTime?: number | string;
  issuer?: string;
  kid?: string;
  notBefore?: number | string;
  omitExpiration?: boolean;
  privateKey?: CryptoKey;
}

async function signToken(overrides: TokenOverrides): Promise<string> {
  const tokenBuilder = new SignJWT({ email: args.email })
    .setProtectedHeader({ alg: overrides.algorithm ?? "RS256", kid: overrides.kid ?? kid })
    .setIssuer(overrides.issuer ?? args.issuer)
    .setSubject("local-hop1-user")
    .setAudience(overrides.audience ?? args.audience)
    .setJti(randomUUID())
    .setIssuedAt()
    .setNotBefore(overrides.notBefore ?? 0);

  if (!overrides.omitExpiration) {
    tokenBuilder.setExpirationTime(overrides.expirationTime ?? "10m");
  }

  return tokenBuilder.sign(overrides.privateKey ?? keyPair.privateKey);
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error(`Invalid argument pair near ${key ?? "<end>"}`);
    }
    values.set(key.slice(2), value);
  }

  return {
    port: Number(required(values, "port")),
    issuer: required(values, "issuer"),
    audience: required(values, "audience"),
    tokenFile: required(values, "token-file"),
    email: values.get("email") ?? "local.user@example.com",
  };
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) {
    throw new Error(`Missing required arg: --${key}`);
  }

  return value;
}
