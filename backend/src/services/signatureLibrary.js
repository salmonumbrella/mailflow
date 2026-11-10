import { randomUUID } from 'node:crypto';
import { withTransaction } from './db.js';
import { sanitizeSignature } from './emailSanitizer.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class SignatureError extends Error {
  constructor(status, message, code = 'invalid_signature') { super(message); this.status = status; this.code = code; }
}
const invalid = message => { throw new SignatureError(400, message); };
const conflict = () => { throw new SignatureError(409, 'Signatures changed. Reload and review your changes before saving.', 'signature_revision_conflict'); };
const normalized = name => name.normalize('NFKC').toLowerCase();
const textHtml = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\n', '<br>');
const htmlOf = signature => signature ? (signature.isPlainText ? textHtml(signature.content) : sanitizeSignature(signature.content)) : '';
const snapshot = (account, aliases) => ({ signature: account.signature ?? null, enabled: account.signature_enabled !== false,
  aliases: Object.fromEntries(aliases.map(a => [a.id, a.signature ?? null])) });

async function read(client, accountId, userId) {
  const { rows } = await client.query(`SELECT id, signature, signature_enabled FROM email_accounts WHERE id = $1${userId ? ' AND user_id = $2' : ''} FOR UPDATE`, userId ? [accountId, userId] : [accountId]);
  if (!rows[0]) throw new SignatureError(404, 'Account not found');
  const aliases = (await client.query('SELECT id, signature FROM account_aliases WHERE account_id = $1 ORDER BY id', [accountId])).rows;
  const state = (await client.query('SELECT revision, legacy_snapshot FROM mail_signature_state WHERE account_id = $1', [accountId])).rows[0];
  const signatures = (await client.query('SELECT id, name, content, is_plain_text FROM mail_signatures WHERE account_id = $1 ORDER BY created_at, id', [accountId])).rows
    .map(r => ({ id: r.id, name: r.name, content: r.is_plain_text ? r.content : sanitizeSignature(r.content), isPlainText: r.is_plain_text }));
  const defaults = (await client.query('SELECT sender_key, new_signature_id, reply_signature_id, legacy_signature_id FROM mail_signature_defaults WHERE account_id = $1 ORDER BY sender_key', [accountId])).rows
    .map(r => ({ senderKey: r.sender_key, newSignatureId: r.new_signature_id, replySignatureId: r.reply_signature_id, legacySignatureId: r.legacy_signature_id }));
  return { accountId, account: rows[0], aliases, state, signatures, defaults };
}
function legacyRecord(data, content, currentId, label) {
  if (!content) return null;
  let entry = data.signatures.find(s => s.id === currentId);
  if (entry) { entry.content = sanitizeSignature(content); entry.isPlainText = false; return entry.id; }
  let name = label, n = 2;
  while (data.signatures.some(s => normalized(s.name) === normalized(name))) name = `${label} ${n++}`;
  entry = { id: randomUUID(), name, content: sanitizeSignature(content), isPlainText: false };
  data.signatures.push(entry);
  return entry.id;
}
function defaultRow(data, senderKey) {
  let row = data.defaults.find(d => d.senderKey === senderKey);
  if (!row) { row = { senderKey, newSignatureId: null, replySignatureId: null, legacySignatureId: null }; data.defaults.push(row); }
  return row;
}
function importLegacy(data) {
  const main = defaultRow(data, 'main');
  main.legacySignatureId = legacyRecord(data, data.account.signature, null, 'My signature');
  main.newSignatureId = main.replySignatureId = data.account.signature_enabled === false ? null : main.legacySignatureId;
  for (const alias of data.aliases) {
    const row = defaultRow(data, alias.id);
    row.legacySignatureId = alias.signature == null ? main.legacySignatureId : legacyRecord(data, alias.signature, null, 'Alias signature');
    row.newSignatureId = row.replySignatureId = data.account.signature_enabled === false ? null : row.legacySignatureId;
  }
}
async function persist(client, data, { mirror = false } = {}) {
  const { accountId } = data;
  for (const s of data.signatures) {
    const result = await client.query(`INSERT INTO mail_signatures(id, account_id, name, normalized_name, content, is_plain_text)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, normalized_name=EXCLUDED.normalized_name,
      content=EXCLUDED.content, is_plain_text=EXCLUDED.is_plain_text, updated_at=NOW() WHERE mail_signatures.account_id=EXCLUDED.account_id RETURNING id`,
    [s.id, accountId, s.name, normalized(s.name), s.content, s.isPlainText]);
    if (!result.rows.length) invalid('Signature does not belong to this account');
  }
  for (const d of data.defaults) {
    await client.query(`INSERT INTO mail_signature_defaults(account_id,sender_key,alias_id,new_signature_id,reply_signature_id,legacy_signature_id)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (account_id,sender_key) DO UPDATE SET new_signature_id=EXCLUDED.new_signature_id,
      reply_signature_id=EXCLUDED.reply_signature_id,legacy_signature_id=EXCLUDED.legacy_signature_id`,
    [accountId, d.senderKey, d.senderKey === 'main' ? null : d.senderKey, d.newSignatureId, d.replySignatureId, d.legacySignatureId]);
  }
  await client.query('DELETE FROM mail_signatures WHERE account_id=$1 AND NOT (id=ANY($2::uuid[]))', [accountId, data.signatures.map(s => s.id)]);
  if (mirror) {
    const get = key => htmlOf(data.signatures.find(s => s.id === data.defaults.find(d => d.senderKey === key)?.newSignatureId));
    const signature = get('main');
    // The legacy account-wide switch must not disable an explicitly selected alias default.
    const enabled = data.defaults.some(d => d.newSignatureId !== null);
    await client.query('UPDATE email_accounts SET signature=$2, signature_enabled=$3 WHERE id=$1', [accountId, signature, enabled]);
    Object.assign(data.account, { signature, signature_enabled: enabled });
    for (const alias of data.aliases) {
      alias.signature = get(alias.id);
      await client.query('UPDATE account_aliases SET signature=$3 WHERE account_id=$1 AND id=$2', [accountId, alias.id, alias.signature]);
    }
  }
  const result = await client.query(`INSERT INTO mail_signature_state(account_id,revision,legacy_snapshot) VALUES ($1,1,$2::jsonb)
    ON CONFLICT(account_id) DO UPDATE SET revision=mail_signature_state.revision+1,legacy_snapshot=EXCLUDED.legacy_snapshot RETURNING revision`,
  [accountId, JSON.stringify(snapshot(data.account, data.aliases))]);
  data.state = { revision: String(result.rows[0].revision), legacy_snapshot: snapshot(data.account, data.aliases) };
}
const dto = data => ({ accountId: data.accountId, revision: String(data.state.revision), signatures: data.signatures,
  legacy: { signature: sanitizeSignature(data.account.signature || ''), signature_enabled: data.account.signature_enabled !== false,
    aliases: data.aliases.map(a => ({ id: a.id, signature: a.signature == null ? null : sanitizeSignature(a.signature) })) },
  defaults: [...data.defaults].sort((a, b) => a.senderKey.localeCompare(b.senderKey)).map(({ senderKey, newSignatureId, replySignatureId }) => ({ senderKey, newSignatureId, replySignatureId })) });

