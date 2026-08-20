import { describe, expect, test } from "bun:test";

import { loadMainConfig } from "./main";

describe("wrapper main config", () => {
  test("requires a JWKS URL for runtime auth", () => {
    expect(() =>
      loadMainConfig({
        GOOGLE_OAUTH_CLIENT_ID: "client-id",
        GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
        GOOGLE_OAUTH_REDIRECT_URI: "https://dev.example.com/oauth/google/callback",
        GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
        GWS_BINARY_PATH: "/usr/local/bin/gws",
        HOP1_ISSUER: "https://accounts.google.com",
        HOP1_AUDIENCE: "mcp-gateway-dev",
        HOP1_EMAIL_CLAIM: "email",
        HOP1_ALLOWED_ALGORITHMS: "RS256",
      }),
    ).toThrow("Missing required env var: HOP1_JWKS_URL");
  });

  test("requires a token store DSN for runtime persistence", () => {
    expect(() =>
      loadMainConfig({
        GOOGLE_OAUTH_CLIENT_ID: "client-id",
        GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
        GOOGLE_OAUTH_REDIRECT_URI: "https://dev.example.com/oauth/google/callback",
        GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
        GWS_BINARY_PATH: "/usr/local/bin/gws",
        HOP1_ISSUER: "https://accounts.google.com",
        HOP1_AUDIENCE: "mcp-gateway-dev",
        HOP1_EMAIL_CLAIM: "email",
        HOP1_ALLOWED_ALGORITHMS: "RS256",
        HOP1_JWKS_URL: "https://www.googleapis.com/oauth2/v3/certs",
      }),
    ).toThrow("Missing required env var: TOKEN_STORE_DSN");
  });

  test("loads wrapper and runtime server settings", () => {
    expect(
      loadMainConfig({
        PORT: "9090",
        GOOGLE_OAUTH_CLIENT_ID: "client-id",
        GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
        GOOGLE_OAUTH_REDIRECT_URI: "https://dev.example.com/oauth/google/callback",
        GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
        GWS_BINARY_PATH: "/usr/local/bin/gws",
        HOP1_ISSUER: "https://accounts.google.com",
        HOP1_AUDIENCE: "mcp-gateway-dev",
        HOP1_EMAIL_CLAIM: "email",
        HOP1_ALLOWED_ALGORITHMS: "RS256",
        HOP1_JWKS_URL: "https://www.googleapis.com/oauth2/v3/certs",
        TOKEN_STORE_DSN: "postgres://mcp:mcp@token-store:5432/mcp",
      }),
    ).toMatchObject({
      port: 9090,
      tokenStoreDsn: "postgres://mcp:mcp@token-store:5432/mcp",
      wrapper: {
        gwsBinary: "/usr/local/bin/gws",
        hop1Issuers: [
          {
            issuer: "https://accounts.google.com",
            jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
          },
        ],
      },
    });
  });

  test("loads an operator-mounted PostgreSQL CA bundle path", () => {
    expect(
      loadMainConfig({
        GOOGLE_OAUTH_CLIENT_ID: "client-id",
        GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
        GOOGLE_OAUTH_REDIRECT_URI: "https://dev.example.com/oauth/google/callback",
        GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
        GWS_BINARY_PATH: "/usr/local/bin/gws",
        HOP1_ISSUER: "https://accounts.google.com",
        HOP1_AUDIENCE: "mcp-gateway-dev",
        HOP1_EMAIL_CLAIM: "email",
        HOP1_ALLOWED_ALGORITHMS: "RS256",
        HOP1_JWKS_URL: "https://www.googleapis.com/oauth2/v3/certs",
        TOKEN_STORE_DSN: "postgres://mcp:mcp@token-store:5432/mcp",
        POSTGRES_CA_BUNDLE_PATH: "/var/run/secrets/postgresql/ca.crt",
      }).postgresCaBundlePath,
    ).toBe("/var/run/secrets/postgresql/ca.crt");
  });

  test("default Google OAuth scopes use compact broad read/write consent", () => {
    const config = loadMainConfig({
      PORT: "9090",
      GOOGLE_OAUTH_CLIENT_ID: "client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
      GOOGLE_OAUTH_REDIRECT_URI: "https://dev.example.com/oauth/google/callback",
      GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      GWS_BINARY_PATH: "/usr/local/bin/gws",
      HOP1_ISSUER: "https://accounts.google.com",
      HOP1_AUDIENCE: "mcp-gateway-dev",
      HOP1_EMAIL_CLAIM: "email",
      HOP1_ALLOWED_ALGORITHMS: "RS256",
      HOP1_JWKS_URL: "https://www.googleapis.com/oauth2/v3/certs",
      TOKEN_STORE_DSN: "postgres://mcp:mcp@token-store:5432/mcp",
    });

    expect(config.googleOAuthScopes).toEqual([
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/presentations",
      "https://www.googleapis.com/auth/tasks",
      "https://www.googleapis.com/auth/meetings.space.created",
    ]);
  });

  test("uses identity-only scopes for the initial MCP client connection", () => {
    const config = loadMainConfig({
      PORT: "9090",
      GOOGLE_OAUTH_CLIENT_ID: "client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
      GOOGLE_OAUTH_REDIRECT_URI: "https://dev.example.com/oauth/google/callback",
      GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      GWS_BINARY_PATH: "/usr/local/bin/gws",
      HOP1_ISSUER: "https://accounts.google.com",
      HOP1_AUDIENCE: "mcp-gateway-dev",
      HOP1_EMAIL_CLAIM: "email",
      HOP1_ALLOWED_ALGORITHMS: "RS256",
      HOP1_JWKS_URL: "https://www.googleapis.com/oauth2/v3/certs",
      TOKEN_STORE_DSN: "postgres://mcp:mcp@token-store:5432/mcp",
    });

    expect(config.hop1OAuthScopes).toEqual(["openid", "email"]);
    expect(config.googleOAuthScopes).toContain("https://www.googleapis.com/auth/drive");
  });

  test("loads configurable HOP-1 identity scopes independently of provider consent", () => {
    const config = loadMainConfig({
      GOOGLE_OAUTH_CLIENT_ID: "client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
      GOOGLE_OAUTH_REDIRECT_URI: "https://dev.example.com/oauth/google/callback",
      GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      GWS_BINARY_PATH: "/usr/local/bin/gws",
      HOP1_ISSUER: "https://accounts.google.com",
      HOP1_AUDIENCE: "mcp-gateway-dev",
      HOP1_EMAIL_CLAIM: "email",
      HOP1_ALLOWED_ALGORITHMS: "RS256",
      HOP1_JWKS_URL: "https://www.googleapis.com/oauth2/v3/certs",
      TOKEN_STORE_DSN: "postgres://mcp:mcp@token-store:5432/mcp",
      HOP1_OAUTH_SCOPES: "openid,email",
      GOOGLE_OAUTH_SCOPES: "openid https://www.googleapis.com/auth/drive",
    });

    expect(config.hop1OAuthScopes).toEqual(["openid", "email"]);
    expect(config.googleOAuthScopes).toEqual(["openid", "https://www.googleapis.com/auth/drive"]);
  });

  test("default Google OAuth scopes exclude legacy GData scopes rejected by Google OAuth", () => {
    const config = loadMainConfig({
      PORT: "9090",
      GOOGLE_OAUTH_CLIENT_ID: "client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
      GOOGLE_OAUTH_REDIRECT_URI: "https://dev.example.com/oauth/google/callback",
      GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      GWS_BINARY_PATH: "/usr/local/bin/gws",
      HOP1_ISSUER: "https://accounts.google.com",
      HOP1_AUDIENCE: "mcp-gateway-dev",
      HOP1_EMAIL_CLAIM: "email",
      HOP1_ALLOWED_ALGORITHMS: "RS256",
      HOP1_JWKS_URL: "https://www.googleapis.com/oauth2/v3/certs",
      TOKEN_STORE_DSN: "postgres://mcp:mcp@token-store:5432/mcp",
    });

    expect(config.googleOAuthScopes).not.toContain("https://www.google.com/calendar/feeds");
    expect(config.googleOAuthScopes).not.toContain("https://www.google.com/m8/feeds");
    expect(
      config.googleOAuthScopes.every(
        (scope) =>
          scope === "openid" ||
          scope === "https://mail.google.com/" ||
          scope.startsWith("https://www.googleapis.com/auth/"),
      ),
    ).toBe(true);
  });

  test("default Google OAuth scopes exclude broad admin and non-core product families for DEV consent", () => {
    const config = loadMainConfig({
      PORT: "9090",
      GOOGLE_OAUTH_CLIENT_ID: "client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
      GOOGLE_OAUTH_REDIRECT_URI: "https://dev.example.com/oauth/google/callback",
      GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      GWS_BINARY_PATH: "/usr/local/bin/gws",
      HOP1_ISSUER: "https://accounts.google.com",
      HOP1_AUDIENCE: "mcp-gateway-dev",
      HOP1_EMAIL_CLAIM: "email",
      HOP1_ALLOWED_ALGORITHMS: "RS256",
      HOP1_JWKS_URL: "https://www.googleapis.com/oauth2/v3/certs",
      TOKEN_STORE_DSN: "postgres://mcp:mcp@token-store:5432/mcp",
    });

    const excludedPrefixes = [
      "https://www.googleapis.com/auth/admin.",
      "https://www.googleapis.com/auth/chat.",
      "https://www.googleapis.com/auth/chat",
      "https://www.googleapis.com/auth/classroom.",
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/contacts",
      "https://www.googleapis.com/auth/directory.",
      "https://www.googleapis.com/auth/forms.",
      "https://www.googleapis.com/auth/forms",
      "https://www.googleapis.com/auth/groups",
      "https://www.googleapis.com/auth/keep",
      "https://www.googleapis.com/auth/script.",
      "https://www.googleapis.com/auth/user.",
    ];

    expect(
      config.googleOAuthScopes.filter((scope) =>
        excludedPrefixes.some((prefix) => scope.startsWith(prefix)),
      ),
    ).toEqual([]);
    expect(config.googleOAuthScopes).toContain("https://www.googleapis.com/auth/userinfo.email");
    expect(config.googleOAuthScopes).toContain("https://www.googleapis.com/auth/drive");
    expect(config.googleOAuthScopes).toContain("https://www.googleapis.com/auth/presentations");
  });

  test("loads configurable Google OAuth scopes for full gws CLI parity", () => {
    expect(
      loadMainConfig({
        GOOGLE_OAUTH_CLIENT_ID: "client-id",
        GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
        GOOGLE_OAUTH_REDIRECT_URI: "https://dev.example.com/oauth/google/callback",
        GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
        GWS_BINARY_PATH: "/usr/local/bin/gws",
        HOP1_ISSUER: "https://accounts.google.com",
        HOP1_AUDIENCE: "mcp-gateway-dev",
        HOP1_EMAIL_CLAIM: "email",
        HOP1_ALLOWED_ALGORITHMS: "RS256",
        HOP1_JWKS_URL: "https://www.googleapis.com/oauth2/v3/certs",
        TOKEN_STORE_DSN: "postgres://mcp:mcp@token-store:5432/mcp",
        GOOGLE_OAUTH_SCOPES:
          "openid, https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/presentations.readonly",
      }).googleOAuthScopes,
    ).toEqual([
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/presentations.readonly",
    ]);
  });

  test("loads runtime settings with multiple issuer profiles", () => {
    expect(
      loadMainConfig({
        PORT: "9090",
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
            allowedAlgorithms: ["RS256"],
            emailClaim: "email",
          },
          {
            name: "partner",
            issuer: "https://partner.example.com",
            jwksUrl: "https://partner.example.com/.well-known/jwks.json",
            audiences: ["mcp-gateway-dev"],
            allowedAlgorithms: ["RS256"],
            emailClaim: "email",
          },
        ]),
        TOKEN_STORE_DSN: "postgres://mcp:mcp@token-store:5432/mcp",
      }),
    ).toMatchObject({
      wrapper: {
        hop1Issuers: [
          {
            name: "google",
            issuer: "https://accounts.google.com",
            jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
          },
          {
            name: "partner",
            issuer: "https://partner.example.com",
            jwksUrl: "https://partner.example.com/.well-known/jwks.json",
          },
        ],
      },
    });
  });

  test("loads an opt-in MCP authorization broker with static clients and constrained DCR", () => {
    const config = loadMainConfig({
      GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
      GOOGLE_OAUTH_REDIRECT_URI: "https://auth.example.com/oauth/google/callback",
      GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      GWS_BINARY_PATH: "/usr/local/bin/gws",
      HOP1_ISSUER: "https://identity.example.com",
      HOP1_AUDIENCE: "https://mcp.example.com/mcp",
      HOP1_EMAIL_CLAIM: "email",
      HOP1_ALLOWED_ALGORITHMS: "RS256",
      HOP1_JWKS_URL: "https://identity.example.com/.well-known/jwks.json",
      TOKEN_STORE_DSN: "postgres://mcp:mcp@token-store:5432/mcp",
      MCP_BROKER_ENABLED: "true",
      MCP_AUTHORIZATION_ISSUER: "https://auth.example.com",
      MCP_RESOURCE_URI: "https://mcp.example.com/mcp",
      MCP_BROKER_GOOGLE_REDIRECT_URI: "https://auth.example.com/oauth/google/broker/callback",
      MCP_BROKER_SIGNING_JWKS_FILE: "/var/run/secrets/mcp-broker/signing-jwks.json",
      MCP_BROKER_ACTIVE_KID: "active-2026-08",
      MCP_OAUTH_STATIC_CLIENTS_JSON: JSON.stringify([
        {
          clientId: "known-client",
          redirectUris: ["https://client.example.com/oauth/callback"],
          scopes: ["mcp"],
        },
      ]),
      MCP_DCR_ENABLED: "true",
      MCP_DCR_ALLOW_LOOPBACK_REDIRECTS: "true",
      MCP_DCR_MAX_CLIENTS: "2000",
      MCP_DCR_TRUSTED_PROXY_HEADER: "X-Real-Client-IP",
      MCP_DCR_TRUSTED_PROXY_ADDRESSES: "10.0.0.10,10.0.0.11",
    });

    expect(config.authorizationBroker).toMatchObject({
      issuer: "https://auth.example.com",
      resource: "https://mcp.example.com/mcp",
      activeSigningKid: "active-2026-08",
      scopes: ["mcp"],
      dcr: { allowLoopbackRedirects: true, maxDynamicClients: 2000 },
      dcrTrustedProxy: {
        headerName: "x-real-client-ip",
        trustedAddresses: ["10.0.0.10", "10.0.0.11"],
      },
    });
  });

  test("rejects direct Google access-token trust when the broker is enabled", () => {
    expect(() =>
      loadMainConfig({
        GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
        GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
        GOOGLE_OAUTH_REDIRECT_URI: "https://auth.example.com/oauth/google/callback",
        GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
        GWS_BINARY_PATH: "/usr/local/bin/gws",
        HOP1_ISSUER: "https://accounts.google.com",
        HOP1_AUDIENCE: "google-client-id",
        HOP1_EMAIL_CLAIM: "email",
        HOP1_ALLOWED_ALGORITHMS: "RS256",
        HOP1_JWKS_URL: "https://www.googleapis.com/oauth2/v3/certs",
        TOKEN_STORE_DSN: "postgres://mcp:mcp@token-store:5432/mcp",
        MCP_BROKER_ENABLED: "true",
        MCP_AUTHORIZATION_ISSUER: "https://auth.example.com",
        MCP_RESOURCE_URI: "https://mcp.example.com/mcp",
        MCP_BROKER_GOOGLE_REDIRECT_URI: "https://auth.example.com/oauth/google/broker/callback",
        MCP_BROKER_SIGNING_JWKS_FILE: "/var/run/secrets/mcp-broker/signing-jwks.json",
        MCP_BROKER_ACTIVE_KID: "active-2026-08",
        MCP_DCR_ENABLED: "true",
      }),
    ).toThrow("Direct Google identity tokens cannot remain trusted");
  });
});
