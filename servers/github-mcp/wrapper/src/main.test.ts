import { describe, expect, test } from "bun:test";

import { loadMainConfig } from "./main";

const baseEnv = {
  TOKEN_STORE_DSN: "postgres://mcp:mcp@token-store:5432/mcp",
  GITHUB_OAUTH_CLIENT_ID: "github-client",
  GITHUB_OAUTH_CLIENT_SECRET: "github-secret",
  GITHUB_OAUTH_REDIRECT_URI: "https://mcp.example.com/oauth/github/callback",
  GITHUB_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  HOP1_ISSUER: "https://issuer.example.com",
  HOP1_JWKS_URL: "https://issuer.example.com/.well-known/jwks.json",
  HOP1_AUDIENCE: "https://mcp.example.com/mcp",
  HOP1_EMAIL_CLAIM: "email",
  HOP1_ALLOWED_ALGORITHMS: "RS256",
};

describe("GitHub MCP wrapper main config", () => {
  test("loads required runtime settings", () => {
    expect(loadMainConfig(baseEnv)).toEqual({
      port: 8080,
      tokenStoreDsn: "postgres://mcp:mcp@token-store:5432/mcp",
      upstreamUrl: "http://github-mcp:8082/mcp",
      githubOAuth: {
        clientId: "github-client",
        clientSecret: "github-secret",
        redirectUri: "https://mcp.example.com/oauth/github/callback",
        tokenEncryptionKey: Buffer.alloc(32, 1).toString("base64"),
      },
      githubScopes: ["repo", "read:org", "workflow", "notifications", "user:email"],
      aliases: {},
      policy: undefined,
      audit: undefined,
      hop1Issuers: [
        {
          name: "issuer",
          issuer: "https://issuer.example.com",
          jwksUrl: "https://issuer.example.com/.well-known/jwks.json",
          audiences: ["https://mcp.example.com/mcp"],
          allowedAlgorithms: ["RS256"],
          emailClaim: "email",
          subjectClaim: undefined,
        },
      ],
    });
  });

  test("loads configurable GitHub OAuth endpoints for isolated integration tests", () => {
    const config = loadMainConfig({
      ...baseEnv,
      GITHUB_OAUTH_AUTHORIZATION_URL: "http://provider-fixture:8090/github/authorize",
      GITHUB_OAUTH_TOKEN_URL: "http://provider-fixture:8090/github/token",
      GITHUB_OAUTH_USER_EMAILS_URL: "http://provider-fixture:8090/github/emails",
    });

    expect(config.githubOAuth).toMatchObject({
      authorizationUrl: "http://provider-fixture:8090/github/authorize",
      tokenUrl: "http://provider-fixture:8090/github/token",
      userEmailsUrl: "http://provider-fixture:8090/github/emails",
    });
  });

  test("loads optional policy, audit, and alias settings", () => {
    const config = loadMainConfig({
      ...baseEnv,
      GITHUB_POLICY_FILE: "/etc/mcp-gw/github-policy.yaml",
      OPA_POLICY_URL: "http://opa:8181/v1/data/mcp/allow",
      AUDIT_LOG_PATH: "/var/log/mcp-gw/audit.jsonl",
      GITHUB_TOOL_ALIASES_JSON: JSON.stringify({
        github_issues_create: "github_create_issue",
      }),
    });

    expect(config.policy).toEqual({
      yamlFile: "/etc/mcp-gw/github-policy.yaml",
      opaUrl: "http://opa:8181/v1/data/mcp/allow",
    });
    expect(config.audit).toEqual({ jsonlPath: "/var/log/mcp-gw/audit.jsonl" });
    expect(config.aliases).toEqual({
      github_issues_create: "github_create_issue",
    });
  });

  test("loads multiple HOP-1 issuers from JSON", () => {
    const config = loadMainConfig({
      ...baseEnv,
      HOP1_ISSUERS_JSON: JSON.stringify([
        {
          name: "portal",
          issuer: "https://issuer.example.com",
          jwksUrl: "https://issuer.example.com/jwks.json",
          audiences: ["https://mcp.example.com/mcp"],
          allowedAlgorithms: ["RS256"],
          emailClaim: "email",
          subjectClaim: "sub",
        },
      ]),
    });

    expect(config.hop1Issuers).toEqual([
      {
        name: "portal",
        issuer: "https://issuer.example.com",
        jwksUrl: "https://issuer.example.com/jwks.json",
        audiences: ["https://mcp.example.com/mcp"],
        allowedAlgorithms: ["RS256"],
        emailClaim: "email",
        subjectClaim: "sub",
      },
    ]);
  });

  test("requires paired introspection URL and client credential", () => {
    const introspectionEnv = {
      ...baseEnv,
      HOP1_INTROSPECTION_URL: "https://issuer.example.com/introspect",
    };

    expect(() => loadMainConfig(introspectionEnv)).toThrow(
      "HOP1_INTROSPECTION_URL and HOP1_INTROSPECTION_CLIENT_CREDENTIAL must be set together",
    );
    expect(
      loadMainConfig({
        ...introspectionEnv,
        HOP1_INTROSPECTION_CLIENT_CREDENTIAL: "gateway-credential",
      }).hop1Issuers[0],
    ).toMatchObject({
      introspectionUrl: "https://issuer.example.com/introspect",
      introspectionClientCredential: "gateway-credential",
    });
  });

  test("resolves per-issuer introspection credentials from environment references", () => {
    const config = loadMainConfig({
      ...baseEnv,
      HOP1_ISSUERS_JSON: JSON.stringify([
        {
          name: "workforce",
          issuer: "https://identity.example.com",
          jwksUrl: "https://identity.example.com/.well-known/jwks.json",
          audiences: ["https://mcp.example.com/mcp"],
          allowedAlgorithms: ["RS256"],
          emailClaim: "email",
          introspectionUrl: "https://identity.example.com/introspect",
          introspectionClientCredentialEnv: "HOP1_INTROSPECTION_CREDENTIAL_0",
        },
      ]),
      HOP1_INTROSPECTION_CREDENTIAL_0: "secret-from-kubernetes",
    });

    expect(config.hop1Issuers[0]?.introspectionClientCredential).toBe("secret-from-kubernetes");
  });

  test("rejects issuer profiles without a non-empty algorithm allowlist", () => {
    const issuer = {
      name: "fixture",
      issuer: "https://identity.example.com",
      jwksUrl: "https://identity.example.com/.well-known/jwks.json",
      audiences: ["https://mcp.example.com/mcp"],
      emailClaim: "email",
    };

    expect(() =>
      loadMainConfig({ ...baseEnv, HOP1_ISSUERS_JSON: JSON.stringify([issuer]) }),
    ).toThrow("allowedAlgorithms must be a non-empty string array");
    expect(() =>
      loadMainConfig({
        ...baseEnv,
        HOP1_ISSUERS_JSON: JSON.stringify([{ ...issuer, allowedAlgorithms: [] }]),
      }),
    ).toThrow("allowedAlgorithms must be a non-empty string array");
  });

  test("requires token store and HOP-1 issuer settings", () => {
    expect(() => loadMainConfig({ ...baseEnv, TOKEN_STORE_DSN: undefined })).toThrow(
      "Missing required env var: TOKEN_STORE_DSN",
    );
    expect(() => loadMainConfig({ ...baseEnv, HOP1_JWKS_URL: undefined })).toThrow(
      "Missing required env var: HOP1_JWKS_URL",
    );
  });

  test.each([
    "TOKEN_STORE_DSN",
    "GITHUB_OAUTH_CLIENT_ID",
    "GITHUB_OAUTH_CLIENT_SECRET",
    "GITHUB_OAUTH_REDIRECT_URI",
    "GITHUB_TOKEN_ENCRYPTION_KEY",
  ])("fails startup when enabled GitHub wrapper setting %s is missing", (name) => {
    expect(() => loadMainConfig({ ...baseEnv, [name]: undefined })).toThrow(
      `Missing required env var: ${name}`,
    );
  });
});
