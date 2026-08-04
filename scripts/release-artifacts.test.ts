import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { generateReleaseHandoff } from "./generate-release-handoff";

describe("release artifacts", () => {
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

  test("optionally promotes exact approved image and chart manifests to ECR", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    const promotion = workflow.slice(
      workflow.indexOf("  promote-ecr:"),
      workflow.indexOf("  release:"),
    );

    expect(promotion).toContain("vars.ECR_PROMOTION_ENABLED == 'true'");
    expect(promotion).toContain("AWS_RELEASE_ROLE_ARN");
    expect(promotion).toContain("MCP_GW_ECR_IMAGE_REPOSITORY");
    expect(promotion).toContain("MCP_GW_ECR_CHART_REPOSITORY");
    expect(promotion).toContain("aws-actions/configure-aws-credentials@");
    expect(promotion).toContain("oras-project/setup-oras@");
    expect(promotion).toContain("oras cp");
    expect(promotion).toContain("cosign sign --yes");
    expect(promotion).toContain("--output-signature dist/ecr-agentgateway.sig");
    expect(promotion).toContain("--output-certificate dist/ecr-helm-chart.pem");
    expect(promotion).not.toContain("cosign verify");
    expect(promotion).not.toMatch(/outputs\.[a-z]+-[a-z-]+/);
    expect(promotion).toContain('test "$IMAGE_DIGEST" = "$SOURCE_IMAGE_DIGEST"');
    expect(promotion).toContain('test "$CHART_DIGEST" = "$SOURCE_CHART_DIGEST"');
    expect(promotion).toContain("ecr-release-handoff");
    expect(promotion).not.toContain("663383948333");
    expect(promotion).not.toContain("dev.apelogic");
  });

  test("blocks the public release when configured ECR promotion fails", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    const release = workflow.slice(workflow.indexOf("  release:"));

    expect(release).toContain("promote-ecr");
    expect(release).toContain("needs.promote-ecr.result == 'success'");
    expect(release).toContain("needs.promote-ecr.result == 'skipped'");
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
