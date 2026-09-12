import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import type { Hop1Identity } from "../../shared/identity/hop1";
import { ConnectionLifecycle } from "../../shared/oauth/connection-lifecycle";
import type { DownstreamConnectionAdapter } from "../../shared/oauth/connection-types";
import { ProviderLifecycleError } from "../../shared/oauth/connection-types";
import { loadOAuthMigrations, runOAuthMigrations } from "../../shared/oauth/migrate";
import { createPostgresQueryClient } from "../../shared/oauth/postgres-client";
import { SqlOAuthTokenStore } from "../../shared/oauth/sql-store";

const connectionString = process.env.TOKEN_STORE_DSN;
if (!connectionString) throw new Error("TOKEN_STORE_DSN is required");

const pool = new Pool({ connectionString });
const suffix = randomUUID();
const identity: Hop1Identity = {
  profile: "postgres-custody-regression",
  issuer: `https://custody-regression.example.com/${suffix}`,
  subject: suffix,
  email: `custody-${suffix}@example.com`,
  claims: {},
};
const scopes = ["repo"];
const encryptionKey = Buffer.alloc(32, 29).toString("base64");
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
  renew: () =>
    Promise.resolve({
      credential: { renewalCredential: "postgres-partial-renewal" },
      grantedScopes: scopes,
      renewalCredentialExpiresAt: new Date(Date.now() + 3_600_000),
    }),
  revoke: (generation) =>
    Promise.resolve(
      generation.credential.renewalCredential && !generation.credential.activeCredential
        ? "permanent_failure"
        : "revoked",
    ),
};

try {
  await runOAuthMigrations({ connect: async () => pool.connect() }, await loadOAuthMigrations());
  const store = new SqlOAuthTokenStore(createPostgresQueryClient(pool));
  const lifecycle = new ConnectionLifecycle({
    adapter,
    store,
    credentialEncryptionKey: encryptionKey,
  });
  await lifecycle.activateAuthorizedGeneration(identity, scopes, {
    credential: {
      activeCredential: "postgres-expired-active",
      renewalCredential: "postgres-original-renewal",
    },
    displayAccountIdentity: identity.email,
    grantedScopes: scopes,
    activeCredentialExpiresAt: new Date(Date.now() - 1),
    renewalCredentialExpiresAt: new Date(Date.now() + 3_600_000),
    validatedAt: new Date(),
  });

  let failure: unknown;
  try {
    await lifecycle.getActiveCredential(identity, scopes);
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof ProviderLifecycleError);
  assert.equal(failure.category, "malformed_provider_response");

  const result = await pool.query(
    `
SELECT custody_state, credential_envelope, cleanup_attempts
FROM oauth_credential_generations
WHERE provider = $1 AND hop1_issuer = $2 AND hop1_subject = $3
  AND connection_generation = 2
`,
    ["github", identity.issuer, identity.subject],
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.custody_state, "cleanup_permanent_failure");
  assert.equal(typeof result.rows[0]?.credential_envelope, "string");
  assert.equal(result.rows[0]?.cleanup_attempts, 1);
  process.stdout.write("PostgreSQL credential custody regression passed.\n");
} finally {
  await pool.query(
    "DELETE FROM oauth_accounts WHERE provider = $1 AND hop1_issuer = $2 AND hop1_subject = $3",
    ["github", identity.issuer, identity.subject],
  );
  await pool.query(
    "DELETE FROM oauth_credential_generations WHERE provider = $1 AND hop1_issuer = $2 AND hop1_subject = $3",
    ["github", identity.issuer, identity.subject],
  );
  await pool.query(
    "DELETE FROM oauth_connection_authorizations WHERE provider = $1 AND hop1_issuer = $2 AND hop1_subject = $3",
    ["github", identity.issuer, identity.subject],
  );
  await pool.end();
}
