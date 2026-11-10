import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true } : nextLoad(url, context);
} });
const mem = new Map();
globalThis.localStorage = { getItem: key => mem.get(key) ?? null, setItem: (key, value) => mem.set(key, String(value)), removeItem: key => mem.delete(key) };
const { useStore } = await import('./index.js');
globalThis.window = new EventTarget(); window.location = { href: '' };
const { api } = await import('../utils/api.js');
const { createAttachmentSessionScope } = await import('../utils/attachmentActions.js');
const state = () => useStore.getState();
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
beforeEach(() => { useStore.setState({ attachmentSignOutPending: false }); state().setUser(null); state().setLocked(false); state().setUser({ id: 'alice' }); });
afterEach(() => { state().setUser(null); mem.clear(); });

test('signout start synchronously invalidates before network settles and blocks new activations', async () => {
  const wait = deferred(); api.logout = () => wait.promise;
  const scope = createAttachmentSessionScope({ store: useStore, eventTarget: window });
  const epoch = state().attachmentSessionEpoch;
  const signingOut = state().signOut();
  assert.equal(state().attachmentSignOutPending, true); assert.ok(state().attachmentSessionEpoch > epoch);
  assert.equal(state().user.id, 'alice'); assert.equal(scope.current(), false); assert.equal(scope.signal.aborted, true);
  const pending = createAttachmentSessionScope({ store: useStore, eventTarget: window }); assert.equal(pending.current(), false);
  state().setUser({ id: 'alice' });
  assert.equal(createAttachmentSessionScope({ store: useStore, eventTarget: window }).current(), false);
  wait.resolve({ ok: true }); await signingOut;
  assert.equal(state().user, null); assert.equal(state().attachmentSignOutPending, false);
  state().setUser({ id: 'alice' });
  const next = createAttachmentSessionScope({ store: useStore, eventTarget: window }); assert.equal(next.current(), true);
  assert.equal(scope.current(), false); assert.equal(pending.current(), false); next.dispose();
});
test('failed signout still ends old attachment lifetime; pending flag clears only after local signout', async () => {
  const wait = deferred(); api.logout = () => wait.promise;
  const scope = createAttachmentSessionScope({ store: useStore, eventTarget: window }); const signingOut = state().signOut();
  assert.equal(scope.current(), false); assert.equal(state().attachmentSignOutPending, true);
  wait.reject(new Error('offline')); await signingOut;
  assert.equal(state().user, null); assert.equal(state().attachmentSignOutPending, false);
  assert.equal(window.location.href, '/login'); assert.equal(scope.current(), false);
});
test('duplicate signout does not send another logout while pending', async () => {
  const wait = deferred(); let calls = 0; api.logout = () => { calls++; return wait.promise; };
  const signingOut = state().signOut(); const duplicate = state().signOut();
  wait.resolve({ ok: true }); await Promise.all([signingOut, duplicate]); assert.equal(calls, 1);
});
test('auth epoch changes on null-to-same-user round trip but not ordinary user refresh', () => {
  const epoch = state().attachmentSessionEpoch; state().setUser({ id: 'alice', display_name: 'Alice' });
  assert.equal(state().attachmentSessionEpoch, epoch);
  state().setUser(null); state().setUser({ id: 'alice' }); assert.ok(state().attachmentSessionEpoch > epoch);
  assert.ok(![...mem.keys()].some(key => /attachment.*(?:session|signout)/i.test(key)));
});
