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
    accounts, accountsReady: true,
    selectedAccountId: accountId, selectedFolder: folder,
    messages: rows, messagesTotal: rows.length, hasMoreMessages: false, loadingMessages: false,
    searchQuery: '', threadedView, selectedMessageId: null, activeGtdTab: null, gtdSections: null,
    folders: { 'acct-1': [{ path: 'INBOX', name: 'INBOX' }, { path: 'Archive', name: 'Archive' }, { path: 'Drafts', name: 'Drafts', special_use: '\\Drafts' }] },
  });
  await React.act(async () => {
    root = createRoot(container);
    root.render(React.createElement(MessageList, { gmailSearchTarget }));
  });
}

const { api } = await import('../utils/api.js');
const { UNDO_COMMIT_DELAY_MS } = await import('../utils/undoableAction.js');
api.savePreferencesOnExit = () => {};
const { pendingDeleteMap, completedDeleteMap, clearDeleteGuard } = await import('../utils/pendingDeletes.js');

afterEach(async () => {
  if (root) await React.act(async () => root.unmount());
  root = null;
  window.dispatchEvent(new window.Event('pagehide'));
  [...pendingDeleteMap.keys(), ...completedDeleteMap.keys()].forEach(clearDeleteGuard);
});

async function switchLayout(layout) {
  await React.act(async () => useStore.getState().setLayout(layout));
}

async function selectRows(rows, threadedView = true, folder = 'INBOX') {
  useStore.setState({ notifications: [], activeLabel: null, nativeLabelFeed: null, layout: 'gmail', scrollMode: 'infinite', enabledPlugins: [], threadMessages: {} });
  await mount({ rows, threadedView, folder });
  await switchLayout('gmail');
  await React.act(async () => container.querySelector('[data-gmail-select-all]').click());
}
async function contextAction(id, label = 'contextMenu.delete') {
  await React.act(async () => container.querySelector(`[data-msgid="${id}"] [draggable]`).dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 30 })));
  const item = [...document.querySelectorAll('button, [role="menuitem"], div, span')].find(node => node.textContent === label && node.children.length < 2);
  assert.ok(item, 'context delete exists');
  await React.act(async () => item.click());
}
async function flushDeletes() {
  await React.act(async () => { window.dispatchEvent(new window.Event('mailflow:will-lock')); await new Promise(resolve => setTimeout(resolve, 0)); });
}
async function dialogClick(label) {
  const dialog = document.querySelector('[role="alertdialog"]');
  assert.ok(dialog, 'exact-target confirmation is visible');
  const button = [...dialog.querySelectorAll('button')].find(node => node.textContent === label);
  assert.ok(button, label);
  await React.act(async () => button.click());
}
async function withDeleteSpy(run) {
  const originals = { getThread: api.getThread, bulkDelete: api.bulkDelete, deleteMessage: api.deleteMessage };
  const writes = [];
  api.bulkDelete = async ids => { writes.push([...ids]); return { deleted: ids }; };
  api.deleteMessage = async id => { writes.push([id]); return {}; };
  try { await run(writes); } finally { Object.assign(api, originals); }
}

// Independent adversarial cases. The setup above follows the repository's existing
// rendered harness; scenarios below are not copied from the implementation suite.
async function unselected(rows, threadedView = true, folder = 'INBOX') {
  useStore.setState({ notifications: [], activeLabel: null, nativeLabelFeed: null, layout: 'gmail', scrollMode: 'infinite', enabledPlugins: [], threadMessages: {}, hoverQuickActions: true, hoverActionSet: ['delete', 'move'] });
  await mount({ rows, threadedView, folder });
}
async function hoverDelete(id) {
  const row = container.querySelector(`[data-msgid="${id}"] [draggable]`);
  await React.act(async () => row.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })));
  const button = row.querySelector('[title="common.delete"], [title="message.delete"]');
  assert.ok(button, 'hover delete is rendered');
  await React.act(async () => button.click());
}

