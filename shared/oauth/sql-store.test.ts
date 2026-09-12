import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { hashState } from "./state";
import {
  OAUTH_SCHEMA_SQL,
  SqlOAuthStateStore,
  SqlOAuthTokenStore,
  type SqlQueryClient,
} from "./sql-store";
import { connectionWriteGuard, type OAuthAccountRecord, type OAuthStateRecord } from "./store";
import type { ConnectionRecord, PendingCredentialCleanupRecord } from "./connection-types";

const account: OAuthAccountRecord = {
  provider: "google",
  hop1Issuer: "https://accounts.google.com",
  hop1Subject: "google-subject",
  email: "user@example.com",
  scopesGranted: ["scope-a", "scope-b"],
  encryptedRefreshToken: "encrypted",
  createdAt: new Date("2026-07-03T00:00:00.000Z"),
  updatedAt: new Date("2026-07-03T00:00:00.000Z"),
};

const stateRecord: OAuthStateRecord = {
  stateHash: hashState("state"),
  provider: "google",
  hop1Issuer: "https://accounts.google.com",
  hop1Subject: "google-subject",
  email: "user@example.com",
  requestedScopes: ["scope-a"],
  redirectAfter: "/done",
  expiresAt: new Date("2026-07-03T00:05:00.000Z"),
};

const connection: ConnectionRecord = {
  provider: "github",
  hop1Issuer: "https://issuer.example.com",
  hop1Subject: "subject",
  displayAccountIdentity: "user@example.com",
  encryptedCredentialEnvelope: "encrypted-envelope",
  credentialSchemaVersion: 1,
  generation: 2,
  requiredScopes: ["repo"],
  grantedScopes: ["repo", "read:org"],
  activeCredentialPresent: true,
  renewalCredentialPresent: true,
  activeCredentialExpiresAt: new Date("2026-09-12T23:00:00.000Z"),
  renewalCredentialExpiresAt: new Date("2027-03-12T15:00:00.000Z"),
  lastAuthorizedAt: new Date("2026-09-12T15:00:00.000Z"),
  lastRenewedAt: new Date("2026-09-12T16:00:00.000Z"),
  lastValidatedAt: new Date("2026-09-12T16:00:00.000Z"),
  phase: "connected",
  revocationState: "none",
  createdAt: new Date("2026-09-12T15:00:00.000Z"),
  updatedAt: new Date("2026-09-12T16:00:00.000Z"),
  encryptedLegacyCredential: "encrypted-legacy",
};

const pendingCleanup: PendingCredentialCleanupRecord = {
  id: "cleanup-1",
  provider: "github",
  hop1Issuer: connection.hop1Issuer,
  hop1Subject: connection.hop1Subject,
  displayAccountIdentity: connection.displayAccountIdentity,
  encryptedCredentialEnvelope: "encrypted-orphan-envelope",
  credentialSchemaVersion: 1,
  generation: 3,
  grantedScopes: ["repo"],
  activeCredentialExpiresAt: new Date("2026-09-13T00:00:00.000Z"),
  renewalCredentialExpiresAt: new Date("2027-09-13T00:00:00.000Z"),
  createdAt: new Date("2026-09-12T17:00:00.000Z"),
  updatedAt: new Date("2026-09-12T17:00:00.000Z"),
};

