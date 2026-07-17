import { describe, expect, test } from "bun:test";

import { loadMainConfig } from "./main";

const baseEnv = {
  TOKEN_STORE_DSN: "postgres://mcp:mcp@token-store:5432/mcp",
  GITHUB_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  HOP1_ISSUER: "https://issuer.example.com",
  HOP1_JWKS_URL: "https://issuer.example.com/.well-known/jwks.json",
  HOP1_AUDIENCE: "https://mcp.example.com/mcp",
  HOP1_EMAIL_CLAIM: "email",
};

describe("GitHub MCP wrapper main config", () => {
  test("loads required runtime settings", () => {
    expect(loadMainConfig(baseEnv)).toEqual({
      port: 8080,
      tokenStoreDsn: "postgres://mcp:mcp@token-store:5432/mcp",
      upstreamUrl: "http://github-mcp:8082/mcp",
      githubOAuth: {
        clientId: "",
        clientSecret: "",
        redirectUri: "",
        tokenEncryptionKey: Buffer.alloc(32, 1).toString("base64"),
      },
      githubScopes: ["repo", "read:org", "workflow", "notifications"],
      hop1Issuers: [
        {
          name: "google",
          issuer: "https://issuer.example.com",
          jwksUrl: "https://issuer.example.com/.well-known/jwks.json",
          audiences: ["https://mcp.example.com/mcp"],
          emailClaim: "email",
          subjectClaim: undefined,
        },
      ],
    });
  });

  test("loads multiple HOP-1 issuers from JSON", () => {
    const config = loadMainConfig({
      ...baseEnv,
      HOP1_ISSUERS_JSON: JSON.stringify([
        {
          name: "burble",
          issuer: "https://issuer.example.com",
          jwksUrl: "https://issuer.example.com/jwks.json",
          audiences: ["https://mcp.example.com/mcp"],
          emailClaim: "email",
          subjectClaim: "sub",
        },
      ]),
    });

    expect(config.hop1Issuers).toEqual([
      {
        name: "burble",
        issuer: "https://issuer.example.com",
        jwksUrl: "https://issuer.example.com/jwks.json",
        audiences: ["https://mcp.example.com/mcp"],
        emailClaim: "email",
        subjectClaim: "sub",
      },
    ]);
  });

  test("requires token store and HOP-1 issuer settings", () => {
    expect(() => loadMainConfig({ ...baseEnv, TOKEN_STORE_DSN: undefined })).toThrow(
      "Missing required env var: TOKEN_STORE_DSN",
    );
    expect(() => loadMainConfig({ ...baseEnv, HOP1_JWKS_URL: undefined })).toThrow(
      "Missing required env var: HOP1_JWKS_URL",
    );
  });
});
