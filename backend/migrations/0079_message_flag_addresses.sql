-- A MOVE without UIDPLUS must never turn its old numeric UID into a flag target.
-- Only live ingestion may replace an invalid row with a fresh, epoch-bound identity.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS flag_address_valid boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS flag_uid_validity bigint,
  ADD COLUMN IF NOT EXISTS read_intent_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS star_intent_version bigint NOT NULL DEFAULT 0;

CREATE SEQUENCE IF NOT EXISTS message_flag_intent_version_seq;
-- A folder epoch cannot prove an old cached numeric UID survived a no-UIDPLUS move.
-- Existing rows stay unproven until identity is checked on a selected live session.
