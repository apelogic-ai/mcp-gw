import { describe, expect, test } from "bun:test";

import type { Hop1Identity } from "../../../../shared/identity/hop1";
import { InMemoryAuditSink } from "../../../../shared/audit/audit";
import { createGoogleWorkspaceWrapperHandler, loadWrapperConfig } from "./app";

const identity: Hop1Identity = {
  profile: "google",
  issuer: "https://accounts.google.com",
  subject: "google-subject",
  email: "user@example.com",
  claims: {},
};

describe("Google Workspace wrapper app", () => {
  test("loads required config from environment", () => {
    const config = loadWrapperConfig({
      GOOGLE_OAUTH_CLIENT_ID: "client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
      GOOGLE_OAUTH_REDIRECT_URI: "https://dev.example.com/oauth/google/callback",
      GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      GWS_BINARY_PATH: "/usr/local/bin/gws",
      HOP1_ISSUER: "https://accounts.google.com",
      HOP1_AUDIENCE: "mcp-gateway-dev",
      HOP1_EMAIL_CLAIM: "email",
      HOP1_JWKS_URL: "https://www.googleapis.com/oauth2/v3/certs",
    });

    expect(config).toMatchObject({
      gwsBinary: "/usr/local/bin/gws",
      hop1: {
        issuer: "https://accounts.google.com",
        audiences: ["mcp-gateway-dev"],
        emailClaim: "email",
      },
      hop1Issuers: [
        {
          issuer: "https://accounts.google.com",
          jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
        },
      ],
      oauth: {
        clientId: "client-id",
      },
    });
  });

  test("loads multiple HOP-1 issuer profiles from JSON", () => {
    const config = loadWrapperConfig({
      GOOGLE_OAUTH_CLIENT_ID: "client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
      GOOGLE_OAUTH_REDIRECT_URI: "https://dev.example.com/oauth/google/callback",
      GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      GWS_BINARY_PATH: "/usr/local/bin/gws",
      HOP1_ISSUERS_JSON: JSON.stringify([
        {
          name: "google",
          issuer: "https://accounts.google.com",
          jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
          audiences: ["mcp-gateway-dev"],
          emailClaim: "email",
        },
        {
          name: "partner",
          issuer: "https://partner.example.com",
          jwksUrl: "https://partner.example.com/.well-known/jwks.json",
          audiences: ["mcp-gateway-dev"],
          emailClaim: "email",
          subjectClaim: "sub",
        },
      ]),
    });

    expect(config.hop1Issuers).toEqual([
      {
        name: "google",
        issuer: "https://accounts.google.com",
        jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
        audiences: ["mcp-gateway-dev"],
        emailClaim: "email",
      },
      {
        name: "partner",
        issuer: "https://partner.example.com",
        jwksUrl: "https://partner.example.com/.well-known/jwks.json",
        audiences: ["mcp-gateway-dev"],
        emailClaim: "email",
        subjectClaim: "sub",
      },
    ]);
  });

  test("loads optional policy and audit wiring from environment", () => {
    const config = loadWrapperConfig({
      GOOGLE_OAUTH_CLIENT_ID: "client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
      GOOGLE_OAUTH_REDIRECT_URI: "https://dev.example.com/oauth/google/callback",
      GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      GWS_BINARY_PATH: "/usr/local/bin/gws",
      HOP1_ISSUER: "https://accounts.google.com",
      HOP1_AUDIENCE: "mcp-gateway-dev",
      HOP1_EMAIL_CLAIM: "email",
      HOP1_JWKS_URL: "https://www.googleapis.com/oauth2/v3/certs",
      OPA_POLICY_URL: "http://opa:8181/v1/data/mcp/allow",
      GOOGLE_WORKSPACE_POLICY_FILE: "/etc/mcp-gw/google-workspace-policy.yaml",
      AUDIT_LOG_PATH: "/var/log/mcp-gw/audit.jsonl",
    });

    expect(config.policy).toEqual({
      opaUrl: "http://opa:8181/v1/data/mcp/allow",
      yamlFile: "/etc/mcp-gw/google-workspace-policy.yaml",
    });
    expect(config.audit).toEqual({ jsonlPath: "/var/log/mcp-gw/audit.jsonl" });
  });

  test("rejects incomplete config", () => {
    expect(() => loadWrapperConfig({})).toThrow("Missing required env var: GOOGLE_OAUTH_CLIENT_ID");
  });

  test("builds an authenticated MCP handler from injected runtime dependencies", async () => {
    const executed: unknown[] = [];
    const handler = createGoogleWorkspaceWrapperHandler({
      serverInfo: { name: "google-workspace-wrapper", version: "0.1.0" },
      authenticate: (token) => {
        expect(token).toBe("valid-token");
        return Promise.resolve(identity);
      },
      tokenBroker: {
        getAccessToken: (_identity, scopes) => {
          expect(scopes).toContain("https://www.googleapis.com/auth/drive");
          return Promise.resolve("google-access-token");
        },
      },
      executor: (request) => {
        executed.push(request);
        return Promise.resolve({ ok: true });
      },
    });

    const response = await handler(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer valid-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "call",
          method: "tools/call",
          params: {
            name: "google_drive_files_list",
            arguments: { pageSize: 5 },
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
            text: JSON.stringify({ ok: true }, null, 2),
          },
        ],
      },
    });
    expect(executed).toHaveLength(1);
  });

  test("resolves Google connection state per request and gates provider tools", async () => {
    let connected = false;
    const handler = createGoogleWorkspaceWrapperHandler({
      serverInfo: { name: "google-workspace-wrapper", version: "0.1.0" },
      authenticate: () => Promise.resolve(identity),
      getOAuthStatus: () =>
        Promise.resolve({
          connected,
          email: connected ? identity.email : undefined,
          scopesRequired: ["https://www.googleapis.com/auth/drive"],
          scopesGranted: connected ? ["https://www.googleapis.com/auth/drive"] : [],
          missingScopes: connected ? [] : ["https://www.googleapis.com/auth/drive"],
        }),
      startOAuth: () =>
        Promise.resolve({ authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth" }),
      tokenBroker: {
        getAccessToken: () => Promise.resolve("google-access-token"),
      },
      executor: () => Promise.resolve({ ok: true }),
    });

    const listTools = () =>
      handler(
        new Request("http://127.0.0.1/mcp", {
          method: "POST",
          headers: {
            authorization: "Bearer valid-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list" }),
        }),
      );

    const before = (await (await listTools()).json()) as {
      result: { tools: { name: string }[] };
    };
    expect(before.result.tools.map((tool) => tool.name)).toEqual([
      "google_oauth_status",
      "google_oauth_start",
    ]);

    connected = true;
    const after = (await (await listTools()).json()) as {
      result: { tools: { name: string }[] };
    };
    expect(after.result.tools.map((tool) => tool.name)).toContain("google_drive_files_list");
  });

  test("passes injected policy and audit sinks to request registries", async () => {
    const audit = new InMemoryAuditSink();
    const handler = createGoogleWorkspaceWrapperHandler({
      serverInfo: { name: "google-workspace-wrapper", version: "0.1.0" },
      authenticate: () => Promise.resolve(identity),
      audit,
      policy: {
        decide: () => Promise.resolve({ kind: "deny", reason: "delete disabled" }),
      },
      tokenBroker: {
        getAccessToken: () => Promise.reject(new Error("token lookup should not run")),
      },
      executor: () => Promise.reject(new Error("executor should not run")),
    });

    expect.assertions(4);
    try {
      await handler(
        new Request("http://127.0.0.1/mcp", {
          method: "POST",
          headers: {
            authorization: "Bearer valid-token",
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
        "Policy denied google_drive_files_delete: delete disabled",
      );
      expect(audit.events).toHaveLength(1);
      expect(audit.events[0]?.status).toBe("deny");
      expect(audit.events[0]?.tool).toBe("google_drive_files_delete");
    }
  });
});
