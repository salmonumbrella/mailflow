-- Local conversation notification preferences, independent of mutable cache row IDs.
CREATE TABLE IF NOT EXISTS muted_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  identifiers TEXT[] NOT NULL CHECK (cardinality(identifiers) BETWEEN 1 AND 512),
  muted BOOLEAN NOT NULL,
  revision UUID NOT NULL DEFAULT gen_random_uuid(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_muted_threads_owner ON muted_threads(user_id, account_id);
CREATE INDEX IF NOT EXISTS idx_muted_threads_identifiers ON muted_threads USING GIN(identifiers);
CREATE INDEX IF NOT EXISTS idx_muted_threads_active ON muted_threads(account_id) WHERE muted;