test('independent: thread response with anchor only in another account never falls back to representative', async () => withDeleteSpy(async writes => {
  api.getThread = async () => ({ messages: [{ ...THREAD, account_id: 'different-account' }] });
  await selectRows([THREAD]);
  await contextAction(THREAD.id); await flushDeletes();
  assert.deepEqual(writes, [], 'account-filtered empty thread must fail closed');
  assert.equal(useStore.getState().messages.length, 1);
}));

for (const threaded of [true, false]) {
  test(`independent: hover ${threaded ? 'thread' : 'flat'} Trash delete confirms and Escape cancels`, async () => withDeleteSpy(async writes => {
    const row = { ...THREAD, folder: 'Trash' };
    api.getThread = async () => ({ messages: [row] });
    await unselected([row], threaded, 'Trash');
    await hoverDelete(row.id);
    const dialog = document.querySelector('[role="alertdialog"]');
    assert.ok(dialog);
    await React.act(async () => dialog.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await flushDeletes();
    assert.deepEqual(writes, []);
    assert.equal(useStore.getState().messages.length, 1);
  }));
}

test('independent: hover thread delete with rejected resolution retains row and makes no write', async () => withDeleteSpy(async writes => {
  api.getThread = async () => { throw new Error('Independent failed lookup'); };
  await unselected([THREAD]); await hoverDelete(THREAD.id); await flushDeletes();
  assert.deepEqual(writes, []);
  assert.equal(useStore.getState().messages.length, 1);
  assert.match(useStore.getState().notifications.at(-1).body, /Independent failed lookup/);
}));

test('independent: late context move after source UID replacement cannot move any message', async () => {
  const originals = { getThread: api.getThread, bulkMove: api.bulkMove, getFolders: api.getFolders };
  let finish;
  const writes = [];
  api.getThread = () => new Promise(resolve => { finish = resolve; });
  api.getFolders = async () => [{ path: 'Archive', name: 'Archive' }];
  api.bulkMove = async (ids, folder) => { writes.push({ ids, folder }); return { moved: ids }; };
  try {
    await unselected([THREAD]);
    await contextAction(THREAD.id, 'contextMenu.moveToFolder');
    const destination = [...document.querySelectorAll('button, span, div')].find(node => node.textContent === 'Archive' && node.children.length === 0);
    assert.ok(destination);
    await React.act(async () => destination.click());
    assert.equal(typeof finish, 'function');
    await React.act(async () => useStore.setState({ messages: [{ ...THREAD, uid: 222 }] }));
    await React.act(async () => finish({ messages: [THREAD] }));
    const { flushUndoables } = await import('../utils/undoableAction.js');
    await React.act(async () => { flushUndoables(); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.deepEqual(writes, []);
    assert.equal(useStore.getState().messages[0].uid, 222);
  } finally { Object.assign(api, originals); }
});

test('independent: confirmed target list remains frozen if response objects mutate during dialog', async () => withDeleteSpy(async writes => {
  const row = { ...THREAD, folder: 'Trash' };
  const child = { ...MESSAGE, id: 'frozen-child', folder: 'Trash' };
  api.getThread = async () => ({ messages: [row, child] });
  await selectRows([row], true, 'Trash'); await contextAction(row.id);
  child.id = 'not-confirmed';
  await dialogClick('Delete permanently'); await flushDeletes();
  assert.deepEqual(writes, [[row.id, 'frozen-child']]);
}));

async function swipeLeft(id) {
  const row = container.querySelector(`[data-msgid="${id}"] .mailflow-message-row`);
  assert.ok(row);
  await React.act(async () => {
    for (const [type, x] of [['touchstart', 200], ['touchmove', 80], ['touchend', 80]]) {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: [{ clientX: x, clientY: 40 }] });
      row.dispatchEvent(event);
    }
  });
}
for (const threaded of [true, false]) {
  test(`independent: mobile swipe ${threaded ? 'thread' : 'flat'} Trash delete requires exact confirmation and Undo prevents write`, async () => withDeleteSpy(async writes => {
    const priorWidth = window.innerWidth;
    window.innerWidth = 390;
    useStore.setState({ swipeActions: { left: 'delete', right: 'disabled' } });
    const row = { ...THREAD, folder: 'Trash' };
    api.getThread = async () => ({ messages: [row] });
    try {
      await unselected([row], threaded, 'Trash'); await swipeLeft(row.id);
      assert.ok(document.querySelector('[role="alertdialog"]'));
      await dialogClick('Delete permanently');
      assert.equal(useStore.getState().messages.length, 0);
      await React.act(async () => useStore.getState().notifications.find(note => note.onUndo).onUndo());
      await flushDeletes();
      assert.deepEqual(writes, []);
      assert.equal(useStore.getState().messages.length, 1);
    } finally { window.innerWidth = priorWidth; }
  }));
}

test('independent: mobile swipe with failed thread lookup never deletes representative', async () => withDeleteSpy(async writes => {
  const priorWidth = window.innerWidth;
  window.innerWidth = 390;
  useStore.setState({ swipeActions: { left: 'delete', right: 'disabled' } });
  api.getThread = async () => { throw new Error('Swipe lookup failed'); };
  try {
    await unselected([THREAD]); await swipeLeft(THREAD.id); await flushDeletes();
    assert.deepEqual(writes, []);
    assert.equal(useStore.getState().messages.length, 1);
    assert.match(useStore.getState().notifications.at(-1).body, /Swipe lookup failed/);
  } finally { window.innerWidth = priorWidth; }
}));

test('independent: pending confirmation rejected when native-label feed becomes stale', async () => withDeleteSpy(async writes => {
  const row = { ...MESSAGE, folder: 'Trash' };
  await unselected([row], false, 'Trash'); await contextAction(row.id);
  await React.act(async () => useStore.setState({ activeLabel: { accountId: ACCOUNT.id, storageGeneration: 'g1', labelId: 'label-1' }, nativeLabelFeed: { key: 'old-view', status: 'loading' } }));
  await dialogClick('Delete permanently'); await flushDeletes();
  assert.deepEqual(writes, []);
}));

test('independent: ordinary context move freezes same-account members and Undo prevents all writes', async () => {
  const originals = { getThread: api.getThread, bulkMove: api.bulkMove, getFolders: api.getFolders };
  const child = { ...MESSAGE, id: 'move-child' };
  const elsewhere = { ...MESSAGE, id: 'other-account-child', account_id: 'different-account' };
  const draft = { ...MESSAGE, id: 'unsent-child', is_draft: true, folder: 'Drafts' };
  let reads = 0;
  const writes = [];
  api.getThread = async () => { reads++; return { messages: [THREAD, child, elsewhere, draft] }; };
  api.getFolders = async () => [{ path: 'Archive', name: 'Archive' }];
  api.bulkMove = async (ids, folder) => { writes.push({ ids: [...ids], folder }); return { moved: ids }; };
  const chooseArchive = async () => {
    await contextAction(THREAD.id, 'contextMenu.moveToFolder');
    const destination = [...document.querySelectorAll('button, span, div')].find(node => node.textContent === 'Archive' && node.children.length === 0);
    assert.ok(destination);
    await React.act(async () => destination.click());
  };
  const { flushUndoables } = await import('../utils/undoableAction.js');
  try {
    await unselected([THREAD]); await chooseArchive();
    assert.equal(document.querySelector('[role="alertdialog"]'), null);
    await React.act(async () => useStore.getState().notifications.find(note => note.onUndo).onUndo());
    await React.act(async () => { flushUndoables(); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.deepEqual(writes, []);
    assert.equal(useStore.getState().messages.length, 1);
    await chooseArchive();
    const preparedReads = reads;
    child.id = 'unprepared-child';
    await React.act(async () => { flushUndoables(); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(reads, preparedReads);
    assert.deepEqual(writes, [{ ids: [THREAD.id, 'move-child'], folder: 'Archive' }]);
  } finally { Object.assign(api, originals); }
});

for (const boundary of ['timer', 'lock', 'beforeunload']) {
  test(`independent: storage generation change during Undo delay aborts delete at ${boundary}`, async () => withDeleteSpy(async writes => {
    const account = { ...ACCOUNT, storage_generation: 'g1' };
    const row = { ...MESSAGE, storageGeneration: 'g1', folder: 'Trash' };
    useStore.setState({ notifications: [], activeLabel: null, nativeLabelFeed: null, layout: 'gmail', scrollMode: 'infinite', enabledPlugins: [], threadMessages: {} });
    await mount({ rows: [row], threadedView: false, folder: 'Trash', accounts: [account] });
    await contextAction(row.id);
    const originalTimer = globalThis.setTimeout;
    let commit;
    globalThis.setTimeout = (callback, delay, ...args) => delay === UNDO_COMMIT_DELAY_MS ? (commit = callback, 987654321) : originalTimer(callback, delay, ...args);
    try { await dialogClick('Delete permanently'); } finally { globalThis.setTimeout = originalTimer; }
    assert.equal(typeof commit, 'function');
    assert.equal(useStore.getState().messages.length, 0);
    await React.act(async () => useStore.setState({ accounts: [{ ...account, storage_generation: 'g2' }] }));
    const requestStart = CALLS.length;
    const rowsBeforeDispatch = structuredClone(useStore.getState().messages);
    const countsBeforeDispatch = structuredClone(useStore.getState().unreadCounts);
    if (boundary === 'timer') await React.act(async () => commit());
    else if (boundary === 'lock') await flushDeletes();
    else await React.act(async () => window.dispatchEvent(new window.Event('beforeunload')));
    assert.deepEqual(writes, []);
    assert.deepEqual(CALLS.slice(requestStart).filter(call => call.method === 'DELETE' || /bulk-delete/.test(call.path)), []);
    assert.deepEqual(useStore.getState().messages, rowsBeforeDispatch, 'abort cannot reinsert old-account rows');
    assert.deepEqual(useStore.getState().unreadCounts, countsBeforeDispatch, 'abort cannot mutate replacement counts');
  }));
}

test('independent: source UID replacement during Undo delay aborts original delete', async () => withDeleteSpy(async writes => {
  const row = { ...MESSAGE, folder: 'Trash' };
  await unselected([row], false, 'Trash'); await contextAction(row.id); await dialogClick('Delete permanently');
  await React.act(async () => useStore.setState({ messages: [{ ...row, uid: 912 }] }));
  const countsBeforeDispatch = structuredClone(useStore.getState().unreadCounts);
  await flushDeletes();
  assert.deepEqual(writes, []);
  assert.equal(useStore.getState().messages[0].uid, 912, 'abort cannot replace new UID with old source');
  assert.deepEqual(useStore.getState().unreadCounts, countsBeforeDispatch);
}));

test('independent: navigation after confirmation preserves frozen original delete targets', async () => withDeleteSpy(async writes => {
  const row = { ...THREAD, folder: 'Trash' };
  const child = { ...MESSAGE, id: 'navigation-child', folder: 'Trash' };
  api.getThread = async () => ({ messages: [row, child] });
  await selectRows([row], true, 'Trash'); await contextAction(row.id); await dialogClick('Delete permanently');
  await React.act(async () => useStore.setState({ selectedFolder: 'Archive', selectedMessageId: 'unrelated-selection' }));
  await flushDeletes();
  assert.deepEqual(writes, [[row.id, child.id]]);
}));

test('independent: account generation change during move Undo delay aborts dispatch', async () => {
  const originals = { getThread: api.getThread, bulkMove: api.bulkMove, getFolders: api.getFolders };
  const writes = [];
  api.getThread = async () => ({ messages: [THREAD] });
  api.getFolders = async () => [{ path: 'Archive', name: 'Archive' }];
  api.bulkMove = async (ids, folder) => { writes.push({ ids, folder }); return { moved: ids }; };
  try {
    await unselected([THREAD]);
    await contextAction(THREAD.id, 'contextMenu.moveToFolder');
    const destination = [...document.querySelectorAll('button, span, div')].find(node => node.textContent === 'Archive' && node.children.length === 0);
    assert.ok(destination);
    await React.act(async () => destination.click());
    await React.act(async () => useStore.setState({ accounts: [{ ...ACCOUNT, storage_generation: 'replacement-generation' }] }));
    const rowsBeforeDispatch = structuredClone(useStore.getState().messages);
    const countsBeforeDispatch = structuredClone(useStore.getState().unreadCounts);
    const { flushUndoables } = await import('../utils/undoableAction.js');
    await React.act(async () => { flushUndoables(); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.deepEqual(writes, []);
    assert.deepEqual(useStore.getState().messages, rowsBeforeDispatch);
    assert.deepEqual(useStore.getState().unreadCounts, countsBeforeDispatch);
  } finally { Object.assign(api, originals); }
});

for (const boundary of ['timer', 'lock', 'beforeunload']) {
  test(`independent: removed account during bulk-delete Undo delay aborts ${boundary}`, async () => withDeleteSpy(async writes => {
    const first = { ...MESSAGE, folder: 'Trash' };
    const second = { ...MESSAGE, id: 'second-bulk-item', uid: 2, message_id: '<bulk-second>', folder: 'Trash' };
    await selectRows([first, second], false, 'Trash');
    await contextAction(first.id);
    const originalTimer = globalThis.setTimeout;
    let commit;
    globalThis.setTimeout = (callback, delay, ...args) => delay === UNDO_COMMIT_DELAY_MS ? (commit = callback, 987654322) : originalTimer(callback, delay, ...args);
    try { await dialogClick('Delete permanently'); } finally { globalThis.setTimeout = originalTimer; }
    assert.equal(typeof commit, 'function');
    await React.act(async () => useStore.setState({ accounts: [] }));
    const requestStart = CALLS.length;
    const rowsBeforeDispatch = structuredClone(useStore.getState().messages);
    const countsBeforeDispatch = structuredClone(useStore.getState().unreadCounts);
    if (boundary === 'timer') await React.act(async () => commit());
    else if (boundary === 'lock') await flushDeletes();
    else await React.act(async () => window.dispatchEvent(new window.Event('beforeunload')));
    assert.deepEqual(writes, []);
    assert.deepEqual(CALLS.slice(requestStart).filter(call => call.method === 'DELETE' || /bulk-delete/.test(call.path)), []);
    assert.deepEqual(useStore.getState().messages, rowsBeforeDispatch, 'abort cannot reinsert old-account rows');
    assert.deepEqual(useStore.getState().unreadCounts, countsBeforeDispatch, 'abort cannot mutate replacement counts');
  }));
}

test('independent: valid unified conversation delete includes both enabled accounts', async () => withDeleteSpy(async writes => {
  const other = { ...ACCOUNT, id: 'acct-2', email_address: 'other@example.com' };
  const child = { ...MESSAGE, id: 'unified-child', account_id: other.id, uid: 55 };
  api.getThread = async () => ({ messages: [THREAD, child] });
  useStore.setState({ notifications: [], activeLabel: null, nativeLabelFeed: null, layout: 'gmail', scrollMode: 'infinite', enabledPlugins: [], threadMessages: {} });
  await mount({ rows: [THREAD], threadedView: true, accountId: null, accounts: [ACCOUNT, other] });
  await contextAction(THREAD.id); await flushDeletes();
  assert.deepEqual(writes, [[THREAD.id, child.id]]);
}));

for (const change of [{ uid: 777 }, { folder: 'DifferentMailbox' }]) {
  test(`independent: resolved anchor replacement ${JSON.stringify(change)} blocks delete before removal`, async () => withDeleteSpy(async writes => {
    api.getThread = async () => ({ messages: [{ ...THREAD, ...change }] });
    await selectRows([THREAD]); await contextAction(THREAD.id); await flushDeletes();
    assert.deepEqual(writes, []);
    assert.equal(useStore.getState().messages.length, 1);
  }));
}

for (const bulk of [false, true]) for (const failure of (bulk ? ['reject', 'partial'] : ['reject'])) {
  test(`independent: late ${bulk ? 'bulk' : 'single'} delete ${failure} cannot restore old generation rows or counts`, async () => {
    const originals = { bulkDelete: api.bulkDelete, deleteMessage: api.deleteMessage };
    let complete, reject;
    const remote = new Promise((resolve, rejectPromise) => { complete = resolve; reject = rejectPromise; });
    api.bulkDelete = () => remote;
    api.deleteMessage = () => remote;
    const row = { ...MESSAGE, folder: 'Trash' };
    const second = { ...row, id: 'late-delete-second', uid: 2, message_id: '<late-delete-second>' };
    try {
      if (bulk) await selectRows([row, second], false, 'Trash');
      else await unselected([row], false, 'Trash');
      await contextAction(row.id);
      const originalTimer = globalThis.setTimeout;
      let commit;
      globalThis.setTimeout = (callback, delay, ...args) => delay === UNDO_COMMIT_DELAY_MS ? (commit = callback, 987654323) : originalTimer(callback, delay, ...args);
      try { await dialogClick('Delete permanently'); } finally { globalThis.setTimeout = originalTimer; }
      let response;
      await React.act(async () => { response = commit(); await Promise.resolve(); });
      const replacementRows = [{ ...row, id: 'replacement-mail', uid: 777, storageGeneration: 'g2' }];
      const replacementCounts = { total: 73, byAccount: { [ACCOUNT.id]: 73 } };
      await React.act(async () => useStore.setState({ accounts: [{ ...ACCOUNT, storage_generation: 'g2' }], messages: replacementRows, unreadCounts: replacementCounts }));
      await React.act(async () => { if (failure === 'reject') reject(new Error('Late delete response')); else complete({ deleted: [] }); await response; });
      assert.deepEqual(useStore.getState().messages, replacementRows);
      assert.deepEqual(useStore.getState().unreadCounts, replacementCounts);
      assert.ok(!useStore.getState().notifications.some(note => /No messages were changed/.test(note.body || '')), 'already-dispatched response cannot claim no remote action');
    } finally { Object.assign(api, originals); }
  });
}

for (const bulk of [false, true]) for (const failure of ['reject', 'partial']) {
  test(`independent: late ${bulk ? 'bulk' : 'single'} move ${failure} cannot restore old generation rows or counts`, async () => {
    const originals = { bulkMove: api.bulkMove, getFolders: api.getFolders };
    let complete, reject;
    const remote = new Promise((resolve, rejectPromise) => { complete = resolve; reject = rejectPromise; });
    api.bulkMove = () => remote;
    api.getFolders = async () => [{ path: 'Archive', name: 'Archive' }];
    const second = { ...MESSAGE, id: 'late-move-second', uid: 2, message_id: '<late-move-second>' };
    try {
      if (bulk) await selectRows([MESSAGE, second], false);
      else await unselected([MESSAGE], false);
      await contextAction(MESSAGE.id, 'contextMenu.moveToFolder');
      const destination = [...document.querySelectorAll('button, span, div')].find(node => node.textContent === 'Archive' && node.children.length === 0);
      assert.ok(destination);
      await React.act(async () => destination.click());
      const { flushUndoables } = await import('../utils/undoableAction.js');
      await React.act(async () => { flushUndoables(); await Promise.resolve(); });
      const replacementRows = [{ ...MESSAGE, id: 'replacement-mail', uid: 777, storageGeneration: 'g2' }];
      const replacementCounts = { total: 73, byAccount: { [ACCOUNT.id]: 73 } };
      await React.act(async () => useStore.setState({ accounts: [{ ...ACCOUNT, storage_generation: 'g2' }], messages: replacementRows, unreadCounts: replacementCounts }));
      await React.act(async () => { if (failure === 'reject') reject(new Error('Late move response')); else complete({ moved: [] }); await new Promise(resolve => setTimeout(resolve, 0)); });
      assert.deepEqual(useStore.getState().messages, replacementRows);
      assert.deepEqual(useStore.getState().unreadCounts, replacementCounts);
      assert.ok(!useStore.getState().notifications.some(note => /No messages were changed/.test(note.body || '')), 'already-dispatched response cannot claim no remote action');
    } finally { Object.assign(api, originals); }
  });
}

test('independent: in-flight move failure after navigation restores original account count but not old-view rows', async () => {
  const originals = { bulkMove: api.bulkMove, getFolders: api.getFolders };
  const originalIncrement = useStore.getState().incrementUnread;
  const increments = [];
  useStore.setState({ incrementUnread: (...args) => { increments.push(args); originalIncrement(...args); } });
  let reject;
  api.bulkMove = () => new Promise((resolve, rejectPromise) => { reject = rejectPromise; });
  api.getFolders = async () => [{ path: 'Archive', name: 'Archive' }];
  try {
    await unselected([MESSAGE], false);
    await contextAction(MESSAGE.id, 'contextMenu.moveToFolder');
    const destination = [...document.querySelectorAll('button, span, div')].find(node => node.textContent === 'Archive' && node.children.length === 0);
    await React.act(async () => destination.click());
    const { flushUndoables } = await import('../utils/undoableAction.js');
    await React.act(async () => { flushUndoables(); await Promise.resolve(); });
    assert.equal(typeof reject, 'function');
    const otherViewRow = { ...MESSAGE, id: 'other-view-row', folder: 'Sent', uid: 911 };
    SERVED = [otherViewRow];
    await React.act(async () => useStore.setState({ selectedFolder: 'Sent', selectedMessageId: otherViewRow.id }));
    const rowsBeforeResponse = structuredClone(useStore.getState().messages);
    await React.act(async () => { reject(new Error('Move failed after navigation')); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.deepEqual(useStore.getState().messages, rowsBeforeResponse);
    assert.equal(useStore.getState().messages.some(row => row.id === MESSAGE.id), false);
    assert.equal(increments.length, 1);
    assert.equal(increments[0][0], ACCOUNT.id);
  } finally { Object.assign(api, originals); useStore.setState({ incrementUnread: originalIncrement }); }
});

for (const action of ['delete', 'move']) {
  test(`independent: late ${action} rejection after user switch exposes no old notification or mailbox state`, async () => {
    const originals = { deleteMessage: api.deleteMessage, bulkMove: api.bulkMove, getFolders: api.getFolders };
    const originalUser = useStore.getState().user;
    let reject;
    const remote = new Promise((resolve, rejectPromise) => { reject = rejectPromise; });
    api.deleteMessage = () => remote;
    api.bulkMove = () => remote;
    api.getFolders = async () => [{ path: 'Archive', name: 'Archive' }];
    const row = { ...MESSAGE, folder: action === 'delete' ? 'Trash' : 'INBOX', subject: 'OLD USER PRIVATE SUBJECT' };
    try {
      useStore.setState({ user: { id: 'old-user' } });
      await unselected([row], false, row.folder);
      await contextAction(row.id, action === 'delete' ? 'contextMenu.delete' : 'contextMenu.moveToFolder');
      let response;
      if (action === 'delete') {
        const originalTimer = globalThis.setTimeout;
        let commit;
        globalThis.setTimeout = (callback, delay, ...args) => delay === UNDO_COMMIT_DELAY_MS ? (commit = callback, 987654324) : originalTimer(callback, delay, ...args);
        try { await dialogClick('Delete permanently'); } finally { globalThis.setTimeout = originalTimer; }
        await React.act(async () => { response = commit(); await Promise.resolve(); });
      } else {
        const destination = [...document.querySelectorAll('button, span, div')].find(node => node.textContent === 'Archive' && node.children.length === 0);
        await React.act(async () => destination.click());
        const { flushUndoables } = await import('../utils/undoableAction.js');
        await React.act(async () => { flushUndoables(); await Promise.resolve(); });
      }
      const rows = [{ ...MESSAGE, id: 'new-user-mail' }];
      const counts = { total: 37, byAccount: { [ACCOUNT.id]: 37 } };
      await React.act(async () => useStore.setState({ user: { id: 'new-user' }, messages: rows, unreadCounts: counts, notifications: [] }));
      await React.act(async () => { reject(new Error('OLD USER PRIVATE ERROR')); await response; await new Promise(resolve => setTimeout(resolve, 0)); });
      assert.deepEqual(useStore.getState().messages, rows);
      assert.deepEqual(useStore.getState().unreadCounts, counts);
      assert.deepEqual(useStore.getState().notifications, []);
      assert.doesNotMatch(document.body.textContent, /OLD USER PRIVATE/);
    } finally { Object.assign(api, originals); await React.act(async () => useStore.setState({ user: originalUser })); }
  });
}
