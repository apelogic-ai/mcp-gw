import { resolve } from "node:path";

import { Pool } from "pg";

import type { Hop1Identity } from "../shared/identity/hop1";
import {
  createPostgresPoolConfig,
  createPostgresQueryClient,
} from "../shared/oauth/postgres-client";
import { SqlOAuthTokenStore } from "../shared/oauth/sql-store";
import { captureUpstreamCatalog } from "../servers/generic-wrapper/src/catalog-capture";
import { compareCatalogDecisions } from "../servers/generic-wrapper/src/catalog-drift";
import {
  isLiveToolCatalog,
  loadGenericToolSource,
  loadGenericWrapperDescriptor,
} from "../servers/generic-wrapper/src/descriptor";
import { createGenericOAuthRuntimeConfig } from "../servers/generic-wrapper/src/oauth";
import { createHttpUpstreamTransport } from "../servers/generic-wrapper/src/transport";

const descriptorPath = resolve(requiredArg(process.argv.slice(2), "descriptor"));
const descriptor = loadGenericWrapperDescriptor(descriptorPath);
if (descriptor.credential.mode !== "per_user_oauth") {
  throw new Error("Catalog drift checks require a per_user_oauth descriptor");
}
if (descriptor.upstream.transport !== "http") {
  throw new Error("Catalog drift checks require an HTTP upstream");
}
const decisions = loadGenericToolSource(descriptor.catalogPath, descriptor.toolPrefix);
if (!isLiveToolCatalog(decisions)) {
  throw new Error("Catalog drift checks require a live tool-decisions catalog");
}
const identity: Hop1Identity = {
  profile: "catalog-drift",
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
  const upstream = await captureUpstreamCatalog({
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
  const { withoutDecision, missingUpstream } = compareCatalogDecisions(
    decisions.decisions,
    upstream.tools,
  );

  printGroup("Upstream tools without a decision", withoutDecision);
  printGroup("Decisions without an upstream tool", missingUpstream);
  if (withoutDecision.length > 0 || missingUpstream.length > 0) process.exitCode = 1;
  else process.stdout.write("No catalog drift detected.\n");
} finally {
  await pool.end();
}

function printGroup(label: string, names: string[]): void {
  process.stdout.write(`${label}: ${String(names.length)}\n`);
  for (const name of names) process.stdout.write(`- ${name}\n`);
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
