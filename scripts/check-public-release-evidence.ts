#!/usr/bin/env bun

import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";

export interface PublicReleaseEvidenceOptions {
  allowedSubjects: string[];
  artifactsDirectory: string;
  attestationPaths: string[];
}

const PRIVATE_IDENTIFIER_PATTERNS = [
  /\b\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\b/iu,
  /\b[a-z0-9.-]+\.(?:internal|local)(?=[:/\s]|$)/iu,
];
const BINARY_EXTENSIONS = new Set([".gz", ".tgz"]);

export async function verifyPublicReleaseEvidence(
  options: PublicReleaseEvidenceOptions,
): Promise<void> {
  if (options.allowedSubjects.length === 0 || options.attestationPaths.length === 0) {
    throw new Error("At least one allowed subject and attestation document are required");
  }

  const allowed = new Set(options.allowedSubjects);
  const observed = new Set<string>();
  for (const path of options.attestationPaths) {
    const document = JSON.parse(await readFile(path, "utf8")) as unknown;
    for (const subject of collectSubjects(document)) {
      observed.add(subject);
      if (!allowed.has(subject)) {
        throw new Error(`Unexpected public attestation subject: ${subject}`);
      }
    }
  }

  for (const subject of allowed) {
    if (!observed.has(subject)) {
      throw new Error(`Missing public attestation subject: ${subject}`);
    }
  }

  for (const path of await listFiles(options.artifactsDirectory)) {
    if (BINARY_EXTENSIONS.has(extname(path))) {
      continue;
    }
    const content = await readFile(path, "utf8");
    const privateIdentifier = PRIVATE_IDENTIFIER_PATTERNS.find((pattern) => pattern.test(content));
    if (privateIdentifier) {
      throw new Error(`Private registry identifier found in public release asset ${path}`);
    }
  }
}

function collectSubjects(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectSubjects);
  }
  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const directSubjects = Array.isArray(record.subject)
    ? record.subject.flatMap((subject) => {
        if (!subject || typeof subject !== "object") {
          return [];
        }
        const name = (subject as Record<string, unknown>).name;
        return typeof name === "string" ? [name] : [];
      })
    : [];
  return [
    ...directSubjects,
    ...Object.entries(record)
      .filter(([key]) => key !== "subject")
      .flatMap(([, nested]) => collectSubjects(nested)),
  ];
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function parseArgs(args: string[]): PublicReleaseEvidenceOptions {
  const allowedSubjects: string[] = [];
  const attestationPaths: string[] = [];
  let artifactsDirectory = "";
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value) {
      throw new Error("Expected --artifacts, --subject, and --attestation arguments");
    }
    if (flag === "--artifacts") artifactsDirectory = value;
    else if (flag === "--subject") allowedSubjects.push(value);
    else if (flag === "--attestation") attestationPaths.push(value);
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!artifactsDirectory) {
    throw new Error("Expected --artifacts, --subject, and --attestation arguments");
  }
  return { allowedSubjects, artifactsDirectory, attestationPaths };
}

if (import.meta.main) {
  verifyPublicReleaseEvidence(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
