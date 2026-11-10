-- Explicit per-send image-load activity. No recipient or network/device identifiers.
-- A token only permits recording a bounded load; it never permits reading activity.
CREATE TABLE IF NOT EXISTS outgoing_open_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  scheduled_id UUID REFERENCES scheduled_messages(id) ON DELETE SET NULL,
  message_id VARCHAR(512) NOT NULL,
  token VARCHAR(43) NOT NULL UNIQUE CHECK (token ~ '^[A-Za-z0-9_-]{43}$'),
  status TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'sending', 'sent', 'failed', 'cancelled', 'uncertain')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days',
  first_loaded_at TIMESTAMPTZ,
  last_loaded_at TIMESTAMPTZ,
  load_count INTEGER NOT NULL DEFAULT 0 CHECK (load_count BETWEEN 0 AND 1000),
  UNIQUE (account_id, message_id),
  CHECK (expires_at > created_at),
  CHECK ((load_count = 0 AND first_loaded_at IS NULL AND last_loaded_at IS NULL)
    OR (load_count > 0 AND first_loaded_at IS NOT NULL AND last_loaded_at >= first_loaded_at
      AND sent_at IS NOT NULL AND first_loaded_at >= sent_at AND last_loaded_at <= expires_at))
);
CREATE INDEX IF NOT EXISTS idx_open_activity_owner ON outgoing_open_activity (user_id, account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_open_activity_expiry ON outgoing_open_activity (expires_at);
CREATE INDEX IF NOT EXISTS idx_open_activity_schedule ON outgoing_open_activity (scheduled_id) WHERE scheduled_id IS NOT NULL;