export async function getSignatureLibrary(userId, accountId, transaction = withTransaction) {
  if (!UUID.test(accountId)) invalid('Invalid account');
  return transaction(async client => {
    const data = await read(client, accountId, userId);
    if (!data.state) { importLegacy(data); await persist(client, data); }
    return dto(data);
  });
}
export function validateSignatureLibrary(input) {
  if (!input || typeof input !== 'object' || !/^(0|[1-9][0-9]*)$/.test(String(input.revision ?? ''))) invalid('A signature revision is required');
  if (!Array.isArray(input.signatures) || input.signatures.length > 100 || !Array.isArray(input.defaults) || input.defaults.length > 200) invalid('Invalid signature library');
  const ids = new Set(), names = new Set();
  let total = 0;
  const signatures = input.signatures.map(s => {
    if (!s || !UUID.test(s.id) || ids.has(s.id.toLowerCase())) invalid('Invalid or duplicate signature ID');
    if (typeof s.name !== 'string' || !s.name.trim() || s.name.trim().length > 80 || Array.from(s.name).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) invalid('Enter a signature name of 1–80 characters');
    const name = s.name.trim(), key = normalized(name);
    if (names.has(key)) invalid('A signature with this name already exists');
    if (typeof s.content !== 'string' || s.content.length > 500000 || typeof s.isPlainText !== 'boolean') invalid('Invalid signature content');
    total += s.content.length;
    ids.add(s.id.toLowerCase()); names.add(key);
    return { id: s.id.toLowerCase(), name, content: s.isPlainText ? s.content : sanitizeSignature(s.content), isPlainText: s.isPlainText };
  });
  if (total > 2000000) invalid('Signature library is too large');
  const senders = new Set();
  const defaults = input.defaults.map(d => {
    if (!d || typeof d.senderKey !== 'string' || (d.senderKey !== 'main' && !UUID.test(d.senderKey)) || senders.has(d.senderKey)) invalid('Invalid signature sender');
    senders.add(d.senderKey);
    for (const key of ['newSignatureId', 'replySignatureId']) if (d[key] !== null && !ids.has(d[key])) invalid('Default signature is not in this library');
    return { senderKey: d.senderKey, newSignatureId: d.newSignatureId, replySignatureId: d.replySignatureId };
  });
  return { revision: String(input.revision), signatures, defaults };
}
export async function saveSignatureLibrary(userId, accountId, input, transaction = withTransaction) {
  if (!UUID.test(accountId)) invalid('Invalid account');
  const checked = validateSignatureLibrary(input);
  return transaction(async client => {
    const data = await read(client, accountId, userId);
    if (!data.state || String(data.state.revision) !== checked.revision) conflict();
    const keys = new Set(['main', ...data.aliases.map(a => a.id)]);
    if (checked.defaults.length !== keys.size || checked.defaults.some(d => !keys.has(d.senderKey))) invalid('Sender list changed. Reload signatures before saving');
    // An explicit library None forgets the legacy fallback. Only the legacy on/off toggle
    // retains its previous record for a later explicit re-enable.
    data.defaults = checked.defaults.map(d => ({ ...d, legacySignatureId: d.newSignatureId }));
    data.signatures = checked.signatures;
    await persist(client, data, { mirror: true });
    return dto(data);
  });
}

