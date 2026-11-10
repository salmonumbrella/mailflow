import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';

registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.json')) return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
  return nextLoad(url, context);
} });
const dom = new JSDOM('', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent });
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const { useStore } = await import('./index.js');
const { api } = await import('../utils/api.js');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
const state = () => useStore.getState();
const flush = () => window.dispatchEvent(new window.Event('pagehide'));

beforeEach(async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  localStorage.clear();
  state().setUser(null);
  state().setLocked(false);
  state().setUser({ id: 'user-a' });
  api.getPreferences = async () => ({ aiActions: [] });
  api.getGmailDensity = async () => ({ gmailDensity: 'default', gmailDensityRevision: 0 });
  api.saveGmailDensity = async body => ({ ok: true, gmailDensity: body.gmailDensity, gmailDensityRevision: body.expectedRevision + 1 });
  await state().loadPreferences();
});
afterEach(async () => { state().setUser(null); await settle(); mock.timers.reset(); });

test('density defaults to default, persists only its key, and leaves presentation/mail state alone', async () => {
  assert.equal(state().gmailDensity, 'default');
  const preserved = { layout: 'gmail', theme: 'dracula', fontSet: 'system', pageSize: 50,
    messages: [{ id: 'mail' }], selectedMessageId: 'mail', composing: true,
    composeData: { body: 'draft' }, gtdSections: { todo: [] }, activeGtdTab: 'todo' };
  useStore.setState(preserved);
  const writes = [];
  api.saveGmailDensity = async prefs => { writes.push(prefs); return { ok: true, gmailDensity: prefs.gmailDensity, gmailDensityRevision: prefs.expectedRevision + 1 }; };
  for (const value of ['comfortable', 'compact', 'default']) state().setGmailDensity(value);
  flush();
  await settle();
  assert.deepEqual(writes, [{ gmailDensity: 'default', expectedRevision: 0 }]);
  assert.equal(localStorage.getItem('mailflow_gmail_density'), 'default');
  assert.equal(document.documentElement.dataset.gmailDensity, 'default');
  for (const [key, value] of Object.entries(preserved)) assert.equal(state()[key], value, key);
});

test('invalid choices never mutate state or queue writes', () => {
  const writes = [];
  api.saveGmailDensity = prefs => writes.push(prefs);
  for (const value of [undefined, null, {}, [], 1, 'dense', 'COMPACT', ' compact ']) {
    assert.equal(state().setGmailDensity(value), false);
  }
  flush();
  assert.equal(state().gmailDensity, 'default');
  assert.deepEqual(writes, []);
});

test('server hydration normalizes missing and malformed values and accepts each density', async () => {
  for (const value of ['default', 'comfortable', 'compact', null, undefined, {}, 'invalid']) {
    api.getPreferences = async () => ({ gmailDensity: value, aiActions: [] });
    await state().loadPreferences();
    const expected = ['default', 'comfortable', 'compact'].includes(value) ? value : 'default';
    assert.equal(state().gmailDensity, expected);
    assert.equal(localStorage.getItem('mailflow_gmail_density'), expected);
    assert.equal(document.documentElement.dataset.gmailDensity, expected);
  }
});

test('a delayed GET cannot overwrite a newer local choice, including a completed save', async () => {
  const get = deferred();
  api.getPreferences = () => get.promise;
  const loading = state().loadPreferences();
  state().setGmailDensity('compact');
  flush();
  await settle();
  get.resolve({ gmailDensity: 'comfortable', aiActions: [] });
  await loading;
  assert.equal(state().gmailDensity, 'compact');
  assert.equal(localStorage.getItem('mailflow_gmail_density'), 'compact');
});

test('a GET started after a local pending choice cannot revert or lose that choice', async () => {
  state().setGmailDensity('compact');
  api.getPreferences = async () => ({ gmailDensity: 'comfortable', aiActions: [] });
  await state().loadPreferences();
  assert.equal(state().gmailDensity, 'compact');
  const writes = [];
  api.saveGmailDensity = prefs => { writes.push(prefs); return Promise.resolve({ ok: true, gmailDensity: prefs.gmailDensity, gmailDensityRevision: prefs.expectedRevision + 1 }); };
  flush();
  await settle();
  assert.deepEqual(writes, [{ gmailDensity: 'compact', expectedRevision: 0 }]);
});

test('newer density hydration wins over an older GET', async () => {
  const old = deferred();
  api.getPreferences = () => old.promise;
  const loading = state().loadPreferences();
  api.getPreferences = async () => ({ gmailDensity: 'compact', aiActions: [] });
  await state().loadPreferences();
  old.resolve({ gmailDensity: 'comfortable', aiActions: [] });
  await loading;
  assert.equal(state().gmailDensity, 'compact');
});

test('a different user and same-user logout/login invalidate old loads and queued writes', async () => {
  const get = deferred();
  api.getPreferences = () => get.promise;
  const loading = state().loadPreferences();
  state().setGmailDensity('compact');
  state().setUser(null);
  state().setUser({ id: 'user-a' });
  get.resolve({ gmailDensity: 'comfortable', aiActions: [] });
  await loading;
  const writes = [];
  api.saveGmailDensity = prefs => writes.push(prefs);
  flush();
  assert.equal(state().gmailDensity, 'default');
  assert.deepEqual(writes, []);
  state().setGmailDensity('comfortable');
  state().setUser({ id: 'user-b' });
  api.getPreferences = async () => ({ aiActions: [] });
  await state().loadPreferences();
  assert.equal(state().gmailDensity, 'default');
  assert.equal(localStorage.getItem('mailflow_gmail_density'), 'default');
});

