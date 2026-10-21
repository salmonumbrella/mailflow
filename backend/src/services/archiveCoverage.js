import { query, withTransaction } from './db.js';
import { reserveBackgroundBudget } from './backgroundDownloadBudget.js';
import { parseMessage } from './messageParser.js';
import { sanitizeStr } from '../utils/sanitizeStr.js';

const SWEEP_WINDOW_MS = 5 * 60000;
const SWEEP_FALLBACK_MS = 60 * 60000;
const modseqValue = value => (typeof value === 'bigint' || typeof value === 'string') && /^[1-9]\d*$/.test(String(value))
  ? BigInt(value).toString() : null;

export function sanitizeArchiveMetadata(record) {
  const clean = value => {
    if (typeof value === 'string') return sanitizeStr(value);
    if (Array.isArray(value)) return value.map(clean);
    if (value && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, clean(field)]));
    }
    return value;
  };
  // Provider identity is exact opaque data, never a text header to normalize.
  return { ...clean(record), providerMsgid: record.providerMsgid };
}

// All normal writers and residue admission use the same account/provider key.
// The callback is SQL only: provider reads must finish before entering here.
export async function withGmailIdentityWrite(accountId, providerIds, write, { client, folder, uidValidity, source, normalWrite = true } = {}) {
  const identities = [...new Set(providerIds.filter(id => typeof id === 'string' && id))].sort();
  if (!identities.length) return write(client || { query });
  const incomplete = () => ({ rows: [], rowCount: 0, pending: true });
  const knownEpoch = value => value != null && /^[1-9]\d*$/.test(String(value));
  if (normalWrite && (!folder || !knownEpoch(uidValidity))) return incomplete();
  if (source && (!knownEpoch(source.uidValidity) || !identities.includes(source.providerMsgid))) return incomplete();
  const run = async db => {
    const { rows: accounts } = await db.query('SELECT id FROM email_accounts WHERE id=$1 AND enabled FOR SHARE', [accountId]);
    if (!accounts.length) return incomplete();
    if (folder) {
      const paths = [...new Set([folder, source?.folder].filter(Boolean))].sort();
      const { rows } = await db.query(`SELECT path,uid_validity,special_use FROM folders
        WHERE account_id=$1 AND path=ANY($2::text[]) ORDER BY path FOR SHARE`, [accountId, paths]);
      const destination = rows.find(row => row.path === folder);
      if (normalWrite && destination?.special_use === '\\All') throw new Error('All Mail writes require archive admission');
      if (uidValidity != null && String(destination?.uid_validity) !== String(uidValidity)) return incomplete();
      if (source && String(rows.find(row => row.path === source.folder)?.uid_validity) !== String(source.uidValidity)) return incomplete();
    }
    for (const identity of identities) {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([accountId, identity])]);
    }
    if (source) {
      const { rows: [row] } = await db.query(`SELECT provider_msgid FROM messages
        WHERE account_id=$1 AND folder=$2 AND uid=$3 AND NOT is_deleted AND NOT is_archive_residue FOR SHARE`,
      [accountId, source.folder, source.uid]);
      if (row?.provider_msgid !== source.providerMsgid) return incomplete();
    }
    const result = await write(db);
    // A verified normal write wins. Physical normal duplicates remain distinct.
    if (normalWrite && result.rowCount !== 0 && identities.length) await db.query(`DELETE FROM messages r WHERE r.account_id=$1 AND r.is_archive_residue
      AND r.provider_msgid=ANY($2::text[]) AND EXISTS (
        SELECT 1 FROM messages n JOIN folders f ON f.account_id=n.account_id AND f.path=n.folder
        WHERE n.account_id=r.account_id AND n.provider_msgid=r.provider_msgid
          AND NOT n.is_archive_residue AND NOT n.is_deleted AND NOT f.no_select
          AND f.special_use IS DISTINCT FROM $3)`, [accountId, identities, '\\All']);
    return normalWrite && result.rowCount === 0 ? { ...result, pending: true } : result;
  };
  return client ? run(client) : withTransaction(run);
}

export async function assertNoArchiveResidue(accountId, folder, uids = null) {
  const { rows } = await query(`SELECT EXISTS(SELECT 1 FROM messages WHERE account_id=$1 AND folder=$2
    AND is_archive_residue AND ($3::bigint[] IS NULL OR uid=ANY($3::bigint[]))) AS refused`, [accountId, folder, uids]);
  if (rows[0]?.refused) {
    const error = new Error('This action is not supported for archive residue');
    error.status = 409;
    throw error;
  }
}

