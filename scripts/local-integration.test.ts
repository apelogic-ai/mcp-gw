import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

describe("local Docker integration smoke", () => {
  test("exposes a separate Docker-backed integration command", async () => {
    await access("scripts/smoke-local-integration.sh", constants.X_OK);

    const packageJson = await readFile("package.json", "utf8");
    expect(packageJson).toContain('"integration:local": "bash scripts/smoke-local-integration.sh"');
  });

  test("uses a local JWKS fixture and signed HOP-1 JWT", async () => {
    const fixture = await readFile("scripts/fixtures/hop1-fixture.ts", "utf8");
    const smoke = await readFile("scripts/smoke-local-integration.sh", "utf8");

    expect(fixture).toContain("SignJWT");
    expect(fixture).toContain(".well-known/jwks.json");
    expect(smoke).toContain('ISSUER="http://host.docker.internal:$JWKS_PORT"');
    expect(smoke).toContain("HOP1_JWKS_URL=$ISSUER/.well-known/jwks.json");
    expect(smoke).toContain(
      "AGENTGATEWAY_IMAGE=${LOCAL_AGENTGATEWAY_IMAGE:-ghcr.io/agentgateway/agentgateway:v1.2.0}",
    );
    expect(smoke).toContain("accept: application/json, text/event-stream");
    expect(smoke).toContain('method":"initialize');
    expect(smoke).toContain("mcp-session-id");
    expect(smoke).toContain("tools/list");
    expect(smoke).toContain("google_drive_files_list");
    expect(smoke).toContain("LOCAL_INCLUDE_GITHUB");
    expect(smoke).toContain("github_oauth_start");
  });

  test("mounts an authenticated local agentgateway config for the smoke path", async () => {
    const compose = await readFile("deploy/compose/docker-compose.yaml", "utf8");
    const override = await readFile("deploy/compose/docker-compose.local-smoke.yaml", "utf8");
    const config = await readFile("gateway/agentgateway/local-smoke.yaml", "utf8");

    expect(compose).toContain("--file");
    expect(compose).toContain("${GATEWAY_PORT:-8080}:3000");
    expect(override).toContain("gateway/agentgateway/local-smoke.yaml");
    expect(override).toContain("host.docker.internal:host-gateway");
    expect(config).toContain("mcpAuthentication:");
    expect(config).toContain("backendAuth:");
    expect(config).toContain("passthrough: {}");
    expect(config).toContain("failureMode: failOpen");
    expect(config).not.toContain("prefixMode:");
    expect(config).not.toContain("prefixMode: always");
    expect(config).toContain("name: google");
    expect(config).not.toContain("name: google-workspace");
    expect(config).toContain("issuer: http://host.docker.internal:18080");
    expect(config).toContain("host: http://google-workspace:8080/mcp");
  });

  test("can opt into a local GitHub MCP backend smoke", async () => {
    const smoke = await readFile("scripts/smoke-local-integration.sh", "utf8");
    const override = await readFile(
      "deploy/compose/docker-compose.local-github-smoke.yaml",
      "utf8",
    );
    const config = await readFile("gateway/agentgateway/local-github-smoke.yaml", "utf8");

    expect(smoke).toContain("LOCAL_GITHUB_COMPOSE_FILE");
    expect(smoke).toContain("docker-compose.github-mcp.yaml");
    expect(smoke).toContain("github-wrapper");
    expect(smoke).toContain("github-mcp");
    expect(smoke).toContain("GITHUB_TOKEN_ENCRYPTION_KEY");
    expect(smoke).toContain("GITHUB_OAUTH_CLIENT_ID=local-github-client");
    expect(override).toContain("gateway/agentgateway/local-github-smoke.yaml");
    expect(override).toContain("host.docker.internal:host-gateway");
    expect(config).toContain("name: google");
    expect(config).toContain("name: github");
    expect(config).toContain("host: http://github-wrapper:8080/mcp");
    expect(config).toContain("mcpAuthentication:");
    expect(config).toContain("failureMode: failOpen");
  });
});
