-- Durable search catch-up state only. Text and generation publication belong to0072.
CREATE TABLE IF NOT EXISTS search_index_accounts (
  account_id uuid PRIMARY KEY REFERENCES email_accounts(id) ON DELETE CASCADE,
  paused boolean NOT NULL DEFAULT false,
  run_epoch bigint NOT NULL DEFAULT 0 CHECK (run_epoch >= 0)
);

CREATE TABLE IF NOT EXISTS search_index_jobs (
  account_id uuid NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  source_key text NOT NULL,
  -- A message FK cascade would reverse publication's job -> message lock order.
  -- Revalidate this locator in the worker; prune non-running orphans under control.
  message_id uuid NOT NULL,
  folder text NOT NULL,
  uid bigint NOT NULL,
  uid_validity bigint NOT NULL,
  source_generation bigint NOT NULL CHECK (source_generation >= 0),
  message_date timestamptz,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','running','complete','failed','unsupported')),
  run_epoch bigint NOT NULL DEFAULT 0 CHECK (run_epoch >= 0),
  lease_token uuid,
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  defer_at timestamptz,
  last_error text,
  priority_at timestamptz,
  -- Keep this slice runnable on the baseline schema. Add a generation FK only
  -- with the explicitly reviewed0072 stack and its grouped restore proof.
  generation_id uuid,
  pending_folder text,
  pending_uid bigint,
  pending_uid_validity bigint,
  pending_body_bytes bigint CHECK (pending_body_bytes >= 0),
  unsupported_reason text,
  unsupported_folder text,
  unsupported_uid bigint,
  unsupported_uid_validity bigint,
  unsupported_source_generation bigint,
  observed_download_bytes bigint CHECK (observed_download_bytes >= 0),
  structure_overrun_bytes bigint CHECK (structure_overrun_bytes >= 0),
  PRIMARY KEY (account_id, source_key),
  CHECK ((pending_folder IS NULL AND pending_uid IS NULL AND pending_uid_validity IS NULL AND pending_body_bytes IS NULL)
    OR (pending_folder IS NOT NULL AND pending_uid IS NOT NULL AND pending_uid_validity IS NOT NULL AND pending_body_bytes IS NOT NULL)),
  CHECK ((state <> 'unsupported' AND unsupported_reason IS NULL AND unsupported_folder IS NULL AND unsupported_uid IS NULL
      AND unsupported_uid_validity IS NULL AND unsupported_source_generation IS NULL AND observed_download_bytes IS NULL AND structure_overrun_bytes IS NULL)
    OR (state = 'unsupported' AND unsupported_reason IS NOT NULL AND unsupported_folder IS NOT NULL AND unsupported_uid IS NOT NULL
      AND unsupported_uid_validity IS NOT NULL AND unsupported_source_generation IS NOT NULL AND observed_download_bytes IS NOT NULL AND structure_overrun_bytes IS NOT NULL)),
  CHECK (state <> 'running' OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS search_index_one_running_account
  ON search_index_jobs(account_id) WHERE state = 'running';
CREATE INDEX IF NOT EXISTS search_index_pending_account
  ON search_index_jobs(account_id, defer_at, message_date DESC)
  WHERE state IN ('queued','failed');
