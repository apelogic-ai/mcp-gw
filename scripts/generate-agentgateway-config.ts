import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  type BackendDescriptor,
  parseBackendDescriptor,
  renderAgentgatewayConfig,
  validateBackendRegistry,
} from "../shared/backends/registry";

const CHECK_MODE = process.argv.includes("--check");
const SERVERS_DIR = "servers";
const BASE_CONFIG_PATH = "gateway/agentgateway/base.yaml";
const FEDERATED_CONFIG_PATH = "gateway/agentgateway/federated.yaml";

const descriptors = await loadBackendDescriptors();
validateBackendRegistry(descriptors);

const outputs = new Map([
  [BASE_CONFIG_PATH, renderAgentgatewayConfig(descriptors)],
  [FEDERATED_CONFIG_PATH, renderAgentgatewayConfig(descriptors, { includeOptional: true })],
]);

if (CHECK_MODE) {
  const drifts: string[] = [];

  for (const [filePath, expected] of outputs) {
    const actual = await readFile(filePath, "utf8");
    if (actual !== expected) {
      drifts.push(filePath);
    }
  }

  if (drifts.length > 0) {
    throw new Error(
      `Generated agentgateway config is stale: ${drifts.join(", ")}. Run bun scripts/generate-agentgateway-config.ts.`,
    );
  }
} else {
  await Promise.all(
    [...outputs.entries()].map(([filePath, content]) => writeFile(filePath, content)),
  );
}

async function loadBackendDescriptors(): Promise<BackendDescriptor[]> {
  const serverEntries = await readdir(SERVERS_DIR, { withFileTypes: true });
  const descriptorPaths = serverEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(SERVERS_DIR, entry.name, "backend.yaml"));

  const descriptors = await Promise.all(
    descriptorPaths.map(async (descriptorPath) =>
      parseBackendDescriptor(await readFile(descriptorPath, "utf8")),
    ),
  );

  return descriptors.sort(compareBackendDescriptors);
}

function compareBackendDescriptors(a: BackendDescriptor, b: BackendDescriptor): number {
  if (a.enabledByDefault !== b.enabledByDefault) {
    return a.enabledByDefault ? -1 : 1;
  }

  return a.name.localeCompare(b.name);
}
