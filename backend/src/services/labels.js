import { query } from './db.js';
import { withReadSourceIdentity, CURRENT_MESSAGE_IDENTITY_SQL } from './messageReadScope.js';
import { fanOutReadToSiblings, readCopyTargets, pushSeen } from '../utils/mailUtils.js';

// Generic "labels" capability (v3.0 plugin platform).
//
// A label on a message physically means a COPY of that message living in the label's
// designated folder — a sibling row sharing the original's RFC Message-ID. Core owns the
// mechanics (ensure the folder, copy in, resolve the sibling, remove the copy) so features —
// and, once the boundary is finished, sandboxed plugins — apply/remove labels without ever
// touching IMAP or SQL directly. GTD is the first consumer; its states (Todo/Watch/…) are
// just labels whose folders come from its own config.
//
// imapManager is injected (callers pass their handle) so the DB/IMAP logic is unit-testable
// without a live connection pool — matching the pattern gtdTransitions/gtdSections already use.

// Resolve the uid of the message's copy that lives in `folder` for its account, or null. The
// acted row is used directly when it already lives there; otherwise the shared RFC Message-ID
// (an IMAP COPY duplicates it verbatim) joins to the sibling copy. A message with no
// Message-ID can only be resolved via the acted-row case.
const LABEL_COPY_COLUMNS = ['id', 'account_id', 'uid', 'folder', 'message_id', 'thread_key',
  'storage_generation', 'uid_validity', 'entity_id', 'subject', 'from_email', 'date', 'is_read'];
const copyLocator = row => row ? Object.fromEntries(LABEL_COPY_COLUMNS
  .filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]])) : null;

export async function resolveLabelCopy(message, folder) {
  if (message.folder === folder) return copyLocator(message);
  if (!message.message_id) return null;
  const { rows } = await query(
    `SELECT ${LABEL_COPY_COLUMNS.join(', ')} FROM messages WHERE account_id = $1 AND folder = $2 AND message_id = $3
      AND storage_generation IS NOT DISTINCT FROM $4::uuid AND is_deleted = false LIMIT 1`,
    [message.account_id, folder, message.message_id, message.storage_generation]
  );
  return copyLocator(rows[0]);
}

export async function resolveLabelCopyUid(message, folder) {
  return (await resolveLabelCopy(message, folder))?.uid ?? null;
}

// Apply a label: ensure the label folder exists, then COPY the message into it (leaving the
// original in place). imapManager.copyMessage also emits the section-refresh event. No-op when
// the message already lives in the label folder. `message` needs { uid, folder }.
export async function applyLabel(imapManager, account, message, labelFolder, { forceCopy = false } = {}) {
  account = { ...account };
  message = { ...message };
  if (message.folder === labelFolder) {
    return { applied: false, uid: message.uid, reason: 'already-there' };
  }
  const existingUid = forceCopy ? null : await resolveLabelCopyUid(message, labelFolder);
  if (existingUid != null) {
    return { applied: false, uid: existingUid, reason: 'already-labelled' };
  }
  await imapManager.ensureFolder(account, labelFolder);
  const uid = await imapManager.copyMessage(account, message.uid, message.folder, labelFolder, { expectedSource: message });
  return { applied: true, uid: uid ?? null };
}

// Remove one exact label copy only when it still carries the source message's RFC Message-ID.
// This is the safe inverse for a COPY whose destination UID was returned by UIDPLUS: a stale or
// forged UID cannot remove a different message's label copy. Without a Message-ID there is no
// stable identity shared by the source and copied rows, so no inverse is advertised.
export async function removeExactLabelCopy(imapManager, message, labelFolder, uid) {
  message = { ...message };
  if (!message.message_id) return { removed: false };
  const { rows } = await query(
    `SELECT * FROM messages
      WHERE account_id = $1 AND folder = $2 AND uid = $3
        AND message_id = $4 AND storage_generation IS NOT DISTINCT FROM $5::uuid AND is_deleted = false
      LIMIT 1`,
    [message.account_id, labelFolder, uid, message.message_id, message.storage_generation]
  );
  if (!rows[0]) return { removed: false };
  const removed = await imapManager.removeMessageCopy(
    { id: message.account_id, storage_generation: message.storage_generation }, uid, labelFolder,
    { expectedSource: { ...rows[0] } });
  return { removed: removed > 0 };
}

// Remove a label: delete the message's copy living in the label folder, leaving INBOX and any
// other labels intact. No-op when no such copy exists. `message` needs { account_id, uid,
// folder, message_id }.
export async function removeLabel(imapManager, message, labelFolder) {
  message = { ...message };
  const copy = await resolveLabelCopy(message, labelFolder);
  if (!copy) return { removed: false };
  const removed = await imapManager.removeMessageCopy(
    { id: message.account_id, storage_generation: message.storage_generation }, copy.uid, labelFolder,
    { expectedSource: { ...copy } });
  return { removed: removed > 0 };
}

