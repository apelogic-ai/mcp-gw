CREATE TABLE IF NOT EXISTS oauth_credential_generations (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  hop1_issuer TEXT NOT NULL,
  hop1_subject TEXT NOT NULL,
  email TEXT NOT NULL,
  credential_envelope TEXT,
  encrypted_legacy_credential TEXT,
  credential_schema_version INTEGER NOT NULL,
  connection_generation BIGINT NOT NULL,
  custody_state TEXT NOT NULL CHECK (custody_state IN (
    'candidate', 'active', 'cleanup_pending', 'cleanup_complete',
    'cleanup_permanent_failure', 'retired'
  )),
  scopes_granted TEXT[] NOT NULL,
  active_credential_expires_at TIMESTAMPTZ,
  renewal_credential_expires_at TIMESTAMPTZ,
  cleanup_attempts INTEGER NOT NULL DEFAULT 0,
  next_cleanup_attempt_at TIMESTAMPTZ,
  last_cleanup_error_category TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE oauth_accounts
  ADD COLUMN IF NOT EXISTS credential_generation_id TEXT;

CREATE INDEX IF NOT EXISTS oauth_credential_generations_cleanup_idx
  ON oauth_credential_generations (provider, next_cleanup_attempt_at, updated_at)
  WHERE custody_state = 'cleanup_pending';

CREATE INDEX IF NOT EXISTS oauth_credential_generations_principal_idx
  ON oauth_credential_generations (provider, hop1_issuer, hop1_subject, created_at);

INSERT INTO oauth_credential_generations (
  id, provider, hop1_issuer, hop1_subject, email, credential_envelope,
  encrypted_legacy_credential,
  credential_schema_version, connection_generation, custody_state, scopes_granted,
  active_credential_expires_at, renewal_credential_expires_at, cleanup_attempts,
  created_at, updated_at
)
SELECT
  'account:' || provider || ':' || md5(hop1_issuer || E'\n' || hop1_subject) || ':' || connection_generation,
  provider, hop1_issuer, hop1_subject, email, credential_envelope,
  encrypted_refresh_token,
  COALESCE(credential_schema_version, 1), connection_generation,
  CASE WHEN COALESCE(local_disabled_at, revoked_at) IS NULL THEN 'active' ELSE 'cleanup_pending' END,
  scopes_granted, active_credential_expires_at, renewal_credential_expires_at, 0,
  created_at, updated_at
FROM oauth_accounts
ON CONFLICT (id) DO NOTHING;

UPDATE oauth_accounts AS account
SET credential_generation_id = generation.id
FROM oauth_credential_generations AS generation
WHERE account.credential_generation_id IS NULL
  AND generation.provider = account.provider
  AND generation.hop1_issuer = account.hop1_issuer
  AND generation.hop1_subject = account.hop1_subject
  AND generation.connection_generation = account.connection_generation
  AND generation.id LIKE 'account:%';

INSERT INTO oauth_credential_generations (
  id, provider, hop1_issuer, hop1_subject, email, credential_envelope,
  encrypted_legacy_credential,
  credential_schema_version, connection_generation, custody_state, scopes_granted,
  active_credential_expires_at, renewal_credential_expires_at, cleanup_attempts,
  created_at, updated_at
)
SELECT
  id, provider, hop1_issuer, hop1_subject, email, credential_envelope,
  NULL,
  credential_schema_version, connection_generation, 'cleanup_pending', scopes_granted,
  active_credential_expires_at, renewal_credential_expires_at, 0, created_at, updated_at
FROM oauth_pending_credential_cleanup
ON CONFLICT (id) DO NOTHING;

UPDATE oauth_states
SET consumed_at = NOW()
WHERE provider IS NULL AND consumed_at IS NULL;

CREATE OR REPLACE FUNCTION oauth_prevent_legacy_disconnect_reversal()
RETURNS trigger AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL
     AND NEW.revoked_at IS NULL
     AND COALESCE(NEW.connection_generation, 1) <= COALESCE(OLD.connection_generation, 1)
  THEN
    RAISE EXCEPTION 'legacy write cannot reverse a disconnected OAuth connection'
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS oauth_legacy_disconnect_fence ON oauth_accounts;
CREATE TRIGGER oauth_legacy_disconnect_fence
BEFORE UPDATE ON oauth_accounts
FOR EACH ROW EXECUTE FUNCTION oauth_prevent_legacy_disconnect_reversal();

COMMENT ON TABLE oauth_credential_generations IS
  'Durable custody ledger for every provider-issued credential generation.';
