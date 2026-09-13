ALTER TABLE oauth_states
  ADD COLUMN IF NOT EXISTS provider TEXT;

CREATE INDEX IF NOT EXISTS oauth_states_provider_principal_idx
  ON oauth_states (provider, hop1_issuer, hop1_subject)
  WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS oauth_pending_credential_cleanup (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  hop1_issuer TEXT NOT NULL,
  hop1_subject TEXT NOT NULL,
  email TEXT NOT NULL,
  credential_envelope TEXT NOT NULL,
  credential_schema_version INTEGER NOT NULL,
  connection_generation BIGINT NOT NULL,
  scopes_granted TEXT[] NOT NULL,
  active_credential_expires_at TIMESTAMPTZ,
  renewal_credential_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_pending_credential_cleanup_provider_idx
  ON oauth_pending_credential_cleanup (provider, updated_at);

COMMENT ON TABLE oauth_pending_credential_cleanup IS
  'Encrypted provider credentials rejected by connection CAS and awaiting provider-side cleanup.';