// Ensure a set of label folders exist on the IMAP server, resolving each to its REAL server
// path (a prefixed namespace turns a bare 'Todo' into 'INBOX.Todo') and reporting whether this
// call created it. Returns one result per DEDUPED input path, in input order:
//   { folder, path, created }  on success  |  { folder, error: true }  on failure.
// A single folder's failure is isolated (logged, marked) so one bad name never aborts the rest.
// Core owns the IMAP mechanics; the caller owns any config persistence keyed off the results
// (e.g. recording where a relocated folder actually landed).
export async function ensureLabelFolders(imapManager, account, folderPaths) {
  const paths = [...new Set(folderPaths || [])];
  const results = [];
  for (const folder of paths) {
    try {
      const { path, created } = await imapManager.ensureFolder(account, folder, { resolvePath: true });
      results.push({ folder, path, created });
    } catch (err) {
      console.error(`ensureLabelFolders failed for ${folder}:`, err.message);
      results.push({ folder, error: true });
    }
  }
  return results;
}

// Mark DB copies read and await surviving per-copy STOREs before the caller archives.
// Excluded folders are stripped next and must not acquire retries. INBOX and the acted
// row stay best-effort because a move without UIDPLUS may invalidate their address.
// `error` reports DB/selection or best-effort failures; other failed pushes are queued.
// `pushedIds` contains confirmed STOREs only, for callers avoiding duplicate writes.
export async function markThreadRead(imapManager, account, message, { excludeFolders = [] } = {}) {
  account = { ...account };
  message = { ...message };
  let inboxCopy = null;
  let inboxSelected = false;
  const pushedIds = [];
  let error;
  try {
    const flipped = await withReadSourceIdentity(account, message, async tx => {
      const { rows } = await tx.query(`SELECT id, uid, is_read, account_id, folder, storage_generation, uid_validity, entity_id
        FROM messages WHERE account_id = $1 AND folder = $2 AND message_id = $3 AND is_deleted = false
          AND storage_generation=$4 AND ${CURRENT_MESSAGE_IDENTITY_SQL} LIMIT 1`,
      [message.account_id, 'INBOX', message.message_id, account.storage_generation]);
      inboxCopy = rows[0] || null;
      inboxSelected = true;
      return await fanOutReadToSiblings(message.account_id, message.message_id, true,
        { queryFn: tx.query.bind(tx), storageGeneration: account.storage_generation }) || [];
    });
    const perCopy = !imapManager.isLabelStore(account);
    let eligible = [];
    if (perCopy) {
      try { eligible = await readCopyTargets(message.account_id, message.message_id, message, {
        queryFn: (...args) => withReadSourceIdentity(account, message, tx => tx.query(...args)),
        storageGeneration: account.storage_generation }); }
      catch (err) { error = err; }
    }
    // INBOX is written without the copy check: Done archives inboxCopy either way.
    if (inboxCopy && !inboxCopy.is_read) {
      try {
        await imapManager.setFlag(account, inboxCopy.uid, 'INBOX', '\\Seen', true, { expectedSource: { ...inboxCopy } });
        pushedIds.push(inboxCopy.id);
      } catch (err) { error = err; }
    }
    if (perCopy) {
      const flippedIds = new Set(flipped.map(r => r.id));
      const copies = eligible.filter(r => flippedIds.has(r.id) && r.id !== inboxCopy?.id && !excludeFolders.includes(r.folder));
      const acted = copies.find(r => r.id === message.id);
      if (acted) {
        try {
          await imapManager.setFlag(account, acted.uid, acted.folder, '\\Seen', true, { expectedSource: { ...acted } });
          pushedIds.push(acted.id);
        } catch (err) { error ||= err; }
      }
      pushedIds.push(...await pushSeen(imapManager, account, message.account_id, copies.filter(r => r.id !== message.id), true));
    }
  } catch (err) {
    if (!inboxSelected && !/^(identity_|storage_generation_)/.test(err.code || '')) throw err;
    error ||= err;
  }
  return { inboxCopy, pushedIds, ...(error ? { error } : {}) };
}

// Best-effort \Seen on one copy, for when a copy other than INBOX is the durable one (GTD Done
// archiving a message's only copy, #524). The DB side is markThreadRead's fan-out; without the
// flag the next sync of the destination folder reads the copy back as unread. Never throws.
// `message` needs { uid, folder, is_read }.
export async function markCopySeen(imapManager, account, message) {
  if (message.is_read) return {};
  try {
    await imapManager.setFlag({ ...account }, message.uid, message.folder, '\\Seen', true, { expectedSource: { ...message } });
  } catch (err) {
    return { error: err };
  }
  return {};
}
