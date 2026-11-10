import { createHash } from 'node:crypto';

const names = new Map();
// Readable fixture keys identify test cache/account rows only. They are not headers,
// provider keys, or evidence that any cached message has a durable entity binding.
export function fixtureId(name) {
  const hex = createHash('sha256').update(name).digest('hex');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  names.set(id, name);
  return id;
}
export const fixtureName = id => names.get(id) ?? id;

// Legacy query tests intentionally use small, connection-local temporary schemas.
// Supply the actual hydration query's tables without certifying historical cache
// rows. Tests with verified identities seed their exact locations themselves.
// Migration constraints and supported membership writes have separate real-schema tests.
export async function installNativeLabelReadFixture(database) {
  await database.query(`
    ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS storage_generation uuid DEFAULT gen_random_uuid();
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS entity_id uuid;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS storage_generation uuid;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS uid_validity bigint;
    CREATE TEMP TABLE IF NOT EXISTS message_entities (
      id uuid PRIMARY KEY, account_id uuid, storage_generation uuid, canonical_entity_id uuid);
    ALTER TABLE message_entities ADD COLUMN IF NOT EXISTS metadata_version bigint NOT NULL DEFAULT 0;
    CREATE TEMP TABLE IF NOT EXISTS entity_locations (
      account_id uuid, storage_generation uuid, folder_path text, uid_validity bigint,
      uid bigint, entity_id uuid, status text);
    CREATE TEMP TABLE IF NOT EXISTS mailbox_identity_epochs (
      account_id uuid, storage_generation uuid, folder_path text, uid_validity bigint);
    CREATE TEMP TABLE native_label_memberships (
      account_id uuid, storage_generation uuid, entity_id uuid, label_id uuid);
    CREATE TEMP TABLE mail_labels (
      id uuid, account_id uuid, parent_id uuid, name text, full_path text, color text,
      text_color text, sidebar_visibility text, message_visibility boolean, revision bigint);
  `);
}
