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

for (const trigger of ['focus', 'timer']) test(`native two-page reader and checkbox selection survive ${trigger} refresh, while actual removal clears them`, async () => {
  const view = { accountId: 'acct-1', storageGeneration: 'generation', labelId: 'label' };
  const make = entityId => ({ ...MESSAGE, id: `cache-${entityId}`, entityId, storageGeneration: 'generation', nativeLabelState: 'available', nativeLabels: [], subject: entityId });
  let rows = ['a', 'b', 'c', 'd', 'e'].map(make);
  const oldFeed = api.getNativeLabelMessages;
  const oldQuery = api.queryNativeLabelMemberships;
  const oldInterval = window.setInterval;
  const oldClearInterval = window.clearInterval;
  const intervals = new Map();
  let nextTimer = -1;
  let feedCalls = 0;
  // The feed and label-definition hook both poll every 30s. Simulate a clock tick,
  // not whichever callback happened to register last after the toolbar mounted.
  window.setInterval = (callback, delay, ...args) => {
    if (delay !== 30000) return oldInterval(callback, delay, ...args);
    const id = nextTimer--;
    intervals.set(id, () => callback(...args));
    return id;
  };
  window.clearInterval = id => { if (!intervals.delete(id)) oldClearInterval(id); };
  api.getNativeLabelMessages = async (id, params) => {
    feedCalls++;
    const start = Number(params.cursor || 0), end = start + params.limit;
    return { ...view, messages: rows.slice(start, end), nextCursor: end < rows.length ? String(end) : null, total: rows.length };
  };
  api.queryNativeLabelMemberships = async params => ({ ...view, targets: params.targets.map(target => ({ requestedEntityId: target.entityId, entityId: target.entityId, labelIds: rows.some(row => row.entityId === target.entityId) ? ['label'] : [], available: true })) });
  try {
    useStore.setState({ pageSize: 2, scrollMode: 'paginated', markReadBehavior: 'manual' });
    await mount({ rows: [], threadedView: false, activeLabel: view, folder: null });
    await React.act(async () => useStore.setState({ layout: 'gmail' }));
    const more = [...container.querySelectorAll('button')].find(button => button.textContent === 'messageList.loadMore');
    assert.ok(more); await React.act(async () => more.click());
    const checkbox = () => container.querySelector('[data-msgid="cache-d"] .mailflow-gmail-row-controls input');
    assert.ok(checkbox());
    await React.act(async () => { checkbox().click(); useStore.getState().setSelectedMessage('cache-d'); });
    assert.equal(checkbox().checked, true);
    const refresh = async () => {
      const before = feedCalls;
      await React.act(async () => {
        if (trigger === 'timer') {
          assert.ok(intervals.size > 0, 'live polling intervals are registered');
          for (const [id, tick] of [...intervals]) if (intervals.has(id)) tick();
        } else window.dispatchEvent(new window.Event('focus'));
      });
      assert.ok(feedCalls > before, 'each refresh actually requests the message feed');
      assert.equal(useStore.getState().nativeLabelFeed.status, 'ready');
      assert.equal(useStore.getState().loadingMessages, false);
    };
    await refresh();
    assert.deepEqual(useStore.getState().messages.map(row => row.entityId), ['a','b','c','d']);
    assert.equal(useStore.getState().selectedMessageId, 'cache-d');
    assert.equal(checkbox().checked, true);
    rows = rows.filter(row => row.entityId !== 'd'); await refresh();
    assert.deepEqual(useStore.getState().messages.map(row => row.entityId), ['a','b','c','e']);
    assert.equal(useStore.getState().selectedMessageId, null);
    assert.equal(container.querySelectorAll('.mailflow-gmail-row-controls input:checked').length, 0);
  } finally {
    // Unmount while the test clock still owns its fake interval handles.
    if (root) await React.act(async () => root.unmount());
    root = null;
    api.getNativeLabelMessages = oldFeed;
    api.queryNativeLabelMemberships = oldQuery;
    window.setInterval = oldInterval;
    window.clearInterval = oldClearInterval;
    assert.equal(intervals.size, 0, 'unmounted polling intervals are cleared');
  }
});
