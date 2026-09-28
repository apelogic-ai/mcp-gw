import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { verifyPublicReleaseEvidence } from "./check-public-release-evidence";

const digest = `sha256:${"a".repeat(64)}`;
const privateRegistry = `${"123456".repeat(2)}.${["dkr", "ecr"].join(
  ".",
)}.us-east-1.amazonaws.com/private/chart`;

describe("public release evidence", () => {
  test("accepts only the expected public attestation subjects and clean artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-gw-public-evidence-"));
    const artifacts = join(root, "artifacts");
    const attestations = join(root, "attestations.json");
    await mkdir(artifacts);
    await Bun.write(join(artifacts, "release-handoff.md"), "ghcr.io/example/chart@sha256:abc\n");
    await writeFile(attestations, JSON.stringify(attestation("ghcr.io/example/chart")));

    await expect(
      verifyPublicReleaseEvidence({
        allowedSubjects: ["ghcr.io/example/chart"],
        artifactsDirectory: artifacts,
        attestationPaths: [attestations],
      }),
    ).resolves.toBeUndefined();
  });

  test("rejects a private registry attestation subject even when the digest is shared", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-gw-private-subject-"));
    const artifacts = join(root, "artifacts");
    const attestations = join(root, "attestations.json");
    await mkdir(artifacts);
    await Bun.write(join(artifacts, "release-handoff.md"), "public evidence\n");
    await writeFile(
      attestations,
      JSON.stringify([attestation("ghcr.io/example/chart"), attestation(privateRegistry)]),
    );

    let failure: Error | undefined;
    try {
      await verifyPublicReleaseEvidence({
        allowedSubjects: ["ghcr.io/example/chart"],
        artifactsDirectory: artifacts,
        attestationPaths: [attestations],
      });
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toMatch(/Unexpected public attestation subject/);
    expect(failure?.message).not.toContain(privateRegistry);
  });

  test("rejects private registry identifiers in public release assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-gw-private-asset-"));
    const artifacts = join(root, "artifacts");
    const attestations = join(root, "attestations.json");
    await mkdir(artifacts);
    await Bun.write(join(artifacts, "release-handoff.md"), `${privateRegistry}\n`);
    await writeFile(attestations, JSON.stringify(attestation("ghcr.io/example/chart")));

    await expect(
      verifyPublicReleaseEvidence({
        allowedSubjects: ["ghcr.io/example/chart"],
        artifactsDirectory: artifacts,
        attestationPaths: [attestations],
      }),
    ).rejects.toThrow(/release-handoff\.md/);
  });

  test("inspects packaged chart contents for private registry identifiers", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-gw-private-chart-"));
    const artifacts = join(root, "artifacts");
    const chart = join(root, "chart");
    const archive = join(artifacts, "mcp-gateway.tgz");
    const attestations = join(root, "attestations.json");
    await mkdir(artifacts);
    await mkdir(chart);
    await writeFile(join(chart, "values.yaml"), `image: ${privateRegistry}\n`);
    const tar = Bun.spawn(["tar", "-czf", archive, "-C", chart, "."]);
    expect(await tar.exited).toBe(0);
    await writeFile(attestations, JSON.stringify(attestation("ghcr.io/example/chart")));

    await expect(
      verifyPublicReleaseEvidence({
        allowedSubjects: ["ghcr.io/example/chart"],
        artifactsDirectory: artifacts,
        attestationPaths: [attestations],
      }),
    ).rejects.toThrow(/mcp-gateway\.tgz/);
  });
});

function attestation(subject: string): object {
  return {
    verificationResult: {
      statement: {
        subject: [{ digest: { sha256: digest.slice("sha256:".length) }, name: subject }],
      },
    },
  };
}
