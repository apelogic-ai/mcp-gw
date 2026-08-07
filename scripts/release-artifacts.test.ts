import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { generatePrivateReleaseHandoff } from "./generate-private-release-handoff";
import { generateReleaseHandoff } from "./generate-release-handoff";

describe("release artifacts", () => {
  test("gates publication on candidate local, Kubernetes, and full-bundle integration", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    const kubernetesSmoke = workflow.slice(
      workflow.indexOf("  kubernetes-smoke:"),
      workflow.indexOf("  publish-images:"),
    );

    expect(kubernetesSmoke).toContain("Build pinned agentgateway candidate");
    expect(kubernetesSmoke).toContain("bun run integration:local");
    expect(kubernetesSmoke).toContain("bun run integration:k8s");
    expect(kubernetesSmoke).toContain("bun run integration:bundle");
    expect(
      kubernetesSmoke.match(/LOCAL_AGENTGATEWAY_IMAGE: mcp-gw-agentgateway:smoke/g),
    ).toHaveLength(2);
    expect(kubernetesSmoke.indexOf("Build pinned agentgateway candidate")).toBeLessThan(
      kubernetesSmoke.indexOf("bun run integration:local"),
    );
    expect(workflow).not.toMatch(
      /  validate:[\s\S]*?bun run integration:local[\s\S]*?  kubernetes-smoke:/,
    );
    expect(workflow.match(/needs: \[validate, kubernetes-smoke\]/g)).toHaveLength(2);
  });

  test("publishes immutable images and an OCI Helm chart with supply-chain evidence", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");

    expect(workflow).toContain("packages: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("attestations: write");
    expect(workflow).toContain("mcp-gw-agentgateway");
    expect(workflow).toContain("mcp-gw-google-workspace");
    expect(workflow).toContain("mcp-gw-github-wrapper");
    expect(workflow).toContain("docker/build-push-action@");
    expect(workflow).toContain("actions/attest-build-provenance@");
    expect(workflow).toContain("anchore/sbom-action@");
    expect(workflow).toContain("aquasecurity/trivy-action@");
    expect(workflow).toContain("helm push");
    expect(workflow).toContain("oci://ghcr.io/${{ github.repository_owner }}/charts");
    expect(workflow).toContain("generate-release-handoff.ts");
    expect(workflow).toContain('VERSION="${GITHUB_REF_NAME#v}"');
    expect(workflow).toContain("steps.version.outputs.version");
    expect(workflow).not.toContain("matrix.repository }}:${{ github.ref_name }}");
    expect(workflow).toContain("Verify public artifact access");
    expect(workflow).toContain("docker buildx imagetools inspect");
    expect(workflow).toContain("helm pull");
    expect(workflow).not.toContain(":latest");
  });

  test("authenticates OCI chart provenance pushes through Docker credentials", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    const publishChart = workflow.slice(
      workflow.indexOf("  publish-chart:"),
      workflow.indexOf("  release:"),
    );

    expect(publishChart).toContain("docker/login-action@");
    expect(publishChart.indexOf("docker/login-action@")).toBeLessThan(
      publishChart.indexOf("Attest chart provenance"),
    );
  });

  test("optionally promotes exact approved first-party images and chart manifests", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    const promotion = workflow.slice(
      workflow.indexOf("  promote-ecr:"),
      workflow.indexOf("  release:"),
    );

    expect(promotion).toContain("vars.ECR_PROMOTION_ENABLED == 'true'");
    expect(promotion).toContain("AWS_RELEASE_ROLE_ARN");
    expect(promotion).toContain("MCP_GW_ECR_AGENTGATEWAY_REPOSITORY");
    expect(promotion).toContain("MCP_GW_ECR_GOOGLE_WORKSPACE_REPOSITORY");
    expect(promotion).toContain("MCP_GW_ECR_GITHUB_WRAPPER_REPOSITORY");
    expect(promotion).toContain("MCP_GW_ECR_CHART_REPOSITORY");
    expect(promotion).toContain("aws-actions/configure-aws-credentials@");
    expect(promotion).toContain("oras-project/setup-oras@");
    expect(promotion).toContain("oras cp");
    expect(promotion).toContain("cosign sign --yes");
    expect(promotion).toContain("--output-signature dist/ecr-agentgateway.sig");
    expect(promotion).toContain("--output-signature dist/ecr-google-workspace.sig");
    expect(promotion).toContain("--output-signature dist/ecr-github-wrapper.sig");
    expect(promotion).toContain("--output-certificate dist/ecr-helm-chart.pem");
    expect(promotion).not.toContain("cosign verify");
    expect(promotion).not.toMatch(/outputs\.[a-z]+-[a-z-]+/);
    expect(promotion).toContain('test "$AGENTGATEWAY_DIGEST" = "$SOURCE_AGENTGATEWAY_DIGEST"');
    expect(promotion).toContain(
      'test "$GOOGLE_WORKSPACE_DIGEST" = "$SOURCE_GOOGLE_WORKSPACE_DIGEST"',
    );
    expect(promotion).toContain('test "$GITHUB_WRAPPER_DIGEST" = "$SOURCE_GITHUB_WRAPPER_DIGEST"');
    expect(promotion).toContain('test "$CHART_DIGEST" = "$SOURCE_CHART_DIGEST"');
    expect(promotion).toContain("ecr-release-handoff");
    expect(promotion).not.toContain("github-mcp-server");
    expect(promotion).not.toMatch(/\b\d{12}\b/);
  });

  test("blocks releases with critical first-party vulnerabilities", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");

    expect(workflow.match(/name: Enforce zero critical vulnerabilities/g)).toHaveLength(2);
    expect(workflow.match(/exit-code: "1"/g)).toHaveLength(2);
    expect(workflow.match(/severity: CRITICAL/g)).toHaveLength(2);
  });

  test("blocks the public release when configured ECR promotion fails", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    const release = workflow.slice(workflow.indexOf("  release:"));

    expect(release).toContain("promote-ecr");
    expect(release).toContain("needs.promote-ecr.result == 'success'");
    expect(release).toContain("needs.promote-ecr.result == 'skipped'");
  });

  test("publishes chart SBOM and vulnerability evidence", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    const publishChart = workflow.slice(
      workflow.indexOf("  publish-chart:"),
      workflow.indexOf("  promote-ecr:"),
    );

    expect(publishChart).toContain("helm-chart.spdx.json");
    expect(publishChart).toContain("helm-chart.vulnerabilities.json");
    expect(publishChart).toContain("anchore/sbom-action@");
    expect(publishChart).toContain("aquasecurity/trivy-action@");
  });

  test("generates a complete private registry handoff", async () => {
    const artifactsDirectory = await mkdtemp(join(tmpdir(), "mcp-gw-ecr-release-"));
    const outputPath = join(artifactsDirectory, "ecr-release-handoff.md");
    const agentgatewayDigest = `sha256:${"a".repeat(64)}`;
    const googleWorkspaceDigest = `sha256:${"b".repeat(64)}`;
    const githubWrapperDigest = `sha256:${"c".repeat(64)}`;
    const chartDigest = `sha256:${"d".repeat(64)}`;
    await Promise.all([
      writeFile(join(artifactsDirectory, "ecr-agentgateway.digest"), `${agentgatewayDigest}\n`),
      writeFile(
        join(artifactsDirectory, "ecr-google-workspace.digest"),
        `${googleWorkspaceDigest}\n`,
      ),
      writeFile(join(artifactsDirectory, "ecr-github-wrapper.digest"), `${githubWrapperDigest}\n`),
      writeFile(join(artifactsDirectory, "ecr-helm-chart.digest"), `${chartDigest}\n`),
    ]);

    await generatePrivateReleaseHandoff({
      agentgatewayRepository: "registry.example.com/mcp-gw-agentgateway",
      artifactsDirectory,
      chartRepository: "registry.example.com/charts/mcp-gw",
      githubWrapperRepository: "registry.example.com/mcp-gw-github-wrapper",
      googleWorkspaceRepository: "registry.example.com/mcp-gw-google-workspace",
      outputPath,
      releaseCommit: "0123456789abcdef",
      version: "1.2.3",
    });

    const handoff = await readFile(outputPath, "utf8");
    expect(handoff).toContain("registry.example.com/mcp-gw-agentgateway@" + agentgatewayDigest);
    expect(handoff).toContain(
      "registry.example.com/mcp-gw-google-workspace@" + googleWorkspaceDigest,
    );
    expect(handoff).toContain("registry.example.com/mcp-gw-github-wrapper@" + githubWrapperDigest);
    expect(handoff).toContain("registry.example.com/charts/mcp-gw@" + chartDigest);
    expect(handoff).toContain("0123456789abcdef");
    expect(handoff).toContain("ecr-agentgateway.sig");
    expect(handoff).toContain("ecr-agentgateway.pem");
    expect(handoff).toContain("ecr-agentgateway.provenance.json");
    expect(handoff).toContain("ecr-google-workspace.sig");
    expect(handoff).toContain("ecr-google-workspace.provenance.json");
    expect(handoff).toContain("ecr-github-wrapper.sig");
    expect(handoff).toContain("ecr-github-wrapper.provenance.json");
    expect(handoff).toContain("agentgateway.spdx.json");
    expect(handoff).toContain("agentgateway.vulnerabilities.json");
    expect(handoff).toContain("google-workspace.spdx.json");
    expect(handoff).toContain("google-workspace.vulnerabilities.json");
    expect(handoff).toContain("github-wrapper.spdx.json");
    expect(handoff).toContain("github-wrapper.vulnerabilities.json");
    expect(handoff).toContain("helm-chart.spdx.json");
    expect(handoff).toContain("helm-chart.vulnerabilities.json");
  });

  test("defaults the chart to release-owned images without mutable tags", async () => {
    const values = await readFile("deploy/k8s/chart/values.yaml", "utf8");

    expect(values).toContain("repository: ghcr.io/apelogic-ai/mcp-gw-agentgateway");
    expect(values).not.toContain("repository: ghcr.io/apelogic-ai/agentgateway");
    expect(values).not.toContain("v2026.07.17-apelogic.1");
  });

  test("generates an operator handoff from release digests", async () => {
    const artifactsDirectory = await mkdtemp(join(tmpdir(), "mcp-gw-release-"));
    const outputPath = join(artifactsDirectory, "release-handoff.md");
    const digest = `sha256:${"a".repeat(64)}`;

    await Promise.all(
      ["agentgateway", "google-workspace", "github-wrapper", "helm-chart"].map((name) =>
        writeFile(join(artifactsDirectory, `${name}.digest`), `${digest}\n`),
      ),
    );

    await generateReleaseHandoff({
      artifactsDirectory,
      outputPath,
      owner: "example",
      version: "1.2.3",
    });

    const handoff = await readFile(outputPath, "utf8");
    expect(handoff).toContain("oci://ghcr.io/example/charts/mcp-gateway");
    expect(handoff).toContain(`ghcr.io/example/mcp-gw-agentgateway@${digest}`);
    expect(handoff).toContain(`ghcr.io/example/mcp-gw-google-workspace@${digest}`);
    expect(handoff).toContain(`ghcr.io/example/mcp-gw-github-wrapper@${digest}`);
    expect(handoff).toContain("TOKEN_STORE_DSN");
    expect(handoff).toContain("GOOGLE_OAUTH_CLIENT_SECRET");
    expect(handoff).toContain("GITHUB_OAUTH_CLIENT_SECRET");
    expect(handoff).toContain("readiness");
    expect(handoff).toContain("8080");
  });

  test("documents the static release handoff contract", async () => {
    const handoff = await readFile("docs/release-handoff.md", "utf8");

    expect(handoff).toContain("OCI chart");
    expect(handoff).toContain("SBOM");
    expect(handoff).toContain("provenance");
    expect(handoff).toContain("vulnerability");
    expect(handoff).toContain("existing Kubernetes Secret");
    expect(handoff).toContain("TOKEN_STORE_DSN");
    expect(handoff).toContain("private values overlay");
  });
});
