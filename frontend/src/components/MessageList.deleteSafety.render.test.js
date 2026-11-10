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
const { shortcutBus } = await import('../utils/shortcutBus.js');
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
const secondThread = { ...THREAD, id: 'second-thread-row', message_id: '<second>', thread_id: 'second-thread', uid: 20 };

test('context bulk delete keeps selection and performs zero DELETE when thread resolution rejects', async () => {
  const originals = { getThread: api.getThread, bulkDelete: api.bulkDelete, deleteMessage: api.deleteMessage };
  const writes = [];
  api.getThread = async () => { throw new Error('Thread unavailable'); };
  api.bulkDelete = async ids => { writes.push(ids); return { deleted: ids }; };
  api.deleteMessage = async id => { writes.push([id]); };
  try {
    await selectRows([THREAD, secondThread]);
    await contextAction(THREAD.id);
    await flushDeletes();
    assert.deepEqual(writes, []);
    assert.equal(container.querySelectorAll('.mailflow-message-row[data-checked="true"]').length, 2);
    assert.match(useStore.getState().notifications.at(-1).body, /Thread unavailable/);
  } finally { Object.assign(api, originals); }
});

async function dialogClick(label) {
  const dialog = document.querySelector('[role="alertdialog"]');
  assert.ok(dialog, 'exact-target confirmation is visible');
  const button = [...dialog.querySelectorAll('button')].find(node => node.textContent === label);
  assert.ok(button, label);
  await React.act(async () => button.click());
}
const toolbarClick = async label => React.act(async () => container.querySelector(`.gmail-toolbar [aria-label="${label}"]`).click());
async function withDeleteSpy(run) {
  const originals = { getThread: api.getThread, bulkDelete: api.bulkDelete, deleteMessage: api.deleteMessage };
  const writes = [];
  api.bulkDelete = async ids => { writes.push([...ids]); return { deleted: ids }; };
  api.deleteMessage = async id => { writes.push([id]); return {}; };
  try { await run(writes); } finally { Object.assign(api, originals); }
}

for (const response of [{}, { messages: [] }, { messages: [{ ...MESSAGE, id: 'not-the-anchor' }] }]) {
  test(`context delete rejects incomplete thread scope ${JSON.stringify(response)}`, async () => withDeleteSpy(async writes => {
    api.getThread = async () => response;
    await selectRows([THREAD, secondThread]);
    await contextAction(THREAD.id); await flushDeletes();
    assert.deepEqual(writes, []);
    assert.equal(container.querySelectorAll('.mailflow-message-row[data-checked="true"]').length, 2);
    assert.match(useStore.getState().notifications.at(-1).body, /fully resolved/);
  }));
}

test('context Trash cancel preserves selection; confirm deletes exactly prepared members once without rereading', async () => withDeleteSpy(async writes => {
  const first = { ...THREAD, folder: 'Trash' };
  const second = { ...secondThread, folder: 'Trash' };
  const member = { ...MESSAGE, id: 'trash-child', folder: 'Trash' };
  let reads = 0;
  api.getThread = async id => { reads++; return { messages: id === first.thread_id ? [first, member] : [second] }; };
  await selectRows([first, second], true, 'Trash');
  await contextAction(first.id);
  assert.match(document.querySelector('[role="alertdialog"]').textContent, /Selected messages: 3/);
  assert.match(document.querySelector('[role="alertdialog"]').textContent, /cannot be recovered/);
  await dialogClick('Cancel'); await flushDeletes();
  assert.deepEqual(writes, []);
  assert.equal(container.querySelectorAll('.mailflow-message-row[data-checked="true"]').length, 2);
  await contextAction(first.id);
  const readsBeforeConfirm = reads;
  api.getThread = async () => { throw new Error('Must not resolve again after confirmation'); };
  await dialogClick('Delete permanently'); await flushDeletes();
  assert.equal(reads, readsBeforeConfirm);
  assert.deepEqual(writes, [[first.id, member.id, second.id]]);
  assert.equal(document.querySelector('[role="alertdialog"]'), null);
}));

