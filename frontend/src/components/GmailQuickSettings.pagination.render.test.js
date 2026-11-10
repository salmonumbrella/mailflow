import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k, d) => (typeof d === "string" ? d : d?.defaultValue?.replace(/{{(\\w+)}}/g, (_, name) => d[name]) ?? k), i18n: { language: "en", changeLanguage: () => {} } });',
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
// useMobile() reads window.innerWidth first, then subscribes to matchMedia. jsdom defaults
// innerWidth to 1024, which is the desktop case the bug report is about.
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
const MessageList = (await import('./MessageList.jsx')).default;
const GmailQuickSettings = (await import('./GmailQuickSettings.jsx')).default;
const originals = { ...api };
const account = { id: 'account-one', storage_generation: 'generation-one', email_address: 'a@example.com', name: 'Account', enabled: true, include_in_unified_inbox: true };
const view = { accountId: account.id, storageGeneration: account.storage_generation, labelId: 'label-one' };
const row = (id, native = false) => ({ id, account_id: account.id, folder: 'INBOX', uid: id,
  subject: `Synthetic ${id}`, snippet: '', message_id: `<${id}@test.invalid>`, from_name: 'Sender', from_address: 'sender@example.com', date: '2026-11-01T12:00:00Z',
  is_read: true, is_starred: false, is_deleted: false, has_attachments: false,
  ...(native ? { entityId: `entity-${id}`, storageGeneration: account.storage_generation, nativeLabelState: 'available', nativeLabels: [] } : {}) });
const page = (prefix, size, native = false) => Array.from({ length: size }, (_, index) => row(`${prefix}-${index}`, native));
let root, calls;
const click = node => React.act(async () => { assert.ok(node, 'click target'); node.click(); });
const findButton = text => [...document.querySelectorAll('button')].find(node => node.textContent === text || node.getAttribute('aria-label') === text);
const settle = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 330)); });
const release = (resolve, response) => React.act(async () => { resolve(response); await new Promise(done => setTimeout(done, 0)); });
const size = value => React.act(async () => {
  const select = document.getElementById('mf-gmail-quick-page-size');
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(select, String(value));
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
});
beforeEach(() => {
  calls = [];
  document.documentElement.dataset.mailflowLayout = 'gmail';
  Object.assign(api, {
    getGmailDensity: async () => ({ gmailDensity: 'default', gmailDensityRevision: 0 }),
    saveGmailDensity: async ({ gmailDensity, expectedRevision }) => ({ ok: true, gmailDensity, gmailDensityRevision: expectedRevision + 1 }),
    getRules: async () => [], savePreferences: async patch => { calls.push(['prefs', patch]); return {}; }, savePreferencesOnExit: () => {},
    syncFolder: async () => ({}), getCategoryCounts: async () => ({ counts: {}, totals: {} }),
    getNativeLabels: async () => ({ ...view, treeRevision: '1', labels: [{ id: view.labelId, name: 'Projects', path: 'Projects' }] }),
    getNativeLabelCounts: async () => ({ ...view, counts: [] }),
    getMessages: async params => { calls.push(['folder', { ...params }]); return { messages: page(`folder-${params.offset}`, params.limit), total: 100 }; },
    search: async (query, id, params) => { calls.push(['search', { query, id, ...params }]); return { messages: page(`search-${params.offset}`, params.limit) }; },
    getNativeLabelMessages: async (id, params) => { calls.push(['label', { id, ...params }]); return { ...view, messages: page(`label-${params.cursor || 'first'}`, params.limit, true), total: 100, nextCursor: String(Number(params.cursor || 0) + params.limit) }; },
  });
  useStore.setState({ user: { id: 'user-one' }, isLocked: false, accounts: [account], accountsReady: true,
    selectedAccountId: account.id, selectedFolder: 'INBOX', activeLabel: null, nativeLabelFeed: null, nativeLabelSnapshots: {}, nativeLabelsRevision: 0,
    messages: [], messagesTotal: 0, messagesOffset: 0, hasMoreMessages: false, loadingMessages: false,
    searchQuery: '', searchResults: [], isSearching: false, searchAllFolders: false, threadedView: false,
    scrollMode: 'paginated', pageSize: 10, layout: 'gmail', gmailDensity: 'default', gmailDensitySaveState: 'idle',
    selectedMessageId: null, composing: false, showContacts: false, categorizationEnabled: false, activeGtdTab: null, notifications: [], markReadBehavior: 'manual',
    listSort: {}, listFilter: 'all', folders: { [account.id]: [{ path: 'INBOX', name: 'Inbox' }] } });
});
afterEach(async () => {
  if (root) await React.act(async () => root.unmount()); root = null;
  useStore.getState().setUser(null);
  Object.assign(api, originals);
});
async function mount(patch = {}) {
  useStore.setState(patch);
  root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(React.Fragment, null,
    React.createElement(MessageList), React.createElement(GmailQuickSettings, { onClose() {}, onShowShortcutHelp() {} }))));
}

test('drawer page size resets a later folder page and uses the native setter without changing scroll mode', async () => {
  await mount();
  await click(findButton('Older'));
  assert.equal(calls.filter(call => call[0] === 'folder').at(-1)[1].offset, 10);
  assert.match(document.querySelector('.gmail-toolbar-range').textContent, /11–20/);
  await size(25);
  const latest = calls.filter(call => call[0] === 'folder').at(-1)[1];
  assert.equal(latest.limit, 25); assert.equal(latest.offset, 0);
  assert.match(document.querySelector('.gmail-toolbar-range').textContent, /1–25/);
  assert.equal(useStore.getState().messagesOffset, 25);
  assert.equal(localStorage.getItem('mailflow_page_size'), '25');
  assert.equal(useStore.getState().scrollMode, 'paginated');
});

