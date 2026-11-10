const KEYS = ['messageId', 'accountId', 'storageGeneration', 'entityId', 'folder', 'uidValidity', 'uid'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uint32 = value => typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 4294967295;
const protocolValue = value => typeof value === 'number' && Number.isInteger(value) ? String(value) : value;

function validatedSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const keys = Reflect.ownKeys(source);
  if (keys.length !== KEYS.length || !KEYS.every(key => keys.includes(key))) return null;
  const copy = {};
  for (const key of KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') return null;
    copy[key] = descriptor.value;
  }
  if (!KEYS.slice(0, 4).every(key => UUID.test(copy[key])) || !uint32(copy.uid) || !uint32(copy.uidValidity)
    || !copy.folder.length || copy.folder.length > 500
    || [...copy.folder].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
  return copy;
}

// Action proof is not display normalization: never trim, coerce or fill missing fields.
export function copyAttachmentSource(source) {
  try {
    const copy = validatedSource(source);
    if (!copy) return null;
    encodeURIComponent(copy.folder);
    if (encodeURIComponent(JSON.stringify(copy)).length > 8192) return null;
    return Object.freeze(copy);
  } catch { return null; }
}

export function encodeAttachmentSource(source) {
  const copy = copyAttachmentSource(source);
  return copy ? encodeURIComponent(JSON.stringify(copy)) : null;
}

export function attachmentSourceKey(source) {
  const copy = copyAttachmentSource(source);
  return copy ? JSON.stringify(copy) : null;
}

export function attachmentSourceMatchesRow(source, row) {
  const copy = copyAttachmentSource(source);
  return Boolean(copy && row && copy.messageId === row.id && copy.accountId === row.account_id
    && copy.storageGeneration === row.storage_generation && copy.entityId === row.entity_id
    && copy.folder === row.folder && copy.uid === protocolValue(row.uid)
    && copy.uidValidity === protocolValue(row.uid_validity));
}
