-- Empty reservations are internal rule decisions, never public Apply or Undo.
ALTER TABLE native_label_mutations DROP CONSTRAINT native_label_mutations_operation_kind_check;
ALTER TABLE native_label_mutations ADD CHECK (operation_kind IN ('apply','undo','rule_decision'));
ALTER TABLE native_label_mutations ADD UNIQUE (account_id,storage_generation,mutation_id);

-- A consumed dispatch authorization is durable even when its outcome is unknown.
-- No runnable/retry state exists: replay and restore cannot rearm a claim.
CREATE TABLE inbox_rule_action_attempts (
  account_id UUID NOT NULL,
  storage_generation UUID NOT NULL,
  decision_id UUID NOT NULL,
  action_ordinal INTEGER NOT NULL CHECK (action_ordinal BETWEEN 0 AND 200),
  action_hash TEXT NOT NULL CHECK (action_hash ~ '^[0-9a-f]{64}$'),
  execution_id UUID NOT NULL,
  rule_id UUID NOT NULL,
  rule_revision TEXT NOT NULL,
  source JSONB NOT NULL CHECK (jsonb_typeof(source)='object'),
  expected_metadata_version BIGINT NOT NULL CHECK (expected_metadata_version >= 0),
  status TEXT NOT NULL CHECK (status IN ('claimed','confirmed','failed','pending')),
  outcome JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id,decision_id,action_ordinal),
  FOREIGN KEY (account_id,storage_generation,decision_id)
    REFERENCES native_label_mutations(account_id,storage_generation,mutation_id) ON DELETE CASCADE
);
CREATE FUNCTION guard_inbox_rule_action_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','outcome','updated_at']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','outcome','updated_at']) OR
     (OLD.status <> 'claimed' AND NEW IS DISTINCT FROM OLD) OR NEW.status='claimed' THEN
    RAISE EXCEPTION 'Rule action claims are immutable and cannot be rearmed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inbox_rule_action_attempt_guard BEFORE UPDATE ON inbox_rule_action_attempts
  FOR EACH ROW EXECUTE FUNCTION guard_inbox_rule_action_attempt();
