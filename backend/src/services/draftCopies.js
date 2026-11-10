import { query } from './db.js';
import { findOwnedAccount, findOwnedMessage } from './ownership.js';
import { captureMessageSource, assertExpectedSource, protocolNumber, withMailboxIdentity } from './messageIdentity.js';
import { sameAttachmentSource } from './attachmentReadScope.js';
import { imapManager } from '../index.js';
import { resolveAllDraftsPaths } from '../utils/mailUtils.js';

// The server copies of drafts: where they live, which previous copy a save replaces, and the
// delete of the draft a message was sent from. routes/draft.js saves and deletes drafts through
// these; the send pipeline (services/outgoingMail.js) deletes the sent draft.

// Tells the user's tabs that a Drafts folder changed, so the Inbox re-checks its reply-draft
// markers. The composer refreshes its own tab; this reaches the user's other tabs and devices.
// Best-effort: the draft is already saved or deleted, and a failed notice only delays a marker.
// The folder's counts are checked soon after too, so the Drafts total in the sidebar follows (#643).
export function noteDraftsChanged(userId, accountId, folder) {
  try {
    if (folder) imapManager.scheduleCountRefresh?.(accountId, [folder]);
    imapManager.broadcast({ type: 'drafts_changed', accountId }, userId);
  } catch (err) {
    console.warn('Drafts change notice failed:', err.message);
  }
}

export async function resolveDraftsFolder(account) {
  const mapped = account.folder_mappings?.drafts;
  if (mapped) return mapped;
  const result = await query(
    "SELECT path FROM folders WHERE account_id = $1 AND special_use = '\\Drafts' LIMIT 1",
    [account.id]
  );
  return result.rows[0]?.path || null;
}

// These routes permanently expunge, so they may only touch a Drafts folder: the canonical set; the
// folder routes/draft.js appends drafts to (resolveDraftsFolder trusts the raw mapping, and a save must
// always be able to replace its own previous copy); and the server's own \Drafts folder, which the
// message list still opens as Drafts when the mapping points somewhere else.
export async function isDraftsPath(account, folder, draftsFolder) {
  if (typeof folder !== 'string' || !folder) return false;
  if (folder === (draftsFolder ?? await resolveDraftsFolder(account))) return true;
  if ((await resolveAllDraftsPaths(account.id, account.folder_mappings)).has(folder)) return true;
  const specialUse = await query(
    "SELECT 1 FROM folders WHERE account_id = $1 AND path = $2 AND special_use = '\\Drafts' LIMIT 1",
    [account.id, folder]
  );
  return specialUse.rows.length > 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_KEYS = ['messageId', 'accountId', 'storageGeneration', 'entityId', 'folder', 'uidValidity', 'uid'];

// A physical cache UUID is not the RFC Message-ID header. Never repair missing proof
// by looking up whatever currently occupies a UID.
export function parseDraftSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)
    || Object.keys(source).length !== SOURCE_KEYS.length || !SOURCE_KEYS.every(key => Object.hasOwn(source, key))
    || !['messageId', 'accountId', 'storageGeneration', 'entityId'].every(key => typeof source[key] === 'string' && UUID_RE.test(source[key]))
    || typeof source.folder !== 'string' || !source.folder.length || source.folder.length > 500
    || [...source.folder].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    || typeof source.uid !== 'string' || protocolNumber(source.uid) !== source.uid
    || typeof source.uidValidity !== 'string' || protocolNumber(source.uidValidity) !== source.uidValidity) return null;
  return Object.freeze({ id: source.messageId.toLowerCase(), account_id: source.accountId.toLowerCase(),
    storage_generation: source.storageGeneration.toLowerCase(), entity_id: source.entityId.toLowerCase(),
    folder: source.folder, uid_validity: source.uidValidity, uid: source.uid });
}

export function draftSourceOf(row) {
  if (!row) return null;
  const source = { messageId: row.id, accountId: row.account_id, storageGeneration: row.storage_generation,
    entityId: row.entity_id, folder: row.folder, uidValidity: protocolNumber(row.uid_validity), uid: protocolNumber(row.uid) };
  return parseDraftSource(source) ? Object.freeze(source) : null;
}

export function draftSourceFromHeader(header) {
  try {
    if (typeof header !== 'string' || header.length > 8192) return null;
    const source = JSON.parse(decodeURIComponent(header));
    return parseDraftSource(source) ? source : null;
  } catch { return null; }
}

export async function findReplacedDraft(userId, account, draftsFolder, { existingUid, existingFolder, existingAccountId, existingSource }) {
  const source = parseDraftSource(existingSource);
  const refuse = why => {
    console.warn(`Draft: retaining previous copy: ${why}`);
    return null;
  };
  if (!source || protocolNumber(existingUid) !== source.uid || existingFolder !== source.folder
    || (existingAccountId ?? account.id) !== source.account_id) return refuse('missing or inconsistent source proof');
  const holder = await findOwnedAccount(userId, source.account_id, { enabled: true });
  if (!holder || holder.storage_generation !== source.storage_generation) return refuse('account changed');
  const frozenAccount = Object.freeze({ ...holder, expectedOwnerId: userId });
  if (!(await isDraftsPath(frozenAccount, source.folder, holder.id === account.id ? draftsFolder : undefined))) return refuse('not a Drafts folder');
  const row = await findOwnedMessage(userId, source.id, { live: true, enabledAccount: true });
  if (!sameAttachmentSource(row, source)) return refuse('source changed');
  const expectedSource = Object.freeze({ ...row });
  try {
    const { context } = await captureMessageSource(frozenAccount, source.folder, source.uid, expectedSource);
    return Object.freeze({ account: frozenAccount, uid: Number(source.uid), folder: source.folder,
      userId, expectedSource, context: Object.freeze({ ...context, expectedOwnerId: userId }) });
  } catch (err) {
    if (err.status === 409 || err.status === 404) return refuse(err.message);
    throw err;
  }
}

export async function deleteDraftCopy(target) {
  const { account, uid, folder, expectedSource, context, userId } = target;
  await assertExpectedSource(context, expectedSource);
  const deleted = await imapManager.permanentDeleteMessage(account, uid, folder, {
    expectRow: expectedSource, expectedSource, expectedOwnerId: userId,
  });
  if (!deleted) return false;
  // A delayed cleanup must never delete a row that sync has since put at the old UID.
  try {
    await withMailboxIdentity(context, tx => tx.query(`DELETE FROM messages WHERE id=$1 AND account_id=$2
      AND folder=$3 AND uid=$4 AND storage_generation=$5 AND uid_validity=$6 AND entity_id=$7`,
    [expectedSource.id, account.id, folder, uid, expectedSource.storage_generation, expectedSource.uid_validity, expectedSource.entity_id]));
  } catch (err) { console.warn(`Draft deleted; local cache refresh pending: ${err.message}`); }
  noteDraftsChanged(userId, account.id, folder);
  return true;
}

// Cleanup is best-effort after SMTP delivery or durable scheduling. Its refusal must
// never turn accepted mail into an apparent send failure that invites duplicate sends.
export async function deleteSentDraft(userId, account, { uid, folder, accountId, source } = {}) {
  try {
    const target = await findReplacedDraft(userId, account, undefined, {
      existingUid: uid, existingFolder: folder, existingAccountId: accountId, existingSource: source,
    });
    return target ? await deleteDraftCopy(target) : false;
  } catch (err) {
    console.error(`Draft: failed to delete sent draft uid=${JSON.stringify(uid)}: ${err.message}`);
    return false;
  }
}