describe("SQL OAuth token store", () => {
  test("ships a Postgres-compatible schema", () => {
    expect(OAUTH_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS oauth_accounts");
    expect(OAUTH_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS oauth_states");
    expect(OAUTH_SCHEMA_SQL).toContain("encrypted_refresh_token TEXT NOT NULL");
    expect(OAUTH_SCHEMA_SQL).toContain("revoked_at TIMESTAMPTZ");
  });

  test("keeps the checked-in schema artifact aligned", async () => {
    const [
      schema,
      migration,
      brokerMigration,
      refreshMigration,
      persistentDcrMigration,
      lifecycleMigration,
      providerStateMigration,
    ] = await Promise.all([
      readFile("servers/google-workspace/config/oauth-schema.sql", "utf8"),
      readFile("shared/oauth/migrations/001_oauth_accounts.sql", "utf8"),
      readFile("shared/oauth/migrations/002_authorization_broker.sql", "utf8"),
      readFile("shared/oauth/migrations/003_broker_refresh_tokens.sql", "utf8"),
      readFile("shared/oauth/migrations/004_persistent_dcr_clients.sql", "utf8"),
      readFile("shared/oauth/migrations/005_provider_connection_lifecycle.sql", "utf8"),
      readFile("shared/oauth/migrations/006_provider_state_and_cleanup.sql", "utf8"),
    ]);

    expect(migration.replaceAll(/\s+/g, " ").trim()).toBe(
      OAUTH_SCHEMA_SQL.replaceAll(/\s+/g, " ").trim(),
    );
    const consolidatedBrokerMigration = brokerMigration.replace(
      "  registration JSONB NOT NULL,\n  expires_at TIMESTAMPTZ NOT NULL\n);",
      "  registration JSONB NOT NULL,\n  expires_at TIMESTAMPTZ\n);",
    );
    expect(persistentDcrMigration.trim()).toBe(
      "ALTER TABLE oauth_dcr_clients\n  ALTER COLUMN expires_at DROP NOT NULL;",
    );
    expect(schema.replaceAll(/\s+/g, " ").trim()).toBe(
      `${migration.trim()}\n\n${consolidatedBrokerMigration.trim()}\n\n${refreshMigration.trim()}\n\n${lifecycleMigration.trim()}\n\n${providerStateMigration.trim()}`
        .replaceAll(/\s+/g, " ")
        .trim(),
    );
  });

  test("upserts account records", async () => {
    const client = new RecordingSqlClient();
    const store = new SqlOAuthTokenStore(client);

    await store.saveAccount(account);

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.sql).toContain("INSERT INTO oauth_accounts");
    expect(client.calls[0]?.params).toEqual([
      "google",
      "https://accounts.google.com",
      "google-subject",
      "user@example.com",
      ["scope-a", "scope-b"],
      "encrypted",
      account.createdAt,
      account.updatedAt,
      null,
    ]);
  });

  test("maps selected rows to OAuth account records", async () => {
    const client = new RecordingSqlClient([
      {
        provider: "google",
        hop1_issuer: "https://accounts.google.com",
        hop1_subject: "google-subject",
        email: "user@example.com",
        scopes_granted: ["scope-a"],
        encrypted_refresh_token: "encrypted",
        created_at: new Date("2026-07-03T00:00:00.000Z"),
        updated_at: new Date("2026-07-03T00:00:01.000Z"),
        revoked_at: null,
      },
    ]);
    const store = new SqlOAuthTokenStore(client);

    const selected = await store.getAccount("https://accounts.google.com", "google-subject");

    expect(selected).toEqual({
      provider: "google",
      hop1Issuer: "https://accounts.google.com",
      hop1Subject: "google-subject",
      email: "user@example.com",
      scopesGranted: ["scope-a"],
      encryptedRefreshToken: "encrypted",
      createdAt: new Date("2026-07-03T00:00:00.000Z"),
      updatedAt: new Date("2026-07-03T00:00:01.000Z"),
      revokedAt: undefined,
    });
  });

  test("selects provider-specific OAuth account records", async () => {
    const client = new RecordingSqlClient([
      {
        provider: "github",
        hop1_issuer: "https://issuer.example.com",
        hop1_subject: "subject",
        email: "user@example.com",
        scopes_granted: ["repo"],
        encrypted_refresh_token: "encrypted-github-token",
        created_at: new Date("2026-07-03T00:00:00.000Z"),
        updated_at: new Date("2026-07-03T00:00:01.000Z"),
        revoked_at: null,
      },
    ]);
    const store = new SqlOAuthTokenStore(client);

    const selected = await store.getAccount("https://issuer.example.com", "subject", "github");

    expect(client.calls[0]?.params).toEqual(["github", "https://issuer.example.com", "subject"]);
    expect(selected).toEqual({
      provider: "github",
      hop1Issuer: "https://issuer.example.com",
      hop1Subject: "subject",
      email: "user@example.com",
      scopesGranted: ["repo"],
      encryptedRefreshToken: "encrypted-github-token",
      createdAt: new Date("2026-07-03T00:00:00.000Z"),
      updatedAt: new Date("2026-07-03T00:00:01.000Z"),
      revokedAt: undefined,
    });
    expect(client.calls[0]?.sql).not.toContain("oauth_connection_authorizations");
  });

  test("reads an unexpired authorization marker through the one-query connection lookup", async () => {
    const updatedAt = new Date("2026-09-12T16:00:00.000Z");
    const client = new RecordingSqlClient([
      {
        provider: "github",
        hop1_issuer: connection.hop1Issuer,
        hop1_subject: connection.hop1Subject,
        email: "",
        scopes_granted: [],
        encrypted_refresh_token: "",
        credential_envelope: null,
        credential_schema_version: null,
        connection_generation: "0",
        scopes_required: ["repo"],
        active_credential_present: false,
        renewal_credential_present: false,
        active_credential_expires_at: null,
        renewal_credential_expires_at: null,
        last_authorized_at: null,
        last_renewed_at: null,
        last_validated_at: null,
        local_disabled_at: null,
        lifecycle_phase: "authorizing",
        revocation_state: "none",
        revocation_started_at: null,
        revocation_completed_at: null,
        lifecycle_error_category: null,
        lifecycle_updated_at: updatedAt,
        created_at: updatedAt,
        updated_at: updatedAt,
        revoked_at: null,
      },
    ]);

    const selected = await new SqlOAuthTokenStore(client).getConnection(
      "github",
      connection.hop1Issuer,
      connection.hop1Subject,
    );

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.sql).toContain("oauth_connection_authorizations");
    expect(client.calls[0]?.sql).toContain("LEFT JOIN oauth_accounts AS account");
    expect(selected).toMatchObject({ phase: "authorizing", generation: 0 });
  });

  test("marks accounts revoked", async () => {
    const client = new RecordingSqlClient();
    const store = new SqlOAuthTokenStore(client);
    const revokedAt = new Date("2026-07-03T01:00:00.000Z");

    await store.markRevoked("https://accounts.google.com", "google-subject", revokedAt);

    expect(client.calls[0]?.sql).toContain("UPDATE oauth_accounts");
    expect(client.calls[0]?.params).toEqual([
      revokedAt,
      "google",
      "https://accounts.google.com",
      "google-subject",
    ]);
  });

  test("persists normalized credential generations with a compare-and-swap guard", async () => {
    const client = new RecordingSqlClient([{ connection_generation: 2 }]);
    const store = new SqlOAuthTokenStore(client);

    expect(await store.saveConnection(connection, connectionWriteGuard(connection))).toBe(true);
    expect(client.calls[0]?.sql).toContain("oauth_accounts.connection_generation = $27");
    expect(client.calls[0]?.sql).toContain("oauth_accounts.updated_at = $28");
    expect(client.calls[0]?.sql).toContain("oauth_accounts.revoked_at IS NOT DISTINCT FROM $29");
    expect(client.calls[0]?.sql).toContain("credential_envelope");
    expect(client.calls[0]?.params[8]).toBe(2);
    expect(client.calls[0]?.params.slice(25)).toEqual([
      true,
      connection.generation,
      connection.updatedAt,
      null,
    ]);
  });

  test("persists, selects, and deletes orphaned credential cleanup records", async () => {
    const saveClient = new RecordingSqlClient();
    await new SqlOAuthTokenStore(saveClient).savePendingCredentialCleanup(pendingCleanup);
    expect(saveClient.calls[0]?.sql).toContain("oauth_pending_credential_cleanup");
    expect(saveClient.calls[0]?.params).toEqual([
      pendingCleanup.id,
      pendingCleanup.provider,
      pendingCleanup.hop1Issuer,
      pendingCleanup.hop1Subject,
      pendingCleanup.displayAccountIdentity,
      pendingCleanup.encryptedCredentialEnvelope,
      pendingCleanup.credentialSchemaVersion,
      pendingCleanup.generation,
      pendingCleanup.grantedScopes,
      pendingCleanup.activeCredentialExpiresAt,
      pendingCleanup.renewalCredentialExpiresAt,
      pendingCleanup.createdAt,
      pendingCleanup.updatedAt,
    ]);

    const listClient = new RecordingSqlClient([
      {
        id: pendingCleanup.id,
        provider: pendingCleanup.provider,
        hop1_issuer: pendingCleanup.hop1Issuer,
        hop1_subject: pendingCleanup.hop1Subject,
        email: pendingCleanup.displayAccountIdentity,
        credential_envelope: pendingCleanup.encryptedCredentialEnvelope,
        credential_schema_version: String(pendingCleanup.credentialSchemaVersion),
        connection_generation: String(pendingCleanup.generation),
        scopes_granted: pendingCleanup.grantedScopes,
        active_credential_expires_at: pendingCleanup.activeCredentialExpiresAt,
        renewal_credential_expires_at: pendingCleanup.renewalCredentialExpiresAt,
        created_at: pendingCleanup.createdAt,
        updated_at: pendingCleanup.updatedAt,
      },
    ]);
    expect(
      await new SqlOAuthTokenStore(listClient).listPendingCredentialCleanups("github", 5),
    ).toEqual([pendingCleanup]);
    expect(listClient.calls[0]?.params).toEqual(["github", 5]);

    const deleteClient = new RecordingSqlClient();
    await new SqlOAuthTokenStore(deleteClient).deletePendingCredentialCleanup(pendingCleanup.id);
    expect(deleteClient.calls[0]?.sql).toContain("DELETE FROM oauth_pending_credential_cleanup");
    expect(deleteClient.calls[0]?.params).toEqual([pendingCleanup.id]);
  });

  test("detects and prefers a newer legacy write over stale normalized metadata", async () => {
    const old = new Date("2026-09-12T15:00:00.000Z");
    const newer = new Date("2026-09-12T16:00:00.000Z");
    const client = new RecordingSqlClient([
      {
        provider: "github",
        hop1_issuer: connection.hop1Issuer,
        hop1_subject: connection.hop1Subject,
        email: connection.displayAccountIdentity,
        scopes_granted: ["repo"],
        encrypted_refresh_token: "new-legacy-active",
        credential_envelope: "stale-envelope",
        credential_schema_version: 1,
        connection_generation: "2",
        scopes_required: ["repo"],
        active_credential_expires_at: old,
        renewal_credential_expires_at: old,
        last_authorized_at: old,
        last_renewed_at: old,
        last_validated_at: old,
        local_disabled_at: old,
        lifecycle_phase: "disconnected",
        revocation_state: "complete",
        revocation_started_at: old,
        revocation_completed_at: old,
        lifecycle_error_category: null,
        lifecycle_updated_at: old,
        created_at: old,
        updated_at: newer,
        revoked_at: null,
      },
    ]);
    const selected = await new SqlOAuthTokenStore(client).getConnection(
      "github",
      connection.hop1Issuer,
      connection.hop1Subject,
    );

    expect(selected).toMatchObject({
      phase: "connected",
      encryptedLegacyCredential: "new-legacy-active",
      lastAuthorizedAt: newer,
    });
    expect(selected?.encryptedCredentialEnvelope).toBeUndefined();
    expect(selected?.localDisabledAt).toBeUndefined();
    expect(selected?.activeCredentialExpiresAt).toBeUndefined();
  });

  test("takes a transaction-scoped distributed lock per principal connection", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const transactionClient: SqlQueryClient = {
      query: (sql, params) => {
        calls.push({ sql, params });
        return Promise.resolve({ rows: [] });
      },
    };
    const client: SqlQueryClient = {
      query: (sql, params) => transactionClient.query(sql, params),
      transaction: (operation) => operation(transactionClient),
    };
    const store = new SqlOAuthTokenStore(client);

    expect(
      await store.withConnectionLock("github", "https://issuer.example.com", "subject", () =>
        Promise.resolve("locked"),
      ),
    ).toBe("locked");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("pg_advisory_xact_lock");
    expect(calls[0]?.params).toEqual(["github\nhttps://issuer.example.com\nsubject"]);
  });

  test("saves OAuth state records", async () => {
    const client = new RecordingSqlClient();
    const store = new SqlOAuthStateStore(client);

    await store.save(stateRecord);

    expect(client.calls[0]?.sql).toContain("INSERT INTO oauth_states");
    expect(client.calls[0]?.params).toEqual([
      stateRecord.stateHash,
      stateRecord.provider,
      stateRecord.hop1Issuer,
      stateRecord.hop1Subject,
      stateRecord.email,
      stateRecord.requestedScopes,
      stateRecord.redirectAfter,
      stateRecord.expiresAt,
      null,
      null,
      null,
      null,
    ]);
  });

  test("invalidates all unconsumed OAuth states for one immutable principal", async () => {
    const client = new RecordingSqlClient();
    const store = new SqlOAuthStateStore(client);

    await store.invalidatePrincipal("google", stateRecord.hop1Issuer, stateRecord.hop1Subject);

    expect(client.calls[0]?.sql).toContain("UPDATE oauth_states");
    expect(client.calls[0]?.sql).toContain("consumed_at IS NULL");
    expect(client.calls[0]?.sql).toContain("provider = $1");
    expect(client.calls[0]?.params).toEqual([
      "google",
      stateRecord.hop1Issuer,
      stateRecord.hop1Subject,
    ]);
  });

  test("consumes unexpired OAuth state records", async () => {
    const consumedAt = new Date("2026-07-03T00:01:00.000Z");
    const client = new RecordingSqlClient([
      {
        state_hash: stateRecord.stateHash,
        provider: stateRecord.provider,
        hop1_issuer: stateRecord.hop1Issuer,
        hop1_subject: stateRecord.hop1Subject,
        email: stateRecord.email,
        requested_scopes: stateRecord.requestedScopes,
        redirect_after: stateRecord.redirectAfter,
        expires_at: stateRecord.expiresAt,
        consumed_at: consumedAt,
      },
    ]);
    const store = new SqlOAuthStateStore(client);

    const consumed = await store.consume("google", "state");

    expect(consumed).toEqual({ ...stateRecord, consumedAt });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.sql).toContain("UPDATE oauth_states");
    expect(client.calls[0]?.sql).toContain("consumed_at IS NULL");
    expect(client.calls[0]?.sql).toContain("expires_at > NOW()");
    expect(client.calls[0]?.sql).toContain("provider = $3 OR provider IS NULL");
    expect(client.calls[0]?.sql).toContain("RETURNING");
    expect(client.calls[0]?.params[1]).toBe(stateRecord.stateHash);
    expect(client.calls[0]?.params[2]).toBe("google");
  });
});

class RecordingSqlClient implements SqlQueryClient {
  readonly calls: { sql: string; params: unknown[] }[] = [];

  constructor(private readonly rows: Record<string, unknown>[] = []) {}

  query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ sql, params });
    return Promise.resolve({ rows: this.rows });
  }
}
