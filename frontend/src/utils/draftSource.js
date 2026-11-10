import { copyAttachmentSource, attachmentSourceKey } from './attachmentSource.js';

const protocolValue = value => typeof value === 'number' && Number.isInteger(value) ? String(value) : value;

// Only the row actually opened, or a verified save receipt, may name a draft to remove.
export function draftSourceFromRow(row) {
  return copyAttachmentSource({
    messageId: row?.id, accountId: row?.account_id, storageGeneration: row?.storage_generation,
    entityId: row?.entity_id, folder: row?.folder, uidValidity: protocolValue(row?.uid_validity), uid: protocolValue(row?.uid),
  });
}

export function draftSourceForPointer(pointer) {
  const source = copyAttachmentSource(pointer?.source);
  return source && source.accountId === pointer.accountId && source.folder === pointer.folder
    && source.uid === protocolValue(pointer.uid) ? source : null;
}

export function draftPointerFromCompose(data) {
  const pointer = { accountId: data?.draftAccountId ?? data?.accountId ?? null,
    folder: data?.draftFolder ?? null, uid: data?.draftUid ?? null, source: data?.draftSource };
  return Object.freeze({ ...pointer, source: draftSourceForPointer(pointer) });
}

export function draftPointerFromReceipt(result, accountId) {
  const pointer = { accountId, folder: result?.folder, uid: result?.uid, source: result?.draftSource };
  const source = draftSourceForPointer(pointer);
  return source ? Object.freeze({ ...pointer, source }) : null;
}

export function draftPointerData(pointer) {
  const source = draftSourceForPointer(pointer);
  return { draftAccountId: pointer?.accountId ?? null, draftFolder: pointer?.folder ?? null,
    draftUid: pointer?.uid ?? null, draftMessageId: null, draftSource: source, draftUidValidity: source?.uidValidity ?? null,
    persistedKey: source ? attachmentSourceKey(source) : null };
}
