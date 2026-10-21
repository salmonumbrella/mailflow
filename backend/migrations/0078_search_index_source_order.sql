-- no-transaction
-- Account-scoped metadata windows must follow the complete keyset ordering
-- without sorting the mailbox or scanning other accounts before LIMIT.
-- Rebuild the new name on a receipt-less retry: interrupted CONCURRENTLY builds
-- leave an INVALID index which IF NOT EXISTS would otherwise retain forever.
-- This follows0060 and runs as separate statements in the existing loader.
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_account_search_source_order;
CREATE INDEX CONCURRENTLY idx_messages_account_search_source_order
  ON messages (account_id, date DESC NULLS LAST, id DESC)
  WHERE is_deleted = false;
