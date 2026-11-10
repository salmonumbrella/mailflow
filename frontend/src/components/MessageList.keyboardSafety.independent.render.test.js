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
        'export const useTranslation = () => ({ t: (k, d) => (typeof d === "string" ? d : (d?.defaultValue ?? k).replace(/{{(\\w+)}}/g, (_, name) => d[name])), i18n: { language: "en", changeLanguage: () => {} } });',
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
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent, Event: dom.window.Event,
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

const ACCOUNT = { id: 'acct-1', email_address: 'a@example.com', name: 'A', color: '#6366f1', include_in_unified_inbox: true };
const MESSAGE = {
  id: 'msg-1', account_id: 'acct-1', folder: 'INBOX', uid: 1,
  subject: 'Draggable subject', snippet: 'preview text', message_id: '<m1@example.com>',
  from_name: 'Sender', from_address: 's@example.com', date: new Date().toISOString(),
  is_read: false, is_starred: false, is_deleted: false, has_attachments: false,
};

// A conversation row: threading renders these through ThreadRow instead of MessageRow.
const THREAD = { ...MESSAGE, id: 'msg-2', thread_id: 'thr-1', message_count: 3, unread_count: 2 };

let container, root;

// Mount fresh for each scenario. MessageList refetches on mount and overwrites anything seeded
// in the store, so the fixture is served through fetch rather than set as state.
async function mount({ rows, threadedView, folder = 'INBOX', accountId = 'acct-1', accounts = [ACCOUNT], gmailSearchTarget = null }) {
  SERVED = rows;
  if (root) await React.act(async () => root.unmount());
  container = dom.window.document.getElementById('root');
  useStore.setState({
    accounts, accountsReady: true, user: { id: 'independent-user' }, isLocked: false,
    selectedAccountId: accountId, selectedFolder: folder,
    messages: rows, messagesTotal: rows.length, hasMoreMessages: false, loadingMessages: false,
    searchQuery: '', layout: 'gmail', notifications: [], activeLabel: null, nativeLabelFeed: null, enabledPlugins: [], scrollMode: 'infinite', expandedThreadId: null, threadMessages: {}, markReadBehavior: 'manual', threadedView, selectedMessageId: null, activeGtdTab: null, gtdSections: null,
    folders: { 'acct-1': [{ path: 'INBOX', name: 'INBOX' }, { path: 'Archive', name: 'Archive' }, { path: 'Drafts', name: 'Drafts', special_use: '\\Drafts' }] },
  });
  await React.act(async () => {
    root = createRoot(container);
    root.render(React.createElement(MessageList, { gmailSearchTarget }));
  });
}

const { api } = await import('../utils/api.js');
const { flushUndoables } = await import('../utils/undoableAction.js');
api.savePreferencesOnExit = () => {};
const { pendingDeleteMap, completedDeleteMap, clearDeleteGuard } = await import('../utils/pendingDeletes.js');

afterEach(async () => {
  if (root) await React.act(async () => root.unmount());
  root = null;
  window.dispatchEvent(new window.Event('pagehide'));
  [...pendingDeleteMap.keys(), ...completedDeleteMap.keys()].forEach(clearDeleteGuard);
});


