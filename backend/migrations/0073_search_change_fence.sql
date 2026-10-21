-- After 0072: pointer publication and search-visible mutations share this fence.
-- Legacy rows remain NULL/stable; no default or backfill rewrites the table.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS search_changed_xid xid8;

CREATE OR REPLACE FUNCTION stamp_message_search_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Always use the top-level xid, including savepoints and supplied stamp values.
  NEW.search_changed_xid := pg_current_xact_id();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_search_change_fence ON messages;
CREATE TRIGGER messages_search_change_fence
BEFORE INSERT OR UPDATE OF account_id, thread_id, date, folder, subject,
  from_name, from_email, to_addresses, cc_addresses, body_text, snippet,
  is_read, is_starred, has_attachments, is_deleted, search_vector,
  search_generation_id, search_changed_xid
ON messages FOR EACH ROW EXECUTE FUNCTION stamp_message_search_change();
