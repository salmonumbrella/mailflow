import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), batch: vi.fn(), message: vi.fn(), identities: vi.fn(), active: vi.fn() }));
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
const note2Id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
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
  mocks.identities.mockImplementation(async (owner, id) => { const message = await mocks.message(owner, id); return message ? [message] : []; });
  mocks.get.mockImplementation(async (_plugin, owner, key) => records.get(`${owner}:${key}`) || null);
  mocks.batch.mockImplementation(async (plugin, owner, changes, { guards }) => {
    if (guards.some(guard => (records.get(`${owner}:${guard.key}`)?.revision ?? null) !== guard.revision)
      || changes.some(item => (records.get(`${owner}:${item.key}`)?.revision ?? null) !== item.expectedRevision)) return null;
    const saved = [];
    for (const item of changes) saved.push(await mocks.put(plugin, owner, item.key, item.value, { expectedRevision: item.expectedRevision }));
    return saved;
  });
  mocks.put.mockImplementation(async (_plugin, owner, key, value, { expectedRevision, guards }) => {
    if (guards?.some(guard => (records.get(`${owner}:${guard.key}`)?.revision ?? null) !== guard.revision)) return null;
    const previous = records.get(`${owner}:${key}`);
    if ((previous?.revision ?? null) !== expectedRevision) return null;
    const record = { key, value, revision: `r${++revision}` };
    records.set(`${owner}:${key}`, record);
    return record;
  });
});
const add = (text = 'Private', version = null, requestId = noteId, id = messageId) => call(id, 'POST', { text, requestId, version });

describe('private thread notes ownership and stable identity', () => {
  it('requires authentication and explicit plugin activation', async () => {
    expect((await call(messageId, 'GET', undefined, null)).status).toBe(401);
    mocks.active.mockResolvedValue(false);
    expect((await call()).status).toBe(403);
    expect(mocks.message).not.toHaveBeenCalled();
  });
  it('derives owner, account and thread server-side, isolates users/accounts, and follows moves', async () => {
    const saved = await (await call(messageId, 'POST', { text: 'mine', requestId: noteId, version: null, ownerId: 'bob', accountId: 'account-b', thread: 'attacker' })).json();
    expect(saved.notes[0].text).toBe('mine');
    expect((await call(messageId, 'GET', undefined, 'bob')).status).toBe(404);
    expect((await call(messageId, 'POST', { text: 'stolen', requestId: note2Id, version: saved.version }, 'bob')).status).toBe(404);
    expect((await call(`${messageId}/${noteId}`, 'DELETE', { version: saved.version }, 'bob')).status).toBe(404);
    expect((await (await call(accountBId)).json()).notes).toEqual([]);
    expect(await (await call(movedId)).json()).toEqual(saved);
    expect(mocks.get.mock.calls.every(([, owner, key]) => owner === 'alice' && key.startsWith('alice:'))).toBe(true);
  });
  it('uses an RFC message identity for messages without a thread, never a replaceable row id', async () => {
    mocks.message.mockImplementation(async (_owner, id) => ({ id, account_id: 'a', message_id: '<same>', thread_key: id }));
    await add();
    expect((await (await call(movedId)).json()).notes).toHaveLength(1);
    mocks.message.mockResolvedValue({ id: movedId, account_id: 'a', thread_key: movedId });
    expect((await call(movedId)).status).toBe(422);
  });
});

describe('private thread notes concurrency and validation', () => {
  it('is idempotent for submission retries and refuses token reuse with different content', async () => {
    const saved = await (await add()).json();
    expect(await (await add()).json()).toEqual(saved);
    expect((await add('different')).status).toBe(409);
    expect(mocks.batch).toHaveBeenCalledTimes(1);
  });
  it('rejects stale appends and deletes, then allows an explicit retry against latest version', async () => {
    const first = await (await add()).json();
    const conflict = await add('second', null, note2Id);
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).version).toBe(first.version);
    const second = await (await add('second', first.version, note2Id)).json();
    expect((await call(`${messageId}/${noteId}`, 'DELETE', { version: first.version })).status).toBe(409);
    const removed = await (await call(`${messageId}/${noteId}`, 'DELETE', { version: second.version })).json();
    expect(removed.notes.map(note => note.id)).toEqual([note2Id]);
    expect([...records.values()][0].value.notes.find(note => note.id === noteId)).not.toHaveProperty('text');
    expect(await (await add()).json()).toEqual(removed);
    expect(await (await call(`${messageId}/${noteId}`, 'DELETE', { version: second.version })).json()).toEqual(removed);
  });
  it('uses compare-and-swap when two writes race after the same read', async () => {
    const responses = await Promise.all([add(), add('second', null, note2Id)]);
    expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
    expect((await (await call()).json()).notes).toHaveLength(1);
  });
  it('validates limits and stores markup only as plain text', async () => {
    for (const value of ['', ' ', 'x'.repeat(4001), 'bad\u0000text']) expect((await add(value)).status).toBe(400);
    expect((await call('invalid')).status).toBe(400);
    expect((await call(messageId, 'POST', { text: 'x', requestId: noteId })).status).toBe(400);
    const saved = await (await add('<img src=x onerror=alert(1)>')).json();
    expect(saved.notes[0].text).toBe('<img src=x onerror=alert(1)>');
  });
  it('does not report a failed storage write as success', async () => {
    mocks.batch.mockRejectedValueOnce(new Error('Storage unavailable'));
    expect((await add()).status).toBe(500);
    expect((await (await call()).json()).notes).toEqual([]);
  });
});

