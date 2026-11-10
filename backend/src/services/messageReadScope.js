import { withAccountIdentity } from './messageIdentity.js';

// Flag and count mutations never need the potentially large cached message payload.
export const MESSAGE_FLAG_COLUMNS = 'id, account_id, storage_generation, uid_validity, entity_id, uid, folder, message_id, is_read, is_starred, is_deleted';

// Legacy sibling rules still decide which copies participate, but only current,
// verified physical rows may receive a delayed read mutation.
export const CURRENT_MESSAGE_IDENTITY_SQL = `EXISTS (
  SELECT 1 FROM entity_locations l JOIN mailbox_identity_epochs e
    USING (account_id, storage_generation, folder_path, uid_validity)
  WHERE l.account_id=messages.account_id AND l.storage_generation=messages.storage_generation
    AND l.folder_path=messages.folder AND l.uid_validity=messages.uid_validity
    AND l.uid=messages.uid AND l.entity_id=messages.entity_id AND l.status='present'
)`;

export async function assertReadSourceIdentity(tx, account, source) {
  const stale = () => Object.assign(new Error('The source message changed before updating its flags'), { code: 'identity_source_changed' });
  if (!source.entity_id || !source.storage_generation || !source.uid_validity
    || source.account_id !== account.id || source.storage_generation !== account.storage_generation) throw stale();
  const { rows } = await tx.query(`SELECT ${MESSAGE_FLAG_COLUMNS} FROM messages WHERE id=$1 AND account_id=$2
    AND storage_generation=$3 AND folder=$4 AND uid=$5 AND uid_validity=$6 AND entity_id=$7
    AND ${CURRENT_MESSAGE_IDENTITY_SQL} FOR UPDATE`,
  [source.id, account.id, source.storage_generation, source.folder, source.uid, source.uid_validity, source.entity_id]);
  if (!rows.length) throw stale();
  return rows[0];
}

export async function withReadSourceIdentity(account, source, write) {
  return withAccountIdentity(account, async tx => {
    const current = await assertReadSourceIdentity(tx, account, source);
    return write(tx, current);
  });
}
