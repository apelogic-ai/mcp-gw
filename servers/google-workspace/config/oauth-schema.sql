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

CREATE INDEX IF NOT EXISTS oauth_accounts_email_idx ON oauth_accounts (provider, email);

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

CREATE INDEX IF NOT EXISTS oauth_states_expiry_idx ON oauth_states (expires_at);

CREATE TABLE IF NOT EXISTS oauth_broker_transactions (
  state_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL,
  scopes TEXT[] NOT NULL,
  client_state TEXT,
  code_challenge TEXT NOT NULL,
  google_nonce TEXT NOT NULL,
  google_code_verifier TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_broker_transactions_expiry_idx
  ON oauth_broker_transactions (expires_at);

CREATE TABLE IF NOT EXISTS oauth_broker_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL,
  scopes TEXT[] NOT NULL,
  code_challenge TEXT NOT NULL,
  identity_issuer TEXT NOT NULL,
  identity_subject TEXT NOT NULL,
  identity_email TEXT NOT NULL,
  identity_email_verified BOOLEAN NOT NULL CHECK (identity_email_verified),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_broker_codes_expiry_idx
  ON oauth_broker_codes (expires_at);

CREATE TABLE IF NOT EXISTS oauth_dcr_clients (
  client_id TEXT PRIMARY KEY,
  registration JSONB NOT NULL,
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS oauth_dcr_clients_expiry_idx
  ON oauth_dcr_clients (expires_at);

CREATE TABLE IF NOT EXISTS oauth_dcr_rate_limits (
  rate_limit_key_hash TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL CHECK (attempts > 0),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_dcr_rate_limits_expiry_idx
  ON oauth_dcr_rate_limits (expires_at);

CREATE TABLE IF NOT EXISTS oauth_broker_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  scopes TEXT[] NOT NULL CHECK (cardinality(scopes) > 0),
  identity_issuer TEXT NOT NULL,
  identity_subject TEXT NOT NULL,
  identity_email TEXT NOT NULL,
  identity_email_verified BOOLEAN NOT NULL CHECK (identity_email_verified),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS oauth_broker_refresh_tokens_family_idx
  ON oauth_broker_refresh_tokens (family_id);

CREATE INDEX IF NOT EXISTS oauth_broker_refresh_tokens_expiry_idx
  ON oauth_broker_refresh_tokens (expires_at);

ALTER TABLE oauth_accounts
  ADD COLUMN IF NOT EXISTS credential_envelope TEXT,
  ADD COLUMN IF NOT EXISTS credential_schema_version INTEGER,
  ADD COLUMN IF NOT EXISTS connection_generation BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS scopes_required TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS active_credential_present BOOLEAN,
  ADD COLUMN IF NOT EXISTS renewal_credential_present BOOLEAN,
  ADD COLUMN IF NOT EXISTS active_credential_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS renewal_credential_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_authorized_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_renewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_validated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS local_disabled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lifecycle_phase TEXT,
  ADD COLUMN IF NOT EXISTS revocation_state TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS revocation_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revocation_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lifecycle_error_category TEXT,
  ADD COLUMN IF NOT EXISTS lifecycle_updated_at TIMESTAMPTZ;

ALTER TABLE oauth_states
  ADD COLUMN IF NOT EXISTS connection_generation BIGINT,
  ADD COLUMN IF NOT EXISTS connection_locally_disabled BOOLEAN,
  ADD COLUMN IF NOT EXISTS connection_updated_at TIMESTAMPTZ;

UPDATE oauth_accounts
SET last_authorized_at = COALESCE(last_authorized_at, created_at),
    lifecycle_phase = COALESCE(
      lifecycle_phase,
      CASE WHEN revoked_at IS NULL THEN 'connected' ELSE 'disconnected' END
    ),
    local_disabled_at = COALESCE(local_disabled_at, revoked_at),
    revocation_state = CASE
      WHEN revoked_at IS NOT NULL AND revocation_state = 'none' THEN 'complete'
      ELSE revocation_state
    END;

CREATE INDEX IF NOT EXISTS oauth_accounts_pending_revocation_idx
  ON oauth_accounts (revocation_state, updated_at)
  WHERE revocation_state = 'pending';

COMMENT ON COLUMN oauth_accounts.encrypted_refresh_token IS
  'Legacy rolling-deployment compatibility: Google refresh token or GitHub access token. New code uses credential_envelope.';

COMMENT ON COLUMN oauth_accounts.credential_envelope IS
  'Encrypted, versioned provider-specific credential JSON. Never read for ordinary status.';

CREATE TABLE IF NOT EXISTS oauth_connection_authorizations (
  provider TEXT NOT NULL,
  hop1_issuer TEXT NOT NULL,
  hop1_subject TEXT NOT NULL,
  required_scopes TEXT[] NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (provider, hop1_issuer, hop1_subject)
);

CREATE INDEX IF NOT EXISTS oauth_connection_authorizations_expiry_idx
  ON oauth_connection_authorizations (expires_at);
