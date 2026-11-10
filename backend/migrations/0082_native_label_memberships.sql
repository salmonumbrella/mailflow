-- Local user metadata, independent of disposable caches and provider folders.
CREATE TABLE native_label_memberships (
  account_id UUID NOT NULL,
  storage_generation UUID NOT NULL,
  entity_id UUID NOT NULL,
  label_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, storage_generation, entity_id, label_id),
  FOREIGN KEY (account_id, storage_generation, entity_id)
    REFERENCES message_entities(account_id, storage_generation, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, label_id) REFERENCES mail_labels(account_id, id) ON DELETE CASCADE
);
CREATE INDEX native_label_memberships_label ON native_label_memberships(account_id, label_id, storage_generation, entity_id);

-- NULL response is a permanent used-key tombstone, never permission to execute again.
CREATE TABLE native_label_mutations (
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  mutation_id UUID NOT NULL,
  storage_generation UUID NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response JSONB,
  undo_state JSONB,
  operation_kind TEXT NOT NULL DEFAULT 'apply' CHECK (operation_kind IN ('apply', 'undo')),
  CHECK (undo_state IS NULL OR (operation_kind='apply' AND response IS NOT NULL)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, mutation_id)
);

-- Do not permit a membership on an untouched provisional identity: reconciliation may
-- alias only version zero. Writers advance the version under the account lock first.
-- Locking the entity also serializes direct writes with reconciliation's entity lock.
CREATE FUNCTION guard_native_label_entity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entity RECORD;
BEGIN
  SELECT metadata_version,canonical_entity_id INTO entity FROM message_entities
    WHERE account_id=NEW.account_id AND storage_generation=NEW.storage_generation AND id=NEW.entity_id FOR UPDATE;
  IF NOT FOUND OR entity.metadata_version=0 OR entity.canonical_entity_id IS NOT NULL THEN
    RAISE EXCEPTION 'Native labels require a canonical entity with an explicit metadata decision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER native_label_entity_guard BEFORE INSERT OR UPDATE ON native_label_memberships
  FOR EACH ROW EXECUTE FUNCTION guard_native_label_entity();
