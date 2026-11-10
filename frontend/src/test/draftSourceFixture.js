import { createHash } from 'node:crypto';

export const DRAFT_STORAGE_GENERATION = '10000000-0000-4000-8000-000000000001';

function fixtureUuid(value) {
  const hex = createHash('sha256').update(value).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// A source is a physical row snapshot, not the RFC Message-ID or a mailbox locator.
// Advance revision when a mock APPEND returns another copy with the same UID.
export function draftSourceFixture(accountId, uid, revision = uid) {
  return Object.freeze({
    messageId: fixtureUuid(`message:${accountId}:${revision}`),
    accountId,
    storageGeneration: DRAFT_STORAGE_GENERATION,
    entityId: fixtureUuid(`entity:${accountId}:${revision}`),
    folder: 'Drafts',
    uidValidity: '101',
    uid: String(uid),
  });
}

export function savedDraftFixture(accountId, uid, revision = uid) {
  return { uid, folder: 'Drafts', draftSource: draftSourceFixture(accountId, uid, revision) };
}

export function composeDraftFixture(accountId, uid, revision = uid) {
  const draftSource = draftSourceFixture(accountId, uid, revision);
  return { draftUid: uid, draftFolder: 'Drafts', draftAccountId: accountId,
    draftSource, persistedKey: JSON.stringify(draftSource) };
}

export function draftRowFixture(accountId, uid, revision = uid) {
  const source = draftSourceFixture(accountId, uid, revision);
  return { id: source.messageId, account_id: source.accountId,
    storage_generation: source.storageGeneration, entity_id: source.entityId,
    folder: source.folder, uid_validity: source.uidValidity, uid: source.uid };
}

// Real UUID accounts load the signature API. Preserve the existing account fixtures' content
// and defaults instead of making those tests depend on a failed or incomplete library load.
export function signatureLibraryFixture(account) {
  const signatures = [];
  const defaults = [{ senderKey: 'main', signature: account.signature },
    ...(account.aliases || []).map(alias => ({ senderKey: alias.id, signature: alias.signature ?? account.signature }))]
    .map(({ senderKey, signature }) => {
      const id = signature ? fixtureUuid(`signature:${account.id}:${senderKey}`) : null;
      if (id) signatures.push({ id, name: 'Existing signature', content: signature, isPlainText: false });
      return { senderKey, newSignatureId: account.signature_enabled !== false ? id : null,
        replySignatureId: account.signature_enabled !== false ? id : null };
    });
  return { accountId: account.id, revision: '1', signatures, defaults };
}
