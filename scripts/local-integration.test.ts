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
    expect(fixture).toContain(".well-known/oauth-authorization-server");
    expect(fixture).toContain(".well-known/jwks.json");
    expect(fixture).toContain('url.pathname === "/token"');
    expect(smoke).toContain('ISSUER="http://host.docker.internal:$JWKS_PORT"');
    expect(smoke).toContain('FIXTURE_BASE_URL="http://127.0.0.1:$JWKS_PORT"');
    expect(smoke).toContain("HOP1_JWKS_URL=$ISSUER/.well-known/jwks.json");
    expect(smoke).toContain("HOP1_ALLOWED_ALGORITHMS=RS256");
    expect(smoke).toContain(
      "AGENTGATEWAY_IMAGE=${LOCAL_AGENTGATEWAY_IMAGE:-ghcr.io/apelogic-ai/mcp-gw-agentgateway:0.3.0}",
    );
    expect(smoke).toContain("accept: application/json, text/event-stream");
    expect(smoke).toContain('method":"initialize');
    expect(smoke).toContain("mcp-session-id");
    expect(smoke).toContain("tools/list");
    expect(smoke).toContain('EXPECTED_TOOLS=("google_oauth_start")');
    expect(smoke).not.toContain('EXPECTED_TOOL="google_drive_files_list"');
    expect(smoke).toContain("LOCAL_INCLUDE_GITHUB");
    expect(smoke).toContain("github_oauth_start");
    expect(smoke).toContain('EXPECTED_TOOLS+=("github_oauth_start")');
    expect(smoke).toContain('for expected_tool in "${EXPECTED_TOOLS[@]}"');
    expect(smoke).toContain("assert_rejected_without_token");
    expect(smoke).toContain("assert_rejected_token expired");
    expect(smoke).toContain("assert_rejected_token missing-expiration");
    expect(smoke).toContain("assert_rejected_token wrong-issuer");
    expect(smoke).toContain("assert_rejected_token wrong-audience");
    expect(smoke).toContain("assert_rejected_token invalid-signature");
    expect(smoke).toContain("assert_rejected_token wrong-algorithm");
    expect(smoke).toContain("assert_rejected_token not-before");
    expect(smoke).toContain("assert_fixture_authorization_server");
    expect(smoke).toContain('curl -sS "$FIXTURE_BASE_URL/.well-known/jwks.json"');
    expect(smoke).toContain("authorization_servers");
    expect(smoke).toContain("assert_public_metadata");
    expect(fixture).toContain("`${args.tokenFile}.expired`");
    expect(fixture).toContain("`${args.tokenFile}.missing-expiration`");
    expect(fixture).toContain("`${args.tokenFile}.wrong-issuer`");
    expect(fixture).toContain("`${args.tokenFile}.wrong-audience`");
    expect(fixture).toContain("`${args.tokenFile}.invalid-signature`");
    expect(fixture).toContain("`${args.tokenFile}.wrong-algorithm`");
    expect(fixture).toContain("`${args.tokenFile}.not-before`");
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
    expect(config).toContain("scopesSupported: [openid, email]");
    expect(config).not.toContain("scopesSupported: [read:all]");
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
    expect(config).toContain("scopesSupported: [openid, email]");
    expect(config).not.toContain("scopesSupported: [read:all]");
    expect(config).toContain("failureMode: failOpen");
  });

  test("runs the complete provider bundle against TLS PostgreSQL and safe fixtures", async () => {
    const [packageJson, workflow, smoke, compose, gatewayConfig, providerFixture, client] =
      await Promise.all([
        readFile("package.json", "utf8"),
        readFile(".github/workflows/ci.yml", "utf8"),
        readFile("scripts/smoke-full-bundle.sh", "utf8"),
        readFile("deploy/compose/docker-compose.full-bundle-smoke.yaml", "utf8"),
        readFile("gateway/agentgateway/local-full-bundle-smoke.yaml", "utf8"),
        readFile("scripts/fixtures/provider-fixture.ts", "utf8"),
        readFile("scripts/fixtures/full-bundle-client.ts", "utf8"),
      ]);

    expect(packageJson).toContain('"integration:bundle": "bash scripts/smoke-full-bundle.sh"');
    expect(workflow).toContain("bun run integration:bundle");
    expect(workflow).toContain("LOCAL_AGENTGATEWAY_IMAGE: mcp-gw-agentgateway:smoke");
    expect(compose).toContain("ssl=on");
    expect(compose).toContain("sslmode=verify-full");
    expect(compose).toContain("sslrootcert=/tls/ca.crt");
    expect(gatewayConfig).toMatch(
      /providers:\n\s+- issuer: http:\/\/host\.docker\.internal:18180[\s\S]*?allowedAlgorithms: \[RS256\]/,
    );
    expect(gatewayConfig).not.toMatch(/jwtValidationOptions:\n\s+allowedAlgorithms:/);
    expect(smoke).toContain("oauth-migrations");
    expect(smoke).toContain("missing-expiration");
    expect(smoke).toContain("compose_cmd up -d --build --wait token-store provider-fixture");
    expect(smoke).toContain("compose_cmd build oauth-migrations");
    expect(smoke.match(/compose_cmd run --rm --no-deps oauth-migrations/g)).toHaveLength(2);
    expect(smoke).toContain('wait "$MIGRATION_PID_ONE"');
    expect(smoke).toContain('wait "$MIGRATION_PID_TWO"');
    expect(providerFixture).toContain("fixture-google-provider-token");
    expect(providerFixture).toContain("fixture-github-provider-token");
    expect(client).toContain("google_oauth_start");
    expect(client).toContain("github_oauth_start");
    expect(client).toContain("google_drive_files_list");
    expect(client).toContain("get_file_contents");
    expect(client).toContain("resources/templates/list");
    expect(client).toContain("resources/list");
    expect(client).toContain("assertGithubGrantStatus");
    expect(client).toContain("assertNoProviderCredentials");
    expect(smoke).toContain("assert_logs_do_not_contain_credentials");
  });
});