// These source-kind and async interruption cases are independent of the row owner's suite.
const row = id => container.querySelector(`[data-msgid="${id}"] .mailflow-message-row`);
const childRow = id => [...container.querySelectorAll('.mailflow-thread-message-row')].find(el => el.dataset.gmailRowId === id || el.dataset.msgid === id) || container.querySelector('.mailflow-thread-message-row');
async function key(target, value, options = {}) {
  assert.ok(target, 'keyboard target exists');
  await React.act(async () => target.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options })));
}
async function contextDelete(target) {
  assert.ok(target);
  await React.act(async () => target.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 })));
  const item = [...document.querySelectorAll('[role="menuitem"], span, div')].find(el => el.textContent === 'contextMenu.delete' && el.children.length < 2);
  assert.ok(item, 'delete menu item exists');
  await React.act(async () => item.click());
}
async function expand(parent, members) {
  await React.act(async () => useStore.setState({ expandedThreadId: parent.thread_id, threadMessages: { [parent.thread_id]: members } }));
}
async function flush() {
  await React.act(async () => {
    flushUndoables(); window.dispatchEvent(new window.Event('mailflow:will-lock'));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}
async function spyDeletes(run) {
  const originals = { getThread: api.getThread, bulkDelete: api.bulkDelete, deleteMessage: api.deleteMessage };
  const writes = [];
  api.bulkDelete = async ids => { writes.push([...ids]); return { deleted: ids }; };
  api.deleteMessage = async id => { writes.push([id]); return {}; };
  try { await run(writes); } finally { Object.assign(api, originals); }
}
const aliasChild = { ...MESSAGE, id: THREAD.id, uid: THREAD.uid, thread_id: THREAD.thread_id };
const sibling = { ...MESSAGE, id: 'independent-sibling', uid: 42, thread_id: THREAD.thread_id };

test('independent keyboard: same-ID child context replaces selected parent and deletes only the child', async () => spyDeletes(async writes => {
  let lookups = 0;
  api.getThread = async () => { lookups++; return { messages: [aliasChild, sibling] }; };
  await mount({ rows: [THREAD], threadedView: true });
  await expand(THREAD, [aliasChild, sibling]);
  await key(row(THREAD.id), ' ');
  await contextDelete(childRow(aliasChild.id));
  await flush();
  assert.deepEqual(writes, [[aliasChild.id]], 'expanded child never broadens to conversation');
  assert.equal(lookups, 0, 'single child does not resolve a whole conversation');
}));

test('independent keyboard: switching parent selection to same-ID child while resolution is pending cancels the original conversation delete', async () => spyDeletes(async writes => {
  let finish;
  api.getThread = () => new Promise(resolve => { finish = resolve; });
  await mount({ rows: [THREAD], threadedView: true });
  await expand(THREAD, [aliasChild, sibling]);
  await key(row(THREAD.id), ' ');
  await contextDelete(row(THREAD.id));
  assert.equal(typeof finish, 'function', 'conversation resolution is pending');
  await key(childRow(aliasChild.id), ' ');
  await React.act(async () => finish({ messages: [aliasChild, sibling] }));
  await flush();
  assert.deepEqual(writes, [], 'same raw ID with different selection source invalidates prepared intent');
  assert.equal(useStore.getState().messages.length, 1);
}));

for (const transition of [
  ['user', () => useStore.setState({ user: { id: 'replacement-user' } })],
  ['lock', () => useStore.setState({ isLocked: true })],
  ['account generation', () => useStore.setState({ accounts: [{ ...ACCOUNT, storage_generation: 'replacement' }] })],
]) {
  test(`independent keyboard: ${transition[0]} change during resolution cancels an unprepared action`, async () => spyDeletes(async writes => {
    let finish;
    api.getThread = () => new Promise(resolve => { finish = resolve; });
    await mount({ rows: [THREAD], threadedView: true });
    await key(row(THREAD.id), ' ');
    await contextDelete(row(THREAD.id));
    assert.equal(typeof finish, 'function');
    await React.act(async () => transition[1]());
    await React.act(async () => finish({ messages: [aliasChild, sibling] }));
    await flush();
    assert.deepEqual(writes, [], 'interrupted preauthorization cannot snapshot the new context');
    assert.equal(useStore.getState().messages.length, 1);
  }));
}

test('independent keyboard: collapsed selected child cannot fall back to its same-ID parent', async () => spyDeletes(async writes => {
  api.getThread = async () => ({ messages: [aliasChild, sibling] });
  await mount({ rows: [THREAD], threadedView: true });
  await expand(THREAD, [aliasChild, sibling]);
  await key(childRow(aliasChild.id), ' ');
  await React.act(async () => useStore.setState({ expandedThreadId: null }));
  const selectedToolbarDelete = container.querySelector('.gmail-toolbar button[aria-label="gmailToolbar.delete"]');
  if (selectedToolbarDelete) await React.act(async () => selectedToolbarDelete.click());
  await flush();
  assert.deepEqual(writes, []);
  assert.equal(row(THREAD.id).dataset.checked, 'false', 'hidden child selection does not become parent selection');
}));

for (const action of ['markSpam', 'markRead']) {
  test(`independent keyboard: ${action} cannot send after user changes during thread resolution`, async () => {
    const { shortcutBus } = await import('../utils/shortcutBus.js');
    const originals = { getThread: api.getThread, markSpam: api.markSpam, bulkRead: api.bulkRead };
    let finish;
    const writes = [];
    api.getThread = () => new Promise(resolve => { finish = resolve; });
    api.markSpam = async id => { writes.push({ action: 'spam', ids: [id] }); return {}; };
    api.bulkRead = async (ids, read) => { writes.push({ action: 'read', ids: [...ids], read }); return {}; };
    try {
      await mount({ rows: [THREAD], threadedView: true });
      await key(row(THREAD.id), ' ');
      await React.act(async () => shortcutBus.emit(action));
      assert.equal(typeof finish, 'function', 'thread resolution is pending');
      await React.act(async () => useStore.setState({ user: { id: 'replacement-user' } }));
      await React.act(async () => finish({ messages: [aliasChild, sibling] }));
      await flush();
      assert.deepEqual(writes, [], 'an interrupted shortcut must not issue commands under replacement identity');
    } finally { Object.assign(api, originals); }
  });
}

test('independent keyboard: mixed exact child and unrelated parent preserve both distinct scopes', async () => spyDeletes(async writes => {
  const other = { ...THREAD, id: 'other-parent', uid: 51, thread_id: 'other-thread', message_id: '<other-parent@test>' };
  const otherMember = { ...MESSAGE, id: 'other-member', uid: 52, thread_id: 'other-thread', message_id: '<other-member@test>' };
  const lookups = [];
  api.getThread = async id => { lookups.push(id); return { messages: id === other.thread_id ? [other, otherMember] : [aliasChild, sibling] }; };
  await mount({ rows: [THREAD, other], threadedView: true });
  await expand(THREAD, [aliasChild, sibling]);
  await key(childRow(aliasChild.id), ' ');
  await key(row(other.id), ' ');
  assert.equal(childRow(aliasChild.id).dataset.checked, 'true');
  assert.equal(row(THREAD.id).dataset.checked, 'false');
  assert.equal(row(other.id).dataset.checked, 'true');
  await contextDelete(row(other.id)); await flush();
  assert.deepEqual(writes.flat().sort(), [aliasChild.id, other.id, otherMember.id].sort());
  assert.deepEqual(lookups, [other.thread_id], 'exact child never triggers its parent thread lookup');
}));

test('independent keyboard: parent plus a different expanded child deduplicates exact resolved targets', async () => spyDeletes(async writes => {
  api.getThread = async () => ({ messages: [aliasChild, sibling] });
  await mount({ rows: [THREAD], threadedView: true });
  await expand(THREAD, [aliasChild, sibling]);
  await key(row(THREAD.id), ' ');
  await key(childRow(sibling.id), ' ');
  assert.equal(row(THREAD.id).dataset.checked, 'true');
  assert.equal(childRow(sibling.id).dataset.checked, 'true');
  await contextDelete(childRow(sibling.id)); await flush();
  assert.deepEqual(writes, [[aliasChild.id, sibling.id]], 'overlapping parent/child sources produce no duplicate write');
}));

test('independent keyboard: child source kind cannot widen even if an enriched cache retains aggregate metadata', async () => spyDeletes(async writes => {
  let lookups = 0;
  const enrichedChild = { ...THREAD };
  api.getThread = async () => { lookups++; return { messages: [enrichedChild, sibling] }; };
  await mount({ rows: [THREAD], threadedView: true });
  await expand(THREAD, [enrichedChild, sibling]);
  await key(childRow(enrichedChild.id), ' ');
  await contextDelete(childRow(enrichedChild.id)); await flush();
  assert.deepEqual(writes, [[enrichedChild.id]]);
  assert.equal(lookups, 0, 'rendered expanded kind is authoritative over incidental count metadata');
}));

test('independent keyboard: explicit unread still targets a reader message parked outside the visible list', async () => {
  const { shortcutBus } = await import('../utils/shortcutBus.js');
  const original = api.bulkRead;
  const writes = [];
  const parked = { ...MESSAGE, id: 'parked-reader', uid: 81, is_read: true, message_id: '<parked-reader@test>' };
  api.bulkRead = async (ids, read) => { writes.push({ ids: [...ids], read }); return {}; };
  try {
    await mount({ rows: [MESSAGE], threadedView: false });
    await React.act(async () => useStore.setState({ selectedMessageId: parked.id, threadMessages: { parked: [parked] } }));
    await React.act(async () => shortcutBus.emit('markUnread'));
    assert.deepEqual(writes, [{ ids: [parked.id], read: false }], 'reader shortcut must not require its message to be a visible list row');
  } finally { api.bulkRead = original; }
});

for (const outcome of ['lookup rejection', 'read rejection', 'undo', 'queued identity cancellation', 'commit rejection', 'commit success']) {
  test(`independent keyboard: action guards dispose subscriptions after ${outcome}`, async () => {
    const { shortcutBus } = await import('../utils/shortcutBus.js');
    const originalSubscribe = useStore.subscribe;
    const originals = { getThread: api.getThread, markSpam: api.markSpam, bulkRead: api.bulkRead };
    let subscriptions = 0;
    api.getThread = async () => { if (outcome === 'lookup rejection') throw new Error('review lookup rejection'); return { messages: [aliasChild, sibling] }; };
    api.markSpam = async () => { if (outcome === 'commit rejection') throw new Error('review commit rejection'); return {}; };
    api.bulkRead = async () => { if (outcome === 'read rejection') throw new Error('review read rejection'); return {}; };
    try {
      await mount({ rows: [THREAD], threadedView: true });
      await key(row(THREAD.id), ' ');
      useStore.subscribe = listener => {
        subscriptions++;
        const unsubscribe = originalSubscribe(listener);
        let disposed = false;
        return () => { if (!disposed) { subscriptions--; disposed = true; } unsubscribe(); };
      };
      await React.act(async () => shortcutBus.emit(outcome === 'read rejection' ? 'markRead' : 'markSpam'));
      if (outcome === 'undo') {
        assert.ok(subscriptions > 0, 'queued action is guarded until Undo or commit');
        const note = useStore.getState().notifications.find(item => item.onUndo);
        assert.ok(note);
        await React.act(async () => note.onUndo());
      } else if (outcome === 'queued identity cancellation') {
        await React.act(async () => useStore.setState({ user: { id: 'replacement-user' } }));
      }
      await flush();
      assert.equal(subscriptions, 0, `${outcome} must dispose every guard subscription`);
    } finally { await flush(); useStore.subscribe = originalSubscribe; Object.assign(api, originals); }
  });
}

for (const action of ['markSpam', 'markRead']) {
  test(`independent keyboard: unmount while ${action} resolves cannot authorize a late write`, async () => {
    const { shortcutBus } = await import('../utils/shortcutBus.js');
    const originals = { getThread: api.getThread, markSpam: api.markSpam, bulkRead: api.bulkRead };
    let finish;
    const writes = [];
    api.getThread = () => new Promise(resolve => { finish = resolve; });
    api.markSpam = async id => { writes.push(id); return {}; };
    api.bulkRead = async ids => { writes.push(...ids); return {}; };
    try {
      await mount({ rows: [THREAD], threadedView: true });
      await key(row(THREAD.id), ' ');
      await React.act(async () => shortcutBus.emit(action));
      assert.equal(typeof finish, 'function');
      await React.act(async () => root.unmount()); root = null;
      await React.act(async () => finish({ messages: [aliasChild, sibling] }));
      await flush();
      assert.deepEqual(writes, [], 'work not prepared before unmount must be cancelled');
    } finally { Object.assign(api, originals); }
  });
}
