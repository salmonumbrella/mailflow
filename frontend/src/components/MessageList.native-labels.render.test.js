import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k, d) => (typeof d === "string" ? d : d?.defaultValue ?? k), i18n: { language: "en", changeLanguage: () => {} } });',
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
// MessageList loads its own messages on mount and overwrites anything seeded in the store,
// so the fetch stub has to serve the row rather than the store. Only the messages endpoint
// needs a real shape; everything else can be an empty object, unless a test serves a path
// through ROUTES as [status, body].
let SERVED = [];
let ROUTES = {};
// Every request, with its JSON body, for tests that assert what reached the server.
let CALLS = [];
globalThis.fetch = async (url, opts = {}) => {
  const path = String(url);
  let sent = null;
  try { sent = typeof opts.body === 'string' ? JSON.parse(opts.body) : null; } catch { /* not JSON */ }
  CALLS.push({ path, method: opts.method || 'GET', body: sent });
  // A route may carry response headers as a third element.
  const [status, body, headers = {}] = Object.entries(ROUTES).find(([p]) => path.endsWith(p))?.[1]
    ?? [200, path.includes('/mail/messages?') ? { messages: SERVED, total: SERVED.length } : {}];
  return { ok: status < 400, status, headers: { get: name => headers[name] ?? (/content-type/i.test(name) ? 'application/json' : null) }, json: async () => body, text: async () => JSON.stringify(body) };
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const MessageList = (await import('./MessageList.jsx')).default;
const { shortcutBus } = await import('../utils/shortcutBus.js');

const ACCOUNT = { id: 'acct-1', storage_generation: 'generation', email_address: 'a@example.com', name: 'A', color: '#6366f1', include_in_unified_inbox: true };
const MESSAGE = {
  id: 'msg-1', account_id: 'acct-1', folder: 'INBOX', uid: 1,
  subject: 'Draggable subject', snippet: 'preview text', message_id: '<m1@example.com>',
  from_name: 'Sender', from_address: 's@example.com', date: new Date().toISOString(),
  is_read: false, is_starred: false, is_deleted: false, has_attachments: false,
};

// A conversation row: threading renders these through ThreadRow instead of MessageRow.


let container, root;

// Mount fresh for each scenario. MessageList refetches on mount and overwrites anything seeded
// in the store, so the fixture is served through fetch rather than set as state.
async function mount({ rows, threadedView, folder = 'INBOX', accountId = 'acct-1', accounts = [ACCOUNT], activeLabel = null }) {
  SERVED = rows;
  if (root) await React.act(async () => root.unmount());
  container = dom.window.document.getElementById('root');
  useStore.setState({
    accounts, accountsReady: true, activeLabel, nativeLabelFeed: null, layout: 'classic',
    selectedAccountId: accountId, selectedFolder: folder,
    messages: rows, messagesTotal: rows.length, hasMoreMessages: false, loadingMessages: false,
    searchQuery: '', threadedView,
    folders: { 'acct-1': [{ path: 'INBOX', name: 'INBOX' }, { path: 'Archive', name: 'Archive' }, { path: 'Drafts', name: 'Drafts', special_use: '\\Drafts' }] },
  });
  await React.act(async () => {
    root = createRoot(container);
    root.render(React.createElement(MessageList));
  });
}


const { api } = await import('../utils/api.js');
api.savePreferencesOnExit = () => {};
afterEach(async () => {
  if (root) await React.act(async () => root.unmount());
  root = null;
  window.dispatchEvent(new window.Event('pagehide'));
});
for (const scrollMode of ['infinite', 'paginated']) test(`late legacy ${scrollMode} pagination cannot contaminate a native label feed`, async () => {
  const original = globalThis.fetch;
  const native = { ...MESSAGE, id: 'native-row', entityId: 'native-entity', storageGeneration: 'generation', nativeLabelState: 'available', nativeLabels: [], message_id: '<native@test>' };
  const late = { ...MESSAGE, id: 'late-folder-row', message_id: '<late@test>' };
  let release;
  const response = body => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) });
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    if (path.includes('/labels/label/messages?')) return response({ accountId: 'acct-1', storageGeneration: 'generation', labelId: 'label', messages: [native], total: 1, nextCursor: null });
    if (path.includes('/mail/messages?') && /offset=1(&|$)/.test(path)) {
      await new Promise(resolve => { release = resolve; });
      return response({ messages: [late], total: 2 });
    }
    if (path.includes('/mail/messages?')) return response({ messages: [MESSAGE], total: 2 });
    return original(url, options);
  };
  try {
    useStore.setState({ scrollMode, pageSize: 1 });
    await mount({ rows: [MESSAGE], threadedView: false });
    const more = [...container.querySelectorAll('button')].find(button => scrollMode === 'paginated' ? button.textContent.includes('messageList.nextPage') : button.textContent === 'messageList.loadMore');
    assert.ok(more, 'legacy folder exposes its next page');
    await React.act(async () => { more.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.ok(release, 'legacy next page is in flight');
    await React.act(async () => {
      useStore.getState().setActiveLabel({ accountId: 'acct-1', storageGeneration: 'generation', labelId: 'label' });
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    assert.deepEqual(useStore.getState().messages.map(row => row.id), ['native-row']);
    await React.act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.deepEqual(useStore.getState().messages.map(row => row.id), ['native-row'], 'late folder page must not enter native results');
    assert.equal(useStore.getState().hasMoreMessages, false);
  } finally { globalThis.fetch = original; }
});

test('opening a native feed does not request folder messages, sync, or category counts', async () => {
  const original = globalThis.fetch; const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push(String(url));
    if (String(url).includes('/labels/label/messages?')) return { ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => ({ accountId: 'acct-1', storageGeneration: 'generation', labelId: 'label', messages: [], total: 0, nextCursor: null }), text: async () => '' };
    return original(url, options);
  };
  try {
    useStore.setState({ categorizationEnabled: true });
    await mount({ rows: [], threadedView: false, folder: null, activeLabel: { accountId: 'acct-1', storageGeneration: 'generation', labelId: 'label' } });
    assert.equal(requests.filter(path => /\/mail\/(messages\?|sync|category-counts)/.test(path)).length, 0);
    assert.equal(requests.filter(path => path.includes('/labels/label/messages?')).length, 1);
  } finally { globalThis.fetch = original; await React.act(async () => useStore.setState({ categorizationEnabled: false })); }
});

for (const status of ['loading', 'error']) test(`retained native rows cannot issue mutations while feed is ${status}`, async () => {
  const original = globalThis.fetch;
  const message = { ...MESSAGE, id: 'native-row', entityId: 'native-entity', storageGeneration: 'generation', nativeLabelState: 'available', nativeLabels: [] };
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/labels/label/messages?')) return { ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => ({ accountId: 'acct-1', storageGeneration: 'generation', labelId: 'label', messages: [message], total: 1, nextCursor: null }), text: async () => '' };
    return original(url, options);
  };
  try {
    useStore.setState({ markReadBehavior: 'manual', notifications: [] });
    await mount({ rows: [], threadedView: false, folder: null, activeLabel: { accountId: 'acct-1', storageGeneration: 'generation', labelId: 'label' } });
    await React.act(async () => useStore.setState({ selectedMessageId: message.id,
      nativeLabelFeed: { ...useStore.getState().nativeLabelFeed, status, error: status === 'error' ? 'Refresh failed' : null } }));
    CALLS = [];
    await React.act(async () => {
      for (const shortcut of ['archive', 'delete', 'toggleRead', 'markUnread']) shortcutBus.emit(shortcut);
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    assert.equal(CALLS.filter(call => call.method !== 'GET').length, 0, `stale/loading rows must not send mail mutations: ${JSON.stringify(CALLS)}`);
    assert.deepEqual(useStore.getState().messages.map(row => row.id), ['native-row'], 'no local destructive optimistic action');
  } finally { globalThis.fetch = original; }
});

test('an automatic read scheduled while ready is canceled at execution after the native feed becomes stale', async () => {
  const { scheduleMarkRead } = await import('../utils/markRead.js');
  const original = globalThis.fetch;
  const message = { ...MESSAGE, id: 'native-delayed', is_read: false, entityId: 'native-delayed-entity', storageGeneration: 'generation', nativeLabelState: 'available', nativeLabels: [] };
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/labels/label/messages?')) return { ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => ({ accountId: 'acct-1', storageGeneration: 'generation', labelId: 'label', messages: [message], total: 1, nextCursor: null }), text: async () => '' };
    return original(url, options);
  };
  try {
    useStore.setState({ markReadBehavior: 'manual', selectedMessageId: null });
    await mount({ rows: [], threadedView: false, folder: null, activeLabel: { accountId: 'acct-1', storageGeneration: 'generation', labelId: 'label' } });
    CALLS = [];
    await React.act(async () => {
      useStore.setState({ markReadBehavior: 'delay', markReadDelay: 0.01 });
      assert.ok(scheduleMarkRead(message), 'read was scheduled while verified ready');
      useStore.setState({ nativeLabelFeed: { ...useStore.getState().nativeLabelFeed, status: 'error', error: 'Refresh failed' } });
      await new Promise(resolve => setTimeout(resolve, 25));
    });
    assert.equal(CALLS.filter(call => call.method !== 'GET').length, 0);
    assert.equal(useStore.getState().messages[0].is_read, false, 'stale scheduled read has no optimistic flag effect');
  } finally { globalThis.fetch = original; }
});
