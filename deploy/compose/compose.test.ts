import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("Docker Compose deployment skeleton", () => {
  test("defines gateway, google wrapper, and token store services", async () => {
    const compose = await readFile("deploy/compose/docker-compose.yaml", "utf8");

    expect(compose).toContain("agentgateway:");
    expect(compose).toContain(
      "image: ${AGENTGATEWAY_IMAGE:-ghcr.io/apelogic-ai/mcp-gw-agentgateway:0.3.0}",
    );
    expect(compose).toContain("google-workspace:");
    expect(compose).toContain("token-store:");
    expect(compose).toContain("GWS_BINARY_PATH:");
    expect(compose).toContain("GOOGLE_OAUTH_CLIENT_ID:");
    expect(compose).toContain("GOOGLE_OAUTH_SCOPES:");
    expect(compose).toContain("HOP1_OAUTH_SCOPES:");
    expect(compose).toContain("HOP1_JWKS_URL:");
    expect(compose).toContain("HOP1_ALLOWED_ALGORITHMS:");
    expect(compose).toContain("HOP1_ISSUERS_JSON:");
    expect(compose).toContain("OPA_POLICY_URL:");
    expect(compose).toContain("GOOGLE_WORKSPACE_POLICY_FILE:");
    expect(compose).toContain("AUDIT_LOG_PATH:");
    expect(compose).toContain("/docker-entrypoint-initdb.d/001-oauth-schema.sql:ro");
    expect(compose).toContain("GWS_BINARY_PATH: ${GWS_BINARY_PATH:-/app/node_modules/.bin/gws}");
  });

  test("provides an environment-neutral local Compose template", async () => {
    const envExample = await readFile("deploy/compose/.env.example", "utf8");

    expect(envExample).toContain("GOOGLE_OAUTH_CLIENT_ID=");
    expect(envExample).toContain(
      "AGENTGATEWAY_IMAGE=ghcr.io/apelogic-ai/mcp-gw-agentgateway:0.3.0",
    );
    expect(envExample).toContain("GOOGLE_TOKEN_ENCRYPTION_KEY=");
    expect(envExample).toContain("HOP1_PROFILE=");
    expect(envExample).toContain("HOP1_ISSUER=");
    expect(envExample).toContain("HOP1_JWKS_URL=");
    expect(envExample).toContain("HOP1_AUDIENCE=");
    expect(envExample).toContain("HOP1_ALLOWED_ALGORITHMS=");
    expect(envExample).toContain("HOP1_OAUTH_SCOPES=openid email");
    expect(envExample).toContain("HOP1_ISSUERS_JSON=");
    expect(envExample).toContain("OPA_POLICY_URL=");
    expect(envExample).toContain("GOOGLE_WORKSPACE_POLICY_FILE=");
    expect(envExample).toContain("AUDIT_LOG_PATH=/var/log/mcp-gw/audit.jsonl");
    expect(envExample).toContain(
      "GOOGLE_OAUTH_REDIRECT_URI=https://mcp.example.com/oauth/google/callback",
    );
    expect(envExample).toContain("TOKEN_STORE_DSN=postgres://mcp:mcp@token-store:5432/mcp");
    expect(envExample).not.toContain("HOP1_PROFILE=google");
    expect(envExample).not.toContain("HOP1_ISSUER=https://accounts.google.com");
  });

  test("has a Dockerfile that runs the Google Workspace wrapper entrypoint", async () => {
    const dockerfile = await readFile("servers/google-workspace/wrapper/Dockerfile", "utf8");

    expect(dockerfile).toContain("FROM ubuntu:24.04");
    expect(dockerfile).toContain("COPY --from=bun");
    expect(dockerfile).toContain("nodejs");
    expect(dockerfile).toContain("bun install");
    expect(dockerfile).toContain("@googleworkspace/cli@0.22.5");
    expect(dockerfile).toContain("servers/google-workspace/wrapper/src/main.ts");
  });

  test("has scriptable compose checks and smoke tests", async () => {
    const check = await readFile("scripts/check-compose.sh", "utf8");
    const smoke = await readFile("scripts/smoke-compose.sh", "utf8");

    expect(check).toContain("docker compose");
    expect(check).toContain("config");
    expect(smoke).toContain("up -d token-store google-workspace");
    expect(smoke).toContain("/oauth/google/status");
    expect(smoke).toContain("401");
  });
});
