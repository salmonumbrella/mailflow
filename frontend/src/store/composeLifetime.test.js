import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true } : nextLoad(url, context);
} });
const memory = new Map();
globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, String(value)), removeItem: key => memory.delete(key) };
const { useStore } = await import('./index.js');
const { api } = await import('../utils/api.js');
globalThis.window = new EventTarget(); window.location = { href: '' };
const state = () => useStore.getState();
const source = Object.freeze({ messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', accountId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  storageGeneration: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', entityId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  folder: 'Drafts', uidValidity: '42', uid: '5' });
beforeEach(() => {
  useStore.setState({ composeSignOutPending: false, attachmentSignOutPending: false, isLocked: false,
    composing: false, composeData: null, prepareComposeSwitch: null });
  state().setUser(null); state().setUser({ id: 'owner' });
});

test('signout begins a new auth and composer lifetime before logout resolves', async () => {
  const original = api.logout; let finish;
  api.logout = () => new Promise(resolve => { finish = resolve; });
  state().openCompose({ body: 'Private text', draftSource: source });
  const before = state(); const signingOut = state().signOut();
  try {
    assert.ok(state().composeSession > before.composeSession);
    assert.ok(state().composeAuthEpoch > before.composeAuthEpoch);
    assert.equal(state().composeSignOutPending, true);
    assert.equal(state().openCompose({ body: 'Late callback' }), false);
    state().updateComposePersistedKey(before.composeSession, 'late', { draftSource: null });
    assert.deepEqual(state().composeData.draftSource, source);
  } finally { finish({ ok: true }); await signingOut; api.logout = original; }
  assert.equal(state().composeSignOutPending, false);
});

test('lock advances only mounted lifetime and old receipt cannot write after unlock', () => {
  const data = { body: 'Current unsaved text', draftSource: source };
  state().openCompose(data);
  const { composeSession, composeAuthEpoch } = state();
  state().setLocked(true);
  assert.ok(state().composeSession > composeSession);
  assert.equal(state().composeAuthEpoch, composeAuthEpoch, 'same-user deferred Undo remains owned');
  assert.equal(state().openCompose({ body: 'Wrong while locked' }), false);
  state().setLocked(false);
  state().updateComposePersistedKey(composeSession, 'old receipt', { draftSource: null });
  assert.deepEqual(state().composeData, data);
});

test('unrelated same-user composer changes do not change auth ownership', () => {
  state().openCompose({ body: 'First' });
  const { composeSession, composeAuthEpoch } = state();
  state().closeCompose(); state().openCompose({ body: 'Second' });
  assert.ok(state().composeSession > composeSession);
  assert.equal(state().composeAuthEpoch, composeAuthEpoch);
  state().setUser(null); state().setUser({ id: 'owner' });
  assert.ok(state().composeAuthEpoch > composeAuthEpoch, 'same-user login after signout is a new owner lifetime');
});
