import { query } from './db.js';
import { reserveBackgroundBudget } from './backgroundDownloadBudget.js';

export function isBackfillFolder(path, { skipFolderPatterns = [], skipFolderNames = [] }) {
  const lower = path.toLowerCase();
  return !skipFolderPatterns.some(pattern => lower.includes(pattern)) && !skipFolderNames.includes(lower);
}

export async function getGmailArchiveFolder(account, client, labelStore) {
  if (!labelStore || !client.capabilities?.has('X-GM-EXT-1')) return null;
  const { rows } = await query(`SELECT f.path FROM folders f JOIN email_accounts a ON a.id=f.account_id
    WHERE f.account_id=$1 AND a.enabled AND NOT f.no_select AND f.special_use=$2 ORDER BY f.path LIMIT 1`,
  [account.id, '\\All']);
  return rows[0]?.path || null;
}

// Readiness fences identity consumers; it never establishes archive storage coverage.
export async function isIdentityBootstrapComplete(accountId, profile) {
  if (!profile?.labelStore) return false;
  const { rows } = await query(`SELECT f.path, f.special_use, f.no_select,
      (c.uid_validity=f.uid_validity AND c.bootstrap_complete AND NOT EXISTS (
        SELECT 1 FROM messages m WHERE m.account_id=f.account_id AND m.folder=f.path
          AND NOT m.is_archive_residue AND m.provider_msgid IS NULL)) AS ready
    FROM folders f JOIN email_accounts a ON a.id=f.account_id
    LEFT JOIN archive_coverage c ON c.account_id=f.account_id AND c.folder=f.path
    WHERE f.account_id=$1 AND a.enabled`, [accountId]);
  return rows.some(f => !f.no_select && f.special_use === '\\All') && rows
    .filter(f => !f.no_select && f.special_use !== '\\All' && isBackfillFolder(f.path, profile))
    .every(f => f.ready === true);
}

