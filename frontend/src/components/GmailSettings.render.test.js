import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) return { format: 'module', shortCircuit: true, source: `
      export const useTranslation = () => ({ t: (key, fallback) => typeof fallback === 'string' ? fallback : key, i18n: { language: 'en', changeLanguage() {} } });
      export const initReactI18next = { type: '3rdParty', init() {} };
      export const Trans = ({ children }) => children ?? null;
      export const I18nextProvider = ({ children }) => children ?? null;
    ` };
    if (url.endsWith('.json')) return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    if (url.endsWith('.jsx')) return { format: 'module', shortCircuit: true, source: transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic' }).code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const source = readFileSync(new URL(url), 'utf8');
      if (source.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: source.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
    }
    return nextLoad(url, context);
  },
});
const dom = new JSDOM('<button id="opener">Open settings</button><div id="root"></div>', { url: 'https://mail.example.invalid/', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Event: dom.window.Event, Node: dom.window.Node,
  Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true, __VITE_ENV__: { MODE: 'test', DEV: false, PROD: true },
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = dom.window.matchMedia;
globalThis.fetch = async () => new Response('{}', { status: 200 });
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const { default: GmailSettings } = await import('./GmailSettings.jsx');
const host = document.getElementById('root');
let root;
let calls;
let closed;
let savedRules;
let folderList;
const account = { id: 'account-one', name: 'Personal', email_address: 'me@example.invalid', signature: '<p>Original signature</p>', signature_enabled: true };
const button = text => [...host.querySelectorAll('button')].find(el => el.textContent === text);
const click = el => act(async () => { assert.ok(el, 'click target exists'); el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
const change = (el, value) => act(async () => {
  assert.ok(el, 'change target exists');
  const prototype = el.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, value);
  el.dispatchEvent(new dom.window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
});
const submit = form => act(async () => { form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
const key = (el, name, props = {}) => act(async () => { el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...props })); });
async function mount() {
  root = createRoot(host);
  await act(async () => { root.render(React.createElement(GmailSettings, { onClose: () => { closed++; root.render(null); } })); });
}
beforeEach(() => {
  calls = []; closed = 0; savedRules = [];
  folderList = [{ path: 'INBOX', name: 'Inbox', total_count: 8 }, { path: 'Projects', name: 'Projects', total_count: 2 }];
  useStore.setState({ user: { id: 'user-one', username: 'Tester' }, accounts: [account], accountsReady: true, selectedAccountId: account.id, selectedFolder: 'INBOX', folders: { [account.id]: folderList }, hiddenFolders: {}, shortcuts: {}, showMessagePreviews: true, replyDefault: 'reply', pageSize: 50, theme: 'nord', font: 'system', layout: 'gmail' });
  api.savePreferences = async data => { calls.push(['preferences', data]); return {}; };
  api.updateAccount = async (id, data) => { calls.push(['signature', id, data]); return { ...account, ...data }; };
  api.getNativeLabels = async () => ({ labels: [], treeRevision: '0', assignmentSupported: false, coverage: 'not_indexed' });
  api.getFolders = async id => { calls.push(['getFolders', id]); return folderList; };
  api.createFolder = async (id, name, parent) => { calls.push(['createFolder', id, name, parent]); folderList = [...folderList, { path: parent ? `${parent}/${name}` : name, name }]; return {}; };
  api.renameFolder = async (id, path, name) => { calls.push(['renameFolder', id, path, name]); folderList = folderList.map(f => f.path === path ? { ...f, path: name, name } : f); return { newPath: name }; };
  api.deleteFolder = async (id, path) => { calls.push(['deleteFolder', id, path]); folderList = folderList.filter(f => f.path !== path); return {}; };
  api.getRules = async () => { calls.push(['getRules']); return savedRules; };
  api.createRule = async data => { calls.push(['createRule', data]); return { id: 'rule-one', ...data, account_id: data.accountId, condition_logic: data.conditionLogic }; };
  api.updateRule = async (id, data) => { calls.push(['updateRule', id, data]); return { id, ...data }; };
  api.deleteRule = async id => { calls.push(['deleteRule', id]); return {}; };
  document.getElementById('opener').focus();
});
afterEach(async () => { if (root) await act(async () => root.unmount()); root = null; useStore.getState().setUser(null); });

test('real settings panel traps focus, supports keyboard tabs, Escape and restores opener', async () => {
  await mount();
  const first = host.querySelector('[aria-label="Close settings"]');
  assert.equal(document.activeElement, first);
  await key(first, 'Tab', { shiftKey: true });
  assert.equal(document.activeElement, button('Back to mail'));
  await key(document.activeElement, 'Tab');
  assert.equal(document.activeElement, first);
  await key(host.querySelector('[role=tab][aria-selected=true]'), 'ArrowRight');
  assert.equal(document.activeElement.textContent, 'Labels');
  assert.equal(host.querySelector('[role=tab][aria-selected=true]').textContent, 'Labels');
  assert.equal(button('Forwarding and POP/IMAP').disabled, true);
  await key(first, 'Escape');
  assert.equal(closed, 1);
  assert.equal(document.activeElement, document.getElementById('opener'));
});

test('Cancel discards snippets, shortcuts, and signature edits without writes', async () => {
  await mount();
  await click(host.querySelectorAll('input[name=snippets]')[1]);
  await click(host.querySelector('input[name=shortcuts]'));
  await click(button('Clear signature'));
  assert.equal(host.querySelector('[contenteditable=true]').innerHTML, '');
  assert.equal(useStore.getState().showMessagePreviews, true);
  await click(button('Cancel'));
  assert.equal(calls.length, 0);
  await act(async () => root.unmount());
  await mount();
  assert.equal(host.querySelector('input[name=snippets]').checked, true);
  assert.equal(host.querySelector('[contenteditable=true]').innerHTML, account.signature);
});

test('save waits for server acknowledgement, persists supported fields and leaves appearance intact', async () => {
  let resolve;
  api.savePreferences = data => { calls.push(['preferences', data]); return new Promise(r => { resolve = r; }); };
  await mount();
  await click(host.querySelectorAll('input[name=snippets]')[1]);
  await change(host.querySelector('[aria-label="Maximum page size"]'), '25');
  await click(button('Save Changes'));
  assert.equal(useStore.getState().showMessagePreviews, true);
  assert.equal(button('Saving…').disabled, true);
  await key(document.activeElement, 'Escape');
  assert.equal(closed, 0);
  await act(async () => resolve({}));
  assert.deepEqual(calls[0], ['preferences', { showMessagePreviews: false, pageSize: 25 }]);
  assert.equal(useStore.getState().showMessagePreviews, false);
  assert.equal(useStore.getState().pageSize, 25);
  assert.equal(useStore.getState().theme, 'nord');
  assert.equal(useStore.getState().font, 'system');
  assert.equal(useStore.getState().layout, 'gmail');
  assert.equal(button('Save Changes').disabled, true);
  assert.match(host.textContent, /Changes saved/);
});

test('failed save remains dirty, shows error and does not alter store', async () => {
  api.savePreferences = async () => { throw new Error('Storage unavailable'); };
  await mount();
  await click(host.querySelectorAll('input[name=snippets]')[1]);
  await click(button('Save Changes'));
  assert.equal(useStore.getState().showMessagePreviews, true);
  assert.match(host.querySelector('[role=alert]').textContent, /Storage unavailable/);
  assert.equal(button('Save Changes').disabled, false);
  assert.doesNotMatch(host.textContent, /Changes saved/);
});

test('account signature uses native API and real editor, then appears on reopening', async () => {
  await mount();
  const editor = host.querySelector('[contenteditable=true]');
  await act(async () => { editor.innerHTML = '<p>Updated sign-off</p>'; editor.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
  await click(button('Save Changes'));
  assert.deepEqual(calls, [['signature', account.id, { signature: '<p>Updated sign-off</p>', signature_enabled: true }]]);
  assert.equal(useStore.getState().accounts[0].signature, '<p>Updated sign-off</p>');
  await click(button('Back to mail'));
  await act(async () => root.unmount());
  await mount();
  assert.equal(host.querySelector('[contenteditable=true]').innerHTML, '<p>Updated sign-off</p>');
});

test('label visibility updates real preference only after success; create, rename and delete target real folder paths', async () => {
  await mount(); await click(button('Labels'));
  assert.match(host.textContent, /2 messages/);
  await click(host.querySelector('[aria-label="Hide Projects"]'));
  assert.deepEqual(useStore.getState().hiddenFolders, { [account.id]: ['Projects'] });
  await click(button('Create IMAP folder'));
  await change(host.querySelector('form input'), 'Invoices');
  await submit(host.querySelector('form'));
  assert.ok(calls.some(c => c[0] === 'createFolder' && c[1] === account.id && c[2] === 'Invoices'));
  await click(host.querySelector('[aria-label="Edit Projects"]'));
  await change(host.querySelector('form input'), 'Work');
  await submit(host.querySelector('form'));
  assert.deepEqual(useStore.getState().hiddenFolders, { [account.id]: ['Work'] });
  await click(host.querySelector('[aria-label="Remove Work"]'));
  assert.equal(calls.filter(c => c[0] === 'deleteFolder').length, 0);
  assert.match(host.textContent, /permanently delete/);
  await click(button('Cancel'));
  assert.equal(calls.filter(c => c[0] === 'deleteFolder').length, 0);
  await click(host.querySelector('[aria-label="Remove Work"]'));
  await click(button('Delete folder and its contents'));
  assert.ok(calls.some(c => c[0] === 'deleteFolder' && c[1] === account.id && c[2] === 'Work'));
});

test('failed label loading is retryable and does not present empty success', async () => {
  api.getFolders = async () => { throw new Error('Mail server unavailable'); };
  await mount(); await click(button('Labels'));
  assert.match(host.querySelector('[role=alert]').textContent, /Mail server unavailable/);
  assert.doesNotMatch(host.textContent, /No folders found/);
  api.getFolders = async () => folderList;
  await click(button('Retry'));
  assert.equal(host.querySelector('[role=alert]'), null);
  assert.ok(host.querySelector('[aria-label="Edit Projects"]'));
});

test('rules create actual MailFlow conditions/actions and delete only after explicit confirmation', async () => {
  await mount(); await click(button('Filters and Blocked Addresses'));
  await click(button('Create a new filter'));
  const form = host.querySelector('form');
  await change(form.querySelector('input'), 'Invoices');
  await change(form.querySelector('[aria-label="Condition 1 value"]'), 'billing@example.invalid');
  const markRead = [...form.querySelectorAll('label')].find(l => l.textContent === 'Mark as read').querySelector('input');
  await click(markRead);
  await submit(form);
  const created = calls.find(c => c[0] === 'createRule')[1];
  assert.equal(created.accountId, account.id);
  assert.deepEqual(created.conditions, [{ field: 'from', operator: 'contains', value: 'billing@example.invalid' }]);
  assert.deepEqual(created.actions, [{ type: 'mark_read', value: '' }]);
  assert.match(host.textContent, /existing mail has not been changed/);
  await click(host.querySelector('[aria-label="Delete filter Invoices"]'));
  assert.equal(calls.filter(c => c[0] === 'deleteRule').length, 0);
  await click(button('Delete filter'));
  assert.deepEqual(calls.at(-1), ['deleteRule', 'rule-one']);
});

test('editing a rule preserves provider/backend actions not offered by this surface', async () => {
  savedRules = [{ id: 'rule-advanced', name: 'Existing', account_id: account.id, condition_logic: 'OR', conditions: [{ field: 'from', operator: 'equals', value: 'friend@example.invalid' }], actions: [{ type: 'forward', value: 'office@example.invalid' }, { type: 'star' }], enabled: false, stop_processing: true }];
  await mount(); await click(button('Filters and Blocked Addresses'));
  await click(host.querySelector('[aria-label="Edit filter Existing"]'));
  assert.match(host.textContent, /Existing action preserved: forward/);
  await change(host.querySelector('form input'), 'Renamed');
  await submit(host.querySelector('form'));
  const updated = calls.find(c => c[0] === 'updateRule');
  assert.equal(updated[1], 'rule-advanced');
  assert.deepEqual(updated[2].actions, savedRules[0].actions);
  assert.equal(updated[2].conditionLogic, 'OR');
  assert.equal(updated[2].enabled, false);
  assert.equal(updated[2].stopProcessing, true);
});

test('turning shortcuts off is a real native shortcut override and survives reopening', async () => {
  await mount();
  await click(host.querySelector('input[name=shortcuts]'));
  await click(button('Save Changes'));
  const overrides = calls.find(c => c[0] === 'preferences')[1].shortcuts;
  assert.ok(Object.keys(overrides).length > 10);
  assert.ok(Object.values(overrides).every(v => v === ''));
  assert.deepEqual(useStore.getState().shortcuts, overrides);
  await click(button('Back to mail'));
  await act(async () => root.unmount());
  await mount();
  assert.equal(host.querySelector('input[name=shortcuts]').checked, true);
});

test('failed visibility write leaves the real sidebar preference unchanged', async () => {
  api.savePreferences = async () => { throw new Error('Preferences unavailable'); };
  await mount(); await click(button('Labels'));
  await click(host.querySelector('[aria-label="Hide Projects"]'));
  assert.deepEqual(useStore.getState().hiddenFolders, {});
  assert.match(host.querySelector('[role=alert]').textContent, /Preferences unavailable/);
  assert.equal(host.querySelector('[aria-label="Hide Projects"]').disabled, false);
});

test('a successful create followed by refresh failure cannot resubmit the same folder', async () => {
  await mount(); await click(button('Labels'));
  await click(button('Create IMAP folder'));
  await change(host.querySelector('form input'), 'Invoices');
  api.getFolders = async () => { throw new Error('Refresh failed'); };
  await submit(host.querySelector('form'));
  assert.equal(calls.filter(c => c[0] === 'createFolder').length, 1);
  assert.equal(host.querySelector('form'), null);
  assert.match(host.querySelector('[role=alert]').textContent, /Refresh failed/);
});

test('renaming a parent remaps hidden descendants and the selected nested folder with the server delimiter', async () => {
  folderList = [{ path: 'Work', name: 'Work', delimiter: '.' }, { path: 'Work.Client', name: 'Client', delimiter: '.' }, { path: 'Workshop', name: 'Workshop', delimiter: '.' }];
  useStore.setState({ folders: { [account.id]: folderList }, hiddenFolders: { [account.id]: ['Work.Client', 'Workshop'] }, selectedFolder: 'Work.Client' });
  api.renameFolder = async () => { folderList = [{ path: 'Jobs', name: 'Jobs', delimiter: '.' }, { path: 'Jobs.Client', name: 'Client', delimiter: '.' }, { path: 'Workshop', name: 'Workshop', delimiter: '.' }]; return { newPath: 'Jobs' }; };
  await mount(); await click(button('Labels'));
  await click(host.querySelector('[aria-label="Edit Work"]'));
  await change(host.querySelector('form input'), 'Jobs');
  await submit(host.querySelector('form'));
  assert.deepEqual(useStore.getState().hiddenFolders[account.id], ['Jobs.Client', 'Workshop']);
  assert.equal(useStore.getState().selectedFolder, 'Jobs.Client');
  assert.ok(calls.some(c => c[0] === 'preferences' && c[1].hiddenFolders[account.id].includes('Jobs.Client')));
});

test('acknowledged rename retains correct nested local identity even when visibility persistence fails', async () => {
  folderList = [{ path: 'Work', name: 'Work', delimiter: '/' }, { path: 'Work/Client', name: 'Client', delimiter: '/' }];
  useStore.setState({ folders: { [account.id]: folderList }, hiddenFolders: { [account.id]: ['Work/Client'] }, selectedFolder: 'Work/Client' });
  api.renameFolder = async () => ({ newPath: 'Jobs' });
  api.savePreferences = async () => { throw new Error('Preferences unavailable'); };
  await mount(); await click(button('Labels'));
  await click(host.querySelector('[aria-label="Edit Work"]'));
  await change(host.querySelector('form input'), 'Jobs');
  await submit(host.querySelector('form'));
  assert.deepEqual(useStore.getState().hiddenFolders[account.id], ['Jobs/Client']);
  assert.equal(useStore.getState().selectedFolder, 'Jobs/Client');
  assert.match(host.querySelector('[role=alert]').textContent, /Folder renamed, but sidebar visibility could not be saved/);
});

async function prepareRule() {
  await mount(); await click(button('Filters and Blocked Addresses'));
  await click(button('Create a new filter'));
  const form = host.querySelector('form');
  await change(form.querySelector('input'), 'Invoices');
  await change(form.querySelector('[aria-label="Condition 1 value"]'), 'billing@example.invalid');
  await click([...form.querySelectorAll('label')].find(l => l.textContent === 'Mark as read').querySelector('input'));
  return form;
}

test('lost create-rule response reconciles the real saved record and never repeats the POST', async () => {
  const form = await prepareRule();
  api.createRule = async payload => { calls.push(['createRule', payload]); savedRules = [{ id: 'server-saved', name: payload.name, account_id: payload.accountId, condition_logic: payload.conditionLogic, conditions: payload.conditions, actions: payload.actions }]; throw new TypeError('Network response lost'); };
  await submit(form);
  assert.equal(calls.filter(c => c[0] === 'createRule').length, 1);
  assert.equal(host.querySelector('form'), null);
  assert.match(host.textContent, /saved record has been verified/);
  assert.ok(host.querySelector('[aria-label="Edit filter Invoices"]'));
});

test('uncertain rule create blocks resubmission while read reconciliation fails', async () => {
  const form = await prepareRule();
  api.createRule = async payload => { calls.push(['createRule', payload]); throw new TypeError('Network response lost'); };
  api.getRules = async () => { throw new Error('Read failed'); };
  await submit(form);
  assert.equal(button('Save filter').disabled, true);
  assert.equal(button('Create a new filter').disabled, true);
  assert.equal(button('Discard pending draft'), undefined);
  assert.match(host.querySelector('[role=alert]').textContent, /save outcome is unknown/);
  await submit(form);
  assert.equal(calls.filter(c => c[0] === 'createRule').length, 1);
  api.getRules = async () => [];
  await click(button('Check filter save'));
  assert.equal(button('Save filter').disabled, true);
  assert.ok(button('Discard pending draft'));
  assert.match(host.querySelector('[role=alert]').textContent, /No new matching filter was found/);
  await click(button('Discard pending draft'));
  assert.equal(host.querySelector('form'), null);
  assert.equal(button('Create a new filter').disabled, false);
});

test('lost create response reconciles jsonb key order and normalizes whitespace in the submitted name', async () => {
  const form = await prepareRule();
  await change(form.querySelector('input'), '  Invoices  ');
  api.createRule = async payload => {
    calls.push(['createRule', payload]);
    savedRules = [{
      id: 'jsonb-saved', name: payload.name, account_id: payload.accountId,
      condition_logic: payload.conditionLogic, enabled: payload.enabled, stop_processing: payload.stopProcessing,
      conditions: payload.conditions.map(c => ({ value: c.value, operator: c.operator, field: c.field })),
      actions: payload.actions.map(a => ({ value: a.value, type: a.type })),
    }];
    throw new TypeError('Network response lost');
  };
  await submit(form);
  assert.equal(calls.find(c => c[0] === 'createRule')[1].name, 'Invoices');
  assert.equal(calls.filter(c => c[0] === 'createRule').length, 1);
  assert.equal(host.querySelector('form'), null);
  assert.match(host.textContent, /saved record has been verified/);
  assert.ok(host.querySelector('[aria-label="Edit filter Invoices"]'));
});

test('reconciliation preserves action array order rather than matching a different rule', async () => {
  const form = await prepareRule();
  await click([...form.querySelectorAll('label')].find(l => l.textContent === 'Star it').querySelector('input'));
  api.createRule = async payload => {
    calls.push(['createRule', payload]);
    savedRules = [{ id: 'different-rule', name: payload.name, account_id: payload.accountId, condition_logic: payload.conditionLogic, conditions: payload.conditions, actions: [...payload.actions].reverse(), enabled: payload.enabled, stop_processing: payload.stopProcessing }];
    throw new TypeError('Network response lost');
  };
  await submit(form);
  assert.equal(button('Save filter').disabled, true);
  assert.match(host.querySelector('[role=alert]').textContent, /No new matching filter was found/);
  assert.doesNotMatch(host.textContent, /saved record has been verified/);
});

test('HTTP 408 create timeout is reconciled rather than permitting an immediate second POST', async () => {
  const form = await prepareRule();
  api.createRule = async payload => { calls.push(['createRule', payload]); throw Object.assign(new Error('Request timeout'), { status: 408 }); };
  const readsBefore = calls.filter(c => c[0] === 'getRules').length;
  await submit(form);
  assert.equal(calls.filter(c => c[0] === 'getRules').length, readsBefore + 1);
  assert.equal(button('Save filter').disabled, true);
  assert.equal(button('Create a new filter').disabled, true);
  await submit(form);
  assert.equal(calls.filter(c => c[0] === 'createRule').length, 1);
});

test('native label editing Escape cancels its editor without closing settings or mutating folders', async () => {
  await mount(); await click(button('Labels')); await click(button('Create MailFlow label'));
  const input = host.querySelector('.mf-native-labels input');
  assert.equal(document.activeElement, input); await change(input, 'Draft label'); await key(input, 'Escape');
  assert.equal(host.querySelector('.mf-native-labels form'), null); assert.equal(closed, 0);
  assert.ok(document.activeElement === button('Create MailFlow label'));
  assert.equal(calls.some(call => ['createFolder', 'deleteFolder', 'renameFolder'].includes(call[0])), false);
});

test('uncertain native label mutation locks account, tabs and settings close until exact retry resolves', async () => {
  window.sessionStorage.clear();
  api.createNativeLabel = async data => { calls.push(['createNativeLabel', structuredClone(data)]); throw new TypeError('Network lost'); };
  await mount(); await click(button('Labels')); await click(button('Create MailFlow label'));
  await change(host.querySelector('.mf-native-labels input'), 'Pending'); await submit(host.querySelector('.mf-native-labels form'));
  assert.equal(host.querySelector('[aria-label="Label account"]').disabled, true);
  assert.equal(button('General').disabled, true); assert.equal(button('Back to mail').disabled, true);
  assert.equal(host.querySelector('[aria-label="Close settings"]').disabled, true);
  await key(host.querySelector('[aria-label="Close settings"]'), 'Escape'); assert.equal(closed, 0);
  api.createNativeLabel = async data => { calls.push(['createNativeLabel', structuredClone(data)]); return {}; };
  await click(button('Retry pending label request'));
  const mutations = calls.filter(call => call[0] === 'createNativeLabel'); assert.deepEqual(mutations[0][1], mutations[1][1]);
  assert.equal(button('Back to mail').disabled, false); assert.equal(host.querySelector('[aria-label="Label account"]').disabled, false);
});
