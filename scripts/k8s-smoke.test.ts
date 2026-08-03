import { access, constants, readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

describe("Kubernetes smoke test", () => {
  test("installs the chart and verifies unavailable issuers fail closed", async () => {
    await access("scripts/smoke-k8s.sh", constants.X_OK);
    const smoke = await readFile("scripts/smoke-k8s.sh", "utf8");

    expect(smoke).toContain("helm upgrade --install");
    expect(smoke).toContain("kubectl rollout status");
    expect(smoke).toContain("values-k8s-smoke.yaml");
    expect(smoke).toContain("K8S_SMOKE_AGENTGATEWAY_REPOSITORY");
    expect(smoke).toContain("global.imagePullPolicy");
    expect(smoke).toContain("UNAVAILABLE_ISSUER_STATUS");
    expect(smoke).toContain("MCP_STATUS:%{http_code}");
    expect(smoke).toContain("sed -n");
    expect(smoke).toContain('[[ "$UNAVAILABLE_ISSUER_STATUS" == "401" ]]');
    expect(smoke).toContain("Kubernetes smoke failed; collecting namespace diagnostics");
    expect(smoke).toContain('kubectl describe deployment "$RELEASE_NAME-agentgateway"');
    expect(smoke).toContain('kubectl logs "deployment/$RELEASE_NAME-agentgateway"');
  });

  test("runs the Kubernetes smoke in GitHub CI", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");

    expect(workflow).toContain("helm/kind-action@");
    expect(workflow).toContain("repository: apelogic-ai/agentgateway");
    expect(workflow).toContain("ref: cb2fffdafe3d5e31216c82e9d16641c5f6a47cb8");
    expect(workflow).toContain("docker/build-push-action@");
    expect(workflow).toContain("kind load docker-image mcp-gw-agentgateway:smoke");
    expect(workflow).toContain("bun run integration:k8s");
  });
});
