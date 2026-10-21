-- no-transaction
-- A failed concurrent build leaves an invalid named index. Rebuild on retry;
-- IF NOT EXISTS alone would silently retain that invalid uniqueness guard.
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_archive_identity;
CREATE UNIQUE INDEX CONCURRENTLY idx_messages_archive_identity
  ON messages(account_id, provider_msgid) WHERE is_archive_residue;
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_provider_identity;
CREATE INDEX CONCURRENTLY idx_messages_provider_identity
  ON messages(account_id, provider_msgid);

-- New arrivals take priority without losing the descending historical cursor.
ALTER TABLE archive_coverage ADD COLUMN IF NOT EXISTS scan_high_uid bigint;
