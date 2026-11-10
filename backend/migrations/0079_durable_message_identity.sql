-- Durable identity is user data. No table here references disposable folders/messages.
ALTER TABLE email_accounts ADD COLUMN storage_generation UUID NOT NULL DEFAULT gen_random_uuid();

CREATE TABLE message_entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  storage_generation UUID NOT NULL,
  canonical_entity_id UUID,
  metadata_version BIGINT NOT NULL DEFAULT 0 CHECK (metadata_version >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, storage_generation, id),
  CHECK (canonical_entity_id IS NULL OR canonical_entity_id <> id),
  FOREIGN KEY (account_id, storage_generation, canonical_entity_id)
    REFERENCES message_entities(account_id, storage_generation, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX message_entities_account_generation ON message_entities(account_id, storage_generation);

CREATE TABLE entity_provider_keys (
  account_id UUID NOT NULL,
  storage_generation UUID NOT NULL,
  namespace TEXT NOT NULL CHECK (namespace IN ('imap-objectid', 'gmail-x-gm-msgid')),
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 1024),
  entity_id UUID NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, storage_generation, namespace, provider_id),
  FOREIGN KEY (account_id, storage_generation, entity_id)
    REFERENCES message_entities(account_id, storage_generation, id) ON DELETE CASCADE
);
CREATE INDEX entity_provider_keys_entity ON entity_provider_keys(account_id, storage_generation, entity_id);

CREATE TABLE mailbox_identity_epochs (
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  storage_generation UUID NOT NULL,
  folder_path VARCHAR(500) NOT NULL,
  uid_validity BIGINT NOT NULL CHECK (uid_validity BETWEEN 1 AND 4294967295),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  provider_mailbox_id TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, storage_generation, folder_path)
);

CREATE TABLE entity_locations (
  account_id UUID NOT NULL,
  storage_generation UUID NOT NULL,
  folder_path VARCHAR(500) NOT NULL,
  uid_validity BIGINT NOT NULL CHECK (uid_validity BETWEEN 1 AND 4294967295),
  uid BIGINT NOT NULL CHECK (uid BETWEEN 1 AND 4294967295),
  entity_id UUID NOT NULL,
  provider_mailbox_id TEXT,
  status TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present', 'missing', 'invalidated')),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, storage_generation, folder_path, uid_validity, uid),
  UNIQUE (account_id, storage_generation, folder_path, uid_validity, uid, entity_id),
  FOREIGN KEY (account_id, storage_generation, entity_id)
    REFERENCES message_entities(account_id, storage_generation, id) ON DELETE CASCADE
);
CREATE INDEX entity_locations_entity ON entity_locations(account_id, storage_generation, entity_id);

CREATE TABLE mail_identity_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  storage_generation UUID NOT NULL,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('move', 'copy', 'append', 'reconcile')),
  source_entity_id UUID,
  destination_entity_id UUID,
  source_locator JSONB,
  destination_folder VARCHAR(500) NOT NULL,
  destination_revision BIGINT NOT NULL DEFAULT 0,
  destination_locator JSONB,
  state TEXT NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared', 'outcome_unknown', 'provider_confirmed', 'bound', 'failed', 'unresolved')),
  evidence JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (octet_length(evidence::text) <= 16384),
  FOREIGN KEY (account_id, storage_generation, source_entity_id)
    REFERENCES message_entities(account_id, storage_generation, id),
  FOREIGN KEY (account_id, storage_generation, destination_entity_id)
    REFERENCES message_entities(account_id, storage_generation, id)
);
CREATE INDEX mail_identity_operations_pending ON mail_identity_operations(account_id, storage_generation, state);
CREATE INDEX mail_identity_operations_source ON mail_identity_operations(account_id, storage_generation, source_entity_id);

ALTER TABLE messages ADD COLUMN entity_id UUID;
ALTER TABLE messages ADD COLUMN storage_generation UUID;
ALTER TABLE messages ADD COLUMN uid_validity BIGINT;
ALTER TABLE messages ADD CONSTRAINT messages_identity_complete CHECK (
  (entity_id IS NULL AND storage_generation IS NULL AND uid_validity IS NULL)
  OR (entity_id IS NOT NULL AND storage_generation IS NOT NULL AND uid_validity IS NOT NULL AND uid_validity BETWEEN 1 AND 4294967295)
);
ALTER TABLE messages ADD CONSTRAINT messages_entity_scope FOREIGN KEY (account_id, storage_generation, entity_id)
  REFERENCES message_entities(account_id, storage_generation, id);
ALTER TABLE messages ADD CONSTRAINT messages_entity_locator FOREIGN KEY
  (account_id, storage_generation, folder, uid_validity, uid, entity_id)
  REFERENCES entity_locations(account_id, storage_generation, folder_path, uid_validity, uid, entity_id)
  DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX messages_entity ON messages(account_id, storage_generation, entity_id) WHERE entity_id IS NOT NULL;

-- Old routes can repoint cache rows, but cannot carry identity to a guessed UID/epoch.
-- Only a persisted, confirmed operation can translate a source binding on their behalf.
CREATE FUNCTION guard_message_cache_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_entity UUID;
  proof RECORD;