describe('merged immutable note anchors', () => {
  const a = { id: messageId, account_id: 'a', message_id: '<a>', thread_id: '<a>' };
  const b = { id: movedId, account_id: 'a', message_id: '<b>', thread_id: '<b>' };
  const setup = (merged = false) => {
    const rows = [a, b].map(row => ({ ...row, thread_id: merged ? '<root>' : row.thread_id }));
    mocks.message.mockImplementation(async (_owner, id) => rows.find(row => row.id === id));
    mocks.identities.mockImplementation(async (_owner, id) => merged ? rows : rows.filter(row => row.id === id));
  };
  it('exposes both pre-merge roots from every current member with independent idempotency and deletes', async () => {
    setup();
    await add('First root'); await add('Second root', null, note2Id, movedId);
    setup(true);
    const merged = await (await call()).json();
    expect(merged.notes.map(note => note.text)).toEqual(['First root', 'Second root']);
    expect(await (await call(movedId)).json()).toEqual(merged);
    expect(await (await add('First root', null, noteId, movedId)).json()).toEqual(merged);
    expect(await (await add('Second root', null, note2Id, messageId)).json()).toEqual(merged);
    const removed = await (await call(`${movedId}/${noteId}`, 'DELETE', { version: merged.version })).json();
    expect(removed.notes.map(note => note.text)).toEqual(['Second root']);
    expect((await add('First root', null, noteId, messageId)).status).toBe(200);
    expect((await (await call()).json()).notes).toHaveLength(1);
  });
  it('rejects a cross-anchor concurrent create against the same snapshot', async () => {
    setup(true);
    const responses = await Promise.all([add('First', null, noteId, messageId), add('Second', null, note2Id, movedId)]);
    expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
    const merged = await (await call()).json();
    expect(merged.notes).toHaveLength(1);
    expect(await (await call(movedId)).json()).toEqual(merged);
  });
  it('cannot duplicate one request ID from different anchors or resurrect it after deletion', async () => {
    setup(true);
    await Promise.all([add('One submission', null, noteId, messageId), add('One submission', null, noteId, movedId)]);
    const merged = await (await call()).json();
    expect(merged.notes).toHaveLength(1);
    await call(`${movedId}/${noteId}`, 'DELETE', { version: merged.version });
    await add('One submission', null, noteId, messageId);
    expect((await (await call(movedId)).json()).notes).toEqual([]);
    expect([...records.values()].flatMap(record => record.value.notes).filter(note => note.id === noteId)).toHaveLength(1);
  });
  it('retains anchor and tombstone closure after a root disappears from current members', async () => {
    setup(); await add('First root'); await add('Second root', null, note2Id, movedId);
    setup(true);
    const merged = await (await call()).json();
    // A mutation while merged records the old anchors; later sync drops that root from mail.
    await call(`${messageId}/${noteId}`, 'DELETE', { version: merged.version });
    const current = await (await call()).json();
    const thirdId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await add('Remaining member', current.version, thirdId, movedId);
    mocks.identities.mockResolvedValue([b]);
    const remaining = await (await call(movedId)).json();
    expect(remaining.notes.map(note => note.text)).toEqual(['Second root', 'Remaining member']);
    expect(await (await add('First root', null, noteId, movedId)).json()).toEqual(remaining);
  });
  it('refuses oversized membership and does not follow metadata to another account', async () => {
    mocks.identities.mockResolvedValue(Array.from({ length: 201 }, (_, i) => ({ message_id: `<${i}>` })));
    expect((await call()).status).toBe(413);
    mocks.identities.mockResolvedValue([a]);
    mocks.get.mockResolvedValue({ key: 'x', revision: 'v', value: { notes: [], anchors: [`alice:other:${'a'.repeat(64)}`] } });
    expect((await call()).status).toBe(413);
    expect(mocks.get.mock.calls.every(([, , key]) => !key.includes(':other:'))).toBe(true);
  });
});
