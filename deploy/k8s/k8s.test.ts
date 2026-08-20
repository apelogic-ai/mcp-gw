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
    expect(values).not.toMatch(/^\s+issuer:\s+https?:/m);
    expect(values).not.toMatch(/^\s+audiences:\s*$/m);
    expect(values).not.toMatch(/^\s+jwksUrl:\s+/m);
    expect(values).not.toMatch(/^\s+allowedAlgorithms:\s*$/m);
    expect(rendered).not.toMatch(/apelogic\.io/i);
    expect(rendered).not.toMatch(new RegExp(["arn", "aws"].join(":"), "i"));
    expect(rendered).not.toMatch(/\.dkr\.ecr\./i);
    expect(rendered).not.toContain("MCP_BROKER_");
    expect(rendered).not.toContain("broker-signing-keyring");
    expect(rendered).not.toContain("/var/run/secrets/mcp-gateway/broker");
  });

  test("renders a complete OAuth broker contract with a read-only Secret keyring projection", () => {
    const rendered = helmTemplate([
      "--values",
      "deploy/k8s/examples/values-oauth-broker.example.yaml",
    ]);
    const deployment = renderedResource(rendered, "Deployment", "mcp-gateway-google-workspace");
    const gatewayConfig = renderedResource(
      rendered,
      "ConfigMap",
      "mcp-gateway-agentgateway-config",
    );
    const ingress = renderedResource(rendered, "Ingress", "mcp-gateway-agentgateway");
    const networkPolicy = renderedResource(
      rendered,
      "NetworkPolicy",
      "mcp-gateway-google-workspace",
    );

    expect(deployment).toContain("name: MCP_BROKER_ENABLED");
    expect(deployment).toContain('value: "true"');
    expect(deployment).toContain("name: MCP_AUTHORIZATION_ISSUER");
    expect(deployment).toContain('value: "https://mcp.example.com/oauth"');
    expect(deployment).toContain("name: MCP_RESOURCE_URI");
    expect(deployment).toContain('value: "https://mcp.example.com/mcp"');
    expect(deployment).toContain("name: MCP_BROKER_GOOGLE_REDIRECT_URI");
    expect(deployment).toContain('value: "https://mcp.example.com/oauth/google/broker/callback"');
    expect(deployment).toContain("name: MCP_BROKER_ACTIVE_KID");
    expect(deployment).toContain('value: "broker-signing-2026-08"');
    expect(deployment).toContain("name: MCP_BROKER_SIGNING_JWKS_FILE");
    expect(deployment).toContain('value: "/var/run/secrets/mcp-gateway/broker/signing-jwks.json"');
    expect(deployment).toContain("name: MCP_DCR_ENABLED");
    expect(deployment).toContain("name: broker-signing-keyring");
    expect(deployment).toContain("secretName: mcp-broker-signing-keyring");
    expect(deployment).toContain("key: signing-jwks.json");
    expect(deployment).toContain("path: signing-jwks.json");
    expect(deployment).toContain("defaultMode: 0440");
    expect(deployment).toContain("fsGroup: 10001");
    expect(deployment).toContain("fsGroupChangePolicy: OnRootMismatch");
    expect(deployment).toContain('mountPath: "/var/run/secrets/mcp-gateway/broker"');
    expect(deployment).toContain("readOnly: true");
    expect(deployment).not.toContain("BEGIN PRIVATE KEY");
    expect(deployment).not.toContain('value: "{\\"keys\\"');
    expect(deployment).not.toMatch(/name: MCP_BROKER_SIGNING_JWKS_FILE[\s\S]{0,120}secretKeyRef:/);
    expect(gatewayConfig).toContain("- issuer: https://mcp.example.com/oauth");
    expect(gatewayConfig).toContain("- https://mcp.example.com/mcp");
    expect(gatewayConfig).toContain("url: https://mcp.example.com/oauth/.well-known/jwks.json");
    expect(gatewayConfig).toMatch(/scopesSupported:\n\s+- mcp/);
    for (const path of [
      "/mcp",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server/oauth",
      "/oauth/authorize",
      "/oauth/token",
      "/oauth/register",
      "/oauth/.well-known/jwks.json",
      "/oauth/google/broker/callback",
    ]) {
      expect(ingress).toContain(`path: ${path}`);
    }
    expect(ingress).toMatch(/path: \/oauth\/authorize[\s\S]*?name: mcp-gateway-google-workspace/);
    expect(ingress).toMatch(/path: \/mcp[\s\S]*?name: mcp-gateway-agentgateway/);
    expect(networkPolicy).toContain("ports:");
    expect(networkPolicy).toContain("app.kubernetes.io/component: agentgateway");
    expect(networkPolicy).toContain("kubernetes.io/metadata.name: ingress-nginx");
    expect(networkPolicy).toContain("app.kubernetes.io/component: controller");
    expect(networkPolicy).toMatch(/namespaceSelector:[\s\S]*podSelector:/);
    expect(ingress).toMatch(/path: \/oauth\/authorize\n\s+pathType: Exact/);
  });

  test("keeps broker env, Secret projection, and mount absent when broker mode is disabled", () => {
    const rendered = helmTemplate([
      "--values",
      "deploy/k8s/examples/values-production-bundle.example.yaml",
    ]);
    const deployment = renderedResource(rendered, "Deployment", "mcp-gateway-google-workspace");

    expect(deployment).not.toContain("MCP_BROKER_");
    expect(deployment).not.toContain("MCP_AUTHORIZATION_ISSUER");
    expect(deployment).not.toContain("MCP_RESOURCE_URI");
    expect(deployment).not.toContain("broker-signing-keyring");
    expect(deployment).not.toContain("/var/run/secrets/mcp-gateway/broker");
    expect(rendered).not.toContain("/.well-known/oauth-authorization-server");
  });

  test("rejects broker mode without a complete signing keyring Secret reference", () => {
    for (const [field, value] of [
      ["name", ""],
      ["key", ""],
    ]) {
      const result = helmTemplateResult([
        "--values",
        "deploy/k8s/examples/values-oauth-broker.example.yaml",
        "--set-string",
        `googleWorkspace.authorizationBroker.signingKeyring.secretKeyRef.${field}=${value}`,
      ]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toMatch(/authorizationBroker.*signingKeyring.*secretKeyRef/);
    }
  });

  test("rejects partial or incoherent non-secret broker configuration", () => {
    const invalidOverrides = [
      "googleWorkspace.authorizationBroker.issuer=",
      "googleWorkspace.authorizationBroker.resource=http://mcp.example.com/mcp",
      "googleWorkspace.authorizationBroker.googleCallbackUri=https://other.example.com/oauth/google/broker/callback",
      "googleWorkspace.authorizationBroker.activeSigningKid=",
      "googleWorkspace.authorizationBroker.dcr.enabled=false",
      "agentgateway.mcpAuthentication.resourceMetadata.scopesSupported[0]=openid",
    ];

    for (const override of invalidOverrides) {
      const result = helmTemplateResult([
        "--values",
        "deploy/k8s/examples/values-oauth-broker.example.yaml",
        "--set-string",
        override,
      ]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toMatch(/authorizationBroker/);
    }

    const silentlyDisabled = helmTemplateResult([
      "--set",
      "googleWorkspace.authorizationBroker.issuer=https://mcp.example.com/oauth",
    ]);
    expect(silentlyDisabled.exitCode).not.toBe(0);
    expect(silentlyDisabled.stderr.toString()).toMatch(/authorizationBroker/);

    for (const selector of ["namespaceSelector", "podSelector"]) {
      const missingIngressPeer = helmTemplateResult([
        "--values",
        "deploy/k8s/examples/values-oauth-broker.example.yaml",
        "--set-json",
        `googleWorkspace.authorizationBroker.ingressControllerPeer.${selector}.matchLabels={}`,
      ]);
      expect(missingIngressPeer.exitCode).not.toBe(0);
      expect(missingIngressPeer.stderr.toString()).toMatch(/ingressControllerPeer/);
    }

    const disabledScopeOverride = helmTemplateResult([
      "--set-string",
      "googleWorkspace.authorizationBroker.scopes[0]=openid",
    ]);
    expect(disabledScopeOverride.exitCode).not.toBe(0);
    expect(disabledScopeOverride.stderr.toString()).toMatch(/authorizationBroker/);

    const disabledDcrPolicy = helmTemplateResult([
      "--values",
      "deploy/k8s/examples/values-oauth-broker.example.yaml",
      "--set",
      "googleWorkspace.authorizationBroker.dcr.enabled=false",
      "--set-string",
      "googleWorkspace.authorizationBroker.staticClients[0].clientId=static-client",
      "--set-string",
      "googleWorkspace.authorizationBroker.staticClients[0].redirectUris[0]=https://client.example.com/callback",
      "--set",
      "googleWorkspace.authorizationBroker.dcr.rateLimit=10",
    ]);
    expect(disabledDcrPolicy.exitCode).not.toBe(0);
    expect(disabledDcrPolicy.stderr.toString()).toMatch(/authorizationBroker.*dcr/);

    const loopbackClient = [
      "--values",
      "deploy/k8s/examples/values-oauth-broker.example.yaml",
      "--set-string",
      "googleWorkspace.authorizationBroker.staticClients[0].clientId=native-client",
      "--set-string",
      "googleWorkspace.authorizationBroker.staticClients[0].redirectUris[0]=http://127.0.0.1:53682/callback",
    ];
    const rejectedLoopback = helmTemplateResult(loopbackClient);
    expect(rejectedLoopback.exitCode).not.toBe(0);
    expect(rejectedLoopback.stderr.toString()).toMatch(/loopback/);

    const acceptedLoopback = helmTemplateResult([
      ...loopbackClient,
      "--set",
      "googleWorkspace.authorizationBroker.dcr.allowLoopbackRedirects=true",
    ]);
    expect(acceptedLoopback.exitCode).toBe(0);
  });

  test("rejects broker URLs that are not canonical public HTTPS endpoints", () => {
    const invalidCases: string[][] = [
      ["--set-string", "googleWorkspace.authorizationBroker.issuer=https://localhost/oauth"],
      ["--set-string", "googleWorkspace.authorizationBroker.issuer=https://10.0.0.1/oauth"],
      ["--set-string", "googleWorkspace.authorizationBroker.issuer=https://broker.internal/oauth"],
      ["--set-string", "googleWorkspace.authorizationBroker.issuer=https://intranet/oauth"],
      ["--set-string", "googleWorkspace.authorizationBroker.issuer=https://[2001:db8::1]/oauth"],
      [
        "--set-string",
        "googleWorkspace.authorizationBroker.issuer=https://user:pass@mcp.example.com/oauth",
      ],
      ["--set-string", "googleWorkspace.authorizationBroker.resource=https://192.168.1.1/mcp"],
      [
        "--set-string",
        "googleWorkspace.authorizationBroker.googleCallbackUri=https://localhost/oauth/callback",
      ],
      ["--set-string", "googleWorkspace.authorizationBroker.resource=https://mcp.example.com/mcp/"],
      [
        "--set-string",
        "googleWorkspace.authorizationBroker.googleCallbackUri=https://mcp.example.com/a/../oauth/callback",
      ],
      [
        "--set-string",
        "googleWorkspace.authorizationBroker.googleCallbackUri=https://mcp.example.com/oauth/%2e%2e/callback",
      ],
      [
        "--set-json",
        `googleWorkspace.authorizationBroker.issuer=${JSON.stringify("https://mcp.example.com/oauth\\evil")}`,
      ],
      [
        "--set-string",
        "googleWorkspace.authorizationBroker.googleCallbackUri=https://mcp.example.com/oauth/call back",
      ],
    ];

    for (const args of invalidCases) {
      const result = helmTemplateResult([
        "--values",
        "deploy/k8s/examples/values-oauth-broker.example.yaml",
        ...args,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toMatch(/authorizationBroker/);
    }

    for (const host of ["localhost", "10.0.0.1", "broker.internal"]) {
      const result = helmTemplateResult([
        "--values",
        "deploy/k8s/examples/values-oauth-broker.example.yaml",
        "--set-string",
        `googleWorkspace.authorizationBroker.issuer=https://${host}/oauth`,
        "--set-string",
        `googleWorkspace.authorizationBroker.resource=https://${host}/mcp`,
        "--set-string",
        `googleWorkspace.authorizationBroker.googleCallbackUri=https://${host}/oauth/google/broker/callback`,
        "--set-string",
        `agentgateway.ingress.host=${host}`,
        "--set-string",
        `agentgateway.mcpAuthentication.resourceMetadata.resource=https://${host}/mcp`,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toMatch(/authorizationBroker/);
    }
  });

  test("rejects every broker route collision before deployment", () => {
    for (const callbackPath of [
      "/oauth/authorize",
      "/oauth/token",
      "/oauth/register",
      "/oauth/.well-known/jwks.json",
      "/.well-known/oauth-authorization-server/oauth",
      "/.well-known/oauth-protected-resource/mcp",
      "/mcp",
      "/oauth/google/start",
      "/oauth/google/status",
      "/oauth/google/disconnect",
      "/oauth/google/callback",
      "/oauth/github/start",
      "/oauth/github/status",
      "/oauth/github/disconnect",
      "/oauth/github/callback",
    ]) {
      const result = helmTemplateResult([
        "--values",
        "deploy/k8s/examples/values-oauth-broker.example.yaml",
        "--set-string",
        `googleWorkspace.authorizationBroker.googleCallbackUri=https://mcp.example.com${callbackPath}`,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toMatch(/authorizationBroker.*route/i);
    }

    const resourceCollision = helmTemplateResult([
      "--values",
      "deploy/k8s/examples/values-oauth-broker.example.yaml",
      "--set-string",
      "googleWorkspace.authorizationBroker.resource=https://mcp.example.com/oauth/token",
      "--set-string",
      "agentgateway.mcpAuthentication.resourceMetadata.resource=https://mcp.example.com/oauth/token",
      "--set-json",
      'agentgateway.ingress.paths=["/oauth/token","/.well-known/oauth-protected-resource/oauth/token"]',
    ]);
    expect(resourceCollision.exitCode).not.toBe(0);
    expect(resourceCollision.stderr.toString()).toMatch(/authorizationBroker.*route/i);

    const operatorPathCollision = helmTemplateResult([
      "--values",
      "deploy/k8s/examples/values-oauth-broker.example.yaml",
      "--set-json",
      'agentgateway.ingress.paths=["/mcp","/.well-known/oauth-protected-resource/mcp","/oauth/token"]',
    ]);
    expect(operatorPathCollision.exitCode).not.toBe(0);
    expect(operatorPathCollision.stderr.toString()).toMatch(/ingress\.paths/);
  });

  test("rejects static clients that the runtime registry would reject", () => {
    const validClient = {
      clientId: "browser-client",
      redirectUris: ["https://client.example.com/callback"],
      clientName: "Example client",
      clientUri: "https://client.example.com/app?source=mcp",
      scopes: ["mcp"],
    };
    const invalidClients = [
      { ...validClient, clientId: "x" },
      { ...validClient, clientId: "bad client" },
      { ...validClient, clientId: "x".repeat(201) },
      { ...validClient, scopes: ["admin"] },
      { ...validClient, clientUri: "https://localhost/app" },
      { ...validClient, clientUri: "https://10.0.0.1/app" },
      { ...validClient, redirectUris: ["https://user:pass@client.example.com/callback"] },
      { ...validClient, redirectUris: ["https://192.168.1.1/callback"] },
      { ...validClient, redirectUris: ["https://192.0.1.1/callback"] },
      { ...validClient, redirectUris: ["https://999.999.999.999/callback"] },
      { ...validClient, redirectUris: ["https://client.example.com"] },
      { ...validClient, redirectUris: ["https://client.example.com:99999/callback"] },
      { ...validClient, redirectUris: ["https://client.example.com/cb\\x"] },
      { ...validClient, redirectUris: ["https://client.example.com/call back"] },
      { ...validClient, redirectUris: ["https://client.example.com/callback?x=hello world"] },
      {
        ...validClient,
        redirectUris: Array.from(
          { length: 11 },
          (_, i) => `https://client.example.com/callback-${i}`,
        ),
      },
    ];

    for (const client of invalidClients) {
      const result = helmTemplateResult([
        "--values",
        "deploy/k8s/examples/values-oauth-broker.example.yaml",
        "--set-json",
        `googleWorkspace.authorizationBroker.staticClients=[${JSON.stringify(client)}]`,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toMatch(/authorizationBroker|values don't meet/i);
    }

    const accepted = helmTemplateResult([
      "--values",
      "deploy/k8s/examples/values-oauth-broker.example.yaml",
      "--set-json",
      `googleWorkspace.authorizationBroker.staticClients=[${JSON.stringify(validClient)}]`,
    ]);
    expect(accepted.exitCode).toBe(0);

    const duplicateIds = helmTemplateResult([
      "--values",
      "deploy/k8s/examples/values-oauth-broker.example.yaml",
      "--set-json",
      `googleWorkspace.authorizationBroker.staticClients=[${JSON.stringify(validClient)},${JSON.stringify({ ...validClient, redirectUris: ["https://other.example.com/callback"] })}]`,
    ]);
    expect(duplicateIds.exitCode).not.toBe(0);

    for (const redirect of [
      "http://127.0.0.1:080/callback",
      "http://localhost/callback/../other",
      "http://localhost",
      "http://localhost/cb\\x",
      "http://localhost/call back",
      "http://localhost/callback?x=hello world",
    ]) {
      const invalidLoopback = helmTemplateResult([
        "--values",
        "deploy/k8s/examples/values-oauth-broker.example.yaml",
        "--set",
        "googleWorkspace.authorizationBroker.dcr.allowLoopbackRedirects=true",
        "--set-json",
        `googleWorkspace.authorizationBroker.staticClients=[${JSON.stringify({ ...validClient, redirectUris: [redirect] })}]`,
      ]);
      expect(invalidLoopback.exitCode).not.toBe(0);
    }

    const canonicalLoopback = helmTemplateResult([
      "--values",
      "deploy/k8s/examples/values-oauth-broker.example.yaml",
      "--set",
      "googleWorkspace.authorizationBroker.dcr.allowLoopbackRedirects=true",
      "--set-json",
      `googleWorkspace.authorizationBroker.staticClients=[${JSON.stringify({ ...validClient, redirectUris: ["http://native.localhost:53682/callback?source=mcp"] })}]`,
    ]);
    expect(canonicalLoopback.exitCode).toBe(0);
  });

  test("rejects malformed trusted proxy IP literals and unsafe DCR bounds", () => {
    for (const address of ["not-an-ip", "10.0.0.999", "01.2.3.4", "2001:DB8::1"]) {
      const result = helmTemplateResult([
        "--values",
        "deploy/k8s/examples/values-oauth-broker.example.yaml",
        "--set-string",
        "googleWorkspace.authorizationBroker.dcr.trustedProxy.header=x-forwarded-for",
        "--set-string",
        `googleWorkspace.authorizationBroker.dcr.trustedProxy.addresses[0]=${address}`,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toMatch(/authorizationBroker|values don't meet/i);
    }

    const unsafeBound = helmTemplateResult([
      "--values",
      "deploy/k8s/examples/values-oauth-broker.example.yaml",
      "--set-string",
      "googleWorkspace.authorizationBroker.dcr.maxClients=9007199254740992",
    ]);
    expect(unsafeBound.exitCode).not.toBe(0);

    for (const address of ["203.0.113.10", "2001:db8::1", "1:2:3:4:5::1.2.3.4", "::1.2.3.4"]) {
      const accepted = helmTemplateResult([
        "--values",
        "deploy/k8s/examples/values-oauth-broker.example.yaml",
        "--set-string",
        "googleWorkspace.authorizationBroker.dcr.trustedProxy.header=x-forwarded-for",
        "--set-string",
        `googleWorkspace.authorizationBroker.dcr.trustedProxy.addresses[0]=${address}`,
      ]);
      expect(accepted.exitCode).toBe(0);
    }
  });

  test("rejects broker scope transport ambiguities and direct Google hop-1 trust", () => {
    for (const scope of ["bad scope", "bad,scope", "bad\\scope", "mcp💥"]) {
      const result = helmTemplateResult([
        "--values",
        "deploy/k8s/examples/values-oauth-broker.example.yaml",
        "--set-json",
        `googleWorkspace.authorizationBroker.scopes=[${JSON.stringify(scope)}]`,
        "--set-json",
        `agentgateway.mcpAuthentication.resourceMetadata.scopesSupported=[${JSON.stringify(scope)}]`,
      ]);
      expect(result.exitCode).not.toBe(0);
    }

    const googleHop1 = helmTemplateResult([
      "--values",
      "deploy/k8s/examples/values-oauth-broker.example.yaml",
      "--set-json",
      'hop1.issuers=[{"name":"google","issuer":"https://accounts.google.com","audiences":["google-client"],"jwksUrl":"https://www.googleapis.com/oauth2/v3/certs","allowedAlgorithms":["RS256"]}]',
    ]);
    expect(googleHop1.exitCode).not.toBe(0);
    expect(googleHop1.stderr.toString()).toMatch(/authorizationBroker|Google/i);
  });

  test("rejects broker configuration and signing material through generic environment values", async () => {
    for (const name of [
      "MCP_BROKER_ENABLED",
      "MCP_BROKER_SIGNING_JWKS_FILE",
      "MCP_DCR_ENABLED",
      "MCP_AUTHORIZATION_ISSUER",
      "MCP_RESOURCE_URI",
      "MCP_OAUTH_STATIC_CLIENTS_JSON",
    ]) {
      const result = helmTemplateResult([
        "--values",
        "deploy/k8s/examples/values-production-bundle.example.yaml",
        "--set-string",
        `googleWorkspace.env.${name}=forbidden`,
      ]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toMatch(/googleWorkspace\.env.*reserved/);
    }

    const files = await Promise.all([
      Bun.file("deploy/k8s/chart/values.yaml").text(),
      Bun.file("deploy/k8s/examples/values-oauth-broker.example.yaml").text(),
    ]);
    for (const content of files) {
      expect(content).not.toMatch(/BEGIN (?:RSA |EC )?PRIVATE KEY/);
      expect(content).not.toMatch(/^\s*(?:kty|d|p|q|dp|dq|qi):/m);
    }
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
    expect(rendered).toContain("image: ghcr.io/apelogic-ai/mcp-gw-github-wrapper:0.2.12");
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
    const deployment = renderedResource(rendered, "Deployment", "mcp-gateway-agentgateway");

    expect(rendered).toContain("issuer: https://identity.example.com");
    expect(rendered).toContain("issuer: https://automation.example.com");
    expect(rendered).toContain("allowedAlgorithms:");
    expect(rendered).toContain("- EdDSA");
    expect(rendered).toContain("url: https://identity.example.com/.well-known/jwks.json");
    expect(rendered).toContain("url: https://automation.example.com/oauth2/introspect");
    expect(rendered).toContain(
      "credentialFile: /var/run/secrets/mcp-gateway/introspection/issuer-1",
    );
    expect(deployment).toContain("name: hop1-introspection");
    expect(deployment).toContain("mountPath: /var/run/secrets/mcp-gateway/introspection");
    expect(deployment).toContain("readOnly: true");
    expect(deployment).toContain("runAsNonRoot: true");
    expect(deployment).toContain("runAsUser: 65532");
    expect(deployment).toContain("runAsGroup: 65532");
    expect(deployment).toContain("fsGroup: 65532");
    expect(deployment).toContain("fsGroupChangePolicy: OnRootMismatch");
    expect(deployment).toContain("allowPrivilegeEscalation: false");
    expect(deployment).toContain("readOnlyRootFilesystem: true");
    expect(deployment).toContain("defaultMode: 0440");
    expect(deployment).not.toContain("defaultMode: 0444");
    expect(deployment).toContain("path: issuer-1");
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

function renderedResource(rendered: string, kind: string, name: string): string {
  const resource = rendered
    .split(/^---$/m)
    .find(
      (document) =>
        document.includes(`kind: ${kind}\n`) && document.includes(`\n  name: ${name}\n`),
    );

  expect(resource).toBeDefined();
  return resource!;
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
    "values-oauth-broker.example.yaml",
    "values-private-overlay.example.yaml",
    "values-production-bundle.example.yaml",
  ];
  const contents = new Map<string, string>();

  for (const file of files) {
    contents.set(file, await readExample(file));
  }

  return contents;
}