// Called after legacy writes in the SAME transaction; never creates a library on an unrelated
// account edit. All entry points lock the account first, including alias writes.
export async function syncLegacyAccountSignature(client, accountId, { signatureChanged, enabledChanged }) {
  if (!signatureChanged && !enabledChanged) return;
  if (!(await client.query('SELECT account_id FROM mail_signature_state WHERE account_id=$1', [accountId])).rows.length) return;
  const data = await read(client, accountId);
  const old = data.state.legacy_snapshot;
  const row = defaultRow(data, 'main');
  let changed = false;
  if (signatureChanged && old.signature !== (data.account.signature ?? null)) {
    changed = true;
    const currentId = row.newSignatureId || row.legacySignatureId;
    // Editing one sender through the single-signature legacy control is not an edit to every
    // sender sharing a named record. Fork it when another explicit alias depends on it.
    const shared = data.defaults.some(d => d.senderKey !== 'main'
      && data.aliases.some(a => a.id === d.senderKey && a.signature !== null)
      && [d.newSignatureId, d.replySignatureId, d.legacySignatureId].includes(currentId));
    row.legacySignatureId = legacyRecord(data, data.account.signature, shared ? null : currentId, 'My signature');
    row.newSignatureId = row.replySignatureId = data.account.signature_enabled === false ? null : row.legacySignatureId;
    // NULL aliases still inherit this legacy control. A clear must follow as well as an edit;
    // explicit alias signatures (including library-mirrored None) remain independent.
    for (const alias of data.aliases.filter(a => a.signature == null)) {
      Object.assign(defaultRow(data, alias.id), { legacySignatureId: row.legacySignatureId,
        newSignatureId: row.newSignatureId, replySignatureId: row.replySignatureId });
    }
  }
  if (enabledChanged && old.enabled !== (data.account.signature_enabled !== false)) {
    changed = true;
    for (const d of data.defaults) d.newSignatureId = d.replySignatureId = data.account.signature_enabled === false ? null : d.legacySignatureId;
  }
  if (changed) await persist(client, data);
}
export async function syncLegacyAliasSignature(client, accountId, aliasId) {
  if (!(await client.query('SELECT account_id FROM mail_signature_state WHERE account_id=$1', [accountId])).rows.length) return;
  const data = await read(client, accountId);
  const alias = data.aliases.find(a => a.id === aliasId);
  if (!alias) return;
  if (Object.hasOwn(data.state.legacy_snapshot.aliases || {}, aliasId) && data.state.legacy_snapshot.aliases[aliasId] === alias.signature) return;
  const row = defaultRow(data, aliasId);
  const currentId = row.newSignatureId || row.legacySignatureId;
  const shared = data.defaults.some(d => d.senderKey !== aliasId && [d.newSignatureId, d.replySignatureId, d.legacySignatureId].includes(currentId));
  row.legacySignatureId = alias.signature == null ? defaultRow(data, 'main').legacySignatureId : legacyRecord(data, alias.signature, shared ? null : currentId, 'Alias signature');
  row.newSignatureId = row.replySignatureId = data.account.signature_enabled === false ? null : row.legacySignatureId;
  await persist(client, data);
}