export async function bootstrapGmailIdentity(account, client, folder, {
  labelStore = false, skipFolderPatterns = [], skipFolderNames = [], signal, batchSize = 50,
  reserveBudget = reserveBackgroundBudget, foregroundPending = () => false, onReadError = () => {},
} = {}) {
  const stopped = () => signal?.aborted || foregroundPending();
  if (stopped() || !isBackfillFolder(folder, { skipFolderPatterns, skipFolderNames }) ||
      !await getGmailArchiveFolder(account, client, labelStore)) return;
  const { rows: [state] } = await query(`SELECT f.uid_validity, c.uid_validity AS coverage_epoch, c.bootstrap_complete
    FROM folders f JOIN email_accounts a ON a.id=f.account_id
    LEFT JOIN archive_coverage c ON c.account_id=f.account_id AND c.folder=f.path
    WHERE f.account_id=$1 AND f.path=$2 AND f.uid_validity IS NOT NULL AND NOT f.no_select
      AND f.special_use IS DISTINCT FROM $3 AND a.enabled`, [account.id, folder, '\\All']);
  if (!state) return;
  const epoch = String(state.uid_validity);
  const rollover = state.coverage_epoch != null && String(state.coverage_epoch) !== epoch;
  let { rows } = await query(`SELECT uid FROM messages WHERE account_id=$1 AND folder=$2
    AND NOT is_archive_residue AND (provider_msgid IS NULL OR $4) ORDER BY uid LIMIT $3`,
  [account.id, folder, Math.max(1, Math.min(500, Math.trunc(Number(batchSize)) || 50)), rollover]);
  if (!rollover && state.bootstrap_complete && !rows.length) return;
  let budget;
  do {
    // Reserve EXAMINE metadata plus bounded UID/64-bit Gmail ID/MODSEQ framing.
    // No envelope, arbitrary headers, labels or bodies are requested.
    budget = await reserveBudget(account.id, account.imap_host, { messages: rows.length, bytes: 512 + rows.length * 256 });
    if (stopped()) return;
    if (budget.allowed) break;
    if (rows.length <= 1) return { pending: true, deferAt: budget.deferAt };
    rows = rows.slice(0, Math.floor(rows.length / 2));
  } while (rows.length);
  let lock, reading = false;
  const invalidateEpoch = () => query(`UPDATE archive_coverage SET bootstrap_complete=false,
    phase='bootstrap', last_error='Mailbox epoch changed' WHERE account_id=$1 AND folder=$2 AND uid_validity=$3`,
  [account.id, folder, epoch]);
  try {
    reading = true;
    lock = await client.getMailboxLock(folder, { readOnly: true });
    reading = false;
    if (String(client.mailbox?.uidValidity || '') !== epoch) { await invalidateEpoch(); return { pending: true }; }
    // Clear stale identities before advancing the checkpoint, so interruption is retryable.
    if (rollover) await query(`UPDATE messages m SET provider_msgid=NULL FROM folders f
      WHERE m.account_id=$1 AND m.folder=$2 AND NOT m.is_archive_residue
        AND f.account_id=m.account_id AND f.path=m.folder AND f.uid_validity=$3`, [account.id, folder, epoch]);
    const saved = await query(`INSERT INTO archive_coverage(account_id,folder,uid_validity)
      SELECT f.account_id,f.path,f.uid_validity FROM folders f JOIN email_accounts a ON a.id=f.account_id
      WHERE f.account_id=$1 AND f.path=$2 AND f.uid_validity=$3 AND a.enabled
      ON CONFLICT(account_id,folder) DO UPDATE SET uid_validity=EXCLUDED.uid_validity,
        bootstrap_complete=CASE WHEN archive_coverage.uid_validity=EXCLUDED.uid_validity THEN archive_coverage.bootstrap_complete ELSE false END,
        phase='bootstrap',
        scan_cursor=CASE WHEN archive_coverage.uid_validity=EXCLUDED.uid_validity THEN archive_coverage.scan_cursor END,
        label_modseq=CASE WHEN archive_coverage.uid_validity=EXCLUDED.uid_validity THEN archive_coverage.label_modseq END,
        sweep_cursor=CASE WHEN archive_coverage.uid_validity=EXCLUDED.uid_validity THEN archive_coverage.sweep_cursor END, last_error=NULL
      RETURNING account_id`, [account.id, folder, epoch]);
    if (!saved.rows.length || stopped()) return;
    const requested = new Set(rows.map(row => String(row.uid)));
    const records = new Map();
    if (rows.length) {
      reading = true;
      for await (const msg of client.fetch(rows.map(row => row.uid).join(','), { uid: true }, { uid: true })) {
        if (signal?.aborted) return;
        if (requested.has(String(msg.uid)) && typeof msg.emailId === 'string' && msg.emailId) records.set(String(msg.uid), { uid: msg.uid, emailId: msg.emailId });
      }
      reading = false;
    }
    if (String(client.mailbox?.uidValidity || '') !== epoch) { await invalidateEpoch(); return { pending: true }; }
    for (const msg of records.values()) await query(`UPDATE messages m SET provider_msgid=$4 FROM folders f, email_accounts a
      WHERE m.account_id=$1 AND m.folder=$2 AND m.uid=$3 AND NOT m.is_archive_residue
        AND f.account_id=m.account_id AND f.path=m.folder AND f.uid_validity=$5 AND a.id=m.account_id AND a.enabled`,
    [account.id, folder, msg.uid, msg.emailId, epoch]);
    await query(`UPDATE archive_coverage c SET bootstrap_complete=NOT EXISTS (
        SELECT 1 FROM messages m WHERE m.account_id=c.account_id AND m.folder=c.folder
          AND NOT m.is_archive_residue AND m.provider_msgid IS NULL), phase='pending', last_error=NULL
      FROM folders f, email_accounts a WHERE c.account_id=$1 AND c.folder=$2 AND c.uid_validity=$3
        AND f.account_id=c.account_id AND f.path=c.folder AND f.uid_validity=c.uid_validity
        AND a.id=c.account_id AND a.enabled`, [account.id, folder, epoch]);
  } catch (err) {
    if (reading) onReadError(err);
    await query(`INSERT INTO archive_coverage(account_id,folder,uid_validity,last_error)
      SELECT f.account_id,f.path,f.uid_validity,$3 FROM folders f JOIN email_accounts a ON a.id=f.account_id
      WHERE f.account_id=$1 AND f.path=$2 AND f.uid_validity=$4 AND a.enabled
      ON CONFLICT(account_id,folder) DO UPDATE SET bootstrap_complete=false, phase='bootstrap', last_error=EXCLUDED.last_error
      WHERE archive_coverage.uid_validity=EXCLUDED.uid_validity`, [account.id, folder, 'Identity bootstrap read failed', epoch])
      .catch(() => { /* Preserve the original transport/database error. */ });
    throw err;
  } finally { lock?.release(); }
}
