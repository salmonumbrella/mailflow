import { Router } from 'express';
import { createHash } from 'node:crypto';
import { requireAuth, isPluginActivated, loadOwnedMessage, getOwnedThreadIdentities, storage } from '../api.js';

const PLUGIN = 'private-notes';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 4000;
const MAX_NOTES = 500;
const MAX_BYTES = 240 * 1024;
const digest = text => createHash('sha256').update(text).digest('hex');
// Notes permit normal line breaks and tabs, but not invisible control characters.
const hasControlText = text => [...text].some(character => {
  const code = character.charCodeAt(0);
  return code === 127 || (code < 32 && ![9, 10, 13].includes(code));
});
const router = Router();
router.use(requireAuth);
router.use(async (req, res, next) => {
  try {
    if (!(await isPluginActivated(req.session.userId, PLUGIN))) return res.status(403).json({ error: 'Enable Private thread notes in Settings → Plugins.' });
    next();
  } catch (error) { failure(error, res, next); }
});

const MAX_ANCHORS = 200;
const bounded = () => Object.assign(new Error('This conversation is too large to load all private notes safely.'), { status: 413 });
const failure = (error, res, next) => [409, 413].includes(error.status) ? res.status(error.status).json({ error: error.message }) : next(error);
const keyFor = (owner, accountId, identity) => `${owner}:${accountId}:${digest(identity)}`;
function identitiesFor(messages) {
  const identities = new Set();
  const add = identity => {
    if (!identity) return;
    if (typeof identity !== 'string' || identity.length > 4096) throw bounded();
    identities.add(identity);
    if (identities.size > MAX_ANCHORS) throw bounded();
  };
  for (const message of messages) {
    add(message.message_id);
    add(message.thread_id);
    for (const value of [message.in_reply_to, message.thread_references]) {
      if (!value) continue;
      if (typeof value !== 'string' || value.length > 16384) throw bounded();
      const ids = value.match(/<[^<>\s]+>/g);
      if (ids) ids.forEach(add);
      else if (value.trim()) add(value.trim());
    }
  }
  return [...identities];
}
async function scope(req, res) {
  if (!UUID.test(req.params.messageId)) { res.status(400).json({ error: 'Invalid message ID' }); return null; }
  const owner = req.session.userId;
  const message = await loadOwnedMessage(owner, req.params.messageId);
  if (!message || message.is_deleted) { res.status(404).json({ error: 'Message not found' }); return null; }
  // Thread roots can be healed by sync. The RFC Message-ID is the durable write anchor.
  if (!message.message_id) { res.status(422).json({ error: 'This message has no stable message identifier.' }); return null; }
  const members = await getOwnedThreadIdentities(owner, message.id);
  const identities = identitiesFor([message, ...members]);
  return { owner, accountId: message.account_id, rootKey: keyFor(owner, message.account_id, message.thread_id || message.message_id), key: keyFor(owner, message.account_id, message.message_id),
    keys: identities.map(identity => keyFor(owner, message.account_id, identity)) };
}
async function read(target) {
  const keys = new Set(target.keys);
  const records = new Map();
  let queue = [...keys];
  const prefix = `${target.owner}:${target.accountId}:`;
  while (queue.length) {
    const batch = queue.splice(0, 20);
    const loaded = await Promise.all(batch.map(key => storage.getOwned(PLUGIN, target.owner, key)));
    loaded.forEach((record, index) => {
      records.set(batch[index], record);
      // Retain known old anchors when later sync has removed a provisional root from mail.
      for (const key of record?.value?.anchors || []) {
        if (typeof key !== 'string' || !key.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(key.slice(prefix.length))) throw bounded();
        if (!keys.has(key)) { keys.add(key); queue.push(key); }
      }
    });
    if (keys.size > MAX_ANCHORS) throw bounded();
  }
  const entries = [...records].sort(([a], [b]) => a.localeCompare(b));
  const present = entries.filter(([, record]) => record);
  const allNotes = present.flatMap(([key, record]) => (record.value.notes || []).map(note => ({ key, note })));
  if (allNotes.length > MAX_NOTES || Buffer.byteLength(JSON.stringify(present)) > MAX_BYTES) throw bounded();
  const version = present.length ? digest(JSON.stringify(present.map(([key, record]) => [key, record.revision]))) : null;
  const deleted = new Set(allNotes.filter(({ note }) => note.deletedAt).map(({ note }) => note.id));
  const visible = new Map();
  for (const { note } of allNotes) if (!deleted.has(note.id) && !visible.has(note.id)) visible.set(note.id, note);
  const notes = [...visible.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return { records, allNotes, guards: entries.map(([key, record]) => ({ key, revision: record?.revision ?? null })),
    anchors: present.map(([key]) => key), snapshot: { notes, version } };
}
function rootChanges(target, state, changes = []) {
  const byKey = new Map(changes.map(item => [item.key, item]));
  const root = state.records.get(target.rootKey);
  const previous = byKey.get(target.rootKey)?.value || root?.value || { notes: [] };
  const anchors = [...new Set([...state.anchors, ...changes.map(item => item.key), target.rootKey])].sort();
  if (JSON.stringify(previous.anchors || []) !== JSON.stringify(anchors)) byKey.set(target.rootKey, {
    key: target.rootKey, expectedRevision: root?.revision ?? null, value: { ...previous, anchors },
  });
  const writes = [...byKey.values()];
  if (writes.length > 20) throw bounded();
  const candidate = new Map([...state.records].filter(([, record]) => record));
  for (const item of writes) candidate.set(item.key, { key: item.key, value: item.value, revision: 'x'.repeat(36) });
  if (Buffer.byteLength(JSON.stringify([...candidate])) > MAX_BYTES) throw bounded();
  return writes;
}
async function linkedRead(target) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await read(target);
    if (!state.allNotes.length) return state;
    const changes = rootChanges(target, state);
    if (!changes.length) return state;
    if (await storage.putOwnedBatch(PLUGIN, target.owner, changes, { guards: state.guards })) return read(target);
  }
  throw Object.assign(new Error('Notes changed while loading. Refresh notes and try again.'), { status: 409 });
}
const validVersion = value => value === null || (typeof value === 'string' && value.length > 0 && value.length <= 64);
const conflict = (res, state) => res.status(409).json({ error: 'Notes changed in another window. Review the latest notes and try again.', ...state.snapshot });

