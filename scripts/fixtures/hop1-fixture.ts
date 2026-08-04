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
const invalidKeyPair = await generateKeyPair("RS256");
const publicJwk = await exportJWK(keyPair.publicKey);
const kid = "local-hop1";
const jwks = {
  keys: [
    {
      ...publicJwk,
      kid,
      alg: "RS256",
      use: "sig",
    },
  ],
};

const token = await signToken({});
const expiredToken = await signToken({ expirationTime: Math.floor(Date.now() / 1000) - 60 });
const wrongIssuerToken = await signToken({ issuer: `${args.issuer}/wrong` });
const wrongAudienceToken = await signToken({ audience: `${args.audience}/wrong` });
const invalidSignatureToken = await signToken({ privateKey: invalidKeyPair.privateKey });

await Promise.all([
  writeFile(args.tokenFile, token, "utf8"),
  writeFile(`${args.tokenFile}.expired`, expiredToken, "utf8"),
  writeFile(`${args.tokenFile}.wrong-issuer`, wrongIssuerToken, "utf8"),
  writeFile(`${args.tokenFile}.wrong-audience`, wrongAudienceToken, "utf8"),
  writeFile(`${args.tokenFile}.invalid-signature`, invalidSignatureToken, "utf8"),
]);

Bun.serve({
  port: args.port,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/jwks.json") {
      return Response.json(jwks);
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`HOP-1 fixture listening on ${args.issuer}`);

interface TokenOverrides {
  audience?: string;
  expirationTime?: number | string;
  issuer?: string;
  privateKey?: CryptoKey;
}

async function signToken(overrides: TokenOverrides): Promise<string> {
  return new SignJWT({ email: args.email })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(overrides.issuer ?? args.issuer)
    .setSubject("local-hop1-user")
    .setAudience(overrides.audience ?? args.audience)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(overrides.expirationTime ?? "10m")
    .sign(overrides.privateKey ?? keyPair.privateKey);
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
