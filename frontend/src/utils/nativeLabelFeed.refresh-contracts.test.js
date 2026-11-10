import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNativeLabelFeed } from './nativeLabelFeed.js';

const view = { accountId: 'account', storageGeneration: 'generation', labelId: 'label' };
const row = entityId => ({ entityId, id: `cache-${entityId}`, account_id: view.accountId,
  storageGeneration: view.storageGeneration, folder: 'INBOX', message_id: '<same-header>' });
function harness() {
  let serverRows = ['a', 'b', 'c', 'd', 'e'].map(row);
  let state = { activeLabel: view, user: { id: 'owner' }, messages: [], selectedMessageId: null };
  const requests = [];
  const store = { getState: () => state, setState: update => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) }; } };
  const api = { getNativeLabelMessages: async (labelId, params) => {
    requests.push({ labelId, ...params });
    const start = params.cursor ? Number(params.cursor) : 0;
    const end = start + params.limit;
    return { ...view, messages: serverRows.slice(start, end), nextCursor: end < serverRows.length ? String(end) : null,
      total: serverRows.length, coverage: { kind: 'synchronized-cache', unresolvedMemberships: 0 } };
  }, queryNativeLabelMemberships: async scope => ({ accountId: view.accountId, storageGeneration: view.storageGeneration, targets: scope.targets.map(target => ({ requestedEntityId: target.entityId, entityId: target.entityId, available: true, metadataVersion: '1', labelIds: serverRows.some(row => row.entityId === target.entityId) ? [view.labelId] : [] })) }) };
  return { store, api, requests, feed: createNativeLabelFeed({ api, store }), replace: rows => { serverRows = rows; } };
}
async function openTwoPages(h) {
  await h.feed.load({ limit: 2 }); await h.feed.load({ limit: 2, append: true });
  assert.deepEqual(h.store.getState().messages.map(message => message.entityId), ['a', 'b', 'c', 'd']);
  h.store.setState({ selectedMessageId: 'cache-d' });
}

test('refresh retains loaded second page and reader selection when membership is unchanged', async () => {
  const h = harness(); await openTwoPages(h);
  await h.feed.load({ limit: 2 });
  assert.deepEqual(h.store.getState().messages.map(message => message.entityId), ['a', 'b', 'c', 'd']);
  assert.equal(h.store.getState().selectedMessageId, 'cache-d');
  assert.equal(h.store.getState().nativeLabelFeed.nextCursor, '4');
  assert.ok(h.requests.every(request => request.limit <= 100), 'refresh stays within bounded per-request limits');
});

test('refresh removes a confirmed missing membership instead of preserving stale page-two mail', async () => {
  const h = harness(); await openTwoPages(h);
  h.replace(['a', 'b', 'c', 'e'].map(row));
  await h.feed.load({ limit: 2 });
  assert.deepEqual(h.store.getState().messages.map(message => message.entityId), ['a', 'b', 'c', 'e']);
  assert.equal(h.store.getState().selectedMessageId, null);
  assert.equal(h.store.getState().hasMoreMessages, false);
});

test('refresh preserves selected canonical entity when its verified cache locator changes', async () => {
  const h = harness(); await openTwoPages(h);
  h.replace(['a', 'b', 'c', 'd', 'e'].map(id => id === 'd' ? { ...row(id), id: 'cache-d-current', folder: 'Archive' } : row(id)));
  await h.feed.load({ limit: 2 });
  assert.equal(h.store.getState().selectedMessageId, 'cache-d-current');
  assert.equal(h.store.getState().messages.find(message => message.entityId === 'd').folder, 'Archive');
});

test('a new arrival that displaces loaded mail is resolved within bounded lookahead', async () => {
  const h = harness(); await openTwoPages(h);
  h.replace(['new-a', 'new-b', 'new-c', 'new-d', 'new-e', 'a', 'b', 'c', 'd', 'e'].map(row));
  await h.feed.load({ limit: 2 });
  assert.equal(h.store.getState().selectedMessageId, 'cache-d');
  assert.equal(h.store.getState().nativeLabelFeed.status, 'ready');
  assert.ok(h.store.getState().messages.some(message => message.entityId === 'd'));
});

