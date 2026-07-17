import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".ts",
  ".js",
  ".json",
  ".yaml",
  ".yml",
  ".sh",
  ".example",
  ".tf",
  ".j2",
]);

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".terraform"]);
const INTERNAL_PRODUCT_NAMES = [`bur${"ble"}`];

describe("public repository content", () => {
  test("does not mention internal control-plane product names", async () => {
    const violations: string[] = [];

    for (const path of await listTextFiles(".")) {
      const content = await readFile(path, "utf8");
      for (const name of INTERNAL_PRODUCT_NAMES) {
        if (content.toLowerCase().includes(name)) {
          violations.push(path);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

async function listTextFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".github") {
      continue;
    }

    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        files.push(...(await listTextFiles(path)));
      }
      continue;
    }

    if (isTextFile(entry.name)) {
      files.push(path);
    }
  }

  return files;
}

function isTextFile(fileName: string): boolean {
  if (fileName.includes(".")) {
    const extension = fileName.slice(fileName.lastIndexOf("."));
    return TEXT_EXTENSIONS.has(extension);
  }

  return false;
}
