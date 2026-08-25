ALTER TABLE folders
  ADD COLUMN IF NOT EXISTS observation_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_present BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS topology_identity UUID NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS mailbox_topology_generation BIGINT NOT NULL DEFAULT 0;

-- Historical rows have not yet been confirmed by a complete post-rollout LIST.
UPDATE folders
   SET is_present = false,
       uid_validity = NULL,
       highest_modseq = NULL,
       observation_generation = observation_generation + 1,
       topology_identity = gen_random_uuid();

-- A message is actionable only when its provider folder identity is known. Existing
-- orphaned rows and rows from an unknown UID epoch are retained for reconciliation,
-- but quarantined from every normal read/mutation surface.
UPDATE messages m
   SET metadata_complete = false
 WHERE NOT EXISTS (
   SELECT 1
     FROM folders f
    WHERE f.account_id = m.account_id
      AND f.path = m.folder
      AND f.is_present = true
      AND f.uid_validity IS NOT NULL
 );
