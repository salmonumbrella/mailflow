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

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.test', pretendToBeVisual: true });
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
const { applyDeleteGuard } = await import('../utils/pendingDeletes.js');
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
  { id: 'a', enabled: true, email_address: 'a@mail.test', gtd_enabled: true, categorization_enabled: true },
  { id: 'b', enabled: true, email_address: 'b@mail.test' },
  { id: 'x', enabled: true, email_address: 'x@mail.test', include_in_unified_inbox: false },
];
const sample = (n, revision = '1') => ({ byAccount: { a: n, b: 10, x: 7 }, snapshots: Object.fromEntries(accounts.map(a => [a.id, { revision, attemptRevision: revision, totalCount: a.id === 'a' ? n + 3 : 10, known: true, stale: false, observedAt: new Date().toISOString() }])) });
const rows = Array.from({ length: 111 }, (_, i) => ({ id: `row-${i}`, uid: i + 1, account_id: 'a', folder: 'INBOX', category: 'primary', is_read: false, from_email: 'sender@mail.test', subject: `Synthetic ${i}`, date: new Date().toISOString() }));
const byAccount = n => ({ a: { counts: { primary: n }, totals: { primary: n + 3 } }, b: { counts: {}, totals: {} } });
const press = (target = document.body) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'e', repeat: true, bubbles: true }));
after(() => dom.window.close());

test('observed empty category retains zero after the last archive settles', async () => {
  const originals = { getAccounts: api.getAccounts, getUnreadCounts: api.getUnreadCounts, getCategoryCounts: api.getCategoryCounts, refreshCounts: api.refreshCounts, getFolders: api.getFolders, getMessages: api.getMessages };
  let root, certified = false;
  const row = { ...rows[0], id: 'last-category.test' };
  const observed = () => ({ lease: { token: 'category.test.1', expiresInMs: 360000 },
    byAccount: { a: certified ? 0 : 1, b: 0, x: 0 }, snapshots: Object.fromEntries(accounts.map(account => [account.id, {
      revision: certified ? '21' : '1', totalCount: account.id === 'a' && !certified ? 1 : 0,
      known: true, stale: false, observedAt: new Date().toISOString(), epoch: 'category.test',
      quiescentAtStart: certified, refreshSeqAtStart: certified ? '20' : '0',
    }])) });
  try {
    api.getAccounts = async () => accounts;
    api.getUnreadCounts = async () => observed();
    api.refreshCounts = async () => ({ epoch: 'category.test', refreshSeq: '20' });
    api.getFolders = async () => [];
    api.getMessages = async () => ({ messages: SERVED, total: SERVED.length });
    api.getCategoryCounts = async () => ({ counts: certified ? {} : { primary: 1 }, totals: certified ? {} : { primary: 1 },
      byAccount: { a: { counts: certified ? {} : { primary: 1 }, totals: certified ? {} : { primary: 1 } } }, countRevision: certified ? '22' : '1' });
    SERVED = [row];
    useStore.getState().setUser({ id: 'last-category-user.test' });
    useStore.setState({ accounts, accountsReady: true, isLocked: false, selectedAccountId: 'a', selectedFolder: 'INBOX',
      selectedMessageId: row.id, threadedView: false, categorizationEnabled: true, enabledPlugins: [],
      activeCategory: null, activeGtdTab: null, messages: [row], pageSize: 50 });
    root = createRoot(document.getElementById('root'));
    await React.act(async () => root.render(React.createElement(MailApp)));
    const primary = [...document.querySelectorAll('button')].find(button => button.textContent.startsWith('messageList.categories.primary'));
    assert.ok(primary, 'the real category tab is mounted');
    await React.act(async () => primary.click());
    let generation;
    await React.act(async () => {
      generation = useStore.getState().beginArchiveCount('last-category', [row], Date.now() + 4750);
      useStore.getState().removeMessage(row.id);
    });
    assert.equal(document.querySelector('[title="Cached results matching this filter"]').textContent, '~0');
    await React.act(async () => {
      certified = true; SERVED = [];
      useStore.getState().finishArchiveCount('last-category', { countTargets: [row] }, generation);
      for (let i = 0; i < 100; i++) await Promise.resolve();
    });
    assert.equal(Object.keys(useStore.getState().countOperations.operations).length, 0);
    assert.deepEqual(useStore.getState().categoryTotals, {});
    assert.equal(document.querySelector('[title="Cached results matching this filter"]').textContent, '0');
  } finally {
    useStore.getState().setLocked(true);
    if (root) await React.act(async () => root.unmount());
    Object.assign(api, originals);
    SERVED = []; ROUTES = {}; CALLS = [];
  }
});

