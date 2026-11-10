import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) return { format: 'module', shortCircuit: true, source: 'export const useTranslation = () => ({ t: (key, fallback) => typeof fallback === "string" ? fallback : fallback?.defaultValue?.replace(/{{(\\w+)}}/g, (_, name) => fallback[name]) || key }); export const initReactI18next = {type: "3rdParty", init() {}};' };
    if (url.endsWith('/components/ProfileModal.jsx')) return { format: 'module', shortCircuit: true, source: 'import React from "react"; export default function ProfileModal({onClose}) { return React.createElement("div", {role:"dialog", "aria-label":"Native profile"}, React.createElement("button", {onClick:onClose}, "Close profile")); }' };
    if (url.endsWith('/components/GmailSettings.jsx')) return { format: 'module', shortCircuit: true, source: 'import React from "react"; export default function GmailSettings({onClose, initialAccountId, initialTab, initialCreateLabel}) { return React.createElement("div", {role:"dialog", "aria-label":"Settings", "data-account":initialAccountId, "data-tab":initialTab, "data-create":String(!!initialCreateLabel)}, React.createElement("input", {defaultValue:"unsaved draft", "aria-label":"Draft"}), React.createElement("button", {onClick:onClose}, "Close settings")); }' };
    if (url.endsWith('.json')) return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    if (url.endsWith('.jsx')) return { format: 'module', shortCircuit: true, source: transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url }).code };
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
    }
    return nextLoad(url, context);
  },
});
const dom = new JSDOM('<div id="root"></div><button id="outside">Outside</button>', { url: 'https://mail.example.invalid/', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, CustomEvent: dom.window.CustomEvent, Event: dom.window.Event, Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const GmailQuickSettings = (await import('./GmailQuickSettings.jsx')).default;
const originals = { getRules: api.getRules, deleteRule: api.deleteRule, setPageSize: useStore.getState().setPageSize, setGmailDensity: useStore.getState().setGmailDensity };
let root, rules, calls, closed, shortcuts;
const button = text => [...document.querySelectorAll('button')].find(el => el.textContent === text || el.getAttribute('aria-label') === text);
const click = async el => { assert.ok(el, 'Expected button'); await React.act(async () => { el.focus(); el.click(); }); };
const change = (el, value) => React.act(async () => {
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
});
const press = (el, key) => React.act(async () => el.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
const fixture = (id = 'r1') => ({ id, name: 'Work updates', enabled: true, account_id: 'a2', conditions: [{ field: 'from', operator: 'contains', value: 'team.example' }], actions: [{ type: 'mark_read' }] });
const mount = () => React.act(async () => root.render(React.createElement(GmailQuickSettings, { onClose: () => { closed++; root.render(null); }, onShowShortcutHelp: () => shortcuts++ })));
const removeButton = () => document.querySelector('.mf-gmail-quick-rules button');
beforeEach(() => {
  rules = [fixture()]; calls = []; closed = 0; shortcuts = 0;
  document.documentElement.dataset.mailflowLayout = 'gmail';
  useStore.setState({ user: { id: 'u1' }, isLocked: false, accounts: [{ id: 'a1', name: 'Personal', email_address: 'me@example.com', enabled: true }, { id: 'a2', name: 'Work', email_address: 'me@work.example', enabled: true }], layout: 'gmail', selectedAccountId: 'a1', gmailDensity: 'default', gmailDensitySaveState: 'idle', nativeLabelsRevision: 0, pageSize: 50, scrollMode: 'infinite', theme: 'nord', font: 'system', composing: true, selectedMessageId: 'keep-message',
    setGmailDensity: value => { calls.push(['density', value]); useStore.setState({ gmailDensity: value }); },
    setPageSize: value => { calls.push(['pageSize', value]); useStore.setState({ pageSize: value }); } });
  api.getRules = async () => { calls.push(['getRules']); return rules; };
  api.deleteRule = async id => { calls.push(['deleteRule', id]); rules = rules.filter(rule => rule.id !== id); };
  root = createRoot(document.getElementById('root'));
});
afterEach(async () => {
  await React.act(async () => root.unmount());
  api.getRules = originals.getRules; api.deleteRule = originals.deleteRule;
  useStore.setState({ setPageSize: originals.setPageSize, setGmailDensity: originals.setGmailDensity });
});

test('density and page size call only native setters, with truthful infinite-scroll semantics', async () => {
  await mount();
  assert.equal(document.querySelector('[name="gmail-density"]:checked').value, 'default');
  for (const value of ['comfortable', 'compact', 'default']) await click(document.querySelector(`[name="gmail-density"][value="${value}"]`));
  assert.deepEqual(calls.filter(call => call[0] === 'density'), [['density', 'comfortable'], ['density', 'compact'], ['density', 'default']]);
  assert.match(document.getElementById('mailflow-gmail-quick-settings').textContent, /Default and Comfortable currently use the same row spacing/);
  assert.match(document.getElementById('mailflow-gmail-quick-settings').textContent, /Syncing them to your account requires a connection/);
  const select = document.getElementById('mf-gmail-quick-page-size');
  assert.deepEqual([...select.options].map(option => option.value), ['10', '25', '50', '100']);
  for (const size of [10, 25, 50, 100]) await change(select, String(size));
  assert.deepEqual(calls.filter(call => call[0] === 'pageSize'), [10, 25, 50, 100].map(value => ['pageSize', value]));
  assert.match(document.querySelector('label[for="mf-gmail-quick-page-size"]').textContent, /Messages per load/);
  assert.equal(useStore.getState().scrollMode, 'infinite');
  assert.equal(useStore.getState().theme, 'nord'); assert.equal(useStore.getState().font, 'system'); assert.equal(useStore.getState().layout, 'gmail');
  assert.equal(useStore.getState().composing, true); assert.equal(useStore.getState().selectedMessageId, 'keep-message');
  await React.act(async () => useStore.setState({ scrollMode: 'pages' }));
  assert.match(document.querySelector('label[for="mf-gmail-quick-page-size"]').textContent, /Messages per page/);
});

test('real rules display names, account scope and structured summaries; cancel sends no mutation', async () => {
  rules.push({ ...fixture('r2'), name: 'Every account', account_id: null, enabled: false });
  await mount();
  const list = document.querySelector('.mf-gmail-quick-rules');
  assert.match(list.textContent, /Work updates.*Work · me@work.example.*From contains team.example.*Mark as read/);
  assert.match(list.textContent, /Every account.*All accounts · Disabled/);
  await click(removeButton());
  const confirm = document.querySelector('[role="alertdialog"]');
  assert.match(confirm.textContent, /Delete filter “Work updates” for Work · me@work.example/);
  assert.equal(document.activeElement, button('Cancel'));
  await click(button('Cancel'));
  assert.equal(document.querySelector('[role="alertdialog"]'), null);
  assert.equal(calls.filter(call => call[0] === 'deleteRule').length, 0);
});

test('loading, empty, error and retry states reflect actual rule reads', async () => {
  let resolve; api.getRules = () => new Promise(r => { resolve = r; });
  await mount();
  assert.match(document.querySelector('[role="status"]').textContent, /Loading filters/);
  await React.act(async () => resolve([]));
  assert.match(document.getElementById('mailflow-gmail-quick-settings').textContent, /You have no filters/);
  api.getRules = async () => { throw new Error('network'); };
  await React.act(async () => useStore.setState({ selectedAccountId: 'a2' }));
  assert.match(document.querySelector('[role="alert"]').textContent, /could not be loaded/);
  api.getRules = async () => [fixture()];
  await click(button('Refresh filters'));
  assert.ok(removeButton());
});

test('delete is exact, duplicate guarded and never runs or applies a rule to existing mail', async () => {
  let resolve;
  api.deleteRule = id => { calls.push(['deleteRule', id]); return new Promise(r => { resolve = r; }); };
  await mount(); await click(removeButton());
  const confirm = button('Delete filter');
  await React.act(async () => { confirm.click(); confirm.click(); });
  assert.deepEqual(calls.filter(call => call[0] === 'deleteRule'), [['deleteRule', 'r1']]);
  assert.equal(button('Checking deletion…').disabled, true);
  assert.equal(button('Manage filters').disabled, true);
  await React.act(async () => resolve({}));
  assert.equal(document.querySelector('[role="alertdialog"]'), null);
  assert.equal(removeButton(), null);
  assert.match(document.getElementById('mailflow-gmail-quick-settings').textContent, /Filter deleted. Existing messages were not changed/);
});

test('lost delete response reconciles exact ID without replaying mutation', async () => {
  api.deleteRule = async id => { calls.push(['deleteRule', id]); rules = rules.filter(rule => rule.id !== id); throw new Error('response lost'); };
  await mount(); await click(removeButton()); await click(button('Delete filter'));
  assert.equal(calls.filter(call => call[0] === 'deleteRule').length, 1);
  assert.equal(calls.filter(call => call[0] === 'getRules').length, 2);
  assert.match(document.getElementById('mailflow-gmail-quick-settings').textContent, /no longer exists/);
  assert.equal(removeButton(), null);
});

test('uncertain deletion blocks mutation until a successful read, then requires fresh confirmation', async () => {
  await mount(); await click(removeButton());
  api.deleteRule = async id => { calls.push(['deleteRule', id]); throw new Error('network'); };
  api.getRules = async () => { throw new Error('network'); };
  await click(button('Delete filter'));
  assert.match(document.querySelector('[role="alert"]').textContent, /outcome is unknown/);
  assert.equal(button('Delete filter').disabled, true);
  assert.equal(removeButton().disabled, true);
  await click(button('Delete filter'));
  assert.equal(calls.filter(call => call[0] === 'deleteRule').length, 1);
  api.getRules = async () => rules;
  await click(button('Refresh filters'));
  assert.equal(document.querySelector('[role="alertdialog"]'), null);
  assert.equal(removeButton().disabled, false);
  assert.equal(calls.filter(call => call[0] === 'deleteRule').length, 1);
});

test('confirmed unchanged list after failed deletion is not presented as success', async () => {
  api.deleteRule = async () => { throw new Error('rejected'); };
  await mount(); await click(removeButton()); await click(button('Delete filter'));
  assert.match(document.querySelector('[role="alert"]').textContent, /Deletion was not confirmed/);
  assert.ok(removeButton());
  assert.equal(document.querySelector('[role="alertdialog"]'), null);
});

test('late list responses cannot repopulate a newer account scope', async () => {
  let resolve;
  api.getRules = () => new Promise(r => { resolve = r; });
  await mount();
  api.getRules = async () => [{ ...fixture('r-new'), name: 'Latest rule' }];
  await React.act(async () => useStore.setState({ selectedAccountId: 'a2' }));
  await React.act(async () => resolve([fixture('r-old')]));
  assert.match(document.querySelector('.mf-gmail-quick-rules').textContent, /Latest rule/);
  assert.doesNotMatch(document.querySelector('.mf-gmail-quick-rules').textContent, /Work updates/);
});

test('late delete failure after user transition does not reconcile with the new session', async () => {
  let reject;
  api.deleteRule = id => { calls.push(['deleteRule', id]); return new Promise((_, r) => { reject = r; }); };
  await mount(); await click(removeButton()); await click(button('Delete filter'));
  rules = [{ ...fixture('r-new'), name: 'New user rule' }];
  await React.act(async () => useStore.setState({ user: { id: 'u2' } }));
  const reads = calls.filter(call => call[0] === 'getRules').length;
  await React.act(async () => reject(new Error('late network failure')));
  assert.equal(calls.filter(call => call[0] === 'getRules').length, reads);
  assert.match(document.querySelector('.mf-gmail-quick-rules').textContent, /New user rule/);
  assert.equal(document.querySelector('[role="alert"]'), null);
});

test('drawer controls contain shortcuts, Escape cancels confirmation before dismissing and non-modal Tab can leave', async () => {
  let backgroundKeys = 0;
  const listener = () => backgroundKeys++;
  document.addEventListener('keydown', listener);
  try {
    await mount();
    assert.equal(document.getElementById('mailflow-gmail-quick-settings').getAttribute('aria-modal'), 'false');
    assert.equal(document.activeElement, button('Close quick settings'));
    await press(document.querySelector('[name="gmail-density"]'), 'e');
    assert.equal(backgroundKeys, 0);
    await click(removeButton());
    await press(document.activeElement, 'Escape');
    assert.equal(document.querySelector('[role="alertdialog"]'), null); assert.equal(closed, 0);
    await click(button('View shortcuts')); assert.equal(shortcuts, 1);
    await press(button('Close quick settings'), 'Escape'); assert.equal(closed, 1);
  } finally { document.removeEventListener('keydown', listener); }
});

test('closing a drawer invalidates an in-flight rule read and delete reconciliation', async () => {
  let reject;
  api.deleteRule = id => { calls.push(['deleteRule', id]); return new Promise((_, r) => { reject = r; }); };
  await mount(); await click(removeButton()); await click(button('Delete filter'));
  await click(button('Close quick settings'));
  const reads = calls.filter(call => call[0] === 'getRules').length;
  await React.act(async () => reject(new Error('late')));
  assert.equal(calls.filter(call => call[0] === 'getRules').length, reads);
  assert.equal(document.getElementById('mailflow-gmail-quick-settings'), null);
});

test('density pending and failure remain truthful and retry calls the native queue', async () => {
  const originalRetry = useStore.getState().retryGmailDensitySave;
  try {
    useStore.setState({ gmailDensitySaveState: 'pending', retryGmailDensitySave: () => { calls.push(['retryDensity']); useStore.setState({ gmailDensitySaveState: 'pending' }); } });
    await mount();
    assert.match(document.getElementById('mailflow-gmail-quick-settings').textContent, /Syncing density to your account/);
    await React.act(async () => useStore.setState({ gmailDensitySaveState: 'failed' }));
    assert.match(document.querySelector('[role="alert"]').textContent, /applied on this device, but could not be synced/);
    await click(button('Retry density sync'));
    assert.deepEqual(calls.filter(call => call[0] === 'retryDensity'), [['retryDensity']]);
    assert.equal(button('Retry density sync'), undefined);
    await React.act(async () => useStore.setState({ gmailDensitySaveState: 'saved' }));
    assert.doesNotMatch(document.getElementById('mailflow-gmail-quick-settings').textContent, /Syncing density to your account/);
  } finally { await React.act(async () => useStore.setState({ retryGmailDensitySave: originalRetry })); }
});

test('native label summaries use authoritative paths and explicit reference fallback', async () => {
  rules = [{ ...fixture(), conditions: [{ field: 'native_label', operator: 'has', value: 'label-one' }, { field: 'is_read', operator: 'is_not', value: 'true', semantics: 'search_v1' }], actions: [{ type: 'apply_native_label', value: 'label-one' }, { type: 'remove_native_label', value: 'missing-two' }], nativeLabelReferences: [{ id: 'label-one', path: 'Work/Projects', missing: false }, { id: 'missing-two', path: null, missing: true }] }];
  await mount();
  const text = document.querySelector('.mf-gmail-quick-rules').textContent;
  assert.match(text, /Has label Work\/Projects/);
  assert.match(text, /Apply label: Work\/Projects/);
  assert.match(text, /Remove label: Label reference: missing-two/);
  assert.doesNotMatch(text, /gmail.quick_settings/);
});

test('same-ID account generation change blocks stale confirmation even before React rerenders', async () => {
  await mount(); await click(removeButton());
  const confirm = button('Delete filter');
  await React.act(async () => {
    useStore.setState({ accounts: useStore.getState().accounts.map(account => ({ ...account, storage_generation: 'replacement' })) });
    confirm.click();
  });
  assert.equal(calls.filter(call => call[0] === 'deleteRule').length, 0);
  assert.equal(document.querySelector('[role="alertdialog"]'), null);
});

test('same-user lock and unlock in one tick invalidate pending results and confirmation', async () => {
  let reject;
  api.deleteRule = id => { calls.push(['deleteRule', id]); return new Promise((_, r) => { reject = r; }); };
  await mount(); await click(removeButton()); await click(button('Delete filter'));
  rules = [{ ...fixture('after-unlock'), name: 'After unlock' }];
  await React.act(async () => { useStore.setState({ isLocked: true }); useStore.setState({ isLocked: false }); });
  const reads = calls.filter(call => call[0] === 'getRules').length;
  await React.act(async () => reject(new Error('old locked session')));
  assert.equal(calls.filter(call => call[0] === 'getRules').length, reads);
  assert.match(document.querySelector('.mf-gmail-quick-rules').textContent, /After unlock/);
  assert.equal(document.querySelector('[role="alertdialog"]'), null);
});

const reactProps = element => element[Object.keys(element).find(key => key.startsWith('__reactProps$'))];
for (const dismissal of ['Cancel', 'Escape', 'Close quick settings']) test(`${dismissal} invalidates a retained delete callback and reopening needs new confirmation`, async () => {
  await mount(); await click(removeButton());
  const oldDelete = reactProps(button('Delete filter')).onClick;
  if (dismissal === 'Escape') await press(button('Cancel'), 'Escape');
  else await click(button(dismissal));
  await React.act(async () => oldDelete());
  assert.equal(calls.filter(call => call[0] === 'deleteRule').length, 0);
  if (dismissal === 'Close quick settings') return;
  await click(removeButton());
  await React.act(async () => oldDelete());
  assert.equal(calls.filter(call => call[0] === 'deleteRule').length, 0);
  await click(button('Delete filter'));
  assert.deepEqual(calls.filter(call => call[0] === 'deleteRule'), [['deleteRule', 'r1']]);
});

test('same-tick Cancel invalidates the old submit before React commits dismissal', async () => {
  await mount(); await click(removeButton());
  const oldDelete = reactProps(button('Delete filter')).onClick;
  const confirm = button('Delete filter');
  await React.act(async () => { button('Cancel').click(); oldDelete(); confirm.click(); });
  assert.equal(calls.filter(call => call[0] === 'deleteRule').length, 0);
});