router.get('/:messageId', async (req, res, next) => {
  try {
    const target = await scope(req, res);
    if (target) res.json((await linkedRead(target)).snapshot);
  } catch (error) { failure(error, res, next); }
});

router.post('/:messageId', async (req, res, next) => {
  try {
    const { text, requestId, version } = req.body || {};
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT || hasControlText(text)
      || !UUID.test(requestId || '') || !validVersion(version)) return res.status(400).json({ error: 'Provide a note of 1–4000 characters, a request ID, and the current version.' });
    const target = await scope(req, res);
    if (!target) return;
    const state = await read(target);
    const duplicate = state.allNotes.find(({ note }) => note.id === requestId)?.note;
    if (duplicate) {
      if ((duplicate.textHash || digest(duplicate.text)) !== digest(text.trim())) return conflict(res, state);
      return res.json((await linkedRead(target)).snapshot);
    }
    if (state.snapshot.version !== version) return conflict(res, state);
    if (state.allNotes.length >= MAX_NOTES) return res.status(409).json({ error: 'This conversation has reached its private-note limit.' });
    const record = state.records.get(target.key);
    const value = { anchors: [...new Set([...state.anchors, target.key])].sort(),
      notes: [...(record?.value?.notes || []), { id: requestId, text: text.trim(), createdAt: new Date().toISOString() }] };
    const changes = rootChanges(target, state, [{ key: target.key, value, expectedRevision: record?.revision ?? null }]);
    const saved = await storage.putOwnedBatch(PLUGIN, target.owner, changes, { guards: state.guards });
    if (!saved) return conflict(res, await read(target));
    res.status(201).json((await read(target)).snapshot);
  } catch (error) { failure(error, res, next); }
});

router.delete('/:messageId/:noteId', async (req, res, next) => {
  try {
    const { version } = req.body || {};
    if (!UUID.test(req.params.noteId) || !validVersion(version) || version === null) return res.status(400).json({ error: 'Provide a note ID and the current version.' });
    const target = await scope(req, res);
    if (!target) return;
    const state = await read(target);
    const matches = state.allNotes.filter(({ note }) => note.id === req.params.noteId);
    if (!matches.length) return res.status(404).json({ error: 'Note not found' });
    if (matches.every(({ note }) => note.deletedAt)) return res.json((await linkedRead(target)).snapshot);
    if (state.snapshot.version !== version) return conflict(res, state);
    // Two once-separate roots may contain retries of the same submission. Erase every
    // plaintext copy atomically so deduplication cannot leave a hidden deleted note behind.
    const keys = [...new Set(matches.map(item => item.key))];
    const changes = rootChanges(target, state, keys.map(key => {
      const record = state.records.get(key);
      return { key, expectedRevision: record.revision, value: {
        anchors: state.anchors,
        notes: record.value.notes.map(item => item.id === req.params.noteId && !item.deletedAt
          ? { id: item.id, textHash: digest(item.text), deletedAt: new Date().toISOString() } : item),
      } };
    }));
    const saved = await storage.putOwnedBatch(PLUGIN, target.owner, changes, { guards: state.guards });
    if (!saved) return conflict(res, await read(target));
    res.json((await read(target)).snapshot);
  } catch (error) { failure(error, res, next); }
});

export default router;
