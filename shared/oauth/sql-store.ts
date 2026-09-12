import { hashState } from "./state";
import type {
  ConnectionPhase,
  ConnectionRecord,
  LifecycleErrorCategory,
  PendingCredentialCleanupRecord,
  RevocationState,
} from "./connection-types";
import type {
  ConnectionWriteGuard,
  OAuthAccountRecord,
  OAuthProvider,
  OAuthStateRecord,
  OAuthStateStore,
  OAuthTokenStore,
  OAuthConnectionStore,
} from "./store";

export interface SqlQueryClient {
  query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  transaction?<T>(operation: (client: SqlQueryClient) => Promise<T>): Promise<T>;
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

  async getAccount(
    hop1Issuer: string,
    hop1Subject: string,
    provider: OAuthProvider = "google",
  ): Promise<OAuthAccountRecord | null> {
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
      [provider, hop1Issuer, hop1Subject],
    );

    const row = result.rows[0];
    return row ? rowToAccount(row) : null;
  }

  async markRevoked(
    hop1Issuer: string,
    hop1Subject: string,
    revokedAt: Date,
    provider: OAuthProvider = "google",
  ): Promise<void> {
    await this.client.query(
      `
UPDATE oauth_accounts
SET revoked_at = $1,
    updated_at = $1
WHERE provider = $2
  AND hop1_issuer = $3
  AND hop1_subject = $4
`,
      [revokedAt, provider, hop1Issuer, hop1Subject],
    );
  }

  async getConnection(
    provider: OAuthProvider,
    hop1Issuer: string,
    hop1Subject: string,
  ): Promise<ConnectionRecord | null> {
    const result = await this.client.query(
      `
SELECT
  provider,
  hop1_issuer,
  hop1_subject,
  email,
  scopes_granted,
  encrypted_refresh_token,
  credential_envelope,
  credential_schema_version,
  connection_generation,
  scopes_required,
  active_credential_present,
  renewal_credential_present,
  active_credential_expires_at,
  renewal_credential_expires_at,
  last_authorized_at,
  last_renewed_at,
  last_validated_at,
  local_disabled_at,
  lifecycle_phase,
  revocation_state,
  revocation_started_at,
  revocation_completed_at,
  lifecycle_error_category,
  lifecycle_updated_at,
  created_at,
  updated_at,
  revoked_at
FROM (
  SELECT
    provider,
    hop1_issuer,
    hop1_subject,
    email,
    scopes_granted,
    encrypted_refresh_token,
    credential_envelope,
    credential_schema_version,
    connection_generation,
    scopes_required,
    active_credential_present,
    renewal_credential_present,
    active_credential_expires_at,
    renewal_credential_expires_at,
    last_authorized_at,
    last_renewed_at,
    last_validated_at,
    local_disabled_at,
    lifecycle_phase,
    revocation_state,
    revocation_started_at,
    revocation_completed_at,
    lifecycle_error_category,
    lifecycle_updated_at,
    created_at,
    updated_at,
    revoked_at,
    CASE
      WHEN local_disabled_at IS NULL
        AND revoked_at IS NULL
        AND COALESCE(lifecycle_phase, 'connected') = 'connected'
      THEN 0
      ELSE 2
    END AS authorization_priority
  FROM oauth_accounts
  WHERE provider = $1
    AND hop1_issuer = $2
    AND hop1_subject = $3

  UNION ALL

  SELECT
    authorization.provider,
    authorization.hop1_issuer,
    authorization.hop1_subject,
    COALESCE(account.email, '') AS email,
    COALESCE(account.scopes_granted, ARRAY[]::TEXT[]) AS scopes_granted,
    COALESCE(account.encrypted_refresh_token, '') AS encrypted_refresh_token,
    account.credential_envelope,
    account.credential_schema_version,
    COALESCE(account.connection_generation, 0::BIGINT) AS connection_generation,
    authorization.required_scopes AS scopes_required,
    COALESCE(account.active_credential_present, FALSE) AS active_credential_present,
    COALESCE(account.renewal_credential_present, FALSE) AS renewal_credential_present,
    account.active_credential_expires_at,
    account.renewal_credential_expires_at,
    account.last_authorized_at,
    account.last_renewed_at,
    account.last_validated_at,
    account.local_disabled_at,
    'authorizing' AS lifecycle_phase,
    COALESCE(account.revocation_state, 'none') AS revocation_state,
    account.revocation_started_at,
    account.revocation_completed_at,
    account.lifecycle_error_category,
    authorization.updated_at AS lifecycle_updated_at,
    COALESCE(account.created_at, authorization.updated_at) AS created_at,
    COALESCE(account.updated_at, authorization.updated_at) AS updated_at,
    account.revoked_at,
    1 AS authorization_priority
  FROM oauth_connection_authorizations AS authorization
  LEFT JOIN oauth_accounts AS account
    ON account.provider = authorization.provider
   AND account.hop1_issuer = authorization.hop1_issuer
   AND account.hop1_subject = authorization.hop1_subject
  WHERE authorization.provider = $1
    AND authorization.hop1_issuer = $2
    AND authorization.hop1_subject = $3
    AND authorization.expires_at > NOW()
) AS candidates
ORDER BY authorization_priority ASC
LIMIT 1
`,
      [provider, hop1Issuer, hop1Subject],
    );
    const row = result.rows[0];
    return row ? rowToConnection(row) : null;
  }

  async saveConnection(record: ConnectionRecord, guard: ConnectionWriteGuard): Promise<boolean> {
    const result = await this.client.query(
      `
INSERT INTO oauth_accounts (
  provider, hop1_issuer, hop1_subject, email, scopes_granted,
  encrypted_refresh_token, credential_envelope, credential_schema_version,
  connection_generation, scopes_required, active_credential_present,
  renewal_credential_present, active_credential_expires_at,
  renewal_credential_expires_at, last_authorized_at, last_renewed_at,
  last_validated_at, local_disabled_at, lifecycle_phase, revocation_state,
  revocation_started_at, revocation_completed_at, lifecycle_error_category,
  lifecycle_updated_at, created_at, updated_at, revoked_at
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
  $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $25,
  $24, $25, $18
)
ON CONFLICT (provider, hop1_issuer, hop1_subject)
DO UPDATE SET
  email = EXCLUDED.email,
  scopes_granted = EXCLUDED.scopes_granted,
  encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
  credential_envelope = EXCLUDED.credential_envelope,
  credential_schema_version = EXCLUDED.credential_schema_version,
  connection_generation = EXCLUDED.connection_generation,
  scopes_required = EXCLUDED.scopes_required,
  active_credential_present = EXCLUDED.active_credential_present,
  renewal_credential_present = EXCLUDED.renewal_credential_present,
  active_credential_expires_at = EXCLUDED.active_credential_expires_at,
  renewal_credential_expires_at = EXCLUDED.renewal_credential_expires_at,
  last_authorized_at = EXCLUDED.last_authorized_at,
  last_renewed_at = EXCLUDED.last_renewed_at,
  last_validated_at = EXCLUDED.last_validated_at,
  local_disabled_at = EXCLUDED.local_disabled_at,
  lifecycle_phase = EXCLUDED.lifecycle_phase,
  revocation_state = EXCLUDED.revocation_state,
  revocation_started_at = EXCLUDED.revocation_started_at,
  revocation_completed_at = EXCLUDED.revocation_completed_at,
  lifecycle_error_category = EXCLUDED.lifecycle_error_category,
  lifecycle_updated_at = EXCLUDED.lifecycle_updated_at,
  updated_at = EXCLUDED.updated_at,
  revoked_at = EXCLUDED.revoked_at
WHERE $26 = TRUE
  AND oauth_accounts.connection_generation = $27
  AND oauth_accounts.updated_at = $28
  AND oauth_accounts.revoked_at IS NOT DISTINCT FROM $29
RETURNING connection_generation
`,
      [
        record.provider,
        record.hop1Issuer,
        record.hop1Subject,
        record.displayAccountIdentity,
        record.grantedScopes,
        record.encryptedLegacyCredential,
        record.encryptedCredentialEnvelope ?? null,
        record.credentialSchemaVersion ?? null,
        record.generation,
        record.requiredScopes,
        record.activeCredentialPresent,
        record.renewalCredentialPresent,
        record.activeCredentialExpiresAt ?? null,
        record.renewalCredentialExpiresAt ?? null,
        record.lastAuthorizedAt ?? null,
        record.lastRenewedAt ?? null,
        record.lastValidatedAt ?? null,
        record.localDisabledAt ?? null,
        record.phase,
        record.revocationState,
        record.revocationStartedAt ?? null,
        record.revocationCompletedAt ?? null,
        record.lifecycleErrorCategory ?? null,
        record.createdAt,
        record.updatedAt,
        guard.exists,
        guard.generation ?? null,
        guard.updatedAt ?? null,
        guard.revokedAt ?? null,
      ],
    );
    return result.rows.length === 1;
  }

  async listConnectionsPendingRevocation(
    provider: OAuthProvider,
    limit: number,
  ): Promise<ConnectionRecord[]> {
    const result = await this.client.query(
      `
SELECT
  provider, hop1_issuer, hop1_subject, email, scopes_granted,
  encrypted_refresh_token, credential_envelope, credential_schema_version,
  connection_generation, scopes_required, active_credential_present,
  renewal_credential_present, active_credential_expires_at,
  renewal_credential_expires_at, last_authorized_at, last_renewed_at,
  last_validated_at, local_disabled_at, lifecycle_phase, revocation_state,
  revocation_started_at, revocation_completed_at, lifecycle_error_category,
  lifecycle_updated_at, created_at, updated_at, revoked_at
FROM oauth_accounts
WHERE provider = $1
  AND revocation_state = 'pending'
  AND local_disabled_at IS NOT NULL
ORDER BY updated_at ASC
LIMIT $2
`,
      [provider, limit],
    );
    return result.rows.map(rowToConnection);
  }

  async savePendingCredentialCleanup(record: PendingCredentialCleanupRecord): Promise<void> {
    await this.client.query(
      `
INSERT INTO oauth_pending_credential_cleanup (
  id, provider, hop1_issuer, hop1_subject, email, credential_envelope,
  credential_schema_version, connection_generation, scopes_granted,
  active_credential_expires_at, renewal_credential_expires_at, created_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
ON CONFLICT (id) DO NOTHING
`,
      [
        record.id,
        record.provider,
        record.hop1Issuer,
        record.hop1Subject,
        record.displayAccountIdentity,
        record.encryptedCredentialEnvelope,
        record.credentialSchemaVersion,
        record.generation,
        record.grantedScopes,
        record.activeCredentialExpiresAt ?? null,
        record.renewalCredentialExpiresAt ?? null,
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  async listPendingCredentialCleanups(
    provider: OAuthProvider,
    limit: number,
  ): Promise<PendingCredentialCleanupRecord[]> {
    const result = await this.client.query(
      `
SELECT
  id, provider, hop1_issuer, hop1_subject, email, credential_envelope,
  credential_schema_version, connection_generation, scopes_granted,
  active_credential_expires_at, renewal_credential_expires_at, created_at, updated_at
FROM oauth_pending_credential_cleanup
WHERE provider = $1
ORDER BY updated_at ASC
LIMIT $2
`,
      [provider, limit],
    );
    return result.rows.map(rowToPendingCredentialCleanup);
  }

  async deletePendingCredentialCleanup(id: string): Promise<void> {
    await this.client.query("DELETE FROM oauth_pending_credential_cleanup WHERE id = $1", [id]);
  }

  async markAuthorizing(
    provider: OAuthProvider,
    hop1Issuer: string,
    hop1Subject: string,
    requiredScopes: string[],
    expiresAt: Date,
  ): Promise<void> {
    await this.client.query(
      `
INSERT INTO oauth_connection_authorizations (
  provider, hop1_issuer, hop1_subject, required_scopes, expires_at, updated_at
) VALUES ($1, $2, $3, $4, $5, NOW())
ON CONFLICT (provider, hop1_issuer, hop1_subject)
DO UPDATE SET
  required_scopes = EXCLUDED.required_scopes,
  expires_at = EXCLUDED.expires_at,
  updated_at = EXCLUDED.updated_at
`,
      [provider, hop1Issuer, hop1Subject, requiredScopes, expiresAt],
    );
  }

  async clearAuthorizing(
    provider: OAuthProvider,
    hop1Issuer: string,
    hop1Subject: string,
  ): Promise<void> {
    await this.client.query(
      `
DELETE FROM oauth_connection_authorizations
WHERE provider = $1
  AND hop1_issuer = $2
  AND hop1_subject = $3
`,
      [provider, hop1Issuer, hop1Subject],
    );
  }

  async withConnectionLock<T>(
    provider: OAuthProvider,
    hop1Issuer: string,
    hop1Subject: string,
    operation: (store: OAuthConnectionStore) => Promise<T>,
  ): Promise<T> {
    if (!this.client.transaction) {
      return operation(this);
    }
    return this.client.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `${provider}\n${hop1Issuer}\n${hop1Subject}`,
      ]);
      return operation(new SqlOAuthTokenStore(client));
    });
  }
}

