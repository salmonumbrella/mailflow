-- Identity is account-scoped provider metadata, never an RFC Message-ID heuristic.
-- Legacy rows remain untouched until a bounded, read-only bootstrap verifies them.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_msgid text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_archive_residue boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS archive_coverage (
  account_id uuid NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  folder text NOT NULL,
  uid_validity bigint NOT NULL,
  phase text NOT NULL DEFAULT 'bootstrap',
  bootstrap_complete boolean NOT NULL DEFAULT false,
  scan_cursor bigint,
  label_modseq numeric,
  sweep_cursor bigint,
  last_error text,
  PRIMARY KEY (account_id, folder)
);

CREATE TABLE IF NOT EXISTS background_download_debits (
  account_id uuid NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  day date NOT NULL,
  bytes bigint NOT NULL CHECK (bytes >= 0),
  PRIMARY KEY (account_id, day)
);
-- Identity indexes are built concurrently by the following membership migration.
