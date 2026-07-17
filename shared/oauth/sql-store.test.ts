import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { hashState } from "./state";
import {
  OAUTH_SCHEMA_SQL,
  SqlOAuthStateStore,
  SqlOAuthTokenStore,
  type SqlQueryClient,
} from "./sql-store";
import type { OAuthAccountRecord, OAuthStateRecord } from "./store";

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
  hop1Issuer: "https://accounts.google.com",
  hop1Subject: "google-subject",
  email: "user@example.com",
  requestedScopes: ["scope-a"],
  redirectAfter: "/done",
  expiresAt: new Date("2026-07-03T00:05:00.000Z"),
};

describe("SQL OAuth token store", () => {
  test("ships a Postgres-compatible schema", () => {
    expect(OAUTH_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS oauth_accounts");
    expect(OAUTH_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS oauth_states");
    expect(OAUTH_SCHEMA_SQL).toContain("encrypted_refresh_token TEXT NOT NULL");
    expect(OAUTH_SCHEMA_SQL).toContain("revoked_at TIMESTAMPTZ");
  });

  test("keeps the checked-in schema artifact aligned", async () => {
    const schema = await readFile("servers/google-workspace/config/oauth-schema.sql", "utf8");

    expect(schema.replaceAll(/\s+/g, " ").trim()).toBe(
      OAUTH_SCHEMA_SQL.replaceAll(/\s+/g, " ").trim(),
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

  test("saves OAuth state records", async () => {
    const client = new RecordingSqlClient();
    const store = new SqlOAuthStateStore(client);

    await store.save(stateRecord);

    expect(client.calls[0]?.sql).toContain("INSERT INTO oauth_states");
    expect(client.calls[0]?.params).toEqual([
      stateRecord.stateHash,
      stateRecord.hop1Issuer,
      stateRecord.hop1Subject,
      stateRecord.email,
      stateRecord.requestedScopes,
      stateRecord.redirectAfter,
      stateRecord.expiresAt,
      null,
    ]);
  });

  test("consumes unexpired OAuth state records", async () => {
    const client = new RecordingSqlClient([
      {
        state_hash: stateRecord.stateHash,
        hop1_issuer: stateRecord.hop1Issuer,
        hop1_subject: stateRecord.hop1Subject,
        email: stateRecord.email,
        requested_scopes: stateRecord.requestedScopes,
        redirect_after: stateRecord.redirectAfter,
        expires_at: stateRecord.expiresAt,
        consumed_at: null,
      },
    ]);
    const store = new SqlOAuthStateStore(client);

    const consumed = await store.consume("state");

    expect(consumed).toEqual(stateRecord);
    expect(client.calls[0]?.sql).toContain("SELECT");
    expect(client.calls[1]?.sql).toContain("UPDATE oauth_states");
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