// client is a PostgreSQL transaction client, not the ImapFlow client used by
// bootstrap. records are parsed metadata plus live normal-copy observations.
export async function admitArchiveMetadata(client, { accountId, folder, uidValidity, records, profile, normalEpochs }) {
  records = records.map(sanitizeArchiveMetadata);
  const counts = { stored: 0, suppressed: 0, pending: records.length };
  const result = { counts, admittedIds: [] };
  const arrivals = new Map();
  if (!profile?.labelStore || !normalEpochs || records.length > 500) return result;
  const { rows: [account] } = await client.query('SELECT id FROM email_accounts WHERE id=$1 AND enabled FOR SHARE', [accountId]);
  if (!account) return result;
  const { rows: folders } = await client.query(`SELECT f.path,f.uid_validity,f.special_use,f.no_select,
      c.uid_validity AS coverage_epoch,c.bootstrap_complete,c.phase
    FROM folders f LEFT JOIN archive_coverage c ON c.account_id=f.account_id AND c.folder=f.path
    WHERE f.account_id=$1 ORDER BY f.path FOR SHARE OF f`, [accountId]);
  const archive = folders.find(row => row.path === folder && row.special_use === '\\All' && !row.no_select);
  const normal = folders.filter(row => !row.no_select && row.special_use !== '\\All' && isBackfillFolder(row.path, profile));
  const { rows: readiness } = await client.query(`SELECT folder,uid_validity,bootstrap_complete FROM archive_coverage
    WHERE account_id=$1 AND folder=ANY($2::text[]) ORDER BY folder FOR SHARE`, [accountId, normal.map(row => row.path)]);
  if (!archive || String(archive.uid_validity) !== String(uidValidity) || archive.phase === 'paused' ||
      normal.some(row => !row.bootstrap_complete || String(row.coverage_epoch) !== String(row.uid_validity) ||
        String(normalEpochs[row.path]) !== String(row.uid_validity) || !readiness.some(ready => ready.folder === row.path &&
          ready.bootstrap_complete && String(ready.uid_validity) === String(row.uid_validity)))) return result;
  const { rows: [coverage] } = await client.query(`SELECT phase FROM archive_coverage
    WHERE account_id=$1 AND folder=$2 AND uid_validity=$3 FOR UPDATE`, [accountId, folder, uidValidity]);
  if (!coverage || coverage.phase === 'paused') return result;
  const { rows: unresolved } = await client.query(`SELECT 1 FROM messages WHERE account_id=$1
    AND folder=ANY($2::text[]) AND NOT is_archive_residue AND provider_msgid IS NULL LIMIT 1`,
  [accountId, normal.map(row => row.path)]);
  if (unresolved.length || records.some(row => !row.providerMsgid || !Number.isSafeInteger(row.uid) || row.uid <= 0)) return result;
  const admitted = await withGmailIdentityWrite(accountId, records.map(row => row.providerMsgid), async db => {
    for (const record of [...records].sort((a, b) => a.providerMsgid.localeCompare(b.providerMsgid))) {
      const copies = record.normalCopies || [];
      const { rows: siblings } = await db.query(`SELECT n.folder,n.uid FROM messages n
        WHERE n.account_id=$1 AND n.provider_msgid=$2 AND NOT n.is_archive_residue AND NOT n.is_deleted
          AND n.folder=ANY($3::text[])`, [accountId, record.providerMsgid, normal.map(row => row.path)]);
      // A cached identity is not live membership proof. A normal copy observed
      // outside this transaction must still have its exact cached locator here.
      const sibling = siblings.some(row => copies.some(copy => copy.folder === row.folder && String(copy.uid) === String(row.uid)));
      if (siblings.length && !sibling) continue;
      if (sibling) {
        await db.query('DELETE FROM messages WHERE account_id=$1 AND provider_msgid=$2 AND is_archive_residue', [accountId, record.providerMsgid]);
        arrivals.delete(record.providerMsgid);
        counts.suppressed++;
      } else if (record.identityOnly) {
        // An earlier cache lookup saves a metadata transfer, not this fence.
        // If representation vanished meanwhile, retry with metadata next time.
        const { rows: present } = await db.query(`SELECT id FROM messages WHERE account_id=$1 AND folder=$2 AND uid=$3
          AND provider_msgid=$4 AND is_archive_residue AND NOT is_deleted FOR SHARE`,
        [accountId, folder, record.uid, record.providerMsgid]);
        if (!present.length) continue;
        counts.stored++;
      } else {
        await db.query(`DELETE FROM messages WHERE account_id=$1 AND provider_msgid=$2 AND is_archive_residue
          AND (folder<>$3 OR uid<>$4)`, [accountId, record.providerMsgid, folder, record.uid]);
        const { rows: [written] } = await db.query(`WITH prior AS (
          SELECT id,provider_msgid,is_archive_residue,is_deleted FROM messages
          WHERE account_id=$1 AND folder=$2 AND uid=$3
        ), written AS (
          INSERT INTO messages(account_id,folder,uid,provider_msgid,is_archive_residue,
            message_id,subject,from_name,from_email,to_addresses,cc_addresses,reply_to,in_reply_to,
            thread_references,thread_id,date,is_read,is_starred,flags,has_attachments)
          VALUES($1,$2,$3,$4,true,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17,$18::jsonb,$19)
          ON CONFLICT(account_id,uid,folder) DO UPDATE
          SET provider_msgid=EXCLUDED.provider_msgid,is_archive_residue=true,subject=EXCLUDED.subject,
            is_read=CASE WHEN messages.read_changed_at>NOW()-interval '30 seconds' THEN messages.is_read ELSE EXCLUDED.is_read END,
            is_starred=CASE WHEN messages.star_changed_at>NOW()-interval '30 seconds' THEN messages.is_starred ELSE EXCLUDED.is_starred END,
            body_text=CASE WHEN messages.provider_msgid=EXCLUDED.provider_msgid THEN messages.body_text END,
            body_html=CASE WHEN messages.provider_msgid=EXCLUDED.provider_msgid THEN messages.body_html END,
            flags=EXCLUDED.flags,is_deleted=false,synced_at=NOW()
          RETURNING id,account_id,provider_msgid,is_archive_residue,is_deleted
        ) SELECT w.*,p.id AS prior_id,p.provider_msgid AS prior_provider_msgid,
          p.is_archive_residue AS prior_is_archive_residue,p.is_deleted AS prior_is_deleted
        FROM written w LEFT JOIN prior p ON p.id=w.id`,
        [accountId, folder, record.uid, record.providerMsgid, record.messageId, record.subject, record.fromName, record.fromEmail,
          JSON.stringify(record.to || []), JSON.stringify(record.cc || []), JSON.stringify(record.replyTo || []), record.inReplyTo,
          record.references, record.threadId, record.date, !!record.isRead, !!record.isStarred,
          JSON.stringify(record.flags || []), !!record.hasAttachments]);
        if (written.is_archive_residue && !written.is_deleted &&
            (written.prior_id == null || written.prior_provider_msgid !== written.provider_msgid ||
              !written.prior_is_archive_residue || written.prior_is_deleted)) {
          // These are actual message IDs from RETURNING, never counters/xmax.
          // Keep only the final admitted copy per provider in this transaction.
          arrivals.set(written.provider_msgid, written.id);
        }
        counts.stored++;
      }
      counts.pending--;
    }
    // Still private to the caller's transaction: only its outer COMMIT makes
    // these IDs eligible for a lifecycle handoff.
    return { counts, admittedIds: [...new Set(arrivals.values())] };
  }, { client, normalWrite: false });
  return admitted.counts ? admitted : result;
}