test('toolbar prompts only once for a provider Trash mark discovered during resolution', async () => withDeleteSpy(async writes => {
  const row = { ...THREAD, folder: 'Deleted' };
  const member = { ...MESSAGE, id: 'hidden-trash', folder: 'Deleted', in_trash: true };
  api.getThread = async () => ({ messages: [{ ...row, in_trash: true }, member] });
  await selectRows([row], true, 'Deleted');
  await toolbarClick('Delete');
  assert.equal(document.querySelectorAll('[role="alertdialog"]').length, 1);
  assert.equal(document.querySelector('.gmail-toolbar-menu'), null);
  await dialogClick('Delete permanently'); await flushDeletes();
  assert.deepEqual(writes, [[THREAD.id, member.id]]);
}));

for (const change of ['selection', 'account', 'generation', 'source', 'folder']) {
  test(`confirmation aborts without DELETE after ${change} changes`, async () => withDeleteSpy(async writes => {
    const row = { ...MESSAGE, folder: 'Trash' };
    await selectRows([row], false, 'Trash');
    await contextAction(row.id);
    await React.act(async () => {
      if (change === 'selection') container.querySelector('[data-msgid] input[type=checkbox]').click();
      else if (change === 'account') useStore.setState({ selectedAccountId: 'other' });
      else if (change === 'generation') useStore.setState({ accounts: [{ ...ACCOUNT, storage_generation: 'new-generation' }] });
      else if (change === 'source') useStore.setState({ messages: [{ ...row, uid: 99 }] });
      else useStore.setState({ selectedFolder: 'INBOX' });
    });
    await dialogClick('Delete permanently'); await flushDeletes();
    assert.deepEqual(writes, []);
    assert.match(useStore.getState().notifications.at(-1).body, /selection changed/);
  }));
}

test('pending resolution aborts after selection changes; retry resolves and deletes normally', async () => withDeleteSpy(async writes => {
  let finish;
  api.getThread = () => new Promise(resolve => { finish = resolve; });
  await selectRows([THREAD]);
  await contextAction(THREAD.id);
  await React.act(async () => container.querySelector('[data-msgid] input[type=checkbox]').click());
  await React.act(async () => finish({ messages: [THREAD] }));
  await flushDeletes();
  assert.deepEqual(writes, []);
  assert.match(useStore.getState().notifications.at(-1).body, /selection changed/);
  api.getThread = async () => ({ messages: [THREAD] });
  await contextAction(THREAD.id); await flushDeletes();
  assert.deepEqual(writes, [[THREAD.id]]);
}));

test('ordinary context bulk delete resolves all conversations, preserves drafts, and Undo cancels every write', async () => withDeleteSpy(async writes => {
  const member = { ...MESSAGE, id: 'child' }, draft = { ...MESSAGE, id: 'draft-child', is_draft: true, folder: 'Drafts' };
  api.getThread = async id => ({ messages: id === THREAD.thread_id ? [THREAD, member, draft] : [secondThread] });
  await selectRows([THREAD, secondThread]);
  await contextAction(THREAD.id);
  assert.equal(document.querySelector('[role="alertdialog"]'), null, 'recoverable delete gains no confirmation');
  assert.equal(useStore.getState().messages.length, 0);
  await React.act(async () => useStore.getState().notifications.find(n => n.onUndo).onUndo());
  await flushDeletes();
  assert.deepEqual(writes, []);
  assert.deepEqual(useStore.getState().messages.map(row => row.id).sort(), [THREAD.id, secondThread.id].sort());
  await React.act(async () => container.querySelector('[data-gmail-select-all]').click());
  await contextAction(THREAD.id); await flushDeletes();
  assert.deepEqual(writes, [[THREAD.id, member.id, secondThread.id]]);
}));

test('flat rows never expand their conversation and keyboard Trash delete confirms the exact row', async () => withDeleteSpy(async writes => {
  const row = { ...THREAD, folder: 'Trash' };
  api.getThread = async () => { throw new Error('Flat rows must not expand'); };
  await selectRows([row], false, 'Trash');
  await React.act(async () => shortcutBus.emit('delete'));
  await dialogClick('Delete permanently'); await flushDeletes();
  assert.deepEqual(writes, [[row.id]]);
}));

