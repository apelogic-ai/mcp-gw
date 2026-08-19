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
  expires_at TIMESTAMPTZ NOT NULL
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
