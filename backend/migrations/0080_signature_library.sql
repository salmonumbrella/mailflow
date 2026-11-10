-- Signature definitions are owned content, independent of cached mail and draft snapshots.
CREATE TABLE mail_signature_state (
  account_id UUID PRIMARY KEY REFERENCES email_accounts(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  legacy_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE mail_signatures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  normalized_name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  is_plain_text BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, normalized_name) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX account_aliases_account_identity ON account_aliases(account_id, id);
CREATE TABLE mail_signature_defaults (
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  sender_key TEXT NOT NULL,
  alias_id UUID,
  new_signature_id UUID,
  reply_signature_id UUID,
  legacy_signature_id UUID,
  PRIMARY KEY (account_id, sender_key),
  CHECK ((alias_id IS NULL AND sender_key = 'main') OR (alias_id IS NOT NULL AND sender_key = alias_id::text)),
  FOREIGN KEY (account_id, alias_id) REFERENCES account_aliases(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, new_signature_id) REFERENCES mail_signatures(account_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (account_id, reply_signature_id) REFERENCES mail_signatures(account_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (account_id, legacy_signature_id) REFERENCES mail_signatures(account_id, id) DEFERRABLE INITIALLY DEFERRED
);
