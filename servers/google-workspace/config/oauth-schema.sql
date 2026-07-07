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
