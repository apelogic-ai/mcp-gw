import { describe, expect, test } from "bun:test";

describe("Kubernetes production chart", () => {
  test("renders gateway public ingress and internal backend workloads", () => {
    const rendered = helmTemplate();

    expect(rendered).toContain("kind: Deployment");
    expect(rendered).toContain("name: mcp-gateway-agentgateway");
    expect(rendered).toContain("image: ghcr.io/apelogic-ai/agentgateway:v1.1.0-apelogic.1");
    expect(rendered).toContain("name: mcp-gateway-google-workspace");
    expect(rendered).toContain("name: mcp-gateway-db-mcp");
    expect(rendered).not.toContain("name: mcp-gateway-github-mcp");
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

  test("renders agentgateway MCP backend targets from values", () => {
    const rendered = helmTemplate([
      "--values",
      "deploy/k8s/examples/values-extra-backend.example.yaml",
    ]);

    expect(rendered).toContain("name: mcp-gateway-db-mcp");
    expect(rendered).not.toContain("host: http://mcp-gateway-db-mcp:8080/mcp");
    expect(rendered).toContain("name: enterprise-search");
    expect(rendered).toContain("host: http://enterprise-search.search.svc.cluster.local:8080/mcp");
  });

  test("renders optional GitHub wrapper and internal official MCP workload", () => {
    const rendered = helmTemplate([
      "--values",
      "deploy/k8s/examples/values-github-mcp.example.yaml",
    ]);

    expect(rendered).toContain("name: mcp-gateway-github-wrapper");
    expect(rendered).toContain("image: mcp-gateway/github-wrapper:dev");
    expect(rendered).toContain("GITHUB_MCP_UPSTREAM_URL");
    expect(rendered).toContain("github-wrapper-runtime");
    expect(rendered).toContain("name: mcp-gateway-github-mcp");
    expect(rendered).toContain("image: ghcr.io/github/github-mcp-server:v1.6.0");
    expect(rendered).toContain("name: github-mcp");
    expect(rendered).toContain("host: http://mcp-gateway-github-wrapper:8080/mcp");
    expect(rendered).toContain("GITHUB_TOOLSETS");
    expect(rendered).not.toContain("GITHUB_PERSONAL_ACCESS_TOKEN");
    expect(rendered).toContain(
      'value: "default,actions,code_security,discussions,notifications,orgs,projects"',
    );
    expect(rendered).toContain("app.kubernetes.io/component: github-wrapper");
  });

  test("does not expose the agentgateway admin UI by default", async () => {
    const rendered = helmTemplate();
    const examplesReadme = await readExample("README.md");

    expect(rendered).not.toContain("port: 15000");
    expect(rendered).not.toContain("targetPort: admin");
    expect(examplesReadme).toContain("Do not expose the agentgateway Admin UI");
    expect(examplesReadme).toContain("kubectl port-forward");
  });

  test("renders Google Workspace YAML policy from values", () => {
    const rendered = helmTemplate([
      "--values",
      "deploy/k8s/examples/values-google-policy.example.yaml",
    ]);

    expect(rendered).toContain("name: mcp-gateway-google-workspace-policy");
    expect(rendered).toContain("GOOGLE_WORKSPACE_POLICY_FILE");
    expect(rendered).toContain("/etc/mcp-gw/google-workspace-policy.yaml");
    expect(rendered).toContain("default: deny");
    expect(rendered).toContain("actionClass: read");
  });

  test("renders with the private overlay example values", () => {
    const rendered = helmTemplate([
      "--values",
      "deploy/k8s/examples/values-private-overlay.example.yaml",
    ]);

    expect(rendered).toContain("host: mcp-gateway.internal.example.com");
    expect(rendered).toContain("ingressClassName: nginx");
    expect(rendered).toContain("ghcr.io/example/mcp-gateway-google-workspace");
    expect(rendered).toContain("ghcr.io/example/mcp-gateway-db-mcp");
    expect(rendered).toContain("ghcr.io/example/agentgateway");
    expect(rendered).toContain("mcp-gateway/prod/google-workspace");
    expect(rendered).toContain("mcp-gateway/prod/db-mcp");
  });

  test("ships Flux and Argo CD consumer examples", async () => {
    const flux = await readExample("flux-helmrelease.yaml");
    const argo = await readExample("argocd-application.yaml");
    const secretStore = await readExample("clustersecretstore-aws.yaml");

    expect(flux).toContain("kind: HelmRelease");
    expect(flux).toContain("kind: GitRepository");
    expect(flux).toContain("valuesFiles:");
    expect(argo).toContain("kind: Application");
    expect(argo).toContain("path: deploy/k8s/chart");
    expect(secretStore).toContain("kind: ClusterSecretStore");
    expect(secretStore).toContain("service: SecretsManager");
  });

  test("public deployment examples do not contain private environment values", async () => {
    const examples = await readAllExampleFiles();
    const privatePatterns = [
      /18\.210\.100\.44/,
      /54\.211\.134\.28/,
      /projectn/,
      /apelogic/i,
      new RegExp(`bur${"ble"}`, "i"),
      /\/Users\/lbelyaev/,
      /\/private\/tmp/,
      /client_secret\s*[:=]\s*[^<{\n]/i,
      /refresh_token\s*[:=]\s*[^<{\n]/i,
    ];

    for (const content of examples.values()) {
      for (const pattern of privatePatterns) {
        expect(content).not.toMatch(pattern);
      }
    }
  });
});

function helmTemplate(extraArgs: string[] = []): string {
  const result = Bun.spawnSync({
    cmd: ["helm", "template", "mcp-gateway", "deploy/k8s/chart", ...extraArgs],
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}

async function readExample(fileName: string): Promise<string> {
  return Bun.file(`deploy/k8s/examples/${fileName}`).text();
}

async function readAllExampleFiles(): Promise<Map<string, string>> {
  const files = [
    "README.md",
    "argocd-application.yaml",
    "clustersecretstore-aws.yaml",
    "flux-helmrelease.yaml",
    "values-extra-backend.example.yaml",
    "values-github-mcp.example.yaml",
    "values-google-policy.example.yaml",
    "values-private-overlay.example.yaml",
  ];
  const contents = new Map<string, string>();

  for (const file of files) {
    contents.set(file, await readExample(file));
  }

  return contents;
}