test('context bulk move rejects failed thread resolution instead of moving representatives', async () => {
  const originals = { getThread: api.getThread, bulkMove: api.bulkMove, getFolders: api.getFolders };
  const writes = [];
  api.getThread = async () => { throw new Error('Move scope unavailable'); };
  api.getFolders = async () => [{ path: 'Archive', name: 'Archive' }];
  api.bulkMove = async ids => { writes.push(ids); return { moved: ids }; };
  try {
    await selectRows([THREAD, secondThread]);
    await contextAction(THREAD.id, 'contextMenu.moveToFolder');
    const destination = [...document.querySelectorAll('button, span, div')].find(node => node.textContent === 'Archive' && node.children.length === 0);
    assert.ok(destination);
    await React.act(async () => destination.click());
    const { flushUndoables } = await import('../utils/undoableAction.js');
    await React.act(async () => { flushUndoables(); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.deepEqual(writes, []);
    assert.equal(container.querySelectorAll('.mailflow-message-row[data-checked="true"]').length, 2);
    assert.match(useStore.getState().notifications.at(-1).body, /Move scope unavailable/);
  } finally { Object.assign(api, originals); }
});

test('single context delete never substitutes a different checked row while confirmation is open', async () => withDeleteSpy(async writes => {
  const clicked = { ...MESSAGE, id: 'clicked-trash', message_id: '<clicked-trash>', folder: 'Trash' };
  const selected = { ...MESSAGE, id: 'checked-other', message_id: '<checked-other>', folder: 'Trash', uid: 2 };
  await selectRows([clicked, selected], false, 'Trash');
  await React.act(async () => container.querySelector(`[data-msgid="${clicked.id}"] input[type=checkbox]`).click());
  await contextAction(clicked.id);
  assert.match(document.querySelector('[role="alertdialog"]').textContent, /Selected messages: 1/);
  await dialogClick('Delete permanently'); await flushDeletes();
  assert.deepEqual(writes, [[clicked.id]]);
  assert.equal(container.querySelectorAll('.mailflow-message-row[data-checked="true"]').length, 0,
    'context-click replaced the prior selection with the clicked source, which has now been removed');
  assert.equal(useStore.getState().messages[0].id, selected.id);
}));

test('Inbox delete leaves existing Trash copies and drafts alone without adding a confirmation', async () => withDeleteSpy(async writes => {
  api.getThread = async () => ({ messages: [THREAD, { ...MESSAGE, id: 'already-binned', folder: 'Trash' }, { ...MESSAGE, id: 'unsent', is_draft: true, folder: 'Drafts' }] });
  await selectRows([THREAD]); await toolbarClick('Delete');
  assert.equal(document.querySelector('[role="alertdialog"]'), null);
  await flushDeletes();
  assert.deepEqual(writes, [[THREAD.id]]);
}));

test('unmount during resolution cannot queue a later delete', async () => withDeleteSpy(async writes => {
  let finish;
  api.getThread = () => new Promise(resolve => { finish = resolve; });
  await selectRows([THREAD]); await contextAction(THREAD.id);
  await React.act(async () => root.unmount()); root = null;
  await React.act(async () => finish({ messages: [THREAD] }));
  await flushDeletes();
  assert.deepEqual(writes, []);
}));

test('repeated delete while preparing opens only one confirmation and commits once', async () => withDeleteSpy(async writes => {
  const row = { ...THREAD, folder: 'Trash' };
  let finish, reads = 0;
  api.getThread = () => { reads++; return new Promise(resolve => { finish = resolve; }); };
  await selectRows([row], true, 'Trash');
  await React.act(async () => { shortcutBus.emit('delete'); shortcutBus.emit('delete'); });
  assert.equal(reads, 1);
  await React.act(async () => finish({ messages: [row] }));
  await React.act(async () => shortcutBus.emit('delete'));
  assert.equal(document.querySelectorAll('[role="alertdialog"]').length, 1);
  await dialogClick('Delete permanently'); await flushDeletes();
  assert.deepEqual(writes, [[row.id]]);
}));