export class SqlOAuthStateStore implements OAuthStateStore {
  constructor(private readonly client: SqlQueryClient) {}

  async save(record: OAuthStateRecord): Promise<void> {
    await this.client.query(
      `
INSERT INTO oauth_states (
  state_hash,
  provider,
  hop1_issuer,
  hop1_subject,
  email,
  requested_scopes,
  redirect_after,
  expires_at,
  consumed_at,
  connection_generation,
  connection_locally_disabled,
  connection_updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
ON CONFLICT (state_hash)
DO UPDATE SET
  provider = EXCLUDED.provider,
  hop1_issuer = EXCLUDED.hop1_issuer,
  hop1_subject = EXCLUDED.hop1_subject,
  email = EXCLUDED.email,
  requested_scopes = EXCLUDED.requested_scopes,
  redirect_after = EXCLUDED.redirect_after,
  expires_at = EXCLUDED.expires_at,
  consumed_at = EXCLUDED.consumed_at,
  connection_generation = EXCLUDED.connection_generation,
  connection_locally_disabled = EXCLUDED.connection_locally_disabled,
  connection_updated_at = EXCLUDED.connection_updated_at
`,
      [
        record.stateHash,
        record.provider ?? null,
        record.hop1Issuer,
        record.hop1Subject,
        record.email,
        record.requestedScopes,
        record.redirectAfter ?? null,
        record.expiresAt,
        record.consumedAt ?? null,
        record.connectionGeneration ?? null,
        record.connectionLocallyDisabled ?? null,
        record.connectionUpdatedAt ?? null,
      ],
    );
  }

