-- no-transaction
-- Keep this separate from 0073's transactional PL/pgSQL trigger definition.
-- A failed concurrent build can leave an INVALID index. A missing migration
-- receipt retries this dedicated index from scratch, including a valid build
-- whose receipt was not recorded. Existing thread indexes remain in place.
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_search_thread_order;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_search_thread_order
  ON messages (account_id, thread_key, date DESC NULLS LAST, id)
  WHERE is_deleted = false;
