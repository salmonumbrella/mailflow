import { randomUUID } from 'node:crypto';

// Small SQL model for legacy route behavior tests. The production account lock,
// source validator and confirmed-move cache helper still execute. Only explicitly
// recorded provider acknowledgements authorize a cache move in this fixture.
export function routeIdentityFixture({ account, getRows, removeRow, saveRow }) {
  const operations = [];
  const result = rows => ({ rows, rowCount: rows.length });
  const acknowledgeMove = (source, folder, uid) => operations.push({ source: { ...source }, folder, uid });
  const query = (sql, p) => {
    if (sql === 'SELECT id, storage_generation FROM email_accounts WHERE id=$1 FOR UPDATE') {
      return result(p[0] === account.id ? [account] : []);
    }
    if (sql.startsWith('SELECT id,canonical_entity_id FROM message_entities')) {
      const source = getRows().find(row => row.account_id === p[0] && row.storage_generation === p[1] && row.entity_id === p[2]);
      return result(source ? [{ id: source.entity_id, canonical_entity_id: null }] : []);
    }
    if (sql.startsWith('SELECT uid_validity FROM mailbox_identity_epochs')) {
      return result(p[0] === account.id && p[1] === account.storage_generation ? [{ uid_validity: '10' }] : []);
    }
    if (sql.startsWith('SELECT ') && sql.includes(' FROM messages WHERE id=$1 AND account_id=$2')) {
      const row = getRows().find(r => r.id === p[0] && r.account_id === p[1]);
      const proof = sql.includes('storage_generation IS NOT DISTINCT')
        ? [p[4], p[2], p[3], p[5], p[6]] : [p[2], p[3], p[4], p[5], p[6]];
      return result(row && [row.storage_generation, row.folder, row.uid, row.uid_validity, row.entity_id]
        .every((value, i) => String(value) === String(proof[i])) ? [{ ...row }] : []);
    }
    if (sql.includes('FROM mail_identity_operations')) {
      const exact = sql.includes('JOIN mailbox_identity_epochs');
      const op = operations.find(({ source: s, folder, uid }) => s.account_id === p[0]
        && s.storage_generation === p[1] && s.entity_id === p[2] && folder === p[3]
        && (!exact || String(uid) === p[4]) && s.folder === p[exact ? 5 : 4]
        && String(s.uid) === p[exact ? 6 : 5] && String(s.uid_validity) === p[exact ? 7 : 6]);
      return result(op ? [{ id: 'confirmed-operation', entity_id: op.source.entity_id, uid_validity: '10' }] : []);
    }
    if (sql.startsWith('SELECT id,is_read FROM messages WHERE account_id=$1 AND folder=$2 AND uid=$3')) {
      return result(getRows().filter(r => r.account_id === p[0] && r.folder === p[1] && r.uid === p[2]));
    }
    if (sql.startsWith('DELETE FROM messages WHERE account_id=$1 AND folder=$2 AND uid=$3 AND id<>$4')) {
      const matches = getRows().filter(r => r.account_id === p[0] && r.folder === p[1] && r.uid === p[2]
        && r.id !== p[3] && r.storage_generation === p[4] && r.uid_validity === p[5] && r.entity_id === p[6]);
      matches.forEach(r => removeRow(r.id));
      return result(matches);
    }
    if (sql.startsWith('UPDATE messages SET folder = $1, uid = $2, uid_validity=$4')) {
      const row = getRows().find(r => r.id === p[2]);
      if (!row) return result([]);
      const next = { ...row, folder: p[0], uid: p[1], uid_validity: p[3], entity_id: p[4], id: p[5] ? randomUUID() : row.id };
      saveRow(row.id, next);
      return result([{ ...next }]);
    }
    if (/^DELETE FROM messages WHERE id\s*=\s*\$1(?: RETURNING \*)?$/.test(sql)) {
      const row = getRows().find(r => r.id === p[0]);
      if (row) removeRow(row.id);
      return result(row ? [{ ...row }] : []);
    }
    return null;
  };
  return { query, acknowledgeMove };
}
