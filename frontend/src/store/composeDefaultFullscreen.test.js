import { afterEach, test } from 'node:test';
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
api.savePreferencesOnExit = () => {};
afterEach(() => { window.dispatchEvent(new window.Event('pagehide')); api.savePreferencesOnExit = () => {}; });

test('default fullscreen is opt-in, persisted independently, and reloads from local cache', async () => {
  assert.equal(useStore.getState().composeDefaultFullscreen, false);
  useStore.setState({ layout: 'compact', theme: 'dracula', fontSet: 'system' });
  const writes = [];
  api.savePreferencesOnExit = prefs => writes.push(prefs);
  useStore.getState().setComposeDefaultFullscreen(true);
  window.dispatchEvent(new window.Event('pagehide'));
  assert.deepEqual(writes, [{ composeDefaultFullscreen: true }]);
  assert.equal(localStorage.getItem('mailflow_compose_default_fullscreen'), 'true');
  assert.deepEqual(['layout', 'theme', 'fontSet'].map(key => useStore.getState()[key]), ['compact', 'dracula', 'system']);
  const { useStore: reloaded } = await import('./index.js?fullscreen-reload');
  assert.equal(reloaded.getState().composeDefaultFullscreen, true);
});

test('server hydration accepts both boolean values and rejects malformed values', async () => {
  for (const value of [false, true]) {
    api.getPreferences = async () => ({ composeDefaultFullscreen: value, aiActions: [] });
    await useStore.getState().loadPreferences();
    assert.equal(useStore.getState().composeDefaultFullscreen, value);
    assert.equal(localStorage.getItem('mailflow_compose_default_fullscreen'), String(value));
  }
  for (const value of ['false', null, undefined, 1]) {
    api.getPreferences = async () => ({ composeDefaultFullscreen: value, aiActions: [] });
    await useStore.getState().loadPreferences();
    assert.equal(useStore.getState().composeDefaultFullscreen, true);
  }
});

test('a pending hydration cannot overwrite a newer fullscreen preference', async () => {
  let resolve;
  api.getPreferences = () => new Promise(done => { resolve = done; });
  const load = useStore.getState().loadPreferences();
  useStore.getState().setComposeDefaultFullscreen(false);
  resolve({ composeDefaultFullscreen: true, aiActions: [] });
  await load;
  assert.equal(useStore.getState().composeDefaultFullscreen, false);
  assert.equal(localStorage.getItem('mailflow_compose_default_fullscreen'), 'false');
});

test('invalid setter values do not mutate state or save and leaving a user clears the cached choice', () => {
  useStore.getState().setComposeDefaultFullscreen(true);
  window.dispatchEvent(new window.Event('pagehide'));
  const writes = [];
  api.savePreferencesOnExit = prefs => writes.push(prefs);
  useStore.getState().setComposeDefaultFullscreen('false');
  window.dispatchEvent(new window.Event('pagehide'));
  assert.equal(useStore.getState().composeDefaultFullscreen, true);
  assert.deepEqual(writes, []);
  useStore.setState({ user: { id: 'first-user' } });
  useStore.getState().setUser(null);
  assert.equal(useStore.getState().composeDefaultFullscreen, false);
  assert.equal(localStorage.getItem('mailflow_compose_default_fullscreen'), null);
});