for (const scrollMode of ['paginated', 'infinite']) test(`drawer size change drops a late ${scrollMode} folder page`, async () => {
  await mount({ scrollMode });
  const originalGet = api.getMessages;
  let resolve;
  api.getMessages = params => {
    if (params.offset === 10) { calls.push(['folder', params]); return new Promise(done => { resolve = done; }); }
    return originalGet(params);
  };
  await click(findButton(scrollMode === 'paginated' ? 'Older' : 'messageList.loadMore'));
  assert.ok(resolve, 'old page pending');
  await size(25);
  assert.equal(useStore.getState().messages.length, 25);
  assert.equal(useStore.getState().loadingMessages, false);
  await release(resolve, { messages: page('late', 10), total: 100 });
  assert.equal(useStore.getState().messages.length, 25);
  assert.ok(useStore.getState().messages.every(message => message.id.startsWith('folder-0')));
  assert.equal(useStore.getState().messagesOffset, 25);
  assert.equal(useStore.getState().scrollMode, scrollMode);
});

test('drawer size change restarts search at zero and rejects a pending search append', async () => {
  await mount({ scrollMode: 'infinite', searchQuery: 'subject:synthetic' }); await settle();
  assert.equal(useStore.getState().searchResults.length, 10);
  const originalSearch = api.search;
  let resolve;
  api.search = (query, id, params) => {
    if (params.offset === 10) { calls.push(['search', { query, id, ...params }]); return new Promise(done => { resolve = done; }); }
    return originalSearch(query, id, params);
  };
  await click(findButton('messageList.loadMore'));
  assert.ok(resolve);
  await size(25); await settle();
  const latest = calls.filter(call => call[0] === 'search').at(-1)[1];
  assert.equal(latest.offset, 0); assert.equal(latest.limit, 25);
  assert.equal(latest.query, 'subject:synthetic'); assert.equal(latest.id, account.id); assert.equal(latest.folder, 'INBOX');
  await release(resolve, { messages: page('stale-search', 10) });
  assert.equal(useStore.getState().searchResults.length, 25);
  assert.ok(useStore.getState().searchResults.every(message => message.id.startsWith('search-0')));
  assert.equal(useStore.getState().scrollMode, 'infinite');
});

test('drawer size change resets native label cursor, clears checkbox selection and rejects stale append', async () => {
  await mount({ scrollMode: 'infinite', activeLabel: view, selectedFolder: null });
  assert.equal(useStore.getState().messages.length, 10);
  const checkbox = document.querySelector('[data-msgid="label-first-0"] .mailflow-gmail-row-controls input');
  assert.ok(checkbox); await click(checkbox); assert.equal(checkbox.checked, true);
  const originalGet = api.getNativeLabelMessages;
  let resolve;
  api.getNativeLabelMessages = (id, params) => {
    if (params.cursor === '10') { calls.push(['label', { id, ...params }]); return new Promise(done => { resolve = done; }); }
    return originalGet(id, params);
  };
  await click(findButton('messageList.loadMore'));
  assert.ok(resolve);
  await size(25);
  const latest = calls.filter(call => call[0] === 'label').at(-1)[1];
  assert.equal(latest.limit, 25); assert.equal(latest.cursor, undefined);
  assert.equal(latest.id, view.labelId); assert.equal(latest.accountId, account.id); assert.equal(latest.storageGeneration, account.storage_generation);
  assert.equal(document.querySelectorAll('.mailflow-gmail-row-controls input:checked').length, 0);
  assert.equal(useStore.getState().nativeLabelFeed.windowSize, 25);
  await release(resolve, { ...view, messages: page('stale-label', 10, true), total: 100, nextCursor: '20' });
  assert.equal(useStore.getState().messages.length, 25);
  assert.ok(useStore.getState().messages.every(message => message.id.startsWith('label-first')));
  assert.equal(useStore.getState().nativeLabelFeed.nextCursor, '25');
  assert.equal(useStore.getState().scrollMode, 'infinite');
});

test('drawer page size clears existing folder checkbox selection consistently with page navigation', async () => {
  await mount();
  const checkbox = document.querySelector('[data-msgid="folder-0-0"] .mailflow-gmail-row-controls input');
  await click(checkbox); assert.equal(checkbox.checked, true);
  await size(25);
  assert.equal(document.querySelectorAll('.mailflow-gmail-row-controls input:checked').length, 0);
});


test('density changes preserve folder selection, while a page-size change resets search selection', async () => {
  await mount();
  const checkbox = document.querySelector('[data-msgid="folder-0-0"] .mailflow-gmail-row-controls input');
  await click(checkbox);
  await click(document.querySelector('[name="gmail-density"][value="compact"]'));
  assert.equal(checkbox.checked, true);
  assert.equal(useStore.getState().gmailDensity, 'compact');
  await React.act(async () => useStore.getState().setSearchQuery('subject:synthetic'));
  await settle();
  const searchCheckbox = document.querySelector('[data-msgid="search-0-0"] .mailflow-gmail-row-controls input');
  await click(searchCheckbox); assert.equal(searchCheckbox.checked, true);
  await size(25); await settle();
  assert.equal(useStore.getState().searchResults.length, 25);
  assert.equal(document.querySelectorAll('.mailflow-gmail-row-controls input:checked').length, 0);
});
