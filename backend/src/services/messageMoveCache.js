import { withAccountIdentity } from './messageIdentity.js';

// The provider command and its journal own identity proof. A bare destination UID
// cannot authorize deleting a newer delivery that reused that UID during the await.
export async function applyConfirmedMoveCache(account, row, destinationFolder, newUid, { dropDestination = false, rotateId = false, onApplied } = {}) {
  const messageId = row.id;
  return withAccountIdentity(account, async tx => {
    if (!row.entity_id || !row.storage_generation || !row.uid_validity || row.storage_generation !== account.storage_generation) {
      return { applied: false, sync: true };
    }
    const epoch = (await tx.query(`SELECT uid_validity FROM mailbox_identity_epochs
      WHERE account_id=$1 AND storage_generation=$2 AND folder_path=$3`,
    [row.account_id, row.storage_generation, row.folder])).rows[0];
    if (String(epoch?.uid_validity) !== String(row.uid_validity)) return { applied: false, sync: true };
    const sourceParams = [messageId, row.account_id, row.folder, row.uid,
      row.storage_generation, row.uid_validity, row.entity_id];
    const source = (await tx.query(`SELECT * FROM messages WHERE id=$1 AND account_id=$2
      AND folder=$3 AND uid=$4 AND storage_generation IS NOT DISTINCT FROM $5::uuid
      AND uid_validity IS NOT DISTINCT FROM $6::bigint AND entity_id IS NOT DISTINCT FROM $7::uuid
      FOR UPDATE`, sourceParams)).rows[0];
    if (!source) return { applied: false, sync: true };
    const destination = newUid == null ? null : (await tx.query(`
      SELECT l.entity_id, l.uid_validity FROM mail_identity_operations o
      JOIN mailbox_identity_epochs e ON e.account_id=o.account_id
        AND e.storage_generation=o.storage_generation AND e.folder_path=o.destination_folder
        AND e.uid_validity::text=o.destination_locator->>'uidValidity'
      JOIN entity_locations l ON l.account_id=e.account_id AND l.storage_generation=e.storage_generation
        AND l.folder_path=e.folder_path AND l.uid_validity=e.uid_validity
        AND l.uid=$5 AND l.entity_id=o.destination_entity_id AND l.status='present'
      WHERE o.account_id=$1 AND o.storage_generation=$2 AND o.operation_type='move' AND o.state='bound'
        AND o.source_entity_id=$3 AND o.destination_folder=$4 AND o.destination_locator->>'uid'=$5::text
        AND o.source_locator->>'folder'=$6 AND o.source_locator->>'uid'=$7::text
        AND o.source_locator->>'uidValidity'=$8::text
      ORDER BY o.created_at DESC LIMIT 1`, [row.account_id, account.storage_generation,
      row.entity_id, destinationFolder, String(newUid), row.folder, String(row.uid), String(row.uid_validity)])).rows[0];
    if (destination) {
      if (dropDestination) {
        await tx.query('DELETE FROM messages WHERE id=$1', [messageId]);
        await onApplied?.(tx, source, false);
        return { applied: true, sync: false, row: source };
      }
      const existing = (await tx.query(`SELECT id,is_read FROM messages WHERE account_id=$1 AND folder=$2 AND uid=$3`,
        [row.account_id, destinationFolder, newUid])).rows[0];
      await tx.query(`DELETE FROM messages WHERE account_id=$1 AND folder=$2 AND uid=$3 AND id<>$4
        AND storage_generation=$5 AND uid_validity=$6 AND entity_id=$7`,
      [row.account_id, destinationFolder, newUid, messageId, account.storage_generation,
        destination.uid_validity, destination.entity_id]);
      const saved = (await tx.query(`UPDATE messages SET folder = $1, uid = $2, uid_validity=$4, entity_id=$5,
          id=CASE WHEN $6 THEN gen_random_uuid() ELSE id END
        WHERE id = $3 RETURNING *`, [destinationFolder, newUid, messageId, destination.uid_validity, destination.entity_id, rotateId])).rows[0];
      await onApplied?.(tx, source, true, !!existing, existing);
      return { applied: true, sync: false, row: source, destination: saved };
    }
    const confirmed = (await tx.query(`SELECT id FROM mail_identity_operations
      WHERE account_id=$1 AND storage_generation=$2 AND operation_type='move'
        AND source_entity_id=$3 AND destination_folder=$4
        AND source_locator->>'folder'=$5 AND source_locator->>'uid'=$6
        AND source_locator->>'uidValidity'=$7
        AND (state='bound' OR (state='unresolved' AND evidence->>'providerConfirmed'='true'))
      ORDER BY created_at DESC LIMIT 1`, [row.account_id, row.storage_generation, row.entity_id,
      destinationFolder, row.folder, String(row.uid), String(row.uid_validity)])).rows[0];
    if (confirmed) {
      const dropped = await tx.query('DELETE FROM messages WHERE id=$1 RETURNING *', [messageId]);
      await onApplied?.(tx, source, false);
      return { applied: true, sync: !dropDestination, row: source, dropped: dropped.rows };
    }
    // Missing journal acknowledgement is recovery work, not permission to drop mail.
    return { applied: false, sync: true, row: source };
  });
}
