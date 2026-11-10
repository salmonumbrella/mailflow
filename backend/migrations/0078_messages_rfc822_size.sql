-- RFC822.SIZE is measured by IMAP, never estimated from cached bodies or attachments.
-- Existing rows deliberately remain NULL until a live FETCH measures them. There is
-- no old-cache repair job in this migration. Zero is a valid measured size.
-- ImapFlow exposes a Number, so constrain the persisted range to JS safe integers.
ALTER TABLE messages ADD COLUMN rfc822_size_bytes BIGINT
  CHECK (rfc822_size_bytes >= 0 AND rfc822_size_bytes <= 9007199254740991);
