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
    expect(template).toContain("range .Values.agentgateway.ingress.paths");
  });

  test("runs the Kubernetes smoke in GitHub CI", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");

    expect(workflow).toContain("helm/kind-action@");
    expect(workflow).toContain("repository: apelogic-ai/agentgateway");
    expect(workflow).toContain("ref: 360a5dfd2f088ddb91d8f506f329934fe8b92c43");
    expect(workflow).toContain("docker/build-push-action@");
    expect(workflow).toContain("kind load docker-image mcp-gw-agentgateway:smoke");
    expect(workflow).toContain("bun run integration:k8s");
  });

  test("starts migrations and provider workloads as non-root processes in Kind", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");
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