  async consume(provider: OAuthProvider, state: string): Promise<OAuthStateRecord | null> {
    const stateHash = hashState(state);
    const consumedAt = new Date();
    const result = await this.client.query(
      `
UPDATE oauth_states
SET consumed_at = $1
WHERE state_hash = $2
  AND (provider = $3 OR provider IS NULL)
  AND consumed_at IS NULL
  AND expires_at > NOW()
RETURNING
  state_hash,
  provider,
  hop1_issuer,
  hop1_subject,
  email,
  requested_scopes,
  redirect_after,
  expires_at,
  consumed_at,
  connection_generation,
  connection_locally_disabled,
  connection_updated_at
`,
      [consumedAt, stateHash, provider],
    );

    const row = result.rows[0];
    return row ? rowToState(row) : null;
  }

  async invalidatePrincipal(
    provider: OAuthProvider,
    hop1Issuer: string,
    hop1Subject: string,
  ): Promise<void> {
    await this.client.query(
      `
UPDATE oauth_states
SET consumed_at = NOW()
WHERE provider = $1
  AND hop1_issuer = $2
  AND hop1_subject = $3
  AND consumed_at IS NULL
`,
      [provider, hop1Issuer, hop1Subject],
    );
  }
}

function rowToAccount(row: Record<string, unknown>): OAuthAccountRecord {
  return {
    provider: providerField(row, "provider"),
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

function rowToConnection(row: Record<string, unknown>): ConnectionRecord {
  const provider = providerField(row, "provider");
  const revokedAt = optionalDateField(row, "revoked_at");
  const phase = optionalStringField(row, "lifecycle_phase");
  const updatedAt = dateField(row, "updated_at");
  const lifecycleUpdatedAt = optionalDateField(row, "lifecycle_updated_at");
  const normalizedCurrent =
    lifecycleUpdatedAt !== undefined && lifecycleUpdatedAt.getTime() >= updatedAt.getTime();
  return {
    provider,
    hop1Issuer: stringField(row, "hop1_issuer"),
    hop1Subject: stringField(row, "hop1_subject"),
    displayAccountIdentity: stringField(row, "email"),
    encryptedCredentialEnvelope: normalizedCurrent
      ? optionalStringField(row, "credential_envelope")
      : undefined,
    credentialSchemaVersion: normalizedCurrent
      ? optionalNumberField(row, "credential_schema_version")
      : undefined,
    generation: optionalNumberField(row, "connection_generation") ?? 1,
    requiredScopes: normalizedCurrent
      ? (optionalStringArrayField(row, "scopes_required") ?? [])
      : [],
    grantedScopes: stringArrayField(row, "scopes_granted"),
    activeCredentialPresent: normalizedCurrent
      ? (optionalBooleanField(row, "active_credential_present") ?? false)
      : provider === "github",
    renewalCredentialPresent: normalizedCurrent
      ? (optionalBooleanField(row, "renewal_credential_present") ?? false)
      : provider === "google",
    activeCredentialExpiresAt: normalizedCurrent
      ? optionalDateField(row, "active_credential_expires_at")
      : undefined,
    renewalCredentialExpiresAt: normalizedCurrent
      ? optionalDateField(row, "renewal_credential_expires_at")
      : undefined,
    lastAuthorizedAt: normalizedCurrent
      ? (optionalDateField(row, "last_authorized_at") ?? dateField(row, "created_at"))
      : updatedAt,
    lastRenewedAt: normalizedCurrent ? optionalDateField(row, "last_renewed_at") : undefined,
    lastValidatedAt: normalizedCurrent ? optionalDateField(row, "last_validated_at") : undefined,
    localDisabledAt: normalizedCurrent
      ? (optionalDateField(row, "local_disabled_at") ?? revokedAt)
      : revokedAt,
    phase:
      normalizedCurrent && isConnectionPhase(phase)
        ? phase
        : revokedAt
          ? "disconnected"
          : "connected",
    revocationState: normalizedCurrent
      ? revocationStateField(row, revokedAt)
      : revokedAt
        ? "complete"
        : "none",
    revocationStartedAt: normalizedCurrent
      ? optionalDateField(row, "revocation_started_at")
      : undefined,
    revocationCompletedAt: normalizedCurrent
      ? optionalDateField(row, "revocation_completed_at")
      : revokedAt,
    lifecycleErrorCategory: normalizedCurrent ? lifecycleErrorField(row) : undefined,
    createdAt: dateField(row, "created_at"),
    updatedAt,
    encryptedLegacyCredential: stringField(row, "encrypted_refresh_token"),
  };
}

function providerField(row: Record<string, unknown>, name: string): OAuthProvider {
  const value = stringField(row, name);
  if (value !== "google" && value !== "github") {
    throw new Error(`Expected SQL field ${name} to be a supported OAuth provider`);
  }

  return value;
}

function rowToState(row: Record<string, unknown>): OAuthStateRecord {
  return {
    stateHash: stringField(row, "state_hash"),
    provider: optionalProviderField(row, "provider"),
    hop1Issuer: stringField(row, "hop1_issuer"),
    hop1Subject: stringField(row, "hop1_subject"),
    email: stringField(row, "email"),
    requestedScopes: stringArrayField(row, "requested_scopes"),
    redirectAfter: optionalStringField(row, "redirect_after"),
    expiresAt: dateField(row, "expires_at"),
    consumedAt: optionalDateField(row, "consumed_at"),
    connectionGeneration: optionalNumberField(row, "connection_generation"),
    connectionLocallyDisabled: optionalBooleanField(row, "connection_locally_disabled"),
    connectionUpdatedAt: optionalDateField(row, "connection_updated_at"),
  };
}

function rowToPendingCredentialCleanup(
  row: Record<string, unknown>,
): PendingCredentialCleanupRecord {
  return {
    id: stringField(row, "id"),
    provider: providerField(row, "provider"),
    hop1Issuer: stringField(row, "hop1_issuer"),
    hop1Subject: stringField(row, "hop1_subject"),
    displayAccountIdentity: stringField(row, "email"),
    encryptedCredentialEnvelope: stringField(row, "credential_envelope"),
    credentialSchemaVersion: numberField(row, "credential_schema_version"),
    generation: numberField(row, "connection_generation"),
    grantedScopes: stringArrayField(row, "scopes_granted"),
    activeCredentialExpiresAt: optionalDateField(row, "active_credential_expires_at"),
    renewalCredentialExpiresAt: optionalDateField(row, "renewal_credential_expires_at"),
    createdAt: dateField(row, "created_at"),
    updatedAt: dateField(row, "updated_at"),
  };
}

function optionalProviderField(
  row: Record<string, unknown>,
  name: string,
): OAuthProvider | undefined {
  const value = optionalStringField(row, name);
  if (value === undefined) return undefined;
  if (value !== "google" && value !== "github") {
    throw new Error(`Expected SQL field ${name} to be a supported OAuth provider`);
  }
  return value;
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

function optionalStringArrayField(
  row: Record<string, unknown>,
  name: string,
): string[] | undefined {
  const value = row[name];
  return value === null || value === undefined ? undefined : stringArrayField(row, name);
}

function optionalNumberField(row: Record<string, unknown>, name: string): number | undefined {
  const value = row[name];
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  throw new Error(`Expected SQL field ${name} to be a number`);
}

function numberField(row: Record<string, unknown>, name: string): number {
  const value = optionalNumberField(row, name);
  if (value === undefined) {
    throw new Error(`Expected SQL field ${name} to be a number`);
  }
  return value;
}

function optionalBooleanField(row: Record<string, unknown>, name: string): boolean | undefined {
  const value = row[name];
  if (value === null || value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  throw new Error(`Expected SQL field ${name} to be a boolean`);
}

function isConnectionPhase(value: string | undefined): value is ConnectionPhase {
  return [
    "disconnected",
    "authorizing",
    "connected",
    "renewing",
    "reauthorization_required",
    "revocation_pending",
    "disconnected_with_provider_cleanup_pending",
    "unavailable",
  ].includes(value ?? "");
}

function revocationStateField(row: Record<string, unknown>, revokedAt?: Date): RevocationState {
  const value = optionalStringField(row, "revocation_state");
  return value === "pending" || value === "complete" || value === "permanent_failure"
    ? value
    : revokedAt
      ? "complete"
      : "none";
}

function lifecycleErrorField(row: Record<string, unknown>): LifecycleErrorCategory | undefined {
  return optionalStringField(row, "lifecycle_error_category") as LifecycleErrorCategory | undefined;
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
