#!/usr/bin/env bun
/**
 * Rewrite the `artifacthub.io/images` annotation in the chart's Chart.yaml so
 * the images Artifact Hub scans are pinned to immutable digests rather than
 * floating tags. Run at release time, after the component images are published,
 * with the digests recorded by the publish-images job (dist/<component>.digest).
 *
 * Only the first-party `mcp-gw-*` images are repinned by digest; any other
 * entries (e.g. the upstream github-mcp-server) are left untouched. The
 * committed Chart.yaml keeps its tag-based annotation as a sane default for
 * local `helm template`; only the released package is rewritten.
 */
import { parseDocument, parse, Scalar } from "yaml";
import { readFileSync, writeFileSync } from "node:fs";

function arg(name: string): string | undefined {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index !== -1 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  return undefined;
}

const chartPath = arg("chart") ?? "deploy/k8s/chart/Chart.yaml";

// Map of image `name:` in the annotation -> digest (sha256:...) to pin it to.
const digestByName: Record<string, string | undefined> = {
  "mcp-gw-agentgateway": arg("agentgateway-digest"),
  "mcp-gw-google-workspace": arg("google-workspace-digest"),
  "mcp-gw-github-wrapper": arg("github-wrapper-digest"),
};

for (const [name, digest] of Object.entries(digestByName)) {
  if (!digest) {
    throw new Error(`missing digest for ${name} (pass --${name}-digest)`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`invalid digest for ${name}: ${digest}`);
  }
}

const doc = parseDocument(readFileSync(chartPath, "utf8"));
const annotationKey = "artifacthub.io/images";
const raw = doc.getIn(["annotations", annotationKey]);
if (typeof raw !== "string") {
  throw new Error(`${chartPath} has no string ${annotationKey} annotation`);
}

const images = parse(raw) as Array<{ name: string; image: string }>;
if (!Array.isArray(images)) {
  throw new Error(`${annotationKey} annotation is not a list`);
}

for (const entry of images) {
  const digest = digestByName[entry.name];
  if (!digest) continue; // leave upstream / unknown images as-is
  // Strip any existing :tag or @digest suffix, then pin by digest.
  const repository = entry.image.replace(/(?::[^/@]+|@sha256:[0-9a-f]+)$/, "");
  entry.image = `${repository}@${digest}`;
}

const rebuilt = images.map((entry) => `- name: ${entry.name}\n  image: ${entry.image}`).join("\n");

const scalar = new Scalar(`${rebuilt}\n`);
scalar.type = Scalar.BLOCK_LITERAL;
doc.setIn(["annotations", annotationKey], scalar);

writeFileSync(chartPath, doc.toString());
console.log(`Pinned ${annotationKey} images by digest in ${chartPath}:`);
for (const entry of images) {
  console.log(`  ${entry.name} -> ${entry.image}`);
}
