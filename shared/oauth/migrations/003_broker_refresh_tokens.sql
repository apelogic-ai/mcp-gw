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
