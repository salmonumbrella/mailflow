import { assertExpectedSource, captureMessageSource, protocolNumber, withMailboxIdentity } from './messageIdentity.js';
import { findOwnedMessage } from './ownership.js';

const SOURCE_COLUMNS = 'm.id, m.account_id, m.storage_generation, m.entity_id, m.folder, m.uid_validity, m.uid';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_KEYS = ['messageId', 'accountId', 'storageGeneration', 'entityId', 'folder', 'uidValidity', 'uid'];
export const attachmentSourceChanged = () => Object.assign(new Error('The attachment source changed. Refresh the message and try again.'), {
  code: 'identity_source_changed', status: 409,
});

export function sameAttachmentSource(left, right) {
  return Boolean(left && right && ['id', 'account_id', 'storage_generation', 'entity_id', 'folder'].every(key =>
    typeof left[key] === 'string' && left[key].length > 0 && left[key] === right[key])
    && protocolNumber(left.uid) && protocolNumber(left.uid) === protocolNumber(right.uid)
    && protocolNumber(left.uid_validity) && protocolNumber(left.uid_validity) === protocolNumber(right.uid_validity));
}

// Optional for old readers. New entrypoints send the exact source they displayed, not
// a fresh locator assembled after the user clicked a potentially replaced cache row.
export function assertAttachmentRequestSource(header, row) {
  if (header === undefined) return;
  const invalid = () => Object.assign(new Error('Invalid attachment source proof'), { status: 400 });
  let source;
  try {
    if (typeof header !== 'string' || !header.length || header.length > 8192) throw invalid();
    source = JSON.parse(decodeURIComponent(header));
  } catch { throw invalid(); }
  if (!source || Array.isArray(source) || typeof source !== 'object'
    || Object.keys(source).length !== SOURCE_KEYS.length || !SOURCE_KEYS.every(key => Object.hasOwn(source, key))
    || !['messageId', 'accountId', 'storageGeneration', 'entityId'].every(key => typeof source[key] === 'string' && UUID_RE.test(source[key]))
    || typeof source.folder !== 'string' || !source.folder.length || source.folder.length > 500
    || [...source.folder].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    || typeof source.uid !== 'string' || protocolNumber(source.uid) !== source.uid
    || typeof source.uidValidity !== 'string' || protocolNumber(source.uidValidity) !== source.uidValidity) throw invalid();
  if (!sameAttachmentSource(row, {
    id: source.messageId, account_id: source.accountId, storage_generation: source.storageGeneration,
    entity_id: source.entityId, folder: source.folder, uid_validity: source.uidValidity, uid: source.uid,
  })) throw attachmentSourceChanged();
}

export async function assertAttachmentSource(account, proof) {
  await assertExpectedSource(proof.context, proof.expectedSource);
  await withMailboxIdentity(proof.context, async client => {
    const current = await findOwnedMessage(account.user_id, proof.expectedSource.id, {
      columns: SOURCE_COLUMNS, live: true, enabledAccount: true, client,
    });
    if (account.id !== proof.expectedSource.account_id || !sameAttachmentSource(current, proof.expectedSource)) throw attachmentSourceChanged();
  });
}

export async function captureAttachmentSource(account, folder, uid, expectedSource) {
  const proof = await captureMessageSource(account, folder, uid, expectedSource);
  await assertAttachmentSource(account, proof);
  return proof;
}
