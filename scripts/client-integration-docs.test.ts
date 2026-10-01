import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

describe("client integration documentation", () => {
  test("documents enterprise MCP-GW integration without naming private client apps", async () => {
    const [readme, runbook, providerFlows] = await Promise.all([
      readFile("README.md", "utf8"),
      readFile("docs/client-integration-runbook.md", "utf8"),
      readFile("docs/provider-connection-flows.md", "utf8"),
    ]);

    expect(readme).toContain("docs/client-integration-runbook.md");
    expect(runbook).toContain("Status: public enterprise template");
    expect(runbook).toContain("Claude");
    expect(runbook).toContain("Codex");
    expect(runbook).toContain("HOP-1");
    expect(runbook).toContain("HOP-2");
    expect(runbook).toContain("Provider Connection Flows");
    expect(runbook).toContain("google_oauth_status");
    expect(runbook).toContain("google_oauth_start");
    expect(runbook).toContain("identity-only");
    expect(runbook).toContain("mcp_authentication_failed classification=<reason>");
    expect(runbook).toContain("invalid_signature");
    expect(runbook).toContain("never includes tokens, claims, client IDs");
    expect(providerFlows).toContain("Stable provider discovery");
    expect(providerFlows).toContain("github_oauth_status");
    expect(providerFlows).toContain("provider_oauth_required");
    expect(providerFlows).toContain("does not need another");
    expect(runbook).toContain("Do not commit");
    expect(runbook.toLowerCase()).not.toContain(`bur${"ble"}`);
  });

  test("keeps release, lifecycle-route, and minimal-values guidance internally consistent", async () => {
    const [
      releases,
      externalIssuer,
      directClient,
      chartReadme,
      quickstart,
      providerFlows,
      lifecycle,
      runbook,
      releaseHandoff,
    ] = await Promise.all([
      readFile("docs/releases.md", "utf8"),
      readFile("docs/external-platform-issuer.md", "utf8"),
      readFile("docs/direct-client-oauth-contract.md", "utf8"),
      readFile("deploy/k8s/chart/README.md", "utf8"),
      readFile("docs/quickstart.md", "utf8"),
      readFile("docs/provider-connection-flows.md", "utf8"),
      readFile("docs/provider-connection-lifecycle.md", "utf8"),
      readFile("docs/client-integration-runbook.md", "utf8"),
      readFile("docs/release-handoff.md", "utf8"),
    ]);

    expect(releases).toContain("Before 1.0");
    expect(releases).toContain("0.5.0 upgrade notes");
    expect(releases).toContain("Kubernetes 1.32");
    expect(releases).toContain("resourceMetadata.resource");
    expect(releases).toMatch(/at least one enabled\s+backend/);
    expect(externalIssuer).toContain(
      "/connections/{provider}/{authorize,status,refresh,disconnect}",
    );
    expect(directClient).toContain("/oauth/google/refresh");
    expect(directClient).toContain("/oauth/github/refresh");
    expect(directClient).toMatch(/Provider\s+callback routes are not compatibility aliases/);
    expect(chartReadme).toContain("An AgentGateway deployment additionally requires");
    expect(chartReadme).toMatch(/at\s+least one enabled backend/);
    expect(chartReadme).toContain("oauth_redirect_target_not_allowed");
    expect(chartReadme).toContain("githubWrapper.oauth.redirectAfterAllowedOrigins");
    expect(lifecycle).toContain("Stable `code`");
    expect(lifecycle).toContain("oauth_persistence_failure");
    expect(lifecycle).toContain("SHA-256 correlation hash");
    for (const document of [quickstart, providerFlows, directClient]) {
      expect(document).not.toContain("/oauth/{provider}/*");
    }
    expect(providerFlows).toContain("/oauth/{provider}/{start,status,refresh,disconnect}");
    expect(runbook).toContain("/oauth/google/refresh");
    expect(runbook).toContain("/oauth/github/refresh");
    expect(releaseHandoff).toContain("/oauth/{provider}/{start,status,refresh,disconnect}");
  });
});
