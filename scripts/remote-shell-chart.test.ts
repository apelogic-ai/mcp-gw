import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

const chart = "deploy/k8s/chart";
const issuer = JSON.stringify([
  {
    name: "fixture-identity",
    issuer: "https://identity.example.com",
    audiences: ["https://gateway.example.com/shell"],
    jwksUrl: "https://identity.example.com/.well-known/jwks.json",
    allowedAlgorithms: ["EdDSA"],
    discoverable: true,
    emailClaim: "email",
    subjectClaim: "sub",
  },
]);
const ingressPeers = JSON.stringify([
  {
    namespaceSelector: {
      matchLabels: { "kubernetes.io/metadata.name": "gateway-system" },
    },
  },
]);
const parentRefs = JSON.stringify([
  { name: "shared-gateway", namespace: "gateway-system", sectionName: "https" },
]);
const enabledValues = [
  "--set",
  "remoteShell.enabled=true",
  "--set-string",
  "remoteShell.image.repository=registry.example.com/mcp/remote-shell",
  "--set-string",
  "remoteShell.image.tag=candidate",
  "--set",
  "remoteShell.serviceAccount.create=true",
  "--set-string",
  "remoteShell.bindingsSecretRef.name=remote-shell-bindings",
  "--set-string",
  "remoteShell.bindingsSecretRef.key=bindings.json",
  "--set-string",
  "remoteShell.runBinding.tagKey=example:run-id",
  "--set-json",
  `remoteShell.networkPolicy.ingressPeers=${ingressPeers}`,
  "--set",
  "remoteShell.ingress.enabled=false",
  "--set",
  "remoteShell.gatewayApi.httpRoute.enabled=true",
  "--set-string",
  "remoteShell.gatewayApi.httpRoute.hostname=gateway.example.com",
  "--set-json",
  `remoteShell.gatewayApi.httpRoute.parentRefs=${parentRefs}`,
  "--set-string",
  "remoteShell.gatewayApi.httpRoute.timeouts.request=2m",
  "--set-json",
  `hop1.issuers=${issuer}`,
];

describe("remote-shell chart", () => {
  test("renders no remote-shell workload or route by default", () => {
    const rendered = render([]);
    expect(rendered.exitCode).toBe(0);
    expect(rendered.stdout).not.toContain("app.kubernetes.io/component: remote-shell");
    expect(rendered.stdout).not.toContain("value: /shell");
  });

  test("renders the isolated service, identity, binding Secret, and timed shell route", () => {
    const rendered = render(enabledValues);
    expect(rendered.exitCode, rendered.stderr).toBe(0);
    expect(rendered.stdout).toContain("app.kubernetes.io/component: remote-shell");
    expect(rendered.stdout).toContain("image: registry.example.com/mcp/remote-shell:candidate");
    expect(rendered.stdout).toContain("serviceAccountName: mcp-gateway-remote-shell");
    expect(rendered.stdout).toContain("name: REMOTE_SHELL_BINDINGS_JSON");
    expect(rendered.stdout).toContain("name: remote-shell-bindings");
    expect(rendered.stdout).toContain("key: bindings.json");
    expect(rendered.stdout).toContain("name: REMOTE_SHELL_RUN_TAG_KEY");
    expect(rendered.stdout).toContain('value: "example:run-id"');
    expect(rendered.stdout).toContain("value: /shell");
    expect(rendered.stdout).toContain("request: 2m");
    expect(rendered.stdout).not.toContain("value: /mcp");
  });

  test("refuses every incomplete remote-shell security control", () => {
    const cases: Array<[string, string[], string]> = [
      [
        "image repository",
        ["--set-string", "remoteShell.image.repository="],
        "image.repository is required",
      ],
      ["single replica", ["--set", "remoteShell.replicas=2"], "remoteShell.replicas must be 1"],
      [
        "workload identity",
        [
          "--set",
          "remoteShell.serviceAccount.create=false",
          "--set-string",
          "remoteShell.serviceAccount.name=",
        ],
        "remoteShell.enabled requires serviceAccount.create=true or serviceAccount.name",
      ],
      [
        "binding Secret name",
        ["--set-string", "remoteShell.bindingsSecretRef.name="],
        "remoteShell.enabled requires bindingsSecretRef.name and key",
      ],
      [
        "binding Secret key",
        ["--set-string", "remoteShell.bindingsSecretRef.key="],
        "remoteShell.enabled requires bindingsSecretRef.name and key",
      ],
      [
        "run tag key",
        ["--set-string", "remoteShell.runBinding.tagKey="],
        "remoteShell.enabled requires runBinding.tagKey",
      ],
      [
        "trusted ingress peer",
        ["--set-json", "remoteShell.networkPolicy.ingressPeers=[]"],
        "remoteShell.enabled requires at least one networkPolicy.ingressPeers entry",
      ],
      [
        "verified issuer",
        ["--set-json", "hop1.issuers=[]"],
        "remoteShell.enabled requires at least one HOP-1 issuer",
      ],
      [
        "public route",
        ["--set", "remoteShell.gatewayApi.httpRoute.enabled=false"],
        "remoteShell.enabled requires exactly one of ingress or gatewayApi.httpRoute",
      ],
      [
        "single route",
        ["--set", "remoteShell.ingress.enabled=true"],
        "remoteShell.enabled requires exactly one of ingress or gatewayApi.httpRoute",
      ],
      [
        "route hostname",
        ["--set-string", "remoteShell.gatewayApi.httpRoute.hostname="],
        "remoteShell.gatewayApi.httpRoute requires hostname and parentRefs",
      ],
      [
        "route parent",
        ["--set-json", "remoteShell.gatewayApi.httpRoute.parentRefs=[]"],
        "remoteShell.gatewayApi.httpRoute requires hostname and parentRefs",
      ],
    ];

    for (const [name, overrides, message] of cases) {
      const rendered = render([...enabledValues, ...overrides]);
      expect(rendered.exitCode, name).not.toBe(0);
      expect(rendered.stderr, name).toContain(message);
    }
  });

  test("keeps remote shell opt-in in the shared-gateway tag-promotion example", async () => {
    const example = await readFile(
      "deploy/k8s/examples/values-shared-gateway.example.yaml",
      "utf8",
    );
    expect(example).toContain("remoteShell:");
    expect(example).toContain("enabled: false");
    expect(example).toContain("repository: registry.example.com/mcp/remote-shell");
    expect(example).toContain('digest: ""');
    expect(example).toContain("httpRoute:");
    expect(example).toContain("request: 0s");
  });
});

function render(values: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["helm", "template", "mcp-gateway", chart, ...values], {
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}
