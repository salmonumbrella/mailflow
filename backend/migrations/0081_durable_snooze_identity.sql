-- Headers cannot identify an independent delivery. Legacy snoozes remain held until
-- explicit recovery; neither matching cache rows nor UID reuse certifies them.
ALTER TABLE snoozed_messages ADD COLUMN entity_id UUID;
ALTER TABLE snoozed_messages ADD COLUMN wake_state TEXT NOT NULL DEFAULT 'ready'
  CHECK (wake_state IN ('ready', 'snoozing', 'waking', 'pending'));
ALTER TABLE snoozed_messages ADD CONSTRAINT snoozed_message_entity_scope
  CHECK (entity_id IS NULL OR storage_generation IS NOT NULL);
ALTER TABLE snoozed_messages ADD CONSTRAINT snoozed_message_entity_fk
  FOREIGN KEY (account_id, storage_generation, entity_id)
  REFERENCES message_entities(account_id, storage_generation, id) DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX snoozed_messages_entity ON snoozed_messages(account_id, storage_generation, entity_id)
  WHERE entity_id IS NOT NULL;
