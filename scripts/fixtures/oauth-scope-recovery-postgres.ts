import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import type { Hop1Identity } from "../../shared/identity/hop1";
import { ConnectionLifecycle } from "../../shared/oauth/connection-lifecycle";
import type { DownstreamConnectionAdapter } from "../../shared/oauth/connection-types";
import { loadOAuthMigrations, runOAuthMigrations } from "../../shared/oauth/migrate";
import { createPostgresQueryClient } from "../../shared/oauth/postgres-client";
import { SqlOAuthTokenStore } from "../../shared/oauth/sql-store";
import { connectionWriteGuard } from "../../shared/oauth/store";

const connectionString = process.env.TOKEN_STORE_DSN;
if (!connectionString) throw new Error("TOKEN_STORE_DSN is required");

const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 1_500 });
const suffix = randomUUID();
const encryptionKey = Buffer.alloc(32, 30).toString("base64");
const consentScopes = ["read", "write"];
const principals = ["repair", "incomplete", "disconnect"].map((label): Hop1Identity => ({
  profile: "postgres-scope-recovery",
  issuer: `https://scope-recovery.example.com/${suffix}`,
  subject: `${suffix}-${label}`,
  email: `${label}-${suffix}@example.com`,
  claims: {},
}));
const [repairIdentity, incompleteIdentity, disconnectIdentity] = principals;
if (!repairIdentity || !incompleteIdentity || !disconnectIdentity) {
  throw new Error("Missing test principals");
}

const adapter: DownstreamConnectionAdapter = {
  providerId: "github",
  capabilities: {
    interactiveAuthorization: true,
    activeCredentialExpiry: true,
    automaticRenewal: true,
    manualRenewal: true,
    rotatingRenewalCredential: true,
    providerValidation: true,
    providerRevocation: true,
    scopeReporting: true,
    identityVerification: true,
  },
  revoke: () => Promise.resolve("revoked"),
};

try {
  await runOAuthMigrations({ connect: async () => pool.connect() }, await loadOAuthMigrations());
  const store = new SqlOAuthTokenStore(createPostgresQueryClient(pool));
  const lifecycle = new ConnectionLifecycle({
    adapter,
    store,
    credentialEncryptionKey: encryptionKey,
    consentScopes,
  });

  const authorize = async (principal: Hop1Identity, grantedScopes: string[]) => {
    await lifecycle.activateAuthorizedGeneration(principal, grantedScopes, {
      credential: {
        activeCredential: `active-${principal.subject}`,
        renewalCredential: `renewal-${principal.subject}`,
      },
      displayAccountIdentity: principal.email,
      grantedScopes,
      activeCredentialExpiresAt: new Date(Date.now() + 3_600_000),
      renewalCredentialExpiresAt: new Date(Date.now() + 7_200_000),
      validatedAt: new Date(),
    });
  };
  const poison = async (principal: Hop1Identity) => {
    const current = await store.getConnection("github", principal.issuer, principal.subject);
    assert(current);
    const saved = await store.saveConnection(
      {
        ...current,
        phase: "reauthorization_required",
        lifecycleErrorCategory: "insufficient_scope",
        updatedAt: new Date(current.updatedAt.getTime() + 1),
      },
      connectionWriteGuard(current),
    );
    assert(saved);
  };
  const snapshot = async (principal: Hop1Identity) => {
    const result = await pool.query(
      `SELECT connection_generation, lifecycle_phase, lifecycle_error_category,
              credential_envelope, updated_at, revoked_at
         FROM oauth_accounts
        WHERE provider = $1 AND hop1_issuer = $2 AND hop1_subject = $3`,
      ["github", principal.issuer, principal.subject],
    );
    assert.equal(result.rows.length, 1);
    return result.rows[0];
  };

  await authorize(repairIdentity, consentScopes);
  const beforeToolDenial = await snapshot(repairIdentity);
  await assert.rejects(lifecycle.getActiveCredential(repairIdentity, ["optional"]), {
    category: "insufficient_scope",
  });
  assert.deepEqual(await snapshot(repairIdentity), beforeToolDenial);
  await poison(repairIdentity);
  assert.equal(
    await lifecycle.getActiveCredential(repairIdentity, ["read"]),
    `active-${repairIdentity.subject}`,
  );
  assert.equal((await snapshot(repairIdentity))?.lifecycle_phase, "connected");

  await authorize(incompleteIdentity, ["read"]);
  await poison(incompleteIdentity);
  const beforeIncomplete = await snapshot(incompleteIdentity);
  await assert.rejects(lifecycle.getActiveCredential(incompleteIdentity, ["read"]), {
    category: "insufficient_scope",
  });
  assert.deepEqual(await snapshot(incompleteIdentity), beforeIncomplete);

  await authorize(disconnectIdentity, consentScopes);
  await poison(disconnectIdentity);
  const originalGetConnection = store.getConnection.bind(store);
  let disconnectBeforeRepair = true;
  store.getConnection = async (...args) => {
    const snapshot = await originalGetConnection(...args);
    if (disconnectBeforeRepair && args[2] === disconnectIdentity.subject) {
      disconnectBeforeRepair = false;
      await lifecycle.disconnect(disconnectIdentity, consentScopes);
    }
    return snapshot;
  };
  await assert.rejects(lifecycle.getActiveCredential(disconnectIdentity, ["read"]));
  store.getConnection = originalGetConnection;
  const disconnected = await snapshot(disconnectIdentity);
  assert.notEqual(disconnected?.revoked_at, null);
  assert.notEqual(disconnected?.lifecycle_phase, "connected");

  process.stdout.write("PostgreSQL scope recovery regression passed.\n");
} finally {
  for (const principal of principals) {
    for (const table of [
      "oauth_accounts",
      "oauth_credential_generations",
      "oauth_connection_authorizations",
    ]) {
      await pool.query(
        `DELETE FROM ${table} WHERE provider = $1 AND hop1_issuer = $2 AND hop1_subject = $3`,
        ["github", principal.issuer, principal.subject],
      );
    }
  }
  await pool.end();
}
