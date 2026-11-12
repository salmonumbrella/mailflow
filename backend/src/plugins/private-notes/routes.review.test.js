import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), message: vi.fn(), active: vi.fn(), identities: vi.fn(), batch: vi.fn() }));
vi.mock('../api.js', () => ({
  requireAuth: (req, res, next) => req.session?.userId ? next() : res.status(401).json({ error: 'Not authenticated' }),
  isPluginActivated: mocks.active, loadOwnedMessage: mocks.message, getOwnedThreadIdentities: mocks.identities,
  storage: { getOwned: mocks.get, putOwned: mocks.put, putOwnedBatch: mocks.batch },
}));
import router from './routes.js';
const messageId = '11111111-1111-4111-8111-111111111111';
const movedId = '22222222-2222-4222-8222-222222222222';
const accountBId = '33333333-3333-4333-8333-333333333333';
const noteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let server, base, records, revision;
const call = (path = messageId, method = 'GET', body, user = 'alice') => fetch(`${base}/${path}`, {
  method, headers: { ...(user ? { 'x-user': user } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
});
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId: req.get('x-user') }; next(); });
  app.use(router);
  app.use((error, _req, res, next) => { void next; res.status(500).json({ error: error.message }); });
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));
beforeEach(() => {
  records = new Map(); revision = 0;
  vi.clearAllMocks();
  mocks.active.mockResolvedValue(true);
  mocks.message.mockImplementation(async (owner, id) => owner === 'alice' && [messageId, movedId, accountBId].includes(id)
    ? { id, account_id: id === accountBId ? 'account-b' : 'account-a', thread_id: 'thread-root', message_id: '<message>', folder: id === movedId ? 'Archive' : 'INBOX' } : null);
  mocks.identities.mockImplementation(async (owner, id) => [await mocks.message(owner, id)].filter(Boolean));
  mocks.get.mockImplementation(async (_plugin, owner, key) => records.get(`${owner}:${key}`) || null);
  mocks.batch.mockImplementation(async (_plugin, owner, changes, { guards = [] } = {}) => {
    const current = key => records.get(`${owner}:${key}`)?.revision ?? null;
    if (guards.some(guard => current(guard.key) !== guard.revision)
      || changes.some(change => current(change.key) !== change.expectedRevision)) return null;
    return changes.map(({ key, value }) => {
      const record = { key, value, revision: `r${++revision}` };
      records.set(`${owner}:${key}`, record);
      return record;
    });
  });
  mocks.put.mockImplementation(async (_plugin, owner, key, value, { expectedRevision, guards = [] }) => {
    if (guards.some(guard => (records.get(`${owner}:${guard.key}`)?.revision ?? null) !== guard.revision)) return null;
    const previous = records.get(`${owner}:${key}`);
    if ((previous?.revision ?? null) !== expectedRevision) return null;
    const record = { key, value, revision: `r${++revision}` };
    records.set(`${owner}:${key}`, record);
    return record;
  });
});
const add = (text = 'Private', version = null, requestId = noteId, id = messageId) => call(id, 'POST', { text, requestId, version });

describe('independent private notes regression review', () => {
  it('negative control: a moved cache row retains notes while its conversation root is stable', async () => {
    await add('Keep after move');
    expect((await (await call(movedId)).json()).notes[0].text).toBe('Keep after move');
  });
  it('retains saved notes after sync heals a self-rooted conversation', async () => {
    mocks.message.mockResolvedValue({ id: messageId, account_id: 'a', message_id: '<reply>', thread_id: '<reply>' });
    await add('Keep after thread healing');
    expect((await (await call()).json()).notes).toHaveLength(1);
    // imapManager changes self-rooted thread_id to the true References root during sync.
    mocks.message.mockResolvedValue({ id: messageId, account_id: 'a', message_id: '<reply>', thread_id: '<root>' });
    expect((await (await call()).json()).notes[0]?.text).toBe('Keep after thread healing');
  });
  it('preserves notes from both provisional roots after their current thread merges', async () => {
    const a = { id: messageId, account_id: 'a', message_id: '<a>', thread_id: '<a>' };
    const b = { id: movedId, account_id: 'a', message_id: '<b>', thread_id: '<b>' };
    mocks.message.mockImplementation(async (_owner, id) => id === messageId ? a : b);
    await add('First provisional root');
    await add('Second provisional root', null, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', movedId);
    a.thread_id = '<root>'; b.thread_id = '<root>';
    mocks.identities.mockResolvedValue([a, b]);
    const result = await (await call()).json();
    expect(result.notes.map(note => note.text).sort()).toEqual(['First provisional root', 'Second provisional root']);
  });
  it('retains conversation notes after the message holding their immutable anchor is expunged', async () => {
    const a = { id: messageId, account_id: 'a', message_id: '<a>', thread_id: '<root>', thread_references: '<root>' };
    const b = { id: movedId, account_id: 'a', message_id: '<b>', thread_id: '<root>', thread_references: '<root>' };
    mocks.message.mockImplementation(async (_owner, id) => id === messageId ? a : b);
    mocks.identities.mockResolvedValue([a, b]);
    await add('Conversation note that must remain');
    expect((await (await call(movedId)).json()).notes[0]?.text).toBe('Conversation note that must remain');
    // Permanent deletion and IMAP reconciliation physically remove cached rows.
    mocks.message.mockImplementation(async (_owner, id) => id === messageId ? null : b);
    mocks.identities.mockResolvedValue([b]);
    expect((await (await call(movedId)).json()).notes[0]?.text).toBe('Conversation note that must remain');
  });

  it('removes duplicate note text from every anchor when provisional roots merge', async () => {
    const a = { id: messageId, account_id: 'a', message_id: '<a>', thread_id: '<a>' };
    const b = { id: movedId, account_id: 'a', message_id: '<b>', thread_id: '<b>' };
    mocks.message.mockImplementation(async (_owner, id) => id === messageId ? a : b);
    await add('Same logical note', null, noteId, messageId);
    await add('Same logical note', null, noteId, movedId);
    a.thread_id = '<root>'; b.thread_id = '<root>';
    mocks.identities.mockResolvedValue([a, b]);
    const merged = await (await call(movedId)).json();
    expect(merged.notes).toHaveLength(1);
    const deleted = await (await call(`${movedId}/${noteId}`, 'DELETE', { version: merged.version })).json();
    expect(deleted.notes).toEqual([]);
    const copies = [...records.values()].flatMap(record => record.value.notes || []).filter(note => note.id === noteId);
    expect(copies.some(note => 'text' in note)).toBe(false);
  });

});
