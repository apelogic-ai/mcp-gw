import { hashState } from "./state";
import type {
  OAuthAccountRecord,
  OAuthStateRecord,
  OAuthStateStore,
  OAuthTokenStore,
} from "./store";

export interface SqlQueryClient {
  query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export const OAUTH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS oauth_accounts (
  provider TEXT NOT NULL,
  hop1_issuer TEXT NOT NULL,
  hop1_subject TEXT NOT NULL,
  email TEXT NOT NULL,
  scopes_granted TEXT[] NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (provider, hop1_issuer, hop1_subject)
);

CREATE INDEX IF NOT EXISTS oauth_accounts_email_idx
  ON oauth_accounts (provider, email);

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  hop1_issuer TEXT NOT NULL,
  hop1_subject TEXT NOT NULL,
  email TEXT NOT NULL,
  requested_scopes TEXT[] NOT NULL,
  redirect_after TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS oauth_states_expiry_idx
  ON oauth_states (expires_at);
`;

export class SqlOAuthTokenStore implements OAuthTokenStore {
  constructor(private readonly client: SqlQueryClient) {}

  async saveAccount(record: OAuthAccountRecord): Promise<void> {
    await this.client.query(
      `
INSERT INTO oauth_accounts (
  provider,
  hop1_issuer,
  hop1_subject,
  email,
  scopes_granted,
  encrypted_refresh_token,
  created_at,
  updated_at,
  revoked_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (provider, hop1_issuer, hop1_subject)
DO UPDATE SET
  email = EXCLUDED.email,
  scopes_granted = EXCLUDED.scopes_granted,
  encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
  updated_at = EXCLUDED.updated_at,
  revoked_at = EXCLUDED.revoked_at
`,
      [
        record.provider,
        record.hop1Issuer,
        record.hop1Subject,
        record.email,
        record.scopesGranted,
        record.encryptedRefreshToken,
        record.createdAt,
        record.updatedAt,
        record.revokedAt ?? null,
      ],
    );
  }

  async getAccount(hop1Issuer: string, hop1Subject: string): Promise<OAuthAccountRecord | null> {
    const result = await this.client.query(
      `
SELECT
  provider,
  hop1_issuer,
  hop1_subject,
  email,
  scopes_granted,
  encrypted_refresh_token,
  created_at,
  updated_at,
  revoked_at
FROM oauth_accounts
WHERE provider = $1
  AND hop1_issuer = $2
  AND hop1_subject = $3
LIMIT 1
`,
      ["google", hop1Issuer, hop1Subject],
    );

    const row = result.rows[0];
    return row ? rowToAccount(row) : null;
  }

  async markRevoked(hop1Issuer: string, hop1Subject: string, revokedAt: Date): Promise<void> {
    await this.client.query(
      `
UPDATE oauth_accounts
SET revoked_at = $1,
    updated_at = $1
WHERE provider = 'google'
  AND hop1_issuer = $2
  AND hop1_subject = $3
`,
      [revokedAt, hop1Issuer, hop1Subject],
    );
  }
}

export class SqlOAuthStateStore implements OAuthStateStore {
  constructor(private readonly client: SqlQueryClient) {}

  async save(record: OAuthStateRecord): Promise<void> {
    await this.client.query(
      `
INSERT INTO oauth_states (
  state_hash,
  hop1_issuer,
  hop1_subject,
  email,
  requested_scopes,
  redirect_after,
  expires_at,
  consumed_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (state_hash)
DO UPDATE SET
  hop1_issuer = EXCLUDED.hop1_issuer,
  hop1_subject = EXCLUDED.hop1_subject,
  email = EXCLUDED.email,
  requested_scopes = EXCLUDED.requested_scopes,
  redirect_after = EXCLUDED.redirect_after,
  expires_at = EXCLUDED.expires_at,
  consumed_at = EXCLUDED.consumed_at
`,
      [
        record.stateHash,
        record.hop1Issuer,
        record.hop1Subject,
        record.email,
        record.requestedScopes,
        record.redirectAfter ?? null,
        record.expiresAt,
        record.consumedAt ?? null,
      ],
    );
  }

  async consume(state: string): Promise<OAuthStateRecord | null> {
    const stateHash = hashState(state);
    const result = await this.client.query(
      `
SELECT
  state_hash,
  hop1_issuer,
  hop1_subject,
  email,
  requested_scopes,
  redirect_after,
  expires_at,
  consumed_at
FROM oauth_states
WHERE state_hash = $1
  AND consumed_at IS NULL
  AND expires_at > NOW()
LIMIT 1
`,
      [stateHash],
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    await this.client.query(
      `
UPDATE oauth_states
SET consumed_at = $1
WHERE state_hash = $2
`,
      [new Date(), stateHash],
    );

    return rowToState(row);
  }
}

function rowToAccount(row: Record<string, unknown>): OAuthAccountRecord {
  return {
    provider: "google",
    hop1Issuer: stringField(row, "hop1_issuer"),
    hop1Subject: stringField(row, "hop1_subject"),
    email: stringField(row, "email"),
    scopesGranted: stringArrayField(row, "scopes_granted"),
    encryptedRefreshToken: stringField(row, "encrypted_refresh_token"),
    createdAt: dateField(row, "created_at"),
    updatedAt: dateField(row, "updated_at"),
    revokedAt: optionalDateField(row, "revoked_at"),
  };
}

function rowToState(row: Record<string, unknown>): OAuthStateRecord {
  return {
    stateHash: stringField(row, "state_hash"),
    hop1Issuer: stringField(row, "hop1_issuer"),
    hop1Subject: stringField(row, "hop1_subject"),
    email: stringField(row, "email"),
    requestedScopes: stringArrayField(row, "requested_scopes"),
    redirectAfter: optionalStringField(row, "redirect_after"),
    expiresAt: dateField(row, "expires_at"),
    consumedAt: optionalDateField(row, "consumed_at"),
  };
}

function stringField(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  if (typeof value !== "string") {
    throw new Error(`Expected SQL field ${name} to be a string`);
  }

  return value;
}

function stringArrayField(row: Record<string, unknown>, name: string): string[] {
  const value = row[name];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Expected SQL field ${name} to be a string array`);
  }

  return value;
}

function optionalStringField(row: Record<string, unknown>, name: string): string | undefined {
  const value = row[name];
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`Expected SQL field ${name} to be a string`);
  }

  return value;
}

function dateField(row: Record<string, unknown>, name: string): Date {
  const value = row[name];
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === "string") {
    return new Date(value);
  }

  throw new Error(`Expected SQL field ${name} to be a date`);
}

function optionalDateField(row: Record<string, unknown>, name: string): Date | undefined {
  const value = row[name];
  if (value === null || value === undefined) {
    return undefined;
  }

  return dateField(row, name);
}
