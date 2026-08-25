CREATE TABLE provider_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key TEXT NOT NULL UNIQUE,
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('move', 'copy', 'append')),
  state TEXT NOT NULL DEFAULT 'ready'
    CHECK (state IN (
      'ready', 'provider_started', 'provider_applied', 'completed', 'manual_intervention'
    )),
  marker TEXT NOT NULL UNIQUE,
  source_folder VARCHAR(500),
  source_uid BIGINT,
  destination_folder VARCHAR(500) NOT NULL,
  source_observation JSONB,
  destination_observation JSONB NOT NULL,
  attempt_generation BIGINT NOT NULL DEFAULT 0,
  attempt_owner UUID,
  receipt JSONB,
  uncertainty JSONB,
  marker_cleanup_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (marker_cleanup_state IN ('pending', 'completed')),
  marker_cleanup_error JSONB,
  marker_cleanup_completed_at TIMESTAMPTZ,
  provider_started_at TIMESTAMPTZ,
  provider_applied_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX provider_operations_recovery_idx
  ON provider_operations (state, updated_at)
  WHERE state IN ('provider_started', 'provider_applied');

ALTER TABLE snoozed_messages
  ADD COLUMN message_row_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  ADD COLUMN resolution_state TEXT NOT NULL DEFAULT 'active'
    CHECK (resolution_state IN ('active', 'manual_intervention')),
  ADD COLUMN resolution_error JSONB;

-- Legacy snoozes identified only by Message-ID can be bound to a row when, and only
-- when, that descriptive header identifies one live row in the persisted Snoozed folder.
-- Ambiguous/headerless records remain nullable for manual reconciliation.
WITH candidate_message_rows AS (
  SELECT sm.id AS snooze_id, m.id AS message_row_id,
         COUNT(*) OVER (PARTITION BY sm.id) AS match_count
    FROM snoozed_messages sm
    JOIN messages m ON m.account_id = sm.account_id
                   AND m.message_id = sm.message_id_header
                   AND m.folder = sm.snoozed_folder
                   AND m.is_deleted = false
                   AND m.metadata_complete = true
    JOIN folders f ON f.account_id = m.account_id
                  AND f.path = m.folder
                  AND f.is_present = true
                  AND f.uid_validity IS NOT NULL
   WHERE sm.message_row_id IS NULL
     AND sm.resolution_state = 'active'
), unique_message_rows AS (
  SELECT snooze_id, message_row_id
    FROM candidate_message_rows
   WHERE match_count = 1
)
UPDATE snoozed_messages sm
   SET message_row_id = unique_message_rows.message_row_id
  FROM unique_message_rows
 WHERE sm.id = unique_message_rows.snooze_id;

CREATE INDEX snoozed_messages_message_row_idx
  ON snoozed_messages (message_row_id)
  WHERE message_row_id IS NOT NULL;
