-- Native MailFlow definitions, deliberately independent of messages and IMAP folders.
CREATE TABLE mail_label_state (
    account_id UUID PRIMARY KEY REFERENCES email_accounts(id) ON DELETE CASCADE,
    tree_revision BIGINT NOT NULL DEFAULT 0 CHECK (tree_revision >= 0)
);

CREATE TABLE mail_labels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    parent_id UUID,
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100 AND position('/' in name) = 0),
    normalized_name TEXT COLLATE "C" NOT NULL CHECK (char_length(normalized_name) BETWEEN 1 AND 300),
    full_path TEXT NOT NULL CHECK (char_length(full_path) BETWEEN 1 AND 1000),
    color TEXT CHECK (color ~ '^#[0-9a-f]{6}$'),
    text_color TEXT CHECK (text_color ~ '^#[0-9a-f]{6}$'),
    sidebar_visibility TEXT NOT NULL DEFAULT 'show' CHECK (sidebar_visibility IN ('show', 'hide', 'unread')),
    message_visibility BOOLEAN NOT NULL DEFAULT TRUE,
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (account_id, id),
    CHECK (parent_id IS NULL OR parent_id <> id),
    -- Deferred validation also permits backup batches to restore children before parents.
    FOREIGN KEY (account_id, parent_id) REFERENCES mail_labels(account_id, id)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX mail_labels_root_name ON mail_labels(account_id, normalized_name) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX mail_labels_sibling_name ON mail_labels(account_id, parent_id, normalized_name) WHERE parent_id IS NOT NULL;
CREATE INDEX mail_labels_account_parent ON mail_labels(account_id, parent_id);

CREATE TABLE mail_label_mutations (
    account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    mutation_id UUID NOT NULL,
    request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    response JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, mutation_id)
);
-- Response bodies expire after 30 days. Keep small key/hash tombstones so an old destructive
-- request can never execute again after its replay body is removed.
CREATE INDEX mail_label_mutations_expiry ON mail_label_mutations(account_id, created_at) WHERE response IS NOT NULL;
