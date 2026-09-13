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
