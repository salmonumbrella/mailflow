import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent,
});
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const { useStore } = await import('./index.js');
const { api } = await import('../utils/api.js');
const { applyLayout, DEFAULT_LAYOUT } = await import('../layouts.js');
const originalApi = { getPreferences: api.getPreferences, savePreferencesOnExit: api.savePreferencesOnExit };

// Flush through the actual page-exit listener instead of leaving debounce timers or network
// writes behind. Each test gets its own spy when it needs to inspect the payload.
api.savePreferencesOnExit = () => {};
api.getGmailDensity = async () => ({ gmailDensity: 'default', gmailDensityRevision: 0 });
api.saveGmailDensity = async ({ gmailDensity, expectedRevision }) => ({ ok: true, gmailDensity, gmailDensityRevision: expectedRevision + 1 });
const settleDensity = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
afterEach(() => {
  window.dispatchEvent(new window.Event('pagehide'));
  api.getPreferences = originalApi.getPreferences;
  api.savePreferencesOnExit = () => {};
});

test('Gmail presentation is opt-in on a fresh browser', () => {
  assert.equal(DEFAULT_LAYOUT, 'comfortable');
  assert.equal(useStore.getState().layout, 'comfortable');
  assert.equal(localStorage.getItem('mailflow_layout'), null);
});

test('switching into and out of Gmail preserves mail, GTD, compose, and color preferences', () => {
  const messages = [{ id: 'mail-1', is_read: false }];
  const sections = { todo: { threads: [{ id: 'task-1' }] } };
  const draft = { to: 'recipient@example.invalid', subject: 'Unsent draft', body: 'Keep this text' };
  useStore.setState({
    messages, selectedMessageId: 'mail-1', gtdSections: sections, activeGtdTab: 'todo',
    composing: true, composeData: draft, theme: 'dracula', fontSet: 'system',
  });
  localStorage.setItem('mailflow_theme', 'dracula');
  localStorage.setItem('mailflow_list_width', '451');
  const writes = [];
  api.savePreferencesOnExit = prefs => writes.push(prefs);

  for (const layout of ['gmail', 'compact', 'gmail', 'comfortable']) {
    useStore.getState().setLayout(layout);
    const state = useStore.getState();
    assert.equal(state.layout, layout);
    assert.equal(document.documentElement.dataset.mailflowLayout, layout);
    assert.equal(localStorage.getItem('mailflow_layout'), layout);
    assert.equal(state.messages, messages);
    assert.equal(state.selectedMessageId, 'mail-1');
    assert.equal(state.gtdSections, sections);
    assert.equal(state.activeGtdTab, 'todo');
    assert.equal(state.composing, true);
    assert.equal(state.composeData, draft);
    assert.equal(state.theme, 'dracula');
    assert.equal(localStorage.getItem('mailflow_theme'), 'dracula');
  }
  assert.equal(localStorage.getItem('mailflow_list_width'), null);
  assert.equal(document.documentElement.style.getPropertyValue('--list-width'), '360px');
  window.dispatchEvent(new window.Event('pagehide'));
  assert.deepEqual(writes, [{ layout: 'comfortable' }], 'rapid switches persist only the final presentation');
});

test('Gmail selection survives server preference hydration without changing the color theme', async () => {
  useStore.setState({ layout: 'comfortable', theme: 'dark' });
  localStorage.setItem('mailflow_list_width', '499');
  api.getPreferences = async () => ({ layout: 'gmail', aiActions: [] });
  await useStore.getState().loadPreferences();
  assert.equal(useStore.getState().layout, 'gmail');
  assert.equal(useStore.getState().theme, 'dark');
  assert.equal(localStorage.getItem('mailflow_layout'), 'gmail');
  assert.equal(localStorage.getItem('mailflow_list_width'), null);
  assert.equal(document.documentElement.dataset.mailflowLayout, 'gmail');
});

test('an unknown server preset removes Gmail styling and restores the supported default', async () => {
  useStore.setState({ layout: 'gmail' });
  applyLayout('gmail');
  api.getPreferences = async () => ({ layout: 'removed-preset', aiActions: [] });
  await useStore.getState().loadPreferences();
  assert.equal(useStore.getState().layout, 'comfortable');
  assert.equal(localStorage.getItem('mailflow_layout'), 'comfortable');
  assert.equal(document.documentElement.dataset.mailflowLayout, 'comfortable');
  assert.equal(document.documentElement.style.getPropertyValue('--layout-row-py'), '16px');
});

test('Gmail density is independent of every native layout and preserves mail, drafts, GTD, palette and fonts', async () => {
  const messages = [{ id: 'density-message', is_read: false }];
  const sections = { todo: { threads: [{ id: 'density-task' }] } };
  const composeData = { subject: 'Unsent density draft', body: '<p>Keep my text</p>', attachments: [{ name: 'keep.txt' }] };
  const writes = [];
  const densityWrites = [];
  let revision = 0;
  api.saveGmailDensity = async body => { densityWrites.push(body); return { ok: true, gmailDensity: body.gmailDensity, gmailDensityRevision: body.expectedRevision + 1 }; };
  api.savePreferencesOnExit = prefs => writes.push(prefs);
  useStore.setState({
    user: { id: 'density-presentation-user' }, isLocked: false,
    messages, selectedMessageId: 'density-message', gtdSections: sections, activeGtdTab: 'todo',
    composing: true, composeData, theme: 'dracula', fontSet: 'system', fontSize: 150,
  });
  for (const layout of ['gmail', 'focused', 'compact', 'comfortable', 'wide', 'list', 'vertical', 'gmail']) {
    useStore.getState().setLayout(layout);
    window.dispatchEvent(new window.Event('pagehide'));
    writes.length = 0;
    const layoutStyle = document.documentElement.style.cssText;
    for (const density of ['compact', 'comfortable', 'default']) {
      useStore.getState().setGmailDensity(density);
      const state = useStore.getState();
      assert.equal(state.gmailDensity, density);
      assert.equal(document.documentElement.dataset.gmailDensity, density);
      assert.equal(state.layout, layout);
      assert.equal(document.documentElement.dataset.mailflowLayout, layout);
      assert.equal(document.documentElement.style.cssText, layoutStyle, 'density leaves layout and palette variables alone');
      assert.equal(localStorage.getItem('mailflow_layout'), layout);
      assert.equal(state.messages, messages);
      assert.equal(state.selectedMessageId, 'density-message');
      assert.equal(state.gtdSections, sections);
      assert.equal(state.activeGtdTab, 'todo');
      assert.equal(state.composing, true);
      assert.equal(state.composeData, composeData);
      assert.equal(state.theme, 'dracula');
      assert.equal(state.fontSet, 'system');
      assert.equal(state.fontSize, 150, 'the native UI font scaling preference is retained');
    }
    window.dispatchEvent(new window.Event('pagehide'));
    await settleDensity();
    assert.deepEqual(densityWrites.splice(0), [{ gmailDensity: 'default', expectedRevision: revision++ }], 'density persistence sends only its choice and server revision');
    assert.deepEqual(writes, [], 'density persistence cannot write layout or unrelated preferences');
  }
});
