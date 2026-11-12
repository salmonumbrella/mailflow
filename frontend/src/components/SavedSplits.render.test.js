import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'const t = (key, fallback, values = {}) => { const options = typeof fallback === "object" ? fallback : values; const text = typeof fallback === "string" ? fallback : fallback?.defaultValue ?? (options?.message ? `${key} ${options.message}` : key); return text.replace(/\\{\\{(\\w+)\\}\\}/g, (_, name) => String(options?.[name] ?? "")); }; export const useTranslation = () => ({ t, i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export const Trans = ({ children }) => children ?? null;',
        'export const I18nextProvider = ({ children }) => children ?? null;',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    const shimViteEnv = (code) => code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
    if (url.endsWith('.jsx')) {
      const code = readFileSync(new URL(url), 'utf8');
      const out = transform(code, { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: shimViteEnv(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) {
        return { format: 'module', shortCircuit: true, source: shimViteEnv(code) };
      }
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.matchMedia = dom.window.matchMedia;
dom.window.Element.prototype.scrollIntoView = () => {};
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}), text: async () => '{}' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const Dialog = (await import('./SavedSplitsDialog.jsx')).default;
const Bar = (await import('./SavedSplitBar.jsx')).default;
const MessageList = (await import('./MessageList.jsx')).default;
const originalApi = { ...api };
const A = { id: 'work', label: 'Work', query: 'from:alice' };
const B = { id: 'starred', label: 'Starred', query: 'is:starred' };
const ACCOUNT = { id: 'main', name: 'Main', email_address: 'owner@example.test', include_in_unified_inbox: true };
const MESSAGE = { id: 'm', account_id: 'main', folder: 'INBOX', uid: 1, from_name: 'Alice', from_email: 'alice@example.test', subject: 'Search result', date: new Date().toISOString() };
globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
let root;
beforeEach(() => {
  document.body.innerHTML = '<button id="opener">Open</button><div id="root"></div>';
  document.getElementById('opener').focus();
  useStore.setState({ ...useStore.getInitialState(), user: { id: 'owner' }, isLocked: false, savedSplits: [A, B], hideEmptySplits: false, savedSplitsRevision: 2, savedSplitsLoaded: true, accounts: [ACCOUNT], accountsReady: true, selectedAccountId: 'main', selectedFolder: 'INBOX', layout: 'superhuman' });
  api.getSavedSplitCounts = async () => ({ savedSplitsRevision: 2, counts: { work: { total: 3, unread: 2 }, starred: { total: 0, unread: 0 } } });
  api.saveSavedSplits = async prefs => ({ ...prefs, savedSplitsRevision: prefs.savedSplitsRevision + 1 });
  api.getMessages = async () => ({ messages: [MESSAGE], total: 1 });
  api.search = async () => ({ messages: [MESSAGE] });
  root = createRoot(document.getElementById('root'));
});
afterEach(async () => { await React.act(async () => root.unmount()); Object.assign(api, originalApi); });
const render = async (Component, props = {}) => React.act(async () => root.render(React.createElement(Component, props)));
const click = async node => React.act(async () => { assert.ok(node); node.click(); });
const button = text => [...document.querySelectorAll('button')].find(node => node.textContent === text);
const input = label => document.querySelector(`[aria-label="${label}"]`);
const change = async (node, value) => React.act(async () => {
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(node, value);
  node.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
});
const submit = async () => React.act(async () => document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
const key = async (key, shiftKey = false) => React.act(async () => document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })));
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('edits names and native queries, adds, reorders, deletes and persists hide-empty together', async () => {
  let closed = 0; const saves = [];
  api.saveSavedSplits = async prefs => { saves.push(prefs); return { ...prefs, savedSplitsRevision: 3 }; };
  await render(Dialog, { onClose: () => closed++ });
  await change(input('Split 1 name'), 'Team'); await change(input('Split 1 query'), 'from:team is:unread');
  await click(input('Move Starred up'));
  assert.equal(input('Split 1 name').value, 'Starred');
  await click(input('Delete Starred')); await click(button('Add split'));
  await change(input('Split 2 name'), 'Files'); await change(input('Split 2 query'), 'has:attachment');
  await click(document.querySelector('input[type="checkbox"]')); await submit();
  assert.equal(saves.length, 1); assert.equal(saves[0].hideEmptySplits, true); assert.equal(saves[0].savedSplitsRevision, 2);
  assert.deepEqual(saves[0].savedSplits.map(({ label, query }) => ({ label, query })), [{ label: 'Team', query: 'from:team is:unread' }, { label: 'Files', query: 'has:attachment' }]);
  assert.equal(closed, 1); assert.equal(useStore.getState().savedSplitsRevision, 3);
});
test('rejects duplicate names and blank rules with visible errors, no persistence', async () => {
  let writes = 0; api.saveSavedSplits = async () => { writes++; };
  await render(Dialog, { onClose() {} }); await change(input('Split 2 name'), 'work'); await submit();
  assert.match(document.querySelector('[role="alert"]').textContent, /unique/); assert.equal(writes, 0);
  await change(input('Split 2 name'), 'Different'); await change(input('Split 2 query'), ''); await submit(); assert.equal(writes, 0);
});
test('cancel and Escape discard drafts, trap Tab and restore focus', async () => {
  function Harness() { const [open, setOpen] = React.useState(true); return open ? React.createElement(Dialog, { onClose: () => setOpen(false) }) : null; }
  await render(Harness);
  const first = input('Split 1 name'); assert.equal(document.activeElement, first);
  await key('Tab', true); assert.equal(document.activeElement, button('Save splits'));
  await key('Tab'); assert.equal(document.activeElement, first);
  await change(first, 'Unsaved'); await key('Escape');
  assert.equal(document.querySelector('[role="dialog"]'), null); assert.equal(document.activeElement.id, 'opener');
  assert.equal(useStore.getState().savedSplits[0].label, 'Work');
  await render(Dialog, { onClose() {} }); assert.equal(input('Split 1 name').value, 'Work');
});
test('conflicts remain editable and reload replaces the old revision explicitly', async () => {
  api.saveSavedSplits = async () => { throw new Error('Changed in another window'); };
  api.getSavedSplits = async () => ({ savedSplits: [B], hideEmptySplits: true, savedSplitsRevision: 9 });
  await render(Dialog, { onClose() {} }); await submit(); assert.match(document.querySelector('[role="alert"]').textContent, /another window/);
  await click(button('Reload saved splits')); assert.equal(input('Split 1 name').value, 'Starred');
  assert.equal(input('Split 2 name'), null); assert.equal(document.querySelector('input[type="checkbox"]').checked, true);
});
test('hides only known-empty counts and keeps an active empty split visible', async () => {
  await React.act(async () => useStore.setState({ hideEmptySplits: true })); await render(Bar, { accountId: 'main' });
  assert.ok(button('Work32')); assert.equal(button('Starred0'), undefined);
  await React.act(async () => useStore.getState().selectSavedSplit('starred')); assert.ok(button('Starred0'));
  assert.equal(useStore.getState().searchQuery, 'is:starred'); await click(button('Inbox'));
  assert.equal(useStore.getState().searchQuery, ''); assert.equal(useStore.getState().activeSavedSplitId, null);
});
test('count failures never hide splits or show fabricated zero and Retry recovers', async () => {
  await React.act(async () => useStore.setState({ hideEmptySplits: true })); api.getSavedSplitCounts = async () => { throw new Error('Unavailable'); };
  await render(Bar, { accountId: 'main' }); assert.ok(button('Work—')); assert.ok(button('Starred—')); assert.match(document.querySelector('[role="alert"]').textContent, /Unavailable/);
  api.getSavedSplitCounts = async () => ({ counts: { work: { error: 'Unsupported query' }, starred: { total: 0, unread: 0 } }, savedSplitsRevision: 2 });
  await click(button('Retry counts')); await click(button('Work—')); assert.match(document.querySelector('[role="alert"]').textContent, /Unsupported/);
});
test('drops stale count responses after account navigation and closes private editor on identity changes', async () => {
  const old = defer(); api.getSavedSplitCounts = account => account === 'main' ? old.promise : Promise.resolve({ counts: { work: { total: 7, unread: 0 } }, savedSplitsRevision: 2 });
  await render(Bar, { accountId: 'main' }); await render(Bar, { accountId: 'other' });
  await React.act(async () => old.resolve({ counts: { work: { total: 99, unread: 0 } }, savedSplitsRevision: 2 })); assert.ok(button('Work7')); assert.equal(button('Work99'), undefined);
  await click(button('Manage splits')); await change(input('Split 1 name'), 'Private draft');
  await React.act(async () => useStore.getState().setUser({ id: 'different' })); assert.equal(document.querySelector('[role="dialog"]'), null); assert.doesNotMatch(document.body.textContent, /Private draft/);
});
test('native MessageList searches a saved split in unified INBOX and clears it on navigation', async () => {
  const calls = []; api.search = async (query, account, options) => { calls.push({ query, account, options }); return { messages: [MESSAGE] }; };
  await React.act(async () => useStore.setState({ selectedAccountId: null })); await render(MessageList);
  await click(button('Work32')); await React.act(async () => new Promise(resolve => setTimeout(resolve, 340)));
  assert.equal(calls.at(-1).query, A.query); assert.equal(calls.at(-1).account, undefined); assert.equal(calls.at(-1).options.folder, 'INBOX');
  assert.ok(document.querySelector('[data-msgid="m"]'));
  await React.act(async () => useStore.getState().setSelectedAccount('main', 'Archive'));
  assert.equal(useStore.getState().activeSavedSplitId, null); assert.equal(useStore.getState().searchQuery, '');
});
