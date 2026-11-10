import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNativeLabelFeed } from './nativeLabelFeed.js';
import { labelViewKey, labelViewUrl, parseLabelView } from './nativeLabelNavigation.js';
const view = { accountId: 'account', storageGeneration: 'generation', labelId: 'label' };
const row = (entityId, id = entityId) => ({ entityId, id, account_id: view.accountId, storageGeneration: view.storageGeneration, folder: 'Real/Inbox', message_id: '<same-header>' });
const response = (messages = [], nextCursor = null) => ({ ...view, messages, nextCursor, total: 3, coverage: { kind: 'synchronized-cache', unresolvedMemberships: 0 } });
function harness(getNativeLabelMessages) {
  let state = { activeLabel: view, user: { id: 'user' }, messages: [], selectedMessageId: null };
  const store = { getState: () => state, setState: update => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) }; } };
  return { store, feed: createNativeLabelFeed({ api: { getNativeLabelMessages }, store }) };
}
test('label URLs preserve account/generation identity and malformed routes fail closed', () => {
  assert.deepEqual(parseLabelView(labelViewUrl(view).slice(1)), view);
  assert.equal(parseLabelView('#label/a/g/%'), null);
  assert.notEqual(labelViewKey(view), labelViewKey({ ...view, storageGeneration: 'next' }));
});
test('cursor pagination deduplicates canonical entities, never identical headers, and caps request size', async () => {
  const calls = [];
  const { feed, store } = harness(async (label, params) => { calls.push([label, params]); return calls.length === 1 ? response([row('a'), row('b')], 'cursor') : response([row('b'), row('c')]); });
  await feed.load({ limit: 999 });
  assert.equal(calls[0][1].limit, 100);
  assert.equal(store.getState().messages.length, 2);
  await feed.load({ append: true });
  assert.equal(calls[1][1].cursor, 'cursor');
  assert.deepEqual(store.getState().messages.map(m => m.entityId), ['a', 'b', 'c']);
  assert.equal(store.getState().hasMoreMessages, false);
  await feed.load({ append: true });
  assert.equal(calls.length, 2);
});
test('late account/generation and superseded requests cannot replace a new view', async () => {
  let resolve;
  const { feed, store } = harness(() => new Promise(done => { resolve = done; }));
  const pending = feed.load();
  store.setState({ activeLabel: { ...view, storageGeneration: 'replacement' }, messages: [row('new')] });
  resolve(response([row('old')])); await pending;
  assert.equal(store.getState().messages[0].id, 'new');
});
test('latest response wins when a refresh supersedes an older page', async () => {
  const resolve = [];
  const { feed, store } = harness(() => new Promise(done => resolve.push(done)));
  const first = feed.load(); const second = feed.load();
  resolve[1](response([row('new')])); await second;
  resolve[0](response([row('old')])); await first;
  assert.equal(store.getState().messages[0].id, 'new');
});
test('empty and failure remain distinct, last removal clears selection, unresolved coverage survives', async () => {
  let result = response([row('a')]);
  const { feed, store } = harness(async () => { if (result instanceof Error) throw result; return result; });
  await feed.load(); store.setState({ selectedMessageId: 'a' });
  result = { ...response(), coverage: { kind: 'synchronized-cache', unresolvedMemberships: 2 } };
  await feed.load();
  assert.equal(store.getState().selectedMessageId, null);
  assert.equal(store.getState().nativeLabelFeed.status, 'ready');
  assert.equal(store.getState().nativeLabelFeed.coverage.unresolvedMemberships, 2);
  result = new Error('Network unavailable'); await feed.load();
  assert.equal(store.getState().nativeLabelFeed.status, 'error');
  assert.equal(store.getState().nativeLabelFeed.error, 'Network unavailable');
});
test('a mislabeled response is an error, not an empty feed', async () => {
  const { feed, store } = harness(async () => ({ ...response(), storageGeneration: 'other' }));
  await feed.load(); assert.equal(store.getState().nativeLabelFeed.status, 'error');
});


test('feed identity errors and unavailable-label notifications use the injected translator', async () => {
  const { store } = harness(async () => response());
  const translate = key => `localized:${key}`;
  const feed = createNativeLabelFeed({ api: { getNativeLabelMessages: async () => ({ ...response(), storageGeneration: 'wrong' }) }, store, translate });
  await feed.load();
  assert.equal(store.getState().nativeLabelFeed.error, 'localized:gmail.labelNavigation.wrongMailbox');
  let notification;
  store.setState({ setSelectedAccount: () => {}, addNotification: value => { notification = value; } });
  const unavailable = createNativeLabelFeed({ api: { getNativeLabelMessages: async () => { throw Object.assign(new Error(), { status: 404 }); } }, store, translate });
  await unavailable.load();
  assert.equal(notification.title, 'localized:gmail.labelNavigation.unavailable');
});
