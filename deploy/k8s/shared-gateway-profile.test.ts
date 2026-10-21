import { expect, test } from "bun:test";
import { parse, parseAllDocuments } from "yaml";

const PROFILE = "deploy/k8s/examples/values-shared-gateway.example.yaml";
const EXACT_SEMVER = /^\d+\.\d+\.\d+$/u;
const CLUSTER_SCOPED_KINDS = new Set([
  "APIService",
  "ClusterRole",
  "ClusterRoleBinding",
  "CustomResourceDefinition",
  "MutatingWebhookConfiguration",
  "Namespace",
  "Node",
  "PersistentVolume",
  "PriorityClass",
  "StorageClass",
  "ValidatingWebhookConfiguration",
]);

type Resource = {
  kind?: string;
  spec?: Record<string, unknown>;
};

test("shared-gateway profile is namespaced, baseline-secure, and explicit", async () => {
  const values = parse(await Bun.file(PROFILE).text()) as {
    agentgateway: {
      image: { repository: string; tag: string };
      gatewayApi: { httpRoute: { timeouts: { request: string } } };
    };
    dbMcp: {
      image: { repository: string; tag: string };
      secretRef: { name: string };
      databaseUrl: { secretKey: string };
    };
  };
  const rendered = helmTemplate(PROFILE);
  const resources = parseAllDocuments(rendered)
    .map((document) => document.toJSON() as Resource | null)
    .filter((resource): resource is Resource => resource !== null);

  expect(resources.length).toBeGreaterThan(0);
  expect(resources.some((resource) => resource.kind === "Secret")).toBe(false);
  for (const resource of resources) {
    expect(CLUSTER_SCOPED_KINDS.has(resource.kind ?? ""), resource.kind).toBe(false);
  }

  const podSpecs = resources.flatMap(podSpecsFor);
  expect(podSpecs.length).toBeGreaterThan(0);
  const declaredImages = new Set([
    imageRef(values.agentgateway.image),
    imageRef(values.dbMcp.image),
  ]);
  for (const podSpec of podSpecs) {
    expect(podSpec.hostNetwork).not.toBe(true);
    expect(podSpec.hostPID).not.toBe(true);
    expect(podSpec.hostIPC).not.toBe(true);
    expect(
      (podSpec.nodeSelector as Record<string, unknown> | undefined)?.["kubernetes.io/arch"],
    ).toBe("amd64");
    for (const volume of recordArray(podSpec.volumes)) expect(volume.hostPath).toBeUndefined();
    for (const container of [
      ...recordArray(podSpec.initContainers),
      ...recordArray(podSpec.containers),
      ...recordArray(podSpec.ephemeralContainers),
    ]) {
      expect(
        (container.securityContext as Record<string, unknown> | undefined)?.privileged,
      ).not.toBe(true);
      expect(declaredImages.has(String(container.image)), String(container.image)).toBe(true);
    }
  }

  const routes = resources.filter((resource) => resource.kind === "HTTPRoute");
  expect(routes.length).toBeGreaterThan(0);
  const requests = routes.flatMap((route) =>
    recordArray(route.spec?.rules).map((rule) =>
      String((rule.timeouts as Record<string, unknown> | undefined)?.request ?? ""),
    ),
  );
  expect(requests.every(Boolean)).toBe(true);
  expect(requests).toContain("0s");
  expect(values.agentgateway.gatewayApi.httpRoute.timeouts.request).toBe("0s");
  expect(values.dbMcp.secretRef.name).toBe("runtime-secrets");
  expect(values.dbMcp.databaseUrl.secretKey).toBe("database-url");

  for (const tag of [values.agentgateway.image.tag, values.dbMcp.image.tag]) {
    expect(tag).toMatch(EXACT_SEMVER);
  }
  const chart = parse(await Bun.file("deploy/k8s/chart/Chart.yaml").text()) as {
    version: string;
    appVersion: string;
  };
  expect(chart.version).toMatch(EXACT_SEMVER);
  expect(chart.appVersion).toMatch(EXACT_SEMVER);
  const releaseWorkflow = await Bun.file(".github/workflows/release.yml").text();
  expect(releaseWorkflow).toContain("architecture: amd64");
  expect(releaseWorkflow).toContain("platform: linux/amd64");
});

function helmTemplate(profile: string): string {
  const result = Bun.spawnSync([
    "helm",
    "template",
    "mcp-gateway",
    "deploy/k8s/chart",
    "--kube-version",
    "1.32.0",
    "--values",
    profile,
  ]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString();
}

function imageRef(image: { repository: string; tag: string }): string {
  return `${image.repository}:${image.tag}`;
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

function podSpecsFor(resource: Resource): Array<Record<string, unknown>> {
  const directTemplate = resource.spec?.template as { spec?: Record<string, unknown> } | undefined;
  if (directTemplate?.spec) return [directTemplate.spec];
  const jobTemplate = resource.spec?.jobTemplate as
    { spec?: { template?: { spec?: Record<string, unknown> } } } | undefined;
  return jobTemplate?.spec?.template?.spec ? [jobTemplate.spec.template.spec] : [];
}
