import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { selectedInboxMove, returnConversationToInbox } from './returnToInbox.js';
import { flushUndoables } from './undoableAction.js';
import { clearDeleteGuard, pendingDeleteMap } from './pendingDeletes.js';

globalThis.window = { innerWidth: 1024, dispatchEvent() {} };
globalThis.CustomEvent = class { constructor(type) { this.type = type; } };
const row = { id: 'a1', account_id: 'a', folder: 'Archive', thread_id: 'thread', message_count: 2 };
const inbox = { path: 'INBOX', special_use: '\\Inbox' };
const t = key => key;
function setup(changes = {}) {
  const listeners = new Set();
  const calls = [];
  let state;
  const store = { getState: () => state, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    setState: change => { state = { ...state, ...change }; listeners.forEach(fn => fn(state)); } };
  state = { user: { id: 'owner' }, layout: 'superhuman', accounts: [{ id: 'a', enabled: true }, { id: 'b', enabled: true }],
    folders: { a: [inbox, { path: 'Drafts', special_use: '\\Drafts' }], b: [inbox] }, messages: [row], searchResults: [],
    searchQuery: '', selectedAccountId: 'a', selectedFolder: 'Archive', selectedMessageId: null, listFocusedMessageId: row.id,
    notifications: [], threadMessages: {}, composing: false, showAdmin: false, showContacts: false,
    addNotification: n => store.setState({ notifications: [...state.notifications, n] }),
    removeMessages: ids => store.setState({ messages: state.messages.filter(m => !ids.includes(m.id)), selectedMessageId: null }),
    restoreMessages: messages => store.setState({ messages: [...state.messages, ...messages] }),
    setFolders: (accountId, folders) => store.setState({ folders: { ...state.folders, [accountId]: folders } }),
    clearThreadMessages: () => {}, recordRecentFolder: item => calls.push(['recent', item]), ...changes };
  const api = { getThread: async () => ({ messages: [row, { ...row, id: 'a2' }, { ...row, id: 'b1', account_id: 'b' }, { ...row, id: 'sent', folder: 'Sent' }, { ...row, id: 'draft', is_draft: true }] }),
    bulkMove: async (ids, folder) => { calls.push(['move', ids, folder]); return { moved: ids }; } };
  return { store, api, calls, run: extra => returnConversationToInbox(row, { store, api, t, ...extra }) };
}
const settle = async () => new Promise(resolve => setTimeout(resolve, 0));
afterEach(async () => { flushUndoables(); await settle(); [...pendingDeleteMap.keys()].forEach(clearDeleteGuard); });

test('returning a conversation moves only the visible account and source folder through the provider endpoint', async () => {
  const ctx = setup();
  assert.equal(await ctx.run(), true);
  assert.equal(ctx.store.getState().messages.length, 0);
  assert.deepEqual(ctx.calls, [], 'Undo window holds the mutation');
  flushUndoables(); await settle();
  assert.deepEqual(ctx.calls[0], ['move', ['a1', 'a2'], 'INBOX']);
  assert.equal(ctx.store.getState().notifications.filter(n => n.type === 'error').length, 0);
});

test('Undo restores the original visible row and cancels the provider request exactly once', async () => {
  const ctx = setup();
  await ctx.run();
  const notification = ctx.store.getState().notifications[0];
  assert.equal(notification.onUndo(), true);
  assert.equal(notification.onUndo(), false);
  flushUndoables(); await settle();
  assert.deepEqual(ctx.calls, []);
  assert.deepEqual(ctx.store.getState().messages, [row]);
});

test('Undo after navigation does not inject the old row into a different folder', async () => {
  const ctx = setup(); let currentView = true;
  await ctx.run({ viewCurrent: () => currentView });
  currentView = false;
  ctx.store.setState({ selectedFolder: 'Other', messages: [] });
  ctx.store.getState().notifications[0].onUndo();
  assert.deepEqual(ctx.store.getState().messages, []);
  assert.deepEqual(ctx.calls, []);
});