test('causal archive burst: actual held E, Undo, local intent and every count consumer', async () => {
  const originals = { getAccounts: api.getAccounts, getUnreadCounts: api.getUnreadCounts, getCategoryCounts: api.getCategoryCounts, bulkArchive: api.bulkArchive, refreshCounts: api.refreshCounts, getFolders: api.getFolders, getMessages: api.getMessages };
  let root;
  let release;
  const batches = [];
  let certified = false;
  const observed = () => {
    const value = sample(certified ? 10 : 120, certified ? '21' : '1');
    value.lease = { token: 'render.test.1', expiresInMs: 360000 };
    for (const snapshot of Object.values(value.snapshots)) Object.assign(snapshot, { epoch: 'render.test', quiescentAtStart: certified, refreshSeqAtStart: certified ? '20' : '0' });
    if (certified) value.snapshots.a.totalCount = 14;
    return value;
  };
  try {
    api.getAccounts = async () => accounts;
    api.getUnreadCounts = async () => observed();
    api.refreshCounts = async () => ({ epoch: 'render.test', refreshSeq: '20' });
    ROUTES['/mail/unread-counts'] = [200, observed()];
    api.getFolders = async () => [{ path: 'INBOX', name: 'INBOX', unread_count: 120, total_count: 123, counts_known: true, server_count_revision: '1', status_attempt_revision: '1', server_counts_at: new Date().toISOString() }];
    api.getCategoryCounts = async () => ({ counts: { primary: certified ? 10 : 120 }, totals: { primary: certified ? 14 : 123 }, byAccount: { ...byAccount(certified ? 10 : 120), a: { counts: { primary: certified ? 10 : 120 }, totals: { primary: certified ? 14 : 123 } } }, countRevision: certified ? '22' : '1' });
    api.bulkArchive = async ids => {
      batches.push(ids);
      if (batches.length === 1) await new Promise(resolve => { release = resolve; });
      return { archived: ids, noArchiveFolder: [], countTargets: rows.filter(r => ids.includes(r.id)) };
    };
    SERVED = rows;
    useStore.getState().setUser({ id: 'count-user.test' });
    useStore.setState({ accounts, accountsReady: true, isLocked: false, selectedAccountId: 'a', selectedFolder: 'INBOX', afterRemove: 'next', markReadBehavior: 'manual',
      selectedMessageId: rows[0].id, threadedView: false, categorizationEnabled: true, enabledPlugins: ['gtd'],
      showAppBadge: true, showFaviconBadge: true, expandedAccounts: { a: true }, messages: rows, pageSize: 200 });
    root = createRoot(document.getElementById('root'));
    await React.act(async () => root.render(React.createElement(MailApp)));
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    const input = document.createElement('input'); document.body.appendChild(input);
    await React.act(async () => press(input));
    assert.equal(Object.keys(useStore.getState().countOperations.operations || {}).length, 0, 'E in input does nothing');
    input.remove();
    for (let i = 0; i < 110; i++) await React.act(async () => press());
    assert.equal(useStore.getState().messages.length, 1, 'repeat intentionally advances distinct rows');
    assert.equal(Object.keys(useStore.getState().countOperations.operations).length, 110);
    assert.equal(useStore.getState().unreadCounts.byAccount.a, 10);
    await React.act(async () => { useStore.getState().setSelectedMessage(rows[0].id); press(); });
    assert.equal(Object.keys(useStore.getState().countOperations.operations).length, 110, 'stale same-target repeat is guarded');
    await React.act(async () => useStore.getState().notifications.find(n => n.onUndo).onUndo());
    assert.equal(useStore.getState().unreadCounts.byAccount.a, 11);
    await React.act(async () => { useStore.getState().decrementUnread('a'); useStore.getState().adjustCategoryCount('primary', -1); useStore.getState().setUnreadCounts(sample(119, '2')); });
    assert.equal(useStore.getState().unreadCounts.byAccount.a, 10, 'read-only STATUS does not subtract archives twice');
    await React.act(async () => { mock.timers.tick(30000); for (let i = 0; i < 12; i++) { await Promise.resolve(); mock.timers.tick(1); } });
    assert.ok(release);
    await React.act(async () => { mock.timers.tick(30001); await Promise.resolve(); });
    assert.equal(applyDeleteGuard(rows).length, 2, 'a response held beyond30s cannot resurrect any pending archive row');
    const refreshTokenBeforeBatches = useStore.getState().messagesRefreshToken;
    assert.equal(useStore.getState().unreadCounts.byAccount.a, 10, 'elapsed time cannot remove the read delta from a frozen cohort');
    assert.equal(useStore.getState().categoryCounts.primary, 10);
    assert.equal(document.title, '(10) MailFlow');
    assert.equal(faviconLabels.at(-1), '10');
    assert.equal(badgeValues.at(-1), 20, 'app badges use opted-in unified total');
    const inboxPill = [...document.querySelectorAll('button')].find(b => b.textContent.startsWith('gtd.inbox'));
    assert.match(inboxPill.textContent, /10$/);
    assert.match(document.querySelector('[data-mailbox-sidebar]').textContent, /~10/);
    api.getMessages = async () => ({ messages: [], total: 0 });
    const primaryPill = [...document.querySelectorAll('button')].find(b => b.textContent.startsWith('messageList.categories.primary'));
    await React.act(async () => primaryPill.click());
    const localHeader = document.querySelector('[title="Cached results matching this filter"]');
    assert.equal(localHeader.textContent, '~14', 'empty filtered list cannot zero the fenced local category total');
    assert.equal(useStore.getState().unreadCounts.byAccount.a, 10);

    await React.act(async () => { release(); for (let i = 0; i < 12; i++) { await Promise.resolve(); mock.timers.tick(1); } });
    assert.ok(batches.every(ids => ids.length <= 50));
    assert.equal(useStore.getState().messagesRefreshToken - refreshTokenBeforeBatches, batches.length, 'one current-scope refresh token per actual confirmed provider batch');
    assert.equal(new Set(batches.flat()).size, 109, 'Undo never reaches the provider');
    await React.act(async () => {
      certified = true;
      useStore.getState().setUnreadCounts(observed());
      for (let i = 0; i < 100; i++) await Promise.resolve();
    });
    assert.equal(useStore.getState().unreadCounts.byAccount.a, 10);
    assert.equal(useStore.getState().categoryCounts.primary, 10);
    assert.equal(Object.keys(useStore.getState().countOperations.operations).length, 0);

  } finally {
    mock.timers.reset();
    useStore.getState().setLocked(true);
    if (root) await React.act(async () => root.unmount());
    Object.assign(api, originals);
  }
});
