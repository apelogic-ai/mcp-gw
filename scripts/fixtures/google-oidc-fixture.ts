#!/usr/bin/env bun

import { createHash, randomBytes } from "node:crypto";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

interface AuthorizationRecord {
  challenge: string;
  clientId: string;
  nonce: string;
  redirectUri: string;
}

const port = Number(process.env.PORT ?? "38084");
const keyPair = await generateKeyPair("RS256", { extractable: true });
const publicJwk = {
  ...(await exportJWK(keyPair.publicKey)),
  alg: "RS256",
  kid: "google-oidc-fixture",
  use: "sig",
};
const authorizationCodes = new Map<string, AuthorizationRecord>();

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    if (url.pathname === "/jwks") {
      return Response.json({ keys: [publicJwk] });
    }
    if (
      request.method === "GET" &&
      (url.pathname === "/authorize" || url.pathname === "/o/oauth2/v2/auth")
    ) {
      const clientId = requiredParam(url.searchParams, "client_id");
      const redirectUri = requiredParam(url.searchParams, "redirect_uri");
      const state = requiredParam(url.searchParams, "state");
      const nonce = requiredParam(url.searchParams, "nonce");
      const challenge = requiredParam(url.searchParams, "code_challenge");
      if (
        url.searchParams.get("response_type") !== "code" ||
        url.searchParams.get("code_challenge_method") !== "S256"
      ) {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }
      const code = randomBytes(32).toString("base64url");
      authorizationCodes.set(code, { challenge, clientId, nonce, redirectUri });
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", state);
      return Response.redirect(callback.toString(), 302);
    }
    if (request.method === "POST" && url.pathname === "/token") {
      const params = new URLSearchParams(await request.text());
      const code = params.get("code") ?? "";
      const record = authorizationCodes.get(code);
      authorizationCodes.delete(code);
      const verifier = params.get("code_verifier") ?? "";
      if (
        params.get("grant_type") !== "authorization_code" ||
        !record ||
        params.get("client_id") !== record.clientId ||
        params.get("redirect_uri") !== record.redirectUri ||
        createHash("sha256").update(verifier).digest("base64url") !== record.challenge
      ) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      const issuedAt = Math.floor(Date.now() / 1_000);
      const idToken = await new SignJWT({
        email: "broker.user@example.com",
        email_verified: true,
        nonce: record.nonce,
      })
        .setProtectedHeader({ alg: "RS256", kid: "google-oidc-fixture" })
        .setIssuer("https://accounts.google.com")
        .setAudience(record.clientId)
        .setSubject("google-oidc-fixture-user")
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + 300)
        .sign(keyPair.privateKey);
      return Response.json({ id_token: idToken, token_type: "Bearer" });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`Google OIDC fixture listening on port ${String(port)}`);

function requiredParam(params: URLSearchParams, name: string): string {
  const value = params.get(name);
  if (!value) {
    throw new Error(`Missing OAuth parameter: ${name}`);
  }
  return value;
}
