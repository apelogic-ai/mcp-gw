import { describe, expect, test } from "bun:test";

const DEPLOYED_PUBLIC_SURFACE_FILES = [
  "gateway/agentgateway/base.yaml",
  "gateway/agentgateway/federated.yaml",
  "gateway/agentgateway/local-smoke.yaml",
  "gateway/agentgateway/local-full-bundle-smoke.yaml",
  "gateway/agentgateway/local-github-smoke.yaml",
  "deploy/k8s/chart/templates/agentgateway/configmap.yaml",
  "deploy/k8s/chart/values.yaml",
];

const PRIVATE_CONTROL_ROUTES = [
  "/oauth/google/start",
  "/oauth/google/status",
  "/oauth/google/disconnect",
  "/oauth/github/start",
  "/oauth/github/status",
  "/oauth/github/disconnect",
];

describe("public OAuth routing contract", () => {
  test("does not publish authenticated provider control-plane helpers", async () => {
    for (const path of DEPLOYED_PUBLIC_SURFACE_FILES) {
      const source = await Bun.file(path).text();
      for (const privateRoute of PRIVATE_CONTROL_ROUTES) {
        expect(source, `${path} must not publish ${privateRoute}`).not.toContain(privateRoute);
      }
    }
  });

  test("documents the exact direct-client surface and conservative support claims", async () => {
    const contract = await Bun.file("docs/direct-client-oauth-contract.md").text();
    const publicContractTerms = [
      "/mcp",
      "/.well-known/oauth-protected-resource/mcp",
      "/authorize",
      "/token",
      "/register",
      "jwks_uri",
      "/oauth/google/broker/callback",
    ];

    for (const term of publicContractTerms) {
      expect(contract, `direct-client contract must describe ${term}`).toContain(term);
    }
    for (const privateRoute of PRIVATE_CONTROL_ROUTES) {
      expect(contract, `direct-client contract must classify ${privateRoute}`).toContain(
        privateRoute,
      );
    }

    expect(contract).toContain("Not yet claimed as tested against this broker release");
    expect(contract).toContain("issues no public refresh token");
    expect(contract).toContain("private control-plane APIs");
    expect(contract).toContain("same email remain different");
  });
});