test('lock/unlock fences a delayed load, cancels queued writes while locked, and keeps the local choice', async () => {
  const get = deferred();
  api.getPreferences = () => get.promise;
  const loading = state().loadPreferences();
  state().setGmailDensity('compact');
  state().setLocked(true);
  const writes = [];
  api.saveGmailDensity = async prefs => { writes.push(prefs); return { ok: true, gmailDensity: prefs.gmailDensity, gmailDensityRevision: prefs.expectedRevision + 1 }; };
  flush();
  assert.deepEqual(writes, []);
  assert.equal(state().setGmailDensity('comfortable'), false);
  state().setLocked(false);
  get.resolve({ gmailDensity: 'comfortable', aiActions: [] });
  await loading;
  assert.equal(state().gmailDensity, 'compact');
  flush();
  await settle();
  assert.deepEqual(writes, [{ gmailDensity: 'compact', expectedRevision: 0 }]);
});

test('rapid saves are serialized and coalesced; an older completion cannot acknowledge a newer choice', async () => {
  const first = deferred();
  const second = deferred();
  const writes = [];
  api.saveGmailDensity = prefs => { writes.push(prefs); return writes.length === 1 ? first.promise : second.promise; };
  state().setGmailDensity('comfortable');
  mock.timers.tick(1000);
  state().setGmailDensity('default');
  state().setGmailDensity('compact');
  mock.timers.tick(1000);
  assert.deepEqual(writes, [{ gmailDensity: 'comfortable', expectedRevision: 0 }]);
  first.resolve({ ok: true, gmailDensity: 'comfortable', gmailDensityRevision: 1 });
  await settle();
  assert.deepEqual(writes, [{ gmailDensity: 'comfortable', expectedRevision: 0 }, { gmailDensity: 'compact', expectedRevision: 0 }]);
  assert.equal(state().gmailDensitySaveState, 'pending');
  second.resolve({ ok: true, gmailDensity: 'compact', gmailDensityRevision: 1 });
  await settle();
  assert.equal(state().gmailDensitySaveState, 'saved');
});

test('failed writes remain locally applied and can be retried; HTTP exit failures are not success', async () => {
  const errors = mock.method(console, 'error', () => {});
  try {
    api.saveGmailDensity = async () => ({ ok: false, status: 503 });
    state().setGmailDensity('compact');
    flush();
    await settle();
    assert.equal(state().gmailDensity, 'compact');
    assert.equal(state().gmailDensitySaveState, 'failed');
    api.getPreferences = async () => ({ gmailDensity: 'comfortable', aiActions: [] });
    await state().loadPreferences();
    assert.equal(state().gmailDensity, 'compact');
    const writes = [];
    api.saveGmailDensity = async prefs => { writes.push(prefs); return { ok: true, gmailDensity: prefs.gmailDensity, gmailDensityRevision: prefs.expectedRevision + 1 }; };
    state().retryGmailDensitySave();
    flush();
    await settle();
    assert.deepEqual(writes, [{ gmailDensity: 'compact', expectedRevision: 0 }]);
    assert.equal(state().gmailDensitySaveState, 'saved');
  } finally { errors.mock.restore(); }
});

test('a reload retains the same user pending choice but never adopts another user cache', async () => {
  state().setGmailDensity('compact');
  const { useStore: reload } = await import('./index.js?gmail-density-reload');
  assert.equal(reload.getState().gmailDensity, 'compact');
  reload.getState().setUser({ id: 'user-a' });
  api.getPreferences = async () => ({ gmailDensity: 'comfortable', aiActions: [] });
  await reload.getState().loadPreferences();
  assert.equal(reload.getState().gmailDensity, 'compact');
  reload.getState().setUser(null);
  reload.getState().setUser({ id: 'user-b' });
  await reload.getState().loadPreferences();
  assert.equal(reload.getState().gmailDensity, 'comfortable');
  reload.getState().setUser(null);
});

test('a GET started during a pending write stays fenced when that write finishes before the GET', async () => {
  const get = deferred();
  state().setGmailDensity('compact');
  api.getPreferences = () => get.promise;
  const loading = state().loadPreferences();
  flush();
  await settle();
  assert.equal(state().gmailDensitySaveState, 'saved');
  get.resolve({ gmailDensity: 'default', aiActions: [] });
  await loading;
  assert.equal(state().gmailDensity, 'compact');
});

test('late failure/success after user or lock transitions cannot change current save state', async () => {
  for (const transition of ['user', 'lock']) {
    const save = deferred();
    api.saveGmailDensity = () => save.promise;
    state().setGmailDensity('compact');
    mock.timers.tick(1000);
    await settle();
    if (transition === 'user') state().setUser({ id: 'user-b' });
    else state().setLocked(true);
    const previous = state().gmailDensitySaveState;
    save.reject(new Error('old session response'));
    await settle();
    assert.equal(state().gmailDensitySaveState, previous);
    if (transition === 'lock') state().setLocked(false);
  }
});

test('a cold login with pending density resumes saving even when preference hydration fails', async () => {
  state().setGmailDensity('compact');
  const { useStore: reload } = await import('./index.js?gmail-density-recover-offline-get');
  reload.getState().setUser({ id: 'user-a' });
  api.getPreferences = async () => { throw new Error('GET failed'); };
  await reload.getState().loadPreferences();
  const writes = [];
  api.saveGmailDensity = async prefs => { writes.push(prefs); return { ok: true, gmailDensity: prefs.gmailDensity, gmailDensityRevision: prefs.expectedRevision + 1 }; };
  mock.timers.tick(1000);
  await settle();
  assert.equal(reload.getState().gmailDensity, 'compact');
  assert.equal(writes.some(prefs => prefs.gmailDensity === 'compact'), true);
  reload.getState().setUser(null);
});
