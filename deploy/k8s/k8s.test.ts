import { describe, expect, test } from "bun:test";

describe("Kubernetes production chart", () => {
  test("renders gateway public ingress and internal backend workloads", () => {
    const rendered = helmTemplate();

    expect(rendered).toContain("kind: Deployment");
    expect(rendered).toContain("name: mcp-gateway-agentgateway");
    expect(rendered).toContain("name: mcp-gateway-google-workspace");
    expect(rendered).toContain("name: mcp-gateway-db-mcp");
    expect(rendered).toContain("kind: ExternalSecret");
    expect(rendered).toContain("kind: NetworkPolicy");
    expect(rendered).toContain("kind: HorizontalPodAutoscaler");
    expect(rendered).toContain("kind: PodDisruptionBudget");
    expect(rendered).toContain("kind: Ingress");
    expect(rendered).toContain("name: mcp-gateway-agentgateway");
    expect(rendered).not.toContain("name: mcp-gateway-google-workspace-ingress");
    expect(rendered).not.toContain("name: mcp-gateway-db-mcp-ingress");
  });

  test("uses component-scoped selectors so workloads cannot overlap", () => {
    const rendered = helmTemplate();

    expect(rendered).toContain("app.kubernetes.io/component: agentgateway");
    expect(rendered).toContain("app.kubernetes.io/component: google-workspace");
    expect(rendered).toContain("app.kubernetes.io/component: db-mcp");
    expect(rendered).toContain("selector:");
    expect(rendered).toContain("type: ClusterIP");
  });
});

function helmTemplate(): string {
  const result = Bun.spawnSync({
    cmd: ["helm", "template", "mcp-gateway", "deploy/k8s/chart"],
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}
