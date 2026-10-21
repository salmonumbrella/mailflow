-- Search generations are independent of display caches and provider identity.
CREATE TABLE IF NOT EXISTS search_text_generations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  source_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS search_text_chunks (
  generation_id uuid NOT NULL REFERENCES search_text_generations(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  text text NOT NULL CHECK (char_length(text) <= 32768),
  -- The publisher indexes a lexical projection while retaining raw chunk text.
  en_tsv tsvector NOT NULL,
  simple_tsv tsvector NOT NULL,
  PRIMARY KEY (generation_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_search_chunks_english ON search_text_chunks USING gin(en_tsv);
CREATE INDEX IF NOT EXISTS idx_search_chunks_simple ON search_text_chunks USING gin(simple_tsv);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS search_generation_id uuid
  REFERENCES search_text_generations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_messages_search_generation ON messages(search_generation_id);
