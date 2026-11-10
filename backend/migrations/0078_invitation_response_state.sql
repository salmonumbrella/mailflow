-- Native invitation responses must survive both process restarts and setup/full backups.
-- Keys hash owner/account/organizer/event identity. Values contain only sequence ranks or
-- response status, opaque attempt identifiers and timestamps, never calendar bodies/addresses.
CREATE TABLE IF NOT EXISTS invitation_response_state (
  key TEXT PRIMARY KEY CHECK (length(key) <= 128),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  value TEXT NOT NULL CHECK (octet_length(value) <= 8192),
  expires_at TIMESTAMPTZ CHECK (expires_at IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_invitation_response_user ON invitation_response_state (user_id);
CREATE INDEX IF NOT EXISTS idx_invitation_response_account ON invitation_response_state (account_id);
