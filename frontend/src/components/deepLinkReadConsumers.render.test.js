import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/hooks/useWebSocket.js')) return { format: 'module', shortCircuit: true, source: 'export const useWebSocket = () => {};' };
    if (url.endsWith('/plugins/PluginSlot.jsx')) return { format: 'module', shortCircuit: true, source: 'export const usePluginSlot = () => []; export const usePluginCollected = () => []; export const PluginSlot = () => null; export const PluginRuntime = () => null;' };
    if (['ReadingPane.jsx', 'InboxReplyDraftObserver.js', 'NotificationToasts.jsx', 'CommandPalette.jsx', 'ComposeModal.jsx', 'AdminPanel.jsx', 'ContactsPage.jsx', 'WindowLayer.jsx', 'ElectronNotificationBridge.jsx'].some(name => url.endsWith('/components/' + name))) return { format: 'module', shortCircuit: true, source: 'export default () => null;' };

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

const dom = new JSDOM('<div id="root"></div>', { url: 'https://synthetic.test', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, CustomEvent: dom.window.CustomEvent,
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
  const [status, body] = Object.entries(ROUTES).find(([p]) => path.endsWith(p))?.[1]
    ?? [200, path.includes('/mail/messages?') ? { messages: SERVED, total: SERVED.length } : {}];
  return { ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const { setPendingDelete, clearDeleteGuard } = await import('../utils/pendingDeletes.js');
const { beginReadIntent, completeReadIntent, reconcileReadState } = await import('../utils/pendingReads.js');
const { useGtdTriage } = await import('../hooks/useGtdTriage.js');
const MailApp = (await import('./MailApp.jsx')).default;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.history = dom.window.history;
globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = clearTimeout;
const faviconLabels = [];
globalThis.Image = class { set src(_value) { this.onload?.(); } };
dom.window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {}, beginPath() {}, arc() {}, fill() {}, fillText: label => faviconLabels.push(label) });
dom.window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AA==';
document.documentElement.style.setProperty('--accent', '#6366f1');
const badgeValues = [];
navigator.setAppBadge = async n => { badgeValues.push(n); };
navigator.clearAppBadge = async () => { badgeValues.push(0); };
window.mailflowNative = { badges: { setUnreadCount: async n => { badgeValues.push(n); } } };

const accounts = [
  { id: 'a', enabled: true, email_address: 'a@synthetic.test' },
  { id: 'b', enabled: true, email_address: 'b@synthetic.test' },
];
const message = { id: 'read-fence.test', account_id: 'a', folder: 'INBOX',
  message_id: '<read-fence@synthetic.test>', thread_id: 'read-thread.test',
  is_read: false, subject: 'Read response', from_email: 'sender@synthetic.test' };
const thread = { ...message, thread_key: message.thread_id };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
after(() => dom.window.close());

// Exercise the public publisher callback through the real mounted component/hook.
// No wrapper, read helper or cache/selection setter is replaced. The unrelated
// aggregate refresh scheduler is an observer, so a miss creates no test timer.
async function fixture(t, publisher) {
  const originals = { getAccounts: api.getAccounts, getUnreadCounts: api.getUnreadCounts,
    getCategoryCounts: api.getCategoryCounts, getFolders: api.getFolders,
    getMessages: api.getMessages, refreshCounts: api.refreshCounts,
    resolveMessage: api.resolveMessage, getMessage: api.getMessage,
    getThread: api.getThread, bulkRead: api.bulkRead, todoistStatus: api.todoist.status };
  let root;
  const releases = [];
  const writes = [];
  let requests = 0;
  let misses = 0;
  const scheduleGtdSectionsFetch = useStore.getState().scheduleGtdSectionsFetch;
  const warning = mock.method(console, 'warn', () => {});
  t.after(async () => {
    useStore.getState().setLocked(true);
    for (const release of releases) release();
    if (root) await React.act(async () => root.unmount());
    clearDeleteGuard(message.id);
    api.todoist.status = originals.todoistStatus;
    for (const [key, value] of Object.entries(originals)) {
      if (key !== 'todoistStatus') api[key] = value;
    }
    useStore.setState({ scheduleGtdSectionsFetch });
    warning.mock.restore();
    history.replaceState(null, '', '/');
    SERVED = []; ROUTES = {}; CALLS = [];
  });
  api.getAccounts = async () => accounts;
  api.todoist.status = async () => ({ connected: false });
  api.getUnreadCounts = async () => ({ byAccount: { a: 10, b: 20 }, snapshots: {} });
  api.getCategoryCounts = async () => ({ counts: { primary: 30 }, totals: { primary: 35 },
    byAccount: { a: { counts: { primary: 10 }, totals: { primary: 13 } },
      b: { counts: { primary: 20 }, totals: { primary: 22 } } }, countRevision: '1' });
  api.getFolders = async () => [];
  api.getMessages = async () => ({ messages: [], total: 0 });
  api.refreshCounts = async () => ({ epoch: 'read-fence.test', refreshSeq: '1' });
  api.bulkRead = async (...args) => { writes.push(args); return {}; };
  useStore.getState().setUser({ id: 'read-user@synthetic.test' });
  useStore.setState({ isLocked: false, accounts, accountsReady: true,
    selectedAccountId: 'a', selectedFolder: 'INBOX', selectedMessageId: null,
    messages: [], searchResults: [], searchQuery: '', threadMessages: {},
    markReadBehavior: 'manual', enabledPlugins: [], activeGtdTab: null,
    threadedView: false, categorizationEnabled: false, showAdmin: false,
    notifications: [], composing: false });
  useStore.setState({ scheduleGtdSectionsFetch: () => { misses++; } });
  let triage;
  function Probe() {
    triage = useGtdTriage();
    return null;
  }
  const mount = async () => {
    root = createRoot(document.getElementById('root'));
    await React.act(async () => root.render(React.createElement(publisher === 'mailapp' ? MailApp : Probe)));
  };
  if (publisher !== 'mailapp') await mount();
  return {
    writes,
    requests: () => requests,
    misses: () => misses,
    actions: () => triage,
    cache: () => useStore.getState().threadMessages[`__dl_${message.id}`],
    async open(row = message, { expectRequest = true } = {}) {
      const held = deferred(), started = deferred();
      releases.push(() => held.resolve(row));
      let opening;
      if (publisher === 'mailapp') {
        api.resolveMessage = () => { requests++; started.resolve(); return held.promise; };
        history.replaceState(null, '', `/?m=${row.id}`);
        await mount();
      } else {
        api.getMessage = publisher === 'gtd-fallback'
          ? async () => { throw new Error('snapshot missing'); }
          : () => { requests++; started.resolve(); return held.promise; };
        api.getThread = () => { requests++; started.resolve(); return held.promise.then(value => ({ messages: [value] })); };
        await React.act(async () => { opening = triage.openRow({ ...thread, id: row.id }); });
      }
      if (expectRequest) await started.promise;
      return {
        async release() {
          await React.act(async () => { held.resolve(row); await opening; });
        },
      };
    },
    async unmount() {
      await React.act(async () => root.unmount());
      root = null;
    },
  };
}

for (const publisher of ['mailapp', 'gtd-direct', 'gtd-fallback']) {
  for (const position of ['fresh-after-complete', 'old-issued', 'pending', 'relogin', 'lock', 'delete-first', 'other-account', 'cache-reuse']) {
    test(`deep-link read publisher: ${publisher} ${position}`, async t => {
      const f = await fixture(t, publisher);
      let intent;
      if (['fresh-after-complete', 'old-issued', 'pending', 'delete-first'].includes(position)) {
        intent = beginReadIntent(message, true);
        if (['fresh-after-complete', 'delete-first'].includes(position)) completeReadIntent(intent);
      }
      if (position === 'other-account') {
        completeReadIntent(beginReadIntent({ ...message, account_id: 'b' }, true));
      }
      if (position === 'cache-reuse') {
        useStore.getState().setThreadMessages(`__dl_${message.id}`, [{ ...message, is_read: true }]);
      }
      const request = await f.open();
      if (position === 'old-issued') completeReadIntent(intent);
      if (position === 'relogin') {
        await React.act(async () => {
          useStore.getState().setUser(null);
          useStore.getState().setUser({ id: 'read-user@synthetic.test' });
        });
      }
      if (position === 'lock') await React.act(async () => useStore.getState().setLocked(true));
      if (position === 'delete-first') setPendingDelete(message.id);
      await request.release();
      if (['relogin', 'lock', 'delete-first'].includes(position)) {
        assert.equal(f.cache(), undefined, 'stale/deleted row was never cached');
        assert.notEqual(useStore.getState().selectedMessageId, message.id);
      } else {
        assert.equal(f.cache()[0].is_read, ['old-issued', 'pending'].includes(position));
        assert.equal(f.cache()[0].account_id, 'a');
        assert.equal(useStore.getState().selectedMessageId, message.id);
      }
      if (position === 'delete-first') {
        clearDeleteGuard(message.id);
        assert.equal(reconcileReadState([message])[0].is_read, true,
          'discarded fresh row did not advance the settled read fence');
      }
      if (position === 'pending') completeReadIntent(intent);
      assert.deepEqual(f.writes, [], 'manual preference: response publication never writes read flags');
    });
  }
}

for (const publisher of ['mailapp', 'gtd-direct', 'gtd-fallback']) {
  test(`deep-link read publisher: ${publisher} locked issuance sends no request`, async t => {
    const f = await fixture(t, publisher);
    await React.act(async () => useStore.getState().setLocked(true));
    await f.open(message, { expectRequest: false });
    assert.equal(f.requests(), 0);
    assert.equal(f.cache(), undefined);
    assert.deepEqual(f.writes, []);
  });
}

test('deep-link read publisher: GTD newer click wins', async t => {
  const f = await fixture(t, 'gtd-direct');
  const first = await f.open();
  const next = { ...message, id: 'newer-read-fence.test' };
  const second = await f.open(next);
  await second.release();
  await first.release();
  assert.equal(useStore.getState().selectedMessageId, next.id);
  assert.equal(f.cache(), undefined);
  assert.equal(useStore.getState().threadMessages[`__dl_${next.id}`][0].id, next.id);
  assert.deepEqual(f.writes, []);
});

for (const publisher of ['gtd-direct', 'gtd-fallback']) {
  test(`deep-link read publisher: ${publisher} unmount cancels auto-read`, async t => {
    const f = await fixture(t, publisher);
    useStore.setState({ markReadBehavior: 'delay', markReadDelay: 10 });
    const request = await f.open();
    await f.unmount();
    await request.release();
    assert.equal(f.cache(), undefined);
    assert.deepEqual(f.writes, []);
  });
}

test('deep-link read publisher: GTD fallback captures its own issued token', async t => {
  const f = await fixture(t, 'gtd-direct');
  const direct = deferred(), started = deferred();
  const intent = beginReadIntent(message, true);
  api.getMessage = () => { started.resolve(); return direct.promise; };
  api.getThread = async () => ({ messages: [message] });
  let opening;
  await React.act(async () => { opening = f.actions().openRow(thread); });
  await started.promise;
  completeReadIntent(intent);
  // The direct GET is old, but the recovery GET has not yet been issued.
  await React.act(async () => { direct.resolve(null); await opening; });
  assert.equal(f.cache()[0].is_read, false, 'fresh fallback may accept remote unread');
  assert.equal(f.misses(), 1);
  assert.deepEqual(f.writes, []);
});

test('deep-link read publisher: GTD stale miss has no recovery side effects', async t => {
  const f = await fixture(t, 'gtd-direct');
  const direct = deferred(), started = deferred();
  let fallbackCalls = 0;
  api.getMessage = () => { started.resolve(); return direct.promise; };
  api.getThread = async () => { fallbackCalls++; return { messages: [message] }; };
  let opening;
  await React.act(async () => { opening = f.actions().openRow(thread); });
  await started.promise;
  await React.act(async () => useStore.getState().setLocked(true));
  await React.act(async () => { direct.resolve(null); await opening; });
  assert.equal(f.misses(), 0);
  assert.equal(fallbackCalls, 0);
  assert.equal(f.cache(), undefined);
  assert.deepEqual(f.writes, []);
});
