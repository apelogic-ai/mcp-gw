import { beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

import {
  InMemoryOAuthStateStore,
  InMemoryOAuthTokenStore,
} from "../../../../shared/oauth/memory-store";
import { completeGoogleOAuth, startGoogleOAuth } from "../../../../shared/oauth/google";
import { createRuntimeAuthenticator, createRuntimeWrapperHandler } from "./runtime";

let privateKey: CryptoKey;
let publicJwk: JWK;

const tokenEncryptionKey = Buffer.alloc(32, 9).toString("base64");
const hop1 = {
  name: "google",
  issuer: "https://accounts.google.com",
  audiences: ["mcp-gateway-dev"],
  emailClaim: "email",
};

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = {
    ...(await exportJWK(pair.publicKey)),
    alg: "RS256",
    kid: "runtime-key",
    use: "sig",
  };
});

async function signHop1Token(
  overrides: { iss?: string; aud?: string; sub?: string; email?: string } = {},
): Promise<string> {
  return new SignJWT({
    iss: overrides.iss ?? "https://accounts.google.com",
    aud: overrides.aud ?? "mcp-gateway-dev",
    sub: overrides.sub ?? "google-subject",
    email: overrides.email ?? "user@example.com",
  })
    .setProtectedHeader({ alg: "RS256", kid: "runtime-key" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

describe("runtime wrapper wiring", () => {
  test("creates a JWKS-backed authenticator", async () => {
    const authenticate = createRuntimeAuthenticator({
      issuers: [{ profile: hop1, jwksProvider: () => Promise.resolve([publicJwk]) }],
    });

    const authenticated = await authenticate(await signHop1Token());

    expect(authenticated).toMatchObject({
      email: "user@example.com",
      subject: "google-subject",
    });
  });

  test("creates an authenticator for multiple HOP-1 issuers", async () => {
    const authenticate = createRuntimeAuthenticator({
      issuers: [
        { profile: hop1, jwksProvider: () => Promise.resolve([publicJwk]) },
        {
          profile: {
            name: "partner",
            issuer: "https://partner.example.com",
            audiences: ["mcp-gateway-dev"],
            emailClaim: "email",
          },
          jwksProvider: () => Promise.resolve([publicJwk]),
        },
      ],
    });

    const authenticated = await authenticate(
      await signHop1Token({
        iss: "https://partner.example.com",
        sub: "partner-user",
        email: "partner@example.com",
      }),
    );

    expect(authenticated).toMatchObject({
      profile: "partner",
      issuer: "https://partner.example.com",
      email: "partner@example.com",
      subject: "partner-user",
    });
  });

  test("serves an authenticated MCP tool call through token broker and gws executor", async () => {
    const tokenStore = new InMemoryOAuthTokenStore();
    const stateStore = new InMemoryOAuthStateStore();
    const identity = {
      profile: "google",
      issuer: "https://accounts.google.com",
      subject: "google-subject",
      email: "user@example.com",
      claims: {},
    };
    const oauth = {
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://dev.example.com/oauth/google/callback",
      tokenEncryptionKey,
    };
    const scopes = ["https://www.googleapis.com/auth/drive"];
    const started = await startGoogleOAuth({ identity, scopes, config: oauth, stateStore });
    await completeGoogleOAuth({
      identity,
      code: "auth-code",
      state: started.state,
      config: oauth,
      stateStore,
      tokenStore,
      fetch: (url) => {
        if (url.includes("oauth2.googleapis.com/token")) {
          return Promise.resolve(
            jsonResponse({
              access_token: "initial-access",
              refresh_token: "refresh-token",
              expires_in: 3600,
              scope: scopes.join(" "),
            }),
          );
        }

        return Promise.resolve(jsonResponse({ email: "user@example.com" }));
      },
    });

    const gwsBinary = await fakeGws();
    const handler = createRuntimeWrapperHandler({
      config: {
        gwsBinary,
        hop1,
        hop1Issuers: [
          {
            ...hop1,
            jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
          },
        ],
        oauth,
      },
      tokenStore,
      issuers: [{ profile: hop1, jwksProvider: () => Promise.resolve([publicJwk]) }],
      fetch: (url) => {
        if (url.includes("oauth2.googleapis.com/token")) {
          return Promise.resolve(
            jsonResponse({
              access_token: "runtime-access",
              expires_in: 3600,
              scope: scopes.join(" "),
            }),
          );
        }

        return Promise.resolve(jsonResponse({ email: "user@example.com" }));
      },
    });

    const response = await handler(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${await signHop1Token()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "call",
          method: "tools/call",
          params: {
            name: "google_drive_files_list",
            arguments: { pageSize: 3 },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: "call",
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                argv: [
                  "drive",
                  "files",
                  "list",
                  "--params",
                  JSON.stringify({
                    includeItemsFromAllDrives: true,
                    supportsAllDrives: true,
                    pageSize: 3,
                  }),
                  "--format",
                  "json",
                ],
                token: "runtime-access",
              },
              null,
              2,
            ),
          },
        ],
      },
    });
  });

  test("creates YAML, OPA policy, and JSONL audit sinks from runtime config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-gw-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    const policyPath = join(dir, "google-workspace-policy.yaml");
    await writeFile(
      policyPath,
      `
default: allow
rules:
  - effect: deny
    reason: deletes disabled by YAML policy
    match:
      actionClass: destructive
`,
      "utf8",
    );

    const handler = createRuntimeWrapperHandler({
      config: {
        gwsBinary: await fakeGws(),
        hop1,
        hop1Issuers: [
          {
            ...hop1,
            jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
          },
        ],
        oauth: {
          clientId: "client-id",
          clientSecret: "client-secret",
          redirectUri: "https://dev.example.com/oauth/google/callback",
          tokenEncryptionKey,
        },
        policy: {
          yamlFile: policyPath,
          opaUrl: "http://opa:8181/v1/data/mcp/allow",
        },
        audit: { jsonlPath: auditPath },
      },
      tokenStore: new InMemoryOAuthTokenStore(),
      issuers: [{ profile: hop1, jwksProvider: () => Promise.resolve([publicJwk]) }],
      fetch: () => Promise.reject(new Error("OPA should not run after YAML deny")),
    });

    expect.assertions(5);
    try {
      await handler(
        new Request("http://127.0.0.1/mcp", {
          method: "POST",
          headers: {
            authorization: `Bearer ${await signHop1Token()}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "call",
            method: "tools/call",
            params: {
              name: "google_drive_files_delete",
              arguments: { fileId: "file-123" },
            },
          }),
        }),
      );
    } catch (error) {
      expect((error as Error).message).toBe(
        "Policy denied google_drive_files_delete: deletes disabled by YAML policy",
      );
      const [event] = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(event).toBeDefined();
      if (!event) {
        throw new Error("expected audit event");
      }
      expect(event.status).toBe("deny");
      expect(event.tool).toBe("google_drive_files_delete");
      expect(event.error).toBe("deletes disabled by YAML policy");
    }
  });
});

async function fakeGws(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-gw-runtime-"));
  const path = join(dir, "gws");
  await writeFile(
    path,
    `#!/usr/bin/env bash
set -euo pipefail
node -e 'console.log(JSON.stringify({ argv: process.argv.slice(1), token: process.env.GOOGLE_WORKSPACE_CLI_TOKEN }))' "$@"
`,
    "utf8",
  );
  await chmod(path, 0o755);
  return path;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
