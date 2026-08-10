import { describe, expect, test } from "bun:test";

describe("Kubernetes production chart", () => {
  test("ships wrapper images with a numeric non-root runtime user", async () => {
    const dockerfiles = await Promise.all([
      Bun.file("servers/google-workspace/wrapper/Dockerfile").text(),
      Bun.file("servers/github-mcp/wrapper/Dockerfile").text(),
    ]);

    for (const dockerfile of dockerfiles) {
      expect(dockerfile).toContain("USER 10001:10001");
      expect(dockerfile).toContain("HOME=/tmp");
    }
  });

  test("renders no workloads or identity choices by default", async () => {
    const rendered = helmTemplate();
    const values = await Bun.file("deploy/k8s/chart/values.yaml").text();

    expect(rendered).not.toContain("kind: Deployment");
    expect(rendered).not.toContain("kind: Job");
    expect(rendered).not.toContain("name: mcp-gateway-google-workspace");
    expect(rendered).not.toContain("name: mcp-gateway-db-mcp");
    expect(rendered).not.toContain("name: mcp-gateway-github-mcp");
    expect(rendered).not.toContain("kind: ExternalSecret");
    expect(rendered).not.toContain("kind: HorizontalPodAutoscaler");
    expect(rendered).not.toContain("kind: PodDisruptionBudget");
    expect(rendered).not.toContain("kind: Ingress");
    expect(values).not.toMatch(/^\s+issuer:\s+/m);
    expect(values).not.toMatch(/^\s+audiences:\s*$/m);
    expect(values).not.toMatch(/^\s+jwksUrl:\s+/m);
    expect(values).not.toMatch(/^\s+allowedAlgorithms:\s*$/m);
    expect(rendered).not.toMatch(/apelogic\.io/i);
    expect(rendered).not.toMatch(new RegExp(["arn", "aws"].join(":"), "i"));
    expect(rendered).not.toMatch(/\.dkr\.ecr\./i);
  });

  test("renders a blocking, secret-backed OAuth migration hook", () => {
    const rendered = helmTemplate([
      "--set",
      "oauthMigrations.enabled=true",
      "--set",
      "oauthMigrations.secretKeyRef.name=oauth-database",
      "--set",
      "oauthMigrations.secretKeyRef.key=dsn",
    ]);

    expect(rendered).toContain("kind: Job");
    expect(rendered).toContain('helm.sh/hook: "pre-install,pre-upgrade"');
    expect(rendered).toContain('helm.sh/hook-delete-policy: "before-hook-creation,hook-succeeded"');
    expect(rendered).toContain("name: TOKEN_STORE_DSN");
    expect(rendered).toContain("name: oauth-database");
    expect(rendered).toContain("key: dsn");
    expect(rendered).toContain("shared/oauth/migrate.ts");
    expect(rendered).toContain("restartPolicy: Never");
  });

  test("rejects an enabled OAuth migration without a complete Secret key reference", () => {
    for (const args of [
      ["--set", "oauthMigrations.enabled=true"],
      [
        "--set",
        "oauthMigrations.enabled=true",
        "--set",
        "oauthMigrations.secretKeyRef.name=oauth-database",
      ],
    ]) {
      const result = helmTemplateResult(args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toMatch(/oauthMigrations.*secretKeyRef/);
    }
  });

  test("mounts one operator-owned PostgreSQL CA bundle into every OAuth database client", () => {
    const rendered = helmTemplate([
      "--values",
      "deploy/k8s/examples/values-production-bundle.example.yaml",
      "--set",
      "postgresql.caBundle.enabled=true",
      "--set",
      "postgresql.caBundle.configMapKeyRef.name=database-ca",
      "--set",
      "postgresql.caBundle.configMapKeyRef.key=ca.pem",
    ]);

    const databaseClientDocuments = rendered
      .split("---")
      .filter((document) => document.includes("kind: Deployment") || document.includes("kind: Job"))
      .filter((document) =>
        ["oauth-migrations", "google-workspace", "github-wrapper"].some((component) =>
          document.includes(`app.kubernetes.io/component: ${component}`),
        ),
      );

    expect(databaseClientDocuments).toHaveLength(3);
    for (const document of databaseClientDocuments) {
      expect(document).toContain("name: POSTGRES_CA_BUNDLE_PATH");
      expect(document).toContain('value: "/var/run/secrets/mcp-gateway/postgresql/ca.crt"');
      expect(document).toContain("name: postgresql-ca");
      expect(document).toContain('mountPath: "/var/run/secrets/mcp-gateway/postgresql"');
      expect(document).toContain("readOnly: true");
      expect(document).toContain("name: database-ca");
      expect(document).toContain("key: ca.pem");
      expect(document).toContain("path: ca.crt");
    }
  });

  test("supports a Secret-backed PostgreSQL CA bundle without rendering its value", () => {
    const rendered = helmTemplate([
      "--values",
      "deploy/k8s/examples/values-production-bundle.example.yaml",
      "--set",
      "postgresql.caBundle.enabled=true",
      "--set",
      "postgresql.caBundle.secretKeyRef.name=database-ca",
      "--set",
      "postgresql.caBundle.secretKeyRef.key=ca.pem",
    ]);

    expect(rendered).toContain("secret:");
    expect(rendered).toContain("name: database-ca");
    expect(rendered).toContain("key: ca.pem");
    expect(rendered).not.toContain("BEGIN CERTIFICATE");
  });

  test("rejects incomplete, ambiguous, or silently disabled PostgreSQL CA references", () => {
    const invalidArgs = [
      [
        "--set",
        "postgresql.caBundle.enabled=true",
        "--set",
        "postgresql.caBundle.configMapKeyRef.name=database-ca",
      ],
      [
        "--set",
        "postgresql.caBundle.enabled=true",
        "--set",
        "postgresql.caBundle.configMapKeyRef.name=database-ca",
        "--set",
        "postgresql.caBundle.configMapKeyRef.key=ca.pem",
        "--set",
        "postgresql.caBundle.secretKeyRef.name=database-ca-secret",
        "--set",
        "postgresql.caBundle.secretKeyRef.key=ca.pem",
      ],
      [
        "--set",
        "postgresql.caBundle.enabled=true",
        "--set",
        "postgresql.caBundle.configMapKeyRef.name=database-ca",
        "--set",
        "postgresql.caBundle.configMapKeyRef.key=ca.pem",
        "--set",
        "postgresql.caBundle.secretKeyRef.name=partial-database-ca-secret",
      ],
      [
        "--set",
        "postgresql.caBundle.enabled=true",
        "--set",
        "postgresql.caBundle.secretKeyRef.name=database-ca-secret",
        "--set",
        "postgresql.caBundle.secretKeyRef.key=ca.pem",
        "--set",
        "postgresql.caBundle.configMapKeyRef.key=partial-ca.pem",
      ],
      [
        "--set",
        "postgresql.caBundle.configMapKeyRef.name=database-ca",
        "--set",
        "postgresql.caBundle.configMapKeyRef.key=ca.pem",
      ],
    ];

    for (const args of invalidArgs) {
      const result = helmTemplateResult(args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toMatch(/postgresql(?:\.|\/)caBundle/);
    }
  });

  test("uses existing Kubernetes Secrets without creating provider-specific secret resources", () => {
    const rendered = helmTemplate([
      "--values",
      "deploy/k8s/examples/values-k8s-smoke.yaml",
      "--values",
      "deploy/k8s/examples/values-private-overlay.example.yaml",
    ]);

    expect(rendered).toContain("name: mcp-runtime");
    expect(rendered).toContain("secretRef:");
    expect(rendered).not.toContain("kind: ExternalSecret");
    expect(rendered).not.toContain("secretStoreRef:");
    expect(rendered).not.toContain("remoteKey:");
  });

  test("uses component-scoped selectors so workloads cannot overlap", () => {
    const rendered = helmTemplate([
      "--values",
      "deploy/k8s/examples/values-k8s-smoke.yaml",
      "--values",
      "deploy/k8s/examples/values-private-overlay.example.yaml",
    ]);

    expect(rendered).toContain("app.kubernetes.io/component: agentgateway");
    expect(rendered).toContain("app.kubernetes.io/component: google-workspace");
    expect(rendered).toContain("app.kubernetes.io/component: db-mcp");
    expect(rendered).toContain("selector:");
    expect(rendered).toContain("type: ClusterIP");
  });

  test("renders agentgateway MCP backend targets from values", () => {
    const rendered = helmTemplate([
      "--values",
      "deploy/k8s/examples/values-k8s-smoke.yaml",
      "--values",
      "deploy/k8s/examples/values-extra-backend.example.yaml",
    ]);

    expect(rendered).not.toContain("name: mcp-gateway-db-mcp");
    expect(rendered).toContain("failureMode: failOpen");
    expect(rendered).toContain("prefixMode: never");
    expect(rendered).not.toContain("host: http://mcp-gateway-db-mcp:8080/mcp");
    expect(rendered).toContain("name: enterprise-search");
    expect(rendered).toContain("host: http://enterprise-search.search.svc.cluster.local:8080/mcp");
  });

  test("renders optional GitHub wrapper and internal official MCP workload", () => {
    const rendered = helmTemplate([
      "--values",
      "deploy/k8s/examples/values-k8s-smoke.yaml",
      "--values",
      "deploy/k8s/examples/values-github-mcp.example.yaml",
    ]);

    expect(rendered).toContain("name: mcp-gateway-github-wrapper");
    expect(rendered).toContain("image: ghcr.io/apelogic-ai/mcp-gw-github-wrapper:0.2.9");
    expect(rendered).toContain("GITHUB_MCP_UPSTREAM_URL");
    expect(rendered).toContain("name: mcp-runtime");
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

    const githubMcpDeployment = rendered
      .split("---")
      .find(
        (document) =>
          document.includes("kind: Deployment") &&
          document.includes("name: mcp-gateway-github-mcp"),
      );
    expect(githubMcpDeployment).toBeDefined();
    expect(githubMcpDeployment).toMatch(/name: github-mcp[\s\S]*runAsUser: 10001/);
    expect(githubMcpDeployment).toMatch(/name: github-mcp[\s\S]*runAsGroup: 10001/);
  });

  test("renders the opt-in full provider bundle production profile", () => {
    const rendered = helmTemplate([
      "--values",
      "deploy/k8s/examples/values-production-bundle.example.yaml",
    ]);

    expect(rendered).toContain("kind: Job");
    expect(rendered).toContain("name: mcp-gateway-agentgateway");
    expect(rendered).toContain("name: mcp-gateway-google-workspace");
    expect(rendered).toContain("name: mcp-gateway-github-wrapper");
    expect(rendered).toContain("name: mcp-gateway-github-mcp");
    expect(rendered).toContain("name: google-workspace");
    expect(rendered).toContain("name: github-mcp");
    expect(rendered).toContain("name: mcp-provider-runtime");
    expect(rendered).toContain("name: mcp-oauth-database");
    expect(rendered).toMatch(
      /jwtValidationOptions:\n\s+requiredClaims:\n\s+- exp\n\s+- iss\n\s+- sub\n\s+- aud/,
    );
    expect(rendered).not.toContain("kind: Ingress");
  });

  test("rejects incomplete production profiles and incomplete or duplicate provider targets", () => {
    for (const args of [
      ["--set", "productionProfile.enabled=true"],
      [
        "--values",
        "deploy/k8s/examples/values-production-bundle.example.yaml",
        "--set-json",
        "agentgateway.backends=[]",
      ],
      [
        "--values",
        "deploy/k8s/examples/values-production-bundle.example.yaml",
        "--set",
        "agentgateway.backends[0].enabled=false",
      ],
      [
        "--values",
        "deploy/k8s/examples/values-production-bundle.example.yaml",
        "--set",
        "agentgateway.backends[1].enabled=false",
      ],
      [
        "--values",
        "deploy/k8s/examples/values-production-bundle.example.yaml",
        "--set",
        "agentgateway.backends[1].name=google-workspace",
      ],
    ]) {
      const result = helmTemplateResult(args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toMatch(/productionProfile/);
    }
  });

  test("does not expose the agentgateway admin UI by default", async () => {
    const rendered = helmTemplate(["--values", "deploy/k8s/examples/values-k8s-smoke.yaml"]);
    const examplesReadme = await readExample("README.md");

    expect(rendered).not.toContain("port: 15000");
    expect(rendered).not.toContain("targetPort: admin");
    expect(examplesReadme).toContain("Do not expose the agentgateway Admin UI");
    expect(examplesReadme).toContain("kubectl port-forward");
  });

  test("renders Google Workspace YAML policy from values", () => {
    const rendered = helmTemplate([
      "--values",
      "deploy/k8s/examples/values-k8s-smoke.yaml",
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
      "deploy/k8s/examples/values-k8s-smoke.yaml",
      "--values",
      "deploy/k8s/examples/values-private-overlay.example.yaml",
    ]);

    expect(rendered).toContain("host: mcp-gateway.internal.example.com");
    expect(rendered).toContain("ingressClassName: nginx");
    expect(rendered).toContain("ghcr.io/example/mcp-gateway-google-workspace");
    expect(rendered).toContain("ghcr.io/example/mcp-gateway-db-mcp");
    expect(rendered).toContain("ghcr.io/example/agentgateway");
    expect(rendered).toContain("name: mcp-runtime");
  });

  test("supports the complete environment-owned workload contract", () => {
    const rendered = helmTemplate([
      "--values",
      "deploy/k8s/examples/values-enterprise-contract.example.yaml",
    ]);

    expect(rendered).toContain(
      "image: ghcr.io/example/agentgateway@sha256:1111111111111111111111111111111111111111111111111111111111111111",
    );
    expect(rendered).toContain("type: ClusterIP");
    expect(rendered).toContain("replicas: 2");
    expect(rendered).toContain("name: existing-agentgateway-sa");
    expect(rendered).toContain("identity.example.com/workload: gateway");
    expect(rendered).toContain("nodeSelector:");
    expect(rendered).toContain("kubernetes.io/os: linux");
    expect(rendered).toContain("tolerations:");
    expect(rendered).toContain("affinity:");
    expect(rendered).toContain("topologySpreadConstraints:");
    expect(rendered).toContain("livenessProbe:");
    expect(rendered).toContain("readinessProbe:");
    expect(rendered).toContain("kind: HorizontalPodAutoscaler");
    expect(rendered).toContain("kind: PodDisruptionBudget");
  });

  test("renders multiple HOP-1 issuers and secret-backed introspection credentials", () => {
    const rendered = helmTemplate([
      "--values",
      "deploy/k8s/examples/values-enterprise-contract.example.yaml",
    ]);

    expect(rendered).toContain("issuer: https://identity.example.com");
    expect(rendered).toContain("issuer: https://automation.example.com");
    expect(rendered).toContain("allowedAlgorithms:");
    expect(rendered).toContain("- EdDSA");
    expect(rendered).toContain("url: https://identity.example.com/.well-known/jwks.json");
    expect(rendered).toContain("url: https://automation.example.com/oauth2/introspect");
    expect(rendered).toContain(
      "credentialFile: /var/run/secrets/mcp-gateway/introspection/issuer-1",
    );
    expect(rendered).toContain("name: hop1-introspection");
    expect(rendered).toContain("mountPath: /var/run/secrets/mcp-gateway/introspection");
    expect(rendered).toContain("path: issuer-1");
    expect(rendered).toContain("HOP1_ISSUERS_JSON");
    expect(rendered).toContain("introspectionClientCredentialEnv");
    expect(rendered).toContain("HOP1_INTROSPECTION_CREDENTIAL_1");
    expect(rendered).toContain("secretKeyRef:");
    expect(rendered).toContain("name: identity-runtime");
    expect(rendered).toContain("key: introspection-client-credential");
    expect(rendered).not.toContain('introspectionClientCredential":"');

    const configStart = rendered.indexOf("config.yaml: |");
    const config = rendered.slice(configStart, rendered.indexOf("\n---\n# Source:", configStart));
    expect(config).not.toContain("identity-runtime");
    expect(config).not.toContain("introspection-client-credential");
  });

  test("rejects issuer profiles without a non-empty algorithm allowlist", () => {
    const issuer = {
      name: "fixture",
      issuer: "https://issuer.example.com",
      audiences: ["https://mcp.example.com/mcp"],
      jwksUrl: "https://issuer.example.com/.well-known/jwks.json",
    };

    const missing = helmTemplateResult(["--set-json", `hop1.issuers=[${JSON.stringify(issuer)}]`]);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr.toString()).toMatch(/allowedAlgorithms/);

    const empty = helmTemplateResult([
      "--set-json",
      `hop1.issuers=[${JSON.stringify({ ...issuer, allowedAlgorithms: [] })}]`,
    ]);
    expect(empty.exitCode).not.toBe(0);
    expect(empty.stderr.toString()).toMatch(/allowedAlgorithms/);
  });

  test("rejects enabled authenticated workloads without an issuer profile", () => {
    for (const component of ["agentgateway", "googleWorkspace", "githubWrapper"]) {
      const result = helmTemplateResult(["--set", `${component}.enabled=true`]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toMatch(/hop1(?:\.|\/)issuers/);
    }
  });

  test("rejects malformed introspection secret references", () => {
    const result = helmTemplateResult([
      "--set-json",
      `hop1.issuers=[${JSON.stringify({
        name: "fixture",
        issuer: "https://issuer.example.com",
        audiences: ["https://mcp.example.com/mcp"],
        jwksUrl: "https://issuer.example.com/.well-known/jwks.json",
        allowedAlgorithms: ["EdDSA"],
        introspection: {
          url: "https://issuer.example.com/oauth/introspect",
          credentialSecretKeyRef: { name: "", key: "credential" },
        },
      })}]`,
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toMatch(/credentialSecretKeyRef/);
  });

  test("normalizes one issuer to failure-isolated provider configuration", () => {
    const rendered = helmTemplate(["--values", "deploy/k8s/examples/values-k8s-smoke.yaml"]);
    const config = rendered.slice(
      rendered.indexOf("config.yaml: |"),
      rendered.indexOf("---\napiVersion: apps/v1"),
    );

    expect(config).toContain("mcpAuthentication:");
    expect(config).toContain("providers:");
    expect(config).toContain("- issuer: https://unavailable.example.com");
    expect(config).not.toMatch(/\n\s+issuer: https:\/\/unavailable\.example\.com/);
  });

  test("ships a JSON schema that rejects invalid chart values", async () => {
    const schema = await Bun.file("deploy/k8s/chart/values.schema.json").json();
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");

    const result = Bun.spawnSync({
      cmd: [
        "helm",
        "template",
        "mcp-gateway",
        "deploy/k8s/chart",
        "--set-string",
        "agentgateway.replicas=not-a-number",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toMatch(/agentgateway(?:\.|\/)replicas/);
  });

  test("ships Flux and Argo CD consumer examples", async () => {
    const flux = await readExample("flux-helmrelease.yaml");
    const argo = await readExample("argocd-application.yaml");

    expect(flux).toContain("kind: HelmRelease");
    expect(flux).toContain("kind: OCIRepository");
    expect(flux).toContain("oci://ghcr.io/apelogic-ai/charts/mcp-gateway");
    expect(flux).toContain("chartRef:");
    expect(flux).toContain("valuesFrom:");
    expect(argo).toContain("kind: Application");
    expect(argo).toContain("repoURL: ghcr.io/apelogic-ai/charts");
    expect(argo).toContain("chart: mcp-gateway");
    expect(argo).toContain("$values/");
  });

  test("public deployment examples do not contain private environment values", async () => {
    const examples = await readAllExampleFiles();
    const privatePatterns = [
      /18\.210\.100\.44/,
      /54\.211\.134\.28/,
      new RegExp(["project", "n"].join(""), "i"),
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
  const result = helmTemplateResult(extraArgs);

  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}

function helmTemplateResult(extraArgs: string[] = []): Bun.SyncSubprocess<"pipe", "pipe"> {
  return Bun.spawnSync({
    cmd: ["helm", "template", "mcp-gateway", "deploy/k8s/chart", ...extraArgs],
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function readExample(fileName: string): Promise<string> {
  return Bun.file(`deploy/k8s/examples/${fileName}`).text();
}

async function readAllExampleFiles(): Promise<Map<string, string>> {
  const files = [
    "README.md",
    "argocd-application.yaml",
    "flux-helmrelease.yaml",
    "values-extra-backend.example.yaml",
    "values-enterprise-contract.example.yaml",
    "values-github-mcp.example.yaml",
    "values-google-policy.example.yaml",
    "values-private-overlay.example.yaml",
    "values-production-bundle.example.yaml",
  ];
  const contents = new Map<string, string>();

  for (const file of files) {
    contents.set(file, await readExample(file));
  }

  return contents;
}
