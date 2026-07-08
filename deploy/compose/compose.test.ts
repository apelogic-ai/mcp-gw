import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("Docker Compose deployment skeleton", () => {
  test("defines gateway, google wrapper, and token store services", async () => {
    const compose = await readFile("deploy/compose/docker-compose.yaml", "utf8");

    expect(compose).toContain("agentgateway:");
    expect(compose).toContain(
      "image: ${AGENTGATEWAY_IMAGE:-ghcr.io/agentgateway/agentgateway:v1.1.0}",
    );
    expect(compose).toContain("google-workspace:");
    expect(compose).toContain("token-store:");
    expect(compose).toContain("GWS_BINARY_PATH:");
    expect(compose).toContain("GOOGLE_OAUTH_CLIENT_ID:");
    expect(compose).toContain("HOP1_JWKS_URL:");
    expect(compose).toContain("HOP1_ISSUERS_JSON:");
    expect(compose).toContain("OPA_POLICY_URL:");
    expect(compose).toContain("GOOGLE_WORKSPACE_POLICY_FILE:");
    expect(compose).toContain("AUDIT_LOG_PATH:");
    expect(compose).toContain("/docker-entrypoint-initdb.d/001-oauth-schema.sql:ro");
    expect(compose).toContain("GWS_BINARY_PATH: ${GWS_BINARY_PATH:-/app/node_modules/.bin/gws}");
  });

  test("provides an environment template for local and DEV compose", async () => {
    const envExample = await readFile("deploy/compose/.env.example", "utf8");

    expect(envExample).toContain("GOOGLE_OAUTH_CLIENT_ID=");
    expect(envExample).toContain("AGENTGATEWAY_IMAGE=");
    expect(envExample).toContain("GOOGLE_TOKEN_ENCRYPTION_KEY=");
    expect(envExample).toContain("HOP1_ISSUER=https://accounts.google.com");
    expect(envExample).toContain("HOP1_JWKS_URL=https://www.googleapis.com/oauth2/v3/certs");
    expect(envExample).toContain("HOP1_AUDIENCE=");
    expect(envExample).toContain("HOP1_ISSUERS_JSON=");
    expect(envExample).toContain("OPA_POLICY_URL=");
    expect(envExample).toContain("GOOGLE_WORKSPACE_POLICY_FILE=");
    expect(envExample).toContain("AUDIT_LOG_PATH=/var/log/mcp-gw/audit.jsonl");
    expect(envExample).toContain(
      "GOOGLE_OAUTH_REDIRECT_URI=https://<dev-origin>/oauth/google/callback",
    );
    expect(envExample).toContain("TOKEN_STORE_DSN=postgres://mcp:mcp@token-store:5432/mcp");
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

  test("DEV compose terminates TLS and routes public OAuth paths", async () => {
    const devCompose = await readFile("deploy/compose/docker-compose.dev.yaml", "utf8");
    const deploy = await readFile("scripts/deploy-dev.sh", "utf8");

    expect(devCompose).toContain("caddy:");
    expect(devCompose).toContain("caddy:2");
    expect(devCompose).toContain('"80:80"');
    expect(devCompose).toContain('"443:443"');
    expect(devCompose).toContain(".Caddyfile-dev:/etc/caddy/Caddyfile:ro");
    expect(deploy).toContain('cat > "\\$APP_DIR.next/deploy/compose/.Caddyfile-dev"');
    expect(deploy).toContain("reverse_proxy agentgateway:3000");
    expect(deploy).toContain("header_up X-Forwarded-Proto https");
    expect(deploy).toContain("header_down WWW-Authenticate");
    expect(deploy).toContain("https://\\$dev_host/.well-known/oauth-protected-resource/mcp");
    expect(deploy).toContain("reverse_proxy google-workspace:8080");
    expect(deploy).toContain("handle /oauth/google/*");
    expect(deploy).toContain('respond "mcp-gateway DEV');
    expect(deploy).toContain("handle /authorize");
    expect(deploy).toContain("https://\\$dev_host/authorize");
    expect(deploy).toContain("https://\\$dev_host/token");
    expect(deploy).toContain("handle /token");
    expect(deploy).toContain("reverse_proxy google-workspace:8080");
    expect(deploy).toContain("oauth-authorization-server");
    expect(deploy).toContain("AGENTGATEWAY_MCP_AUTH_YAML");
    expect(deploy).toContain("HOP1_ISSUERS_JSON");
    expect(deploy).not.toContain("respond `");
  });
});