BEGIN
  IF NEW.entity_id IS NULL THEN
    NEW.storage_generation := NULL;
    NEW.uid_validity := NULL;
    RETURN NEW;
  END IF;
  source_entity := NEW.entity_id;
  IF TG_OP = 'UPDATE' THEN
    IF (OLD.account_id, OLD.folder, OLD.uid) IS DISTINCT FROM (NEW.account_id, NEW.folder, NEW.uid) THEN
      source_entity := OLD.entity_id;
      NEW.entity_id := NULL;
    END IF;
  END IF;
  IF NEW.entity_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM entity_locations l JOIN mailbox_identity_epochs e
      USING (account_id, storage_generation, folder_path, uid_validity)
      JOIN email_accounts a ON a.id = l.account_id AND a.storage_generation = l.storage_generation
    WHERE l.account_id = NEW.account_id AND l.storage_generation = NEW.storage_generation
      AND l.folder_path = NEW.folder AND l.uid_validity = NEW.uid_validity
      AND l.uid = NEW.uid AND l.entity_id = NEW.entity_id AND l.status = 'present'
  ) THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (OLD.account_id, OLD.folder, OLD.uid) IS NOT DISTINCT FROM (NEW.account_id, NEW.folder, NEW.uid)
      AND (OLD.entity_id, OLD.storage_generation, OLD.uid_validity) IS DISTINCT FROM (NEW.entity_id, NEW.storage_generation, NEW.uid_validity) THEN
      RAISE EXCEPTION 'Identity assignment does not match a current verified location' USING ERRCODE = '23503';
    END IF;
  END IF;
  SELECT o.destination_entity_id, o.storage_generation,
    (o.destination_locator->>'uidValidity')::bigint AS uid_validity INTO proof
  FROM mail_identity_operations o JOIN email_accounts a ON a.id = o.account_id
    AND a.storage_generation = o.storage_generation
  JOIN mailbox_identity_epochs e ON e.account_id = o.account_id AND e.storage_generation = o.storage_generation
    AND e.folder_path = o.destination_folder AND e.uid_validity::text = o.destination_locator->>'uidValidity'
  JOIN entity_locations l ON l.account_id = o.account_id AND l.storage_generation = o.storage_generation
    AND l.folder_path = o.destination_folder AND l.uid_validity = e.uid_validity
    AND l.uid::text = o.destination_locator->>'uid' AND l.entity_id = o.destination_entity_id AND l.status = 'present'
  WHERE o.account_id = NEW.account_id AND o.source_entity_id = source_entity AND o.state = 'bound'
    AND o.operation_type = 'move' AND o.destination_folder = NEW.folder
    AND o.destination_locator->>'uid' = NEW.uid::text
    AND o.storage_generation = NEW.storage_generation
  ORDER BY o.updated_at DESC LIMIT 1;
  IF FOUND THEN
    NEW.entity_id := proof.destination_entity_id;
    NEW.storage_generation := proof.storage_generation;
    NEW.uid_validity := proof.uid_validity;
  ELSE
    NEW.entity_id := NULL;
    NEW.storage_generation := NULL;
    NEW.uid_validity := NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER messages_identity_guard BEFORE INSERT OR UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION guard_message_cache_identity();

-- Job provenance only, not proof of message identity. Unscoped restored jobs stay held.
ALTER TABLE snoozed_messages ADD COLUMN storage_generation UUID;
UPDATE snoozed_messages s SET storage_generation=a.storage_generation
  FROM email_accounts a WHERE a.id=s.account_id;
CREATE INDEX snoozed_messages_generation ON snoozed_messages(account_id,storage_generation);

-- Pending sends and account-specific rules cannot silently follow a replacement mailbox.
-- Provenance is captured by callers before asynchronous preparation; NULL is held/unverified.
ALTER TABLE scheduled_messages ADD COLUMN storage_generation UUID;
UPDATE scheduled_messages s SET storage_generation=a.storage_generation FROM email_accounts a WHERE a.id=s.account_id;
ALTER TABLE inbox_rules ADD COLUMN storage_generation UUID;
UPDATE inbox_rules r SET storage_generation=a.storage_generation FROM email_accounts a WHERE a.id=r.account_id;
CREATE OR REPLACE FUNCTION guard_account_job_generation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_generation UUID;
BEGIN
  IF TG_TABLE_NAME='inbox_rules' THEN
    IF NEW.account_id IS NULL OR NOT NEW.enabled THEN RETURN NEW; END IF;
  END IF;
  IF TG_TABLE_NAME='scheduled_messages' THEN
    IF NEW.status NOT IN ('scheduled','editing','sending','paused','failed','uncertain') THEN RETURN NEW; END IF;
    -- Recording an already attempted send's failure/uncertainty never authorizes another send.
    IF TG_OP='UPDATE' THEN
      IF OLD.status='sending' AND NEW.status IN ('failed','uncertain') AND NEW.storage_generation IS NOT DISTINCT FROM OLD.storage_generation THEN RETURN NEW; END IF;
    END IF;
  END IF;
  SELECT storage_generation INTO current_generation FROM email_accounts WHERE id=NEW.account_id FOR UPDATE;
  IF current_generation IS NULL OR NEW.storage_generation IS DISTINCT FROM current_generation THEN
    RAISE EXCEPTION 'storage_generation_conflict: pending work belongs to a previous or unverified mailbox'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scheduled_messages_generation_guard BEFORE INSERT OR UPDATE OF status,account_id,storage_generation
  ON scheduled_messages FOR EACH ROW EXECUTE FUNCTION guard_account_job_generation();
CREATE TRIGGER inbox_rules_generation_guard BEFORE INSERT OR UPDATE OF enabled,account_id,storage_generation
  ON inbox_rules FOR EACH ROW EXECUTE FUNCTION guard_account_job_generation();