export async function runArchiveCoverageBatch(account, {
  client, profile, signal, foregroundPending = () => false, reserveBudget = reserveBackgroundBudget,
  prepareRecord = parseMessage, now = Date.now,
} = {}) {
  const stopped = () => signal?.aborted || foregroundPending();
  const pending = { counts: { stored: 0, suppressed: 0, pending: true }, admittedIds: [] };
  const read = async fn => {
    try { return await fn(); }
    catch (error) { error.archiveProviderRead = true; throw error; }
  };
  const fetch = async function* (...args) {
    const iterator = client.fetch(...args)[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await read(() => iterator.next());
        if (next.done) break;
        yield next.value;
      }
    } finally { await iterator.return?.(); }
  };
  if (stopped() || !client || !profile?.labelStore) return pending;
  const folder = await getGmailArchiveFolder(account, client, true);
  if (!folder || !await isIdentityBootstrapComplete(account.id, profile)) return pending;
  const { rows: [state] } = await query('SELECT * FROM archive_coverage WHERE account_id=$1 AND folder=$2', [account.id, folder]);
  if (state?.phase === 'paused') return pending;
  const { rows: folders } = await query(`SELECT path,uid_validity,special_use,no_select FROM folders WHERE account_id=$1`, [account.id]);
  const normal = folders.filter(row => !row.no_select && row.special_use !== '\\All' && isBackfillFolder(row.path, profile));
  const normalEpochs = Object.fromEntries(normal.map(row => [row.path, String(row.uid_validity)]));
  const examine = async path => {
    const budget = await reserveBudget(account.id, account.imap_host, { messages: 0, bytes: 1024 });
    if (!budget.allowed || stopped()) return null;
    const lock = await read(() => client.getMailboxLock(path, { readOnly: true }));
    return { lock, epoch: String(client.mailbox?.uidValidity || '') };
  };
  let selected;
  try {
    selected = await examine(folder);
    if (!selected) return pending;
    const epoch = selected.epoch;
    const high = Number(client.mailbox?.uidNext) - 1;
    if (!epoch || !Number.isSafeInteger(high) || high < 0) return pending;
    const observedModseq = client.enabled?.has('CONDSTORE') && !client.mailbox?.noModseq
      ? modseqValue(client.mailbox?.highestModseq) : null;
    const tick = now();
    const sameEpoch = state && String(state.uid_validity) === epoch;
    if (!sameEpoch) await withTransaction(async db => {
      const { rows: accounts } = await db.query('SELECT id FROM email_accounts WHERE id=$1 AND enabled FOR SHARE', [account.id]);
      if (!accounts.length) return;
      await db.query('SELECT path FROM folders WHERE account_id=$1 AND path=$2 FOR UPDATE', [account.id, folder]);
      const { rows: [current] } = await db.query('SELECT phase FROM archive_coverage WHERE account_id=$1 AND folder=$2 FOR UPDATE', [account.id, folder]);
      if (current?.phase === 'paused') return;
      await db.query('UPDATE folders SET uid_validity=$3 WHERE account_id=$1 AND path=$2', [account.id, folder, epoch]);
      // Invalidate only this All Mail physical epoch, never normal folders.
      if (String(folders.find(row => row.path === folder)?.uid_validity) !== epoch) {
        await db.query('DELETE FROM messages WHERE account_id=$1 AND folder=$2', [account.id, folder]);
      }
      await db.query(`INSERT INTO archive_coverage(account_id,folder,uid_validity,phase,scan_cursor,scan_high_uid)
        VALUES($1,$2,$3,'scan',$4,$4) ON CONFLICT(account_id,folder) DO UPDATE
        SET uid_validity=$3,phase='scan',scan_cursor=$4,scan_high_uid=$4,label_modseq=NULL,sweep_cursor=NULL,sweep_checked_at=NULL,last_error=NULL`,
      [account.id, folder, epoch, high]);
    });
    const previousHigh = sameEpoch ? Number(state.scan_high_uid ?? high) : high;
    const history = sameEpoch ? Number(state.scan_cursor ?? high) : high;
    const arrivals = high > previousHigh;
    const maintenance = sameEpoch && !arrivals && history === 0;
    const sweep = sameEpoch ? Number(state.sweep_cursor || 0) : 0;
    const savedModseq = sameEpoch ? modseqValue(state.label_modseq) : null;
    const checkedAt = sameEpoch && state.sweep_checked_at != null ? new Date(state.sweep_checked_at).getTime() : NaN;
    if (maintenance && Number.isFinite(checkedAt) && checkedAt <= tick) {
      const elapsed = tick - checkedAt;
      if (elapsed < SWEEP_WINDOW_MS || (!sweep && elapsed < SWEEP_FALLBACK_MS &&
          (!observedModseq || !savedModseq || observedModseq === savedModseq))) return pending;
    }
    // A snapshot belongs to the whole pass. Advancing it at the final window
    // would hide label changes behind the cursor while that pass was running.
    const passModseq = maintenance ? (sweep ? savedModseq : observedModseq)
      : (!sameEpoch || state.scan_cursor == null ? observedModseq : savedModseq);
    const upper = arrivals ? high : maintenance ? sweep || high : history;
    let span = Math.min(500, arrivals ? high - previousHigh : upper);
    let budget;
    while (span > 0) {
      budget = await reserveBudget(account.id, account.imap_host, { messages: span, bytes: 1024 + span * 256 });
      if (stopped()) return pending;
      if (budget.allowed) break;
      if (span === 1) return { counts: { ...pending.counts, deferAt: budget.deferAt }, admittedIds: [] };
      span = Math.max(1, Math.floor(span / 2));
    }
    let lower = Math.max(1, upper - span + 1);
    const uids = span ? await read(() => client.search({ uid: `${lower}:${upper}` }, { uid: true })) : [];
    if (!Array.isArray(uids) || uids.some(uid => !Number.isSafeInteger(uid) || uid < lower || uid > upper)) {
      throw new Error('Incomplete archive UID snapshot');
    }
    const records = new Map();
    const loadMetadata = async input => {
      let requested = [...input].sort((a, b) => b - a);
      if (!requested.length) return;
      if (maintenance) {
        budget = await reserveBudget(account.id, account.imap_host, { messages: 0, bytes: 1024 + requested.length * 256 });
        if (!budget.allowed || stopped()) return { counts: { ...pending.counts, deferAt: budget.deferAt }, admittedIds: [] };
      }
      const sizes = new Map();
      for await (const msg of fetch(requested.join(','), { uid: true, size: true }, { uid: true })) {
        if (requested.includes(msg.uid) && Number.isSafeInteger(msg.size) && msg.size >= 0) sizes.set(msg.uid, msg.size);
      }
      if (sizes.size !== requested.length || stopped()) return pending;
      while (requested.length) {
        // Reserve only missing metadata, never represented history on a sweep.
        const bytes = 1024 + requested.reduce((sum, uid) => sum + 4 * sizes.get(uid) + 4096, 0);
        if (!Number.isSafeInteger(bytes)) return pending;
        budget = await reserveBudget(account.id, account.imap_host, { messages: 0, bytes });
        if (stopped()) return pending;
        if (budget.allowed) break;
        if (requested.length === 1) return { counts: { ...pending.counts, deferAt: budget.deferAt }, admittedIds: [] };
        requested = requested.slice(0, Math.floor(requested.length / 2));
        lower = Math.min(...requested);
      }
      const received = new Set();
      for await (const raw of fetch(requested.join(','), {
        uid: true, flags: true, envelope: true, bodyStructure: true, headers: true, internalDate: true,
      }, { uid: true })) {
        if (requested.includes(raw.uid) && typeof raw.emailId === 'string' && raw.emailId &&
            (!records.has(raw.uid) || records.get(raw.uid).providerMsgid === raw.emailId)) {
          const record = await prepareRecord(raw);
          records.set(raw.uid, { ...record, identityOnly: false, providerMsgid: raw.emailId,
            normalCopies: records.get(raw.uid)?.normalCopies || [] });
          received.add(raw.uid);
        }
      }
      if (received.size !== requested.length || stopped()) return pending;
      for (const uid of records.keys()) if (uid < lower) records.delete(uid);
    };
    if (maintenance) {
      if (uids.length) for await (const raw of fetch([...uids].sort((a, b) => b - a).join(','), { uid: true }, { uid: true })) {
        if (uids.includes(raw.uid) && typeof raw.emailId === 'string' && raw.emailId) {
          records.set(raw.uid, { uid: raw.uid, providerMsgid: raw.emailId, identityOnly: true, normalCopies: [] });
        }
      }
      if (records.size !== uids.length || stopped()) return pending;
    } else {
      const blocked = await loadMetadata(uids);
      if (blocked) return blocked;
    }
    selected.lock.release(); selected = null;
    // Idle ticks never select normal mailboxes. Before accounting for any
    // records, cached bootstrap readiness still needs live epoch validation.
    for (const row of records.size ? normal : []) {
      const proof = await examine(row.path);
      if (!proof) return pending;
      try {
        if (proof.epoch !== String(row.uid_validity)) {
          await query(`UPDATE archive_coverage SET bootstrap_complete=false,last_error='Mailbox epoch changed'
            WHERE account_id=$1 AND folder=$2`, [account.id, row.path]);
          return pending;
        }
      } finally { proof.lock.release(); }
    }
    const { rows: copies } = await query(`SELECT DISTINCT ON(provider_msgid) folder,uid,provider_msgid FROM messages WHERE account_id=$1
      AND provider_msgid=ANY($2::text[]) AND folder=ANY($3::text[]) AND NOT is_archive_residue AND NOT is_deleted
      ORDER BY provider_msgid,folder,uid`,
    [account.id, [...records.values()].map(row => row.providerMsgid), normal.map(row => row.path)]);
    for (const path of [...new Set(copies.map(row => row.folder))]) {
      const candidates = copies.filter(row => row.folder === path);
      // DISTINCT identities already consume source-window message tokens. Their
      // bounded UID-only membership proof adds bytes, not another logical message.
      budget = await reserveBudget(account.id, account.imap_host, { messages: 0, bytes: 1024 + 256 * candidates.length });
      if (!budget.allowed || stopped()) return pending;
      const proof = await examine(path);
      if (!proof) return pending;
      try {
        if (proof.epoch !== normalEpochs[path]) return pending;
        for await (const raw of fetch(candidates.map(row => row.uid).join(','), { uid: true }, { uid: true })) {
          if (!candidates.some(row => String(row.uid) === String(raw.uid) && row.provider_msgid === raw.emailId)) continue;
          for (const record of records.values()) if (record.providerMsgid === raw.emailId) record.normalCopies.push({ folder: path, uid: raw.uid });
        }
      } finally { proof.lock.release(); }
    }
    selected = await examine(folder);
    if (!selected || selected.epoch !== epoch || stopped()) return pending;
    if (maintenance) {
      const { rows: represented } = await query(`SELECT uid,provider_msgid FROM messages
        WHERE account_id=$1 AND folder=$2 AND uid=ANY($3::bigint[]) AND is_archive_residue AND NOT is_deleted`,
      [account.id, folder, [...records.keys()]]);
      const missing = [...records.values()].filter(record => !record.normalCopies.length &&
        !copies.some(copy => copy.provider_msgid === record.providerMsgid) &&
        !represented.some(row => String(row.uid) === String(record.uid) && row.provider_msgid === record.providerMsgid));
      const blocked = await loadMetadata(missing.map(record => record.uid));
      if (blocked) return blocked;
    }
    return await withTransaction(async db => {
      const result = await admitArchiveMetadata(db, { accountId: account.id, folder, uidValidity: epoch,
        records: [...records.values()], profile, normalEpochs });
      if (!result.counts.pending) {
        const cursor = arrivals ? (lower > previousHigh + 1 ? Math.max(history, lower - 1) : history)
          : maintenance ? history : Math.max(0, lower - 1);
        const nextSweep = maintenance ? Math.max(0, lower - 1) : cursor === 0 ? 0 : state?.sweep_cursor;
        await db.query(`UPDATE archive_coverage SET phase=$4,scan_cursor=$5,scan_high_uid=$6,
          label_modseq=CASE WHEN $10 THEN label_modseq ELSE $7::numeric END,
          sweep_cursor=CASE WHEN $10 THEN sweep_cursor ELSE $8::bigint END,
          sweep_checked_at=CASE WHEN $10 OR $5::bigint>0 THEN sweep_checked_at ELSE $9::timestamptz END,last_error=NULL
          WHERE account_id=$1 AND folder=$2 AND uid_validity=$3 AND phase<>'paused'`,
        [account.id, folder, epoch, cursor === 0 ? 'sweep' : 'scan', cursor, Math.max(previousHigh, high),
          passModseq, nextSweep ?? null, new Date(tick), arrivals]);
      }
      return result;
    });
  } catch (error) {
    await query(`UPDATE archive_coverage SET last_error='Archive metadata read failed'
      WHERE account_id=$1 AND folder=$2 AND phase<>'paused'`, [account.id, folder]).catch(() => {});
    throw error;
  } finally { selected?.lock.release(); }
}

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
    for (const msg of records.values()) await withGmailIdentityWrite(account.id, [msg.emailId], db => db.query(`UPDATE messages m SET provider_msgid=$4 FROM folders f, email_accounts a
      WHERE m.account_id=$1 AND m.folder=$2 AND m.uid=$3 AND NOT m.is_archive_residue
        AND f.account_id=m.account_id AND f.path=m.folder AND f.uid_validity=$5 AND a.id=m.account_id AND a.enabled`,
    [account.id, folder, msg.uid, msg.emailId, epoch]), { folder, uidValidity: epoch });
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
