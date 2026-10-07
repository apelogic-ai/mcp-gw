import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Pool } from "pg";

import type { Hop1Identity } from "../shared/identity/hop1";
import {
  createPostgresPoolConfig,
  createPostgresQueryClient,
} from "../shared/oauth/postgres-client";
import { SqlOAuthTokenStore } from "../shared/oauth/sql-store";
import { captureUpstreamCatalog } from "../servers/generic-wrapper/src/catalog-capture";
import { loadGenericWrapperDescriptor } from "../servers/generic-wrapper/src/descriptor";
import { createGenericOAuthRuntimeConfig } from "../servers/generic-wrapper/src/oauth";
import { createHttpUpstreamTransport } from "../servers/generic-wrapper/src/transport";
import { catalogCaptureSha256 } from "./generic-catalog-capture-artifact";

const descriptorPath = resolve(requiredArg(process.argv.slice(2), "descriptor"));
const outputPath = resolve(requiredArg(process.argv.slice(2), "output"));
const descriptor = loadGenericWrapperDescriptor(descriptorPath);
if (descriptor.credential.mode !== "per_user_oauth") {
  throw new Error("Catalog capture requires a per_user_oauth descriptor");
}
if (descriptor.upstream.transport !== "http") {
  throw new Error("Catalog capture requires an HTTP upstream");
}
const identity: Hop1Identity = {
  profile: "catalog-capture",
  issuer: requiredEnv("CAPTURE_HOP1_ISSUER"),
  subject: requiredEnv("CAPTURE_HOP1_SUBJECT"),
  email: requiredEnv("CAPTURE_HOP1_EMAIL"),
  claims: {},
};
const runtime = createGenericOAuthRuntimeConfig(descriptor.credential, process.env);
const pool = new Pool(
  createPostgresPoolConfig(runtime.tokenStoreDsn, process.env.POSTGRES_CA_BUNDLE_PATH),
);

try {
  const lifecycle = runtime.lifecycle(new SqlOAuthTokenStore(createPostgresQueryClient(pool)));
  const activeCredential = await lifecycle.getActiveCredential(
    identity,
    descriptor.credential.scopes,
  );
  const capture = await captureUpstreamCatalog({
    transport: createHttpUpstreamTransport(descriptor.upstream, {
      serverInfo: descriptor.serverInfo,
      maxSessions: 1,
      maxSessionsPerPrincipal: 1,
      sessionIdleTtlMs: 60_000,
    }),
    credential: {
      header: descriptor.credential.header ?? "authorization",
      value: `${descriptor.credential.scheme ?? "Bearer"} ${activeCredential}`,
      rawValue: activeCredential,
    },
    principalKey: `${identity.issuer}\n${identity.subject}`,
  });
  const artifact = {
    schemaVersion: "mcp-gateway.generic-catalog-capture/v1",
    provider: descriptor.credential.providerId,
    upstream: descriptor.upstream.url,
    capturedAt: new Date().toISOString(),
    pages: capture.pages,
    tools: capture.tools,
  };
  const digest = catalogCaptureSha256(artifact);
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  await chmod(outputPath, 0o600);
  process.stdout.write(
    `Captured ${String(capture.tools.length)} tools across ${String(capture.pages)} pages; sha256:${digest}\n`,
  );
} finally {
  await pool.end();
}

function requiredArg(argv: string[], name: string): string {
  const index = argv.indexOf(`--${name}`);
  const value = index >= 0 ? argv[index + 1]?.trim() : undefined;
  if (!value) throw new Error(`Missing required argument --${name}`);
  return value;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
