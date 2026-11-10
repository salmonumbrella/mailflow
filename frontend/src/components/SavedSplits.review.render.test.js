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

test('review: IME Escape does not dismiss unsaved saved-split edits', async () => {
  function Harness() { const [open, setOpen] = React.useState(true); return open ? React.createElement(Dialog, { onClose: () => setOpen(false) }) : null; }
  await render(Harness);
  await change(input('Split 1 name'), 'Unsaved name');
  await React.act(async () => input('Split 1 name').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', isComposing: true, keyCode: 229, bubbles: true, cancelable: true })));
  assert.ok(document.querySelector('[role="dialog"]'), 'IME cancellation must not close the split editor');
  assert.equal(input('Split 1 name').value, 'Unsaved name');
});

test('review: an active saved split refreshes rows when its matching count refreshes', async () => {
  const newer = { ...MESSAGE, id: 'new-match', subject: 'New matching mail' };
  let current = [MESSAGE]; let searches = 0;
  api.search = async () => { searches++; return { messages: current }; };
  api.getSavedSplitCounts = async () => ({ savedSplitsRevision: 2, counts: { work: { total: current.length, unread: 0 }, starred: { total: 0, unread: 0 } } });
  await render(MessageList); await click(button('Work1'));
  await React.act(async () => new Promise(resolve => setTimeout(resolve, 350)));
  assert.ok(document.querySelector('[data-msgid="m"]'));
  current = [newer, MESSAGE];
  await React.act(async () => window.dispatchEvent(new CustomEvent('mailflow:refresh')));
  await React.act(async () => new Promise(resolve => setTimeout(resolve, 850)));
  assert.ok(button('Work2'), 'count updated for the newly synced matching message');
  assert.ok(searches > 1, 'saved inbox search should re-run for incoming matching mail');
  assert.ok(document.querySelector('[data-msgid="new-match"]'), 'updated count and visible results must agree');
});

test('review: count-only refresh after flag changes refreshes an active unread split', async () => {
  let current = [MESSAGE];
  useStore.setState({ savedSplits: [{ ...A, query: 'is:unread' }] });
  api.search = async () => ({ messages: current });
  api.getSavedSplitCounts = async () => ({ savedSplitsRevision: 2, counts: { work: { total: current.length, unread: current.length } } });
  await render(MessageList); await click(button('Work11'));
  await React.act(async () => new Promise(resolve => setTimeout(resolve, 350)));
  assert.ok(document.querySelector('[data-msgid="m"]'));
  current = [];
  await React.act(async () => window.dispatchEvent(new CustomEvent('mailflow:counts_refresh')));
  await React.act(async () => new Promise(resolve => setTimeout(resolve, 850)));
  assert.ok(button('Work0'));
  assert.equal(Boolean(document.querySelector('[data-msgid="m"]')), false, 'a message that no longer matches is not kept under a zero-result split');
});

test('review: refresh preserves an ad-hoc search snapshot', async () => {
  let searches = 0; api.search = async () => { searches++; return { messages: [MESSAGE] }; };
  useStore.setState({ searchQuery: 'from:alice' }); await render(MessageList);
  await React.act(async () => new Promise(resolve => setTimeout(resolve, 350)));
  const initial = searches;
  await React.act(async () => {
    window.dispatchEvent(new CustomEvent('mailflow:refresh'));
    window.dispatchEvent(new CustomEvent('mailflow:counts_refresh'));
  });
  await React.act(async () => new Promise(resolve => setTimeout(resolve, 850)));
  assert.equal(searches, initial); assert.ok(document.querySelector('[data-msgid="m"]'));
});