test('stale thread responses cancel on selection, view, owner, lock, account, or pop-out change, including away and back', async () => {
  const changes = [{ listFocusedMessageId: 'other' }, { selectedFolder: 'Other' }, { user: { id: 'other' } },
    { isLocked: true }, { accounts: [{ id: 'a', enabled: false }] }, { messageWindows: [{ messageId: row.id, z: 1 }] }];
  for (const change of changes) {
    const ctx = setup(); let finish;
    ctx.api.getThread = () => new Promise(resolve => { finish = resolve; });
    const running = ctx.run();
    const original = ctx.store.getState(); ctx.store.setState(change); ctx.store.setState(original);
    finish({ messages: [row] });
    assert.equal(await running, false, JSON.stringify(change));
    assert.deepEqual(ctx.calls, []);
    assert.deepEqual(ctx.store.getState().notifications, []);
  }
});

test('disabled accounts and owner changes cancel an already queued move without leaking state to another owner', async () => {
  for (const change of [{ user: { id: 'other' } }, { accounts: [{ id: 'a', enabled: false }] }]) {
    const ctx = setup(); await ctx.run(); ctx.store.setState(change);
    flushUndoables(); await settle(); assert.deepEqual(ctx.calls, []);
  }
});

test('partial provider failures restore the row and report an error instead of silently succeeding', async () => {
  const ctx = setup(); ctx.api.bulkMove = async () => ({ moved: ['a2'] });
  await ctx.run(); flushUndoables(); await settle();
  assert.deepEqual(ctx.store.getState().messages, [row]);
  assert.equal(ctx.store.getState().notifications.at(-1).type, 'error');
});

test('failed or malformed thread resolution never falls back to an unverified move', async () => {
  for (const result of [{}, { messages: [] }, { messages: [{ ...row, account_id: 'b' }] }]) {
    const ctx = setup(); ctx.api.getThread = async () => result;
    assert.equal(await ctx.run(), false); assert.deepEqual(ctx.calls, []);
    assert.equal(ctx.store.getState().notifications.at(-1).type, 'error');
  }
});

test('Inbox, draft, disabled account, hidden selection and pop-out targets are ineligible', () => {
  const ctx = setup(); const state = ctx.store.getState();
  for (const change of [{ messages: [{ ...row, folder: 'INBOX' }] }, { messages: [{ ...row, folder: 'inbox' }] }, { loadingMessages: true }, { messages: [{ ...row, folder: 'Drafts' }] },
    { messages: [{ ...row, is_draft: true }] }, { messages: [] }, { isLocked: true }, { showContacts: true },
    { accounts: [{ id: 'a', enabled: false }] }, { messageWindows: [{ messageId: row.id, z: 1 }] },
    { folders: { a: [{ ...inbox, no_select: true }] } }]) assert.equal(selectedInboxMove({ ...state, ...change }), null);
});


test('unknown folders are verified through the account API before a move is queued', async () => {
  const ctx = setup({ folders: {} }); let reads = 0;
  ctx.api.getFolders = async accountId => { reads++; assert.equal(accountId, 'a'); return [inbox]; };
  assert.equal(await ctx.run(), true); assert.equal(reads, 1); assert.deepEqual(ctx.calls, []);
  ctx.store.getState().notifications[0].onUndo();
  const missing = setup({ folders: {} }); missing.api.getFolders = async () => [{ path: 'Other' }];
  assert.equal(await missing.run(), false); assert.deepEqual(missing.calls, []);
  assert.equal(missing.store.getState().notifications.at(-1).type, 'error');
});

test('Inbox restore leaves native snooze bookkeeping to the existing unsnooze action', () => {
  const ctx = setup(); const state = ctx.store.getState();
  for (const changes of [{ folder: 'Snoozed' }, { folder: 'INBOX.Snoozed', snoozed_folder: 'INBOX.Snoozed' }, { snooze_until: '2026-12-01T12:00:00Z' }]) {
    assert.equal(selectedInboxMove({ ...state, messages: [{ ...row, ...changes }] }), null);
  }
  assert.equal(selectedInboxMove({ ...state, selectedFolder: 'Snoozed' }), null);
});
