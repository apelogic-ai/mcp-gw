import { access, chmod, constants, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

describe("Kubernetes smoke test", () => {
  test("runs without image overrides on Bash 3", async () => {
    const mockBin = await mkdtemp(join(tmpdir(), "mcp-gw-k8s-smoke-"));

    try {
      const helm = join(mockBin, "helm");
      const kubectl = join(mockBin, "kubectl");
      await writeFile(helm, "#!/bin/sh\nexit 0\n");
      await writeFile(
        kubectl,
        `#!/bin/sh
case "$*" in
  "logs mcp-metadata-probe"*) echo 'METADATA_STATUS:200' ;;
  "logs mcp-auth-probe"*) echo 'MCP_STATUS:401' ;;
  "get deployment"*) printf '1' ;;
esac
exit 0
`,
      );
      await Promise.all([chmod(helm, 0o755), chmod(kubectl, 0o755)]);

      const smokeProcess = Bun.spawn(["/bin/bash", "scripts/smoke-k8s.sh"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${mockBin}:${process.env.PATH}`,
          K8S_SMOKE_CREATE_CLUSTER: "false",
        },
        stderr: "pipe",
        stdout: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([
        smokeProcess.exited,
        new Response(smokeProcess.stderr).text(),
      ]);

      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
    } finally {
      await rm(mockBin, { force: true, recursive: true });
    }
  });

  test("installs the chart and verifies unavailable issuers fail closed", async () => {
    await access("scripts/smoke-k8s.sh", constants.X_OK);
    const smoke = await readFile("scripts/smoke-k8s.sh", "utf8");

    expect(smoke).toContain("helm upgrade --install");
    expect(smoke).toContain("kubectl rollout status");
    expect(smoke).toContain("values-k8s-smoke.yaml");
    expect(smoke).toContain("K8S_SMOKE_AGENTGATEWAY_REPOSITORY");
    expect(smoke).toContain("global.imagePullPolicy");
    expect(smoke).toContain("UNAVAILABLE_ISSUER_STATUS");
    expect(smoke).toContain("METADATA_STATUS");
    expect(smoke).toContain("MCP_STATUS:%{http_code}");
    expect(smoke).toContain("sed -n");
    expect(smoke).toContain("run_probe() {");
    expect(smoke).toContain("kubectl wait");
    expect(smoke).toContain('kubectl logs "$pod_name"');
    expect(smoke).toContain('kubectl delete pod "$pod_name"');
    expect(smoke).not.toContain("--attach");
    expect(smoke).not.toContain("--rm");
    expect(smoke).toContain('[[ "$UNAVAILABLE_ISSUER_STATUS" == "401" ]]');
    expect(smoke).toContain('[[ "$METADATA_STATUS" == "200" ]]');
    expect(smoke).toContain("Kubernetes smoke failed; collecting namespace diagnostics");
    expect(smoke).toContain('kubectl describe deployment "$RELEASE_NAME-agentgateway"');
    expect(smoke).toContain('kubectl logs "deployment/$RELEASE_NAME-agentgateway"');
  });

  test("renders public MCP and unauthenticated metadata ingress paths", async () => {
    const template = await readFile("deploy/k8s/chart/templates/agentgateway/ingress.yaml", "utf8");
    const values = await readFile("deploy/k8s/chart/values.yaml", "utf8");

    expect(values).toContain("paths:");
    expect(values).toContain("- /mcp");
    expect(values).toContain("- /.well-known/oauth-protected-resource/mcp");
    expect(template).toContain("$resourcePaths := .Values.agentgateway.ingress.paths");
    expect(template).toContain("oauth-authorization-server");
    expect(template).toContain("$brokerPaths");
  });

  test("runs the Kubernetes smoke in the release workflow, not PR CI", async () => {
    const [ciWorkflow, releaseWorkflow] = await Promise.all([
      readFile(".github/workflows/ci.yml", "utf8"),
      readFile(".github/workflows/release.yml", "utf8"),
    ]);

    expect(ciWorkflow).not.toContain("helm/kind-action@");
    expect(ciWorkflow).not.toContain("docker/build-push-action@");
    expect(releaseWorkflow).toContain("helm/kind-action@");
    expect(releaseWorkflow).toContain("repository: apelogic-ai/agentgateway");
    expect(releaseWorkflow).toContain("ref: 360a5dfd2f088ddb91d8f506f329934fe8b92c43");
    expect(releaseWorkflow).toContain("docker/build-push-action@");
    expect(releaseWorkflow).toContain("kind load docker-image mcp-gw-agentgateway:smoke");
    expect(releaseWorkflow).toContain("bun run integration:k8s");
  });

  test("tests broker fanout with the published release images before publishing the chart", async () => {
    await access("scripts/smoke-k8s-broker-integration.sh", constants.X_OK);
    const [packageJson, smoke, values, workflow, hop1Fixture] = await Promise.all([
      readFile("package.json", "utf8"),
      readFile("scripts/smoke-k8s-broker-integration.sh", "utf8"),
      readFile("deploy/k8s/examples/values-k8s-broker-smoke.yaml", "utf8"),
      readFile(".github/workflows/release.yml", "utf8"),
      readFile("scripts/fixtures/hop1-fixture.ts", "utf8"),
    ]);

    expect(packageJson).toContain(
      '"integration:k8s:broker": "bash scripts/smoke-k8s-broker-integration.sh"',
    );
    expect(smoke).toContain("K8S_BROKER_SMOKE_AGENTGATEWAY_REPOSITORY");
    expect(smoke).toContain("K8S_BROKER_SMOKE_GOOGLE_REPOSITORY");
    expect(smoke).toContain("K8S_BROKER_SMOKE_GITHUB_WRAPPER_REPOSITORY");
    expect(smoke).toContain(
      "google_oauth_start,google_oauth_status,github_oauth_start,github_oauth_status",
    );
    expect(smoke).toContain("--invalid-token-directory");
    expect(smoke).toContain("--reuse-values");
    expect(smoke).toContain("broker-ready=verified");
    expect(smoke).toContain("initContainers:");
    expect(smoke).toContain("name: wait-for-agentgateway");
    expect(smoke).toContain("GATEWAY_URL");
    expect(smoke).toContain("fetch(process.env.GATEWAY_URL");
    expect(smoke).toContain("Date.now() + 30_000");
    expect(smoke).toContain('[[ "$client_phase" == "Succeeded" ]]');
    expect(smoke).not.toContain("rollout restart");
    expect(values).toContain("fixture-enterprise");
    expect(values).toContain("authorizationBroker:");
    expect(values).toContain("dcr:");
    expect(values).toContain("githubMcp:");
    expect(values).toContain("enabled: true");
    expect(hop1Fixture).toContain('key_ops: ["sign"]');

    const releasedSmokeStart = workflow.indexOf("  released-kubernetes-broker-smoke:");
    const publishChartStart = workflow.indexOf("  publish-chart:");
    expect(releasedSmokeStart).toBeGreaterThan(workflow.indexOf("  publish-images:"));
    expect(publishChartStart).toBeGreaterThan(releasedSmokeStart);
    const releasedSmoke = workflow.slice(releasedSmokeStart, publishChartStart);
    expect(releasedSmoke).toContain("needs: publish-images");
    expect(releasedSmoke).toContain("bun run integration:k8s:broker");
    expect(releasedSmoke).toContain("kind load docker-image");
    expect(releasedSmoke).toContain(
      "ghcr.io/${GITHUB_REPOSITORY_OWNER}/mcp-gw-agentgateway:$VERSION",
    );
    expect(releasedSmoke).toContain(
      "ghcr.io/${GITHUB_REPOSITORY_OWNER}/mcp-gw-google-workspace:$VERSION",
    );
    expect(releasedSmoke).toContain(
      "ghcr.io/${GITHUB_REPOSITORY_OWNER}/mcp-gw-github-wrapper:$VERSION",
    );

    const publishChart = workflow.slice(publishChartStart, workflow.indexOf("  promote-ecr:"));
    expect(publishChart).toContain("released-kubernetes-broker-smoke");
  });

  test("starts migrations and provider workloads as non-root processes in Kind", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    const smoke = await readFile("scripts/smoke-k8s-provider-runtime.sh", "utf8");
    const values = await readFile(
      "deploy/k8s/examples/values-k8s-provider-runtime-smoke.yaml",
      "utf8",
    );

    expect(workflow).toContain("servers/google-workspace/wrapper/Dockerfile");
    expect(workflow).toContain("servers/github-mcp/wrapper/Dockerfile");
    expect(workflow).toContain("mcp-gw-google-workspace:smoke");
    expect(workflow).toContain("mcp-gw-github-wrapper:smoke");
    expect(workflow).toContain("ghcr.io/github/github-mcp-server:v1.6.0");
    expect(workflow).toContain(
      "kind load docker-image ghcr.io/github/github-mcp-server:v1.6.0 --name mcp-gateway-smoke",
    );
    expect(workflow).toContain("smoke-k8s-provider-runtime.sh");
    expect(smoke).toContain("oauth_schema_migrations");
    expect(smoke).toContain("rollout status");
    expect(smoke).toContain("google-workspace");
    expect(smoke).toContain("github-wrapper");
    expect(smoke).toContain("deployment/$RELEASE_NAME-github-mcp");
    expect(smoke).toContain("GITHUB_OAUTH_CLIENT_ID=fixture-github-client");
    expect(smoke).toContain("GITHUB_OAUTH_CLIENT_SECRET=fixture-github-secret");
    expect(smoke).toContain(
      "GITHUB_OAUTH_REDIRECT_URI=https://mcp.example.com/oauth/github/callback",
    );
    expect(smoke).toContain("id -u");
    expect(smoke).toContain('[[ "$GOOGLE_UID" == "10001" ]]');
    expect(smoke).toContain('[[ "$GITHUB_UID" == "10001" ]]');
    expect(smoke).toContain("securityContext.runAsUser");
    expect(smoke).toContain("securityContext.runAsGroup");
    expect(smoke).toContain('[[ "$GITHUB_MCP_UID" == "10001" ]]');
    expect(smoke).toContain('[[ "$GITHUB_MCP_GID" == "10001" ]]');
    expect(values).toMatch(/githubMcp:\n\s+enabled: true/);
  });
});
