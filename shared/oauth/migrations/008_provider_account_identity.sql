ALTER TABLE oauth_accounts
  ADD COLUMN IF NOT EXISTS provider_account_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_account_login TEXT;

COMMENT ON COLUMN oauth_accounts.provider_account_id IS
  'Immutable provider-owned account identifier. Consumers must match on this field, never login or email.';

COMMENT ON COLUMN oauth_accounts.provider_account_login IS
  'Mutable provider login retained for display only.';
