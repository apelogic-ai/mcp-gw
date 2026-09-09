import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

describe("local Docker integration smoke", () => {
  test("exposes a separate Docker-backed integration command", async () => {
    await access("scripts/smoke-local-integration.sh", constants.X_OK);
    await access("scripts/smoke-external-issuer-integration.sh", constants.X_OK);

    const packageJson = await readFile("package.json", "utf8");
    expect(packageJson).toContain('"integration:local": "bash scripts/smoke-local-integration.sh"');
    expect(packageJson).toContain(
      '"integration:external": "bash scripts/smoke-external-issuer-integration.sh"',
    );
  });

  test("keeps a broker-disabled multi-backend external issuer journey", async () => {
    const [smoke, client, compose, gateway] = await Promise.all([
      readFile("scripts/smoke-external-issuer-integration.sh", "utf8"),
      readFile("scripts/fixtures/external-issuer-journey-client.ts", "utf8"),
      readFile("deploy/compose/docker-compose.external-issuer-smoke.yaml", "utf8"),
      readFile("gateway/agentgateway/local-external-issuer-smoke.yaml", "utf8"),
    ]);

    expect(smoke).toContain("MCP_BROKER_ENABLED=false");
    expect(smoke).toContain('JWKS_PORT="38080"');
    expect(smoke).not.toContain("EXTERNAL_JWKS_PORT");
    expect(smoke).toContain("google-workspace");
    expect(smoke).toContain("github-wrapper");
    expect(smoke).toContain("github-mcp");
    expect(smoke).toContain("external-issuer-journey-client.ts");
    expect(smoke).toContain("HOP1_EMAIL_CLAIM=mail");
    expect(smoke).toContain("HOP1_SUBJECT_CLAIM=oid");
    expect(smoke).toContain('--email-claim "mail"');
    expect(smoke).toContain('--subject-claim "oid"');
    expect(compose).toContain('MCP_BROKER_ENABLED: "false"');
    expect(compose).toContain('HOP1_ISSUERS_JSON: ""');
    expect(compose).toContain("HOP1_ISSUERS_JSON: ${EXTERNAL_HOP1_ISSUERS_JSON}");
    expect(gateway).toContain("backendAuth:");
    expect(gateway).toContain("passthrough: {}");
    expect(gateway).toContain("host: http://google-workspace:8080/mcp");
    expect(gateway).toContain("host: http://github-wrapper:8080/mcp");
    expect(gateway).not.toContain("https://mcp.example.com/oauth");
    expect(client).toContain("listGoogleWorkspaceTools");
    expect(client).toContain("listStableGithubTools");
    expect(client).toContain("GITHUB_MCP_SHIPPED_TOOLSETS");
    expect(client).toContain("googleTools.map((name) => `google_${name}`)");
    expect(client).toContain("githubTools.map((name) => `github_${name}`)");
    for (const expectation of [
      "google_oauth_start",
      "google_oauth_status",
      "github_oauth_start",
      "github_oauth_status",
      "wrong-issuer",
      "wrong-audience",
      "invalid-signature",
      "expired",
    ]) {
      expect(client).toContain(expectation);
    }
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
    expect(smoke).toContain("HOP1_EMAIL_CLAIM=mail");
    expect(smoke).toContain("HOP1_SUBJECT_CLAIM=oid");
    expect(smoke).toContain('--email-claim "mail"');
    expect(smoke).toContain('--subject-claim "oid"');
    expect(smoke).toContain('"emailClaim":"mail","subjectClaim":"oid"');
    expect(smoke).toContain('"emailClaim":"email","subjectClaim":"sub"');
    expect(smoke).toContain(
      "AGENTGATEWAY_IMAGE=${LOCAL_AGENTGATEWAY_IMAGE:-ghcr.io/apelogic-ai/mcp-gw-agentgateway:0.4.7}",
    );
    expect(smoke).toContain("accept: application/json, text/event-stream");
    expect(smoke).toContain('method":"initialize');
    expect(smoke).toContain("mcp-session-id");
    expect(smoke).toContain("tools/list");
    expect(smoke).toContain('EXPECTED_TOOLS=("google_oauth_start" "google_oauth_status")');
    expect(smoke).toContain('bun "$ROOT_DIR/shared/oauth/migrate.ts"');
    expect(smoke).toContain("OAuth migrations did not complete.");
    expect(smoke.indexOf('bun "$ROOT_DIR/shared/oauth/migrate.ts"')).toBeLessThan(
      smoke.indexOf('bun "$ROOT_DIR/scripts/fixtures/refresh-token-race.ts"'),
    );
    expect(smoke).not.toContain('EXPECTED_TOOL="google_drive_files_list"');
    expect(smoke).toContain("LOCAL_INCLUDE_GITHUB");
    expect(smoke).toContain("github_oauth_start");
    expect(smoke).toContain('EXPECTED_TOOLS+=("github_oauth_start" "github_oauth_status")');
    expect(smoke).toContain('BROKER_EXPECTED_TOOLS=("google_oauth_start" "google_oauth_status")');
    expect(smoke).toContain('BROKER_EXPECTED_DATA_TOOLS=("google_drive_files_list")');
    expect(smoke).toContain('"google_google_oauth_start"');
    expect(smoke).toContain('"github_github_oauth_start"');
    expect(smoke).toContain('"google_google_drive_files_list"');
    expect(smoke).toContain('"github_get_file_contents"');
    expect(smoke).toContain('"${BROKER_EXPECTED_TOOLS[@]}"');
    expect(smoke).toContain('--expected-data-tools "$EXPECTED_DATA_TOOLS_CSV"');
    expect(smoke).toContain("GITHUB_SMOKE_HOP1_ISSUERS_JSON=");
    expect(smoke).toContain('GITHUB_WRAPPER_PORT="${GITHUB_WRAPPER_PORT:-38085}"');
    expect(smoke).toContain('\"issuer\":\"$BROKER_ISSUER\"');
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
    expect(smoke).toContain('BROKER_ISSUER_INPUT="https://mcp.example.com/oauth/"');
    expect(smoke).toContain('BROKER_ISSUER="${BROKER_ISSUER_INPUT%/}"');
    expect(smoke).toContain("MCP_AUTHORIZATION_ISSUER=$BROKER_ISSUER_INPUT");
    expect(smoke).toContain("broker-journey-client.ts");
    expect(await readFile("scripts/fixtures/broker-journey-client.ts", "utf8")).toContain(
      '"mail" in claims || "oid" in claims',
    );
    expect(smoke).toContain('--google-wrapper-url "http://127.0.0.1:$GOOGLE_WRAPPER_PORT/mcp"');
    expect(smoke).toContain('--github-wrapper-url "http://127.0.0.1:$GITHUB_WRAPPER_PORT/mcp"');
    expect(smoke).toContain("google-oidc-fixture.ts");
    expect(smoke).toContain('BROKER_TOKEN_FILE="$WORK_DIR/broker.jwt"');
    expect(smoke).toContain('BROKER_SIGNING_JWKS_DIR="$WORK_DIR/broker"');
    expect(smoke).toContain(
      'BROKER_SIGNING_JWKS_FILE="$BROKER_SIGNING_JWKS_DIR/signing-jwks.json"',
    );
    expect(smoke).toContain('--signing-jwks-file "$BROKER_SIGNING_JWKS_FILE"');
    expect(smoke).toContain("broker_signing_jwks_ready");
    expect(smoke).toContain("Broker fixture did not produce a complete signing JWKS.");
    expect(smoke).toContain('chmod 444 "$BROKER_SIGNING_JWKS_FILE"');
    expect(smoke).toContain('chmod 555 "$BROKER_SIGNING_JWKS_DIR"');
    expect(fixture).toContain("signingJwksFile");
    expect(smoke).toContain("authorization_servers must contain only the public broker issuer");
    expect(smoke).toContain('assert_accepted_token "public broker" "$BROKER_TOKEN"');
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
    expect(override).toContain('MCP_BROKER_ENABLED: "true"');
    expect(override).toContain("MCP_BROKER_SIGNING_JWKS_FILE");
    expect(override).toContain(
      "${LOCAL_BROKER_SIGNING_JWKS_DIR}:/var/run/secrets/mcp-gateway/broker:ro",
    );
    expect(config).toContain("mcpAuthentication:");
    expect(config).toContain("backendAuth:");
    expect(config).toContain("passthrough: {}");
    expect(config).toContain("failureMode: failOpen");
    expect(config).not.toContain("prefixMode:");
    expect(config).not.toContain("prefixMode: always");
    expect(config).toContain("name: google");
    expect(config).not.toContain("name: google-workspace");
    expect(config).toMatch(
      /providers:\n\s+- issuer: http:\/\/host\.docker\.internal:38080[\s\S]*- issuer: https:\/\/mcp\.example\.com\/oauth/,
    );
    expect(config).toMatch(
      /resourceMetadata:[\s\S]*authorizationServers:\n\s+- https:\/\/mcp\.example\.com\/oauth/,
    );
    expect(config).toContain("resource: https://mcp.example.com/mcp");
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
    expect(override).toContain("HOP1_ISSUERS_JSON: ${GITHUB_SMOKE_HOP1_ISSUERS_JSON}");
    expect(config).toContain("name: google");
    expect(config).toContain("name: github");
    expect(config).toContain("host: http://github-wrapper:8080/mcp");
    expect(config).toContain("mcpAuthentication:");
    expect(config).toContain("scopesSupported: [openid, email]");
    expect(config).not.toContain("scopesSupported: [read:all]");
    expect(config).toContain("failureMode: failOpen");
  });

  test("runs the complete provider bundle against TLS PostgreSQL and safe fixtures", async () => {
    const [
      packageJson,
      workflow,
      smoke,
      compose,
      gatewayConfig,
      providerFixture,
      client,
      githubCatalogConformance,
    ] = await Promise.all([
      readFile("package.json", "utf8"),
      readFile(".github/workflows/release.yml", "utf8"),
      readFile("scripts/smoke-full-bundle.sh", "utf8"),
      readFile("deploy/compose/docker-compose.full-bundle-smoke.yaml", "utf8"),
      readFile("gateway/agentgateway/local-full-bundle-smoke.yaml", "utf8"),
      readFile("scripts/fixtures/provider-fixture.ts", "utf8"),
      readFile("scripts/fixtures/full-bundle-client.ts", "utf8"),
      readFile("scripts/fixtures/github-mcp-catalog-conformance.ts", "utf8"),
    ]);

    expect(packageJson).toContain('"integration:bundle": "bash scripts/smoke-full-bundle.sh"');
    expect(workflow).toContain("bun run integration:bundle");
    expect(workflow).toContain("LOCAL_AGENTGATEWAY_IMAGE: mcp-gw-agentgateway:smoke");
    expect(compose).toContain("ssl=on");
    expect(compose).toContain("sslmode=verify-full");
    expect(compose).toContain("sslrootcert=/tls/ca.crt");
    expect(compose).toContain(
      "ghcr.io/github/github-mcp-server@sha256:2b0c48b070f61e9d3969269ead600f62d00fb237b60ac849ef3d166ee7de9ad3",
    );
    expect(compose).toContain("GITHUB_TOOLSETS: all");
    expect(compose).toContain("GITHUB_MCP_GOVERNANCE_CATALOG: github-mcp-server@1.6.0/all");
    expect(compose).toContain(
      "GOOGLE_WORKSPACE_GOVERNANCE_CATALOG: google-workspace-cli@0.22.5/visible-v1/actions-v1",
    );
    expect(gatewayConfig).toMatch(
      /providers:\n\s+- issuer: http:\/\/host\.docker\.internal:18180[\s\S]*?allowedAlgorithms: \[RS256\]/,
    );
    expect(gatewayConfig).not.toMatch(/jwtValidationOptions:\n\s+allowedAlgorithms:/);
    expect(smoke).toContain("oauth-migrations");
    expect(smoke).toContain("missing-expiration");
    expect(smoke).toContain("compose_cmd up -d --build --wait token-store provider-fixture");
    expect(smoke).toContain("compose_cmd build oauth-migrations");
    expect(smoke).toContain("FULL_BUNDLE_USE_PREBUILT_IMAGES:-0");
    expect(smoke).toContain("LOCAL_GOOGLE_WORKSPACE_IMAGE");
    expect(smoke).toContain("LOCAL_GITHUB_WRAPPER_IMAGE");
    expect(smoke).toContain(
      "compose_cmd create --no-build --pull missing google-workspace github-wrapper agentgateway",
    );
    expect(smoke).toContain("compose_cmd start google-workspace github-wrapper agentgateway");
    expect(smoke.indexOf('bun "$ROOT_DIR/scripts/fixtures/hop1-fixture.ts"')).toBeLessThan(
      smoke.indexOf("compose_cmd start google-workspace github-wrapper agentgateway"),
    );
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
    expect(client).toContain("provider_oauth_required");
    expect(client).toContain("disconnectProvider");
    expect(client.match(/await createSession\(\)/g)).toHaveLength(1);
    expect(client.match(/await listTools\(/g)).toHaveLength(1);
    expect(client.match(/method: "tools\/list"/g)).toHaveLength(1);
    expect(githubCatalogConformance).toContain("listStableGithubTools");
    expect(githubCatalogConformance).toContain("parseGithubMcpToolsets");
    expect(githubCatalogConformance).toContain("pinned GitHub MCP tool schema drift");
    expect(githubCatalogConformance).toContain("pinnedGithubToolAnnotationsMatch");
    expect(smoke).toContain("github-mcp-catalog-conformance.ts");
    expect(smoke).toContain("assert_logs_do_not_contain_credentials");
  });
});
