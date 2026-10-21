import { query, withTransaction } from '../services/db.js';
import { withGmailIdentityWrite } from '../services/archiveCoverage.js';

// Private route outcomes: confirmed rows are SOURCE snapshots from RETURNING.
// Destination IDs are SQL results for future integration, never response/count IDs.
export const mailWriteOutcome = () => ({ applied: new Map(), confirmed: new Map(), destinations: [], recovery: new Map() });
export function requestMailResync(outcome, accountId, path) {
  if (!path) return;
  if (!outcome.recovery.has(accountId)) outcome.recovery.set(accountId, new Set());
  outcome.recovery.get(accountId).add(path);
}
export function noteAppliedMailWrite(outcome, message, destinationFolder) {
  outcome.applied.set(message.id, { message, destinationFolder });
}
export function unconfirmedMailIds(outcome) {
  const ids = [];
  for (const [id, { message, destinationFolder }] of outcome.applied) {
    if (outcome.confirmed.has(id)) continue;
    ids.push(id);
    requestMailResync(outcome, message.account_id, message.folder);
    requestMailResync(outcome, message.account_id, destinationFolder);
  }
  return ids;
}

// Provider work has already finished. One account/folder/epoch group per SQL
// transaction; the shared helper owns account -> folder -> sorted identity locks.
export async function fenceMailWrites(outcome, entries, write) {
  const groups = new Map();
  for (const entry of entries) {
    const m = entry.message;
    const key = JSON.stringify([m.account_id, m.folder, m.source_uid_validity, m.provider_msgid != null]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  for (const group of groups.values()) {
    const source = group[0].message;
    const identities = group.map(({ message }) => message.provider_msgid).filter(id => id != null);
    if (identities.length && (source.source_uid_validity == null || !/^[1-9]\d*$/.test(String(source.source_uid_validity)) ||
        identities.some(id => typeof id !== 'string' || !id))) continue;
    try {
      const writeGroup = async db => {
        // Revalidate the captured physical locator AND provider identity under
        // its matching locks. These row locks last through the actual statement.
        const snapshots = group.map(({ message: m }) => ({ id: m.id, account_id: m.account_id,
          folder: m.folder, uid: m.uid, provider_msgid: m.provider_msgid ?? null }));
        const { rows } = await db.query(`SELECT m.* FROM messages m
          JOIN jsonb_to_recordset($1::jsonb) AS s(id uuid,account_id uuid,folder text,uid bigint,provider_msgid text)
            ON m.id=s.id AND m.account_id=s.account_id AND m.folder=s.folder AND m.uid=s.uid
              AND m.provider_msgid IS NOT DISTINCT FROM s.provider_msgid
          WHERE NOT m.is_archive_residue AND NOT m.is_deleted ORDER BY m.id FOR UPDATE OF m`, [JSON.stringify(snapshots)]);
        if (!rows.length) return { rows: [], rowCount: 0 };
        return write(db, rows.map(message => ({ ...group.find(entry => entry.message.id === message.id), message })));
      };
      const result = identities.length
        ? await withGmailIdentityWrite(source.account_id, identities, writeGroup,
          { folder: source.folder, uidValidity: source.source_uid_validity, normalWrite: true })
        : await withTransaction(writeGroup);
      // Both helpers resolve only after their outer COMMIT. Never publish an
      // outcome from the callback or from a rejected/rolled-back transaction.
      for (const row of result.rows) {
        if (row.destination_missing) continue;
        outcome.confirmed.set(row.source_id, row);
        if (row.destination_id) outcome.destinations.push({ accountId: row.account_id, id: row.destination_id });
      }
    } catch (error) {
      console.warn('Post-provider message write is unconfirmed:', error.message);
    }
  }
}

export async function recoverMailWrites(outcome, manager) {
  unconfirmedMailIds(outcome);
  for (const [accountId, paths] of outcome.recovery) {
    let account;
    try { ({ rows: [account] } = await query('SELECT * FROM email_accounts WHERE id = $1 AND enabled', [accountId])); }
    catch (error) { console.warn('Post-mutation account lookup failed:', error.message); continue; }
    if (account) for (const path of paths) {
      try { await manager.syncFolderOnDemand(account, path); }
      catch (error) { console.warn('Post-mutation resync failed:', error.message); }
    }
  }
}
