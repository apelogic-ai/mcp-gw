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