test('displacement beyond the extra100-row budget preserves old snapshot as explicit stale error', async () => {
  const h = harness(); await openTwoPages(h);
  h.replace([...Array.from({ length: 150 }, (_, i) => `new-${i}`), 'a', 'b', 'c', 'd', 'e'].map(row));
  const before = h.requests.length;
  await h.feed.load({ limit: 2 });
  assert.deepEqual(h.store.getState().messages.map(message => message.entityId), ['a', 'b', 'c', 'd']);
  assert.equal(h.store.getState().nativeLabelFeed.status, 'error');
  assert.match(h.store.getState().nativeLabelFeed.error, /loaded window|previous list/i);
  assert.ok(h.requests.length - before <= 3, 'two loaded-window pages plus one lookahead request');
});

test('a failed second refresh page does not partially replace the loaded snapshot', async () => {
  const h = harness(); await openTwoPages(h);
  const original = h.api.getNativeLabelMessages;
  let requests = 0;
  h.api.getNativeLabelMessages = async (...args) => { if (++requests === 2) throw new Error('Second page unavailable'); return original(...args); };
  await h.feed.load({ limit: 2 });
  assert.deepEqual(h.store.getState().messages.map(message => message.entityId), ['a', 'b', 'c', 'd']);
  assert.equal(h.store.getState().nativeLabelFeed.status, 'error');
  assert.match(h.store.getState().nativeLabelFeed.error, /Second page unavailable/);
});

test('reader selection made during refresh wins over the originally selected message', async () => {
  const h = harness(); await openTwoPages(h);
  const original = h.api.getNativeLabelMessages;
  let finish;
  h.api.getNativeLabelMessages = async (...args) => { if (!args[1].cursor) await new Promise(resolve => { finish = resolve; }); return original(...args); };
  const refresh = h.feed.load({ limit: 2 });
  h.store.setState({ selectedMessageId: 'cache-b' });
  finish(); await refresh;
  assert.equal(h.store.getState().selectedMessageId, 'cache-b');
});

test('changing account generation during replay prevents every late page from applying', async () => {
  const h = harness(); await openTwoPages(h);
  const original = h.api.getNativeLabelMessages;
  let finish;
  h.api.getNativeLabelMessages = async (...args) => { if (args[1].cursor === '2') await new Promise(resolve => { finish = resolve; }); return original(...args); };
  const refresh = h.feed.load({ limit: 2 });
  while (!finish) await Promise.resolve();
  h.store.setState({ activeLabel: { ...view, storageGeneration: 'replacement' }, messages: [row('replacement')], selectedMessageId: 'cache-replacement' });
  finish(); await refresh;
  assert.deepEqual(h.store.getState().messages.map(message => message.entityId), ['replacement']);
  assert.equal(h.store.getState().selectedMessageId, 'cache-replacement');
});

test('short continuing pages cannot turn a bounded refresh into unbounded requests', async () => {
  const h = harness(); await openTwoPages(h);
  let calls = 0;
  h.api.getNativeLabelMessages = async () => {
    if (++calls > 6) throw new Error('Test stop: request budget exceeded');
    return { ...view, messages: [], nextCursor: `empty-${calls}`, total: 100 };
  };
  await h.feed.load({ limit: 2 });
  assert.ok(calls <= 3, `expected at most3 bounded page requests, received${calls}`);
  assert.equal(h.store.getState().nativeLabelFeed.status, 'error');
  assert.deepEqual(h.store.getState().messages.map(message => message.entityId), ['a', 'b', 'c', 'd']);
});

test('an unread filter reset supersedes the in-flight unfiltered refresh', async () => {
  const h = harness(); await openTwoPages(h);
  let finish;
  const original = h.api.getNativeLabelMessages;
  h.api.getNativeLabelMessages = async (label, params) => {
    if (!params.unreadOnly) await new Promise(resolve => { finish = resolve; });
    if (params.unreadOnly) return { ...view, messages: ['b', 'd'].map(row), nextCursor: null, total: 2 };
    return original(label, params);
  };
  const old = h.feed.load({ limit: 2 });
  await h.feed.load({ limit: 2, unreadOnly: true, reset: true });
  finish(); await old;
  assert.deepEqual(h.store.getState().messages.map(message => message.entityId), ['b', 'd']);
  assert.equal(h.store.getState().nativeLabelFeed.unreadOnly, true);
  assert.equal(h.store.getState().selectedMessageId, 'cache-d');
});
