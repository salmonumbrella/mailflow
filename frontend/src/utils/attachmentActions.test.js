import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAttachmentActionScope, createAttachmentSessionScope, downloadAttachmentBytes } from './attachmentActions.js';

const source = { messageId: '11111111-1111-4111-8111-111111111111', accountId: '22222222-2222-4222-8222-222222222222', storageGeneration: '33333333-3333-4333-8333-333333333333', entityId: '44444444-4444-4444-8444-444444444444', folder: 'INBOX', uidValidity: '1', uid: '42' };
const initial = () => ({ user: { id: 'user' }, isLocked: false, attachmentSessionEpoch: 1, attachmentSignOutPending: false, accounts: [{ id: source.accountId, user_id: 'user', enabled: true, storage_generation: source.storageGeneration }], locator: 'same', nav: 'inbox' });
function setup(options = {}) {
  let state = initial(); const listeners = new Set(); const events = new EventTarget(); let invalidations = 0;
  const store = { getState: () => state, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, setState(patch) { state = { ...state, ...patch }; for (const fn of [...listeners]) fn(state); } };
  const scope = createAttachmentActionScope({ store, source, sourceCurrent: s => s.locator === 'same', scopeKey: s => s.nav, onInvalidate: () => invalidations++, eventTarget: events, ...options });
  return { scope, store, events, listeners, invalidations: () => invalidations };
}
for (const [name, change] of [
  ['user to null', { user: null }], ['another user', { user: { id: 'other' } }], ['lock', { isLocked: true }],
  ['session epoch', { attachmentSessionEpoch: 2 }], ['pending signout', { attachmentSignOutPending: true }],
  ['missing account', { accounts: [] }], ['disabled account', { accounts: [{ ...initial().accounts[0], enabled: false }] }],
  ['account generation', { accounts: [{ ...initial().accounts[0], storage_generation: source.entityId }] }],
  ['account owner', { accounts: [{ ...initial().accounts[0], user_id: 'other' }] }],
  ['source replacement', { locator: 'other' }], ['navigation', { nav: 'sent' }],
]) test(`sticky invalidation on synchronous ${name} round trip`, () => {
  const { scope, store, invalidations } = setup(); const original = store.getState();
  store.setState(change); store.setState(original);
  assert.equal(scope.current(), false); assert.equal(scope.signal.aborted, true); assert.equal(invalidations(), 1);
});
test('same-source flag/metadata refresh and unchanged native alias do not close guard', () => {
  const { scope, store } = setup(); store.setState({ is_read: true, entityId: 'canonical alias', accounts: initial().accounts.map(a => ({ ...a })) });
  assert.equal(scope.current(), true); scope.dispose();
});
for (const type of ['mailflow:will-lock', 'pagehide', 'popstate']) test(`${type} closes synchronously and removes subscriptions`, () => {
  const { scope, events, listeners } = setup(); events.dispatchEvent(new Event(type));
  assert.equal(scope.current(), false); assert.equal(listeners.size, 0);
});
test('child operations abort independently and parent revokes every remaining URL immediately', () => {
  const oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL; const revoked = []; let next = 0;
  URL.createObjectURL = () => `blob:${++next}`; URL.revokeObjectURL = url => revoked.push(url);
  try {
    const { scope } = setup(); const a = scope.fork(), b = scope.fork();
    assert.equal(a.createObjectURL(new Blob(['a'])), 'blob:1'); assert.equal(b.createObjectURL(new Blob(['b'])), 'blob:2');
    a.dispose(); assert.equal(b.current(), true); assert.deepEqual(revoked, ['blob:1']);
    scope.dispose(); assert.equal(b.current(), false); assert.deepEqual(revoked, ['blob:1', 'blob:2']);
    assert.throws(() => b.createObjectURL(new Blob(['c'])), { name: 'AbortError' }); assert.equal(next, 2);
  } finally { URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke; }
});
test('a source-less guarded scope never silently becomes a legacy scope', () => {
  const { scope } = setup({ source: null }); assert.equal(scope.current(), false);
  const { scope: missingOwner } = setup({ sourceCurrent: undefined }); assert.equal(missingOwner.current(), false);
});
test('explicit legacy scope retains only honest session/owner protection', () => {
  const { store, scope: other } = setup(); other.dispose();
  const scope = createAttachmentSessionScope({ store, eventTarget: new EventTarget() });
  assert.equal(scope.current(), true); store.setState({ attachmentSignOutPending: true }); assert.equal(scope.current(), false);
});
test('download checks again after anchor append, and revokes URL without a click if owner ends there', () => {
  const { scope } = setup(); const oldDocument = globalThis.document; const oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL;
  let clicks = 0, removes = 0; const revoked = [];
  URL.createObjectURL = () => 'blob:download'; URL.revokeObjectURL = url => revoked.push(url);
  globalThis.document = { createElement: () => ({ click() { clicks++; }, remove() { removes++; } }), body: { appendChild() { scope.dispose(); } } };
  try {
    assert.equal(downloadAttachmentBytes(scope, new Uint8Array([1]), 'real.pdf', 'application/pdf'), false);
    assert.equal(clicks, 0); assert.equal(removes, 1); assert.deepEqual(revoked, ['blob:download']);
  } finally { globalThis.document = oldDocument; URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke; }
});
test('download uses exact bytes/name and owned URL; a close revokes the delayed URL', () => {
  const { scope } = setup(); const oldDocument = globalThis.document; const oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL;
  let clicks = 0; let blob; const anchor = { click() { clicks++; }, remove() {} }; const revoked = [];
  URL.createObjectURL = value => { blob = value; return 'blob:ok'; }; URL.revokeObjectURL = url => revoked.push(url);
  globalThis.document = { createElement: () => anchor, body: { appendChild() {} } };
  try {
    assert.equal(downloadAttachmentBytes(scope, new Uint8Array([1, 2]), 'real.pdf', 'application/pdf'), true);
    assert.equal(clicks, 1); assert.equal(blob.size, 2); assert.equal(anchor.download, 'real.pdf');
    scope.dispose(); assert.deepEqual(revoked, ['blob:ok']);
  } finally { globalThis.document = oldDocument; URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke; }
});

test('a synchronous earlier subscriber cannot hide an account round trip from the guard', () => {
  let state = initial(); const listeners = new Set();
  const store = { getState: () => state, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, setState(patch) {
    const previous = state; state = { ...state, ...patch }; listeners.forEach(fn => fn(state, previous));
  } };
  store.subscribe(next => { if (!next.accounts.length) store.setState({ accounts: initial().accounts }); });
  const scope = createAttachmentActionScope({ store, source, sourceCurrent: () => true, eventTarget: new EventTarget() });
  store.setState({ accounts: [] });
  assert.equal(state.accounts.length, 1); assert.equal(scope.current(), false); assert.equal(scope.signal.aborted, true);
});

test('URL creation that ends the lifetime revokes its result without publishing it', () => {
  const { scope } = setup(); const oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL; const revoked = [];
  URL.createObjectURL = () => { scope.dispose(); return 'blob:late'; }; URL.revokeObjectURL = url => revoked.push(url);
  try { assert.throws(() => scope.createObjectURL(new Blob(['late'])), { name: 'AbortError' }); assert.deepEqual(revoked, ['blob:late']); }
  finally { URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke; }
});
