import { setImmediate } from 'node:timers';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toggleThreadMute } from './mutedThreads.js';

const message = { id: 'm1', account_id: 'a', thread_id: 'thread', folder: 'INBOX', is_read: false };
const t = (_key, fallback) => fallback;
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  const listeners = new Set(); const notifications = []; const archived = []; const patches = [];
  let state = { user: { id: 'owner' }, isLocked: false, accounts: [{ id: 'a', enabled: true }, { id: 'b', enabled: true }],
    selectedMessageId: 'm1', selectedAccountId: 'a', selectedFolder: 'INBOX', layout: 'superhuman', searchQuery: '', messages: [message],
    addNotification: notice => notifications.push(notice), decrementUnread() {}, clearThreadMessages() {}, removeMessages: ids => archived.push(...ids),
  };
  const store = { getState: () => state, setState: change => { state = { ...state, ...change }; listeners.forEach(fn => fn(state)); }, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
  const api = { get: async () => ({ muted: false, revision: null, threadKey: 'thread-key' }),
    getThread: async () => ({ messages: [message, { ...message, id: 'm2' }, { ...message, id: 'other', account_id: 'b' }, { ...message, id: 'sent', folder: 'Sent' }, { ...message, id: 'draft', is_draft: true }] }),
    patch: async (path, body) => { patches.push({ path, body }); return { muted: body.muted, revision: 'v1', threadKey: 'thread-key' }; },
    bulkArchive: async (ids, _afterSend, guard) => { assert.deepEqual(guard, { messageId: 'm1', revision: 'v1', accountId: 'a', threadKey: 'thread-key' }); return { archived: ids, noArchiveFolder: [] }; },
  };
  globalThis.window = { dispatchEvent() {} };
  globalThis.CustomEvent = class {};
  return { store, api, t, notifications, archived, patches };
}

test('mute uses CAS and archives only captured account Inbox copies with a server guard', async () => {
  const f = fixture(); const result = await toggleThreadMute(message, f);
  assert.equal(result.muted, true);
  assert.deepEqual(f.patches, [{ path: '/mail/messages/m1/mute', body: { muted: true, revision: null } }]);
  assert.deepEqual(f.archived, ['m1', 'm2']);
  assert.equal(f.notifications[0].title, 'Conversation muted');
});

test('unmute keeps archived mail in place and forwards the exact revision', async () => {
  const f = fixture(); f.api.get = async () => ({ muted: true, revision: 'old' });
  f.api.getThread = () => { throw new Error('Unmute must not fetch archive targets'); };
  f.api.bulkArchive = () => { throw new Error('Unmute must not move mail'); };
  assert.equal((await toggleThreadMute(message, f)).muted, false);
  assert.deepEqual(f.patches[0].body, { muted: false, revision: 'old' });
  assert.deepEqual(f.archived, []);
});

test('navigation, logout, lock, disabled account and away/back prevent a stale read from writing', async () => {
  for (const change of [{ selectedMessageId: 'new' }, { user: { id: 'other' } }, { isLocked: true }, { accounts: [] }, { selectedAccountId: 'b' }]) {
    const f = fixture(); const read = defer(); f.api.get = () => read.promise;
    const action = toggleThreadMute(message, f); f.store.setState(change); f.store.setState({ selectedMessageId: 'm1', selectedAccountId: 'a' });
    read.resolve({ muted: false, revision: null });
    assert.equal(await action, null); assert.deepEqual(f.patches, []); assert.deepEqual(f.archived, []);
  }
});

test('navigation during a confirmed mute never archives or updates a newer selection', async () => {
  const f = fixture(); const write = defer(); f.api.patch = () => write.promise;
  const action = toggleThreadMute(message, f); await new Promise(resolve => setImmediate(resolve));
  f.store.setState({ selectedMessageId: 'new' }); write.resolve({ muted: true, revision: 'v1', threadKey: 'thread-key' });
  assert.equal(await action, null); assert.deepEqual(f.archived, []); assert.deepEqual(f.notifications, []);
});

test('a CAS failure never archives and a partial archive reports the saved mute honestly', async () => {
  const f = fixture(); f.api.patch = async () => { throw new Error('Mute state changed'); };
  await assert.rejects(toggleThreadMute(message, f), /Mute state changed/); assert.deepEqual(f.archived, []);
  const partial = fixture(); partial.api.bulkArchive = async () => ({ archived: ['m1', 'unrequested'], noArchiveFolder: ['a'] });
  assert.equal((await toggleThreadMute(message, partial)).muted, true);
  assert.deepEqual(partial.archived, ['m1']);
  assert.equal(partial.notifications[0].title, 'The conversation is muted, but could not be archived.');
});

test('repeat requests are single flight and a late archive cannot change another owner', async () => {
  const f = fixture(); const archive = defer(); f.api.bulkArchive = () => archive.promise;
  const action = toggleThreadMute(message, f); await new Promise(resolve => setImmediate(resolve));
  assert.equal(await toggleThreadMute(message, f), null); assert.equal(f.patches.length, 1);
  f.store.setState({ user: { id: 'other' } }); archive.resolve({ archived: ['m1', 'm2'] }); await action;
  assert.deepEqual(f.archived, []); assert.deepEqual(f.notifications, []);
});
