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
    accounts, accountsReady: true, user: { id: 'keyboard-user' }, isLocked: false,
    layout: 'gmail', activeLabel: null, nativeLabelFeed: null, enabledPlugins: [],
    hoverQuickActions: true, hoverActionSet: ['archive', 'delete', 'markRead', 'snooze'],
    markReadBehavior: 'manual', expandedThreadId: null, threadMessages: {}, notifications: [],
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
const { flushUndoables } = await import('../utils/undoableAction.js');
api.savePreferencesOnExit = () => {};

afterEach(async () => {
  await React.act(async () => flushUndoables());
  if (root) await React.act(async () => root.unmount());
  root = null;
  window.dispatchEvent(new window.Event('pagehide'));
});

async function switchLayout(layout) {
  await React.act(async () => useStore.getState().setLayout(layout));
}

const row = id => container.querySelector(`[data-msgid="${id}"] .mailflow-message-row`);
const focusedRow = () => document.activeElement;
async function key(target, key, options = {}) {
  const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  await React.act(async () => target.dispatchEvent(event));
  return event;
}
async function focus(target) { await React.act(async () => target.focus()); }
async function context(target) { await React.act(async () => target.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }))); }
const second = { ...MESSAGE, id: 'second', uid: 2, subject: 'Second subject', message_id: '<second@test>' };
const checkedIds = () => [...container.querySelectorAll('.mailflow-message-row[data-checked="true"]')].map(el => el.closest('[data-msgid]').dataset.msgid);

for (const threadedView of [false, true]) {
  test(`Gmail ${threadedView ? 'thread' : 'flat'} rows have named groups, roving focus, selection and independent opening`, async () => {
    const first = threadedView ? THREAD : MESSAGE;
    await mount({ rows: [first, second], threadedView });
    assert.equal(row(first.id).getAttribute('role'), 'group');
    assert.ok(row(first.id).getAttribute('aria-label').includes(first.subject));
    assert.equal(row(first.id).tabIndex, 0);
    assert.equal(row(second.id).tabIndex, -1);
    await focus(row(first.id));
    assert.ok(row(first.id).querySelector('button[title="message.delete"]') || row(first.id).querySelector('button[title="common.delete"]'), 'focus reveals quick actions');
    assert.equal((await key(row(first.id), 'ArrowDown')).defaultPrevented, true);
    assert.equal(focusedRow(), row(second.id));
    assert.equal(useStore.getState().selectedMessageId, null, 'navigation does not open or mark mail');
    await key(row(second.id), ' ');
    assert.deepEqual(checkedIds(), [second.id]);
    await key(row(second.id), 'Enter');
    assert.equal(useStore.getState().selectedMessageId, second.id, 'Enter opens even in selection mode');
    await key(row(second.id), 'Home');
    assert.equal(focusedRow(), row(first.id));
    await key(row(first.id), 'End');
    assert.equal(focusedRow(), row(second.id));
  });
}

test('Gmail context targeting retains a selected multi-set and replaces it for an unselected row', async () => {
  const third = { ...MESSAGE, id: 'third', uid: 3, subject: 'Third', message_id: '<third@test>' };
  await mount({ rows: [MESSAGE, second, third], threadedView: false });
  await key(row(MESSAGE.id), ' ');
  await key(row(second.id), ' ');
  await context(row(second.id));
  assert.deepEqual(checkedIds(), [MESSAGE.id, second.id]);
  await key(document.activeElement, 'Escape');
  assert.ok(row(third.id), JSON.stringify({messages:useStore.getState().messages, calls:CALLS}));
  await context(row(third.id));
  assert.deepEqual(checkedIds(), [third.id]);
  assert.equal(useStore.getState().selectedMessageId, null);
});

test('Gmail embedded controls keep native keys without opening or moving rows twice', async () => {
  await mount({ rows: [MESSAGE, second], threadedView: false });
  const checkbox = row(MESSAGE.id).querySelector('input[type="checkbox"]');
  await focus(checkbox);
  assert.equal((await key(checkbox, ' ')).defaultPrevented, false);
  assert.equal((await key(checkbox, 'ArrowDown')).defaultPrevented, false);
  assert.equal(focusedRow(), checkbox);
  await React.act(async () => checkbox.click());
  assert.deepEqual(checkedIds(), [MESSAGE.id]);
  assert.equal(useStore.getState().selectedMessageId, null);
  assert.equal((await key(row(MESSAGE.id), 'Enter', { ctrlKey: true })).defaultPrevented, false);
});

test('Gmail expanded child gets its own focus and exact selection instead of the thread representative', async () => {
  const child = { ...second, thread_id: THREAD.thread_id };
  await mount({ rows: [THREAD], threadedView: true });
  await React.act(async () => useStore.setState({ expandedThreadId: THREAD.thread_id, threadMessages: { [THREAD.thread_id]: [child] } }));
  const childRow = container.querySelector('.mailflow-thread-message-row');
  await focus(row(THREAD.id));
  await key(row(THREAD.id), 'ArrowDown');
  assert.equal(focusedRow(), childRow);
  await key(childRow, ' ');
  assert.equal(childRow.dataset.checked, 'true');
  assert.equal(row(THREAD.id).dataset.checked, 'false');
  const toolbar = container.querySelector('.gmail-toolbar');
  assert.ok(toolbar.querySelector('button[title="gmailToolbar.delete"]') || [...toolbar.querySelectorAll('button')].some(button => /delete/i.test(button.getAttribute('aria-label') || button.title)), 'child selection reaches toolbar');
  await key(childRow, 'Enter');
  assert.equal(useStore.getState().selectedMessageId, child.id);
});

test('Gmail focus resets safely when rows disappear or the account generation changes', async () => {
  await mount({ rows: [MESSAGE, second], threadedView: false });
  await focus(row(second.id));
  await React.act(async () => useStore.setState({ messages: [MESSAGE] }));
  assert.equal(row(MESSAGE.id).tabIndex, 0);
  await React.act(async () => useStore.setState({ accounts: [{ ...ACCOUNT, storage_generation: 'replacement' }] }));
  assert.equal(useStore.getState().selectedMessageId, null);
});

test('native layout retains its existing navigation and does not gain Gmail row semantics', async () => {
  await mount({ rows: [MESSAGE, second], threadedView: false });
  await switchLayout('comfortable');
  assert.equal(row(MESSAGE.id).getAttribute('role'), null);
  assert.equal(row(MESSAGE.id).getAttribute('tabindex'), null);
  await React.act(async () => shortcutBus.emit('nextMessage'));
  assert.equal(useStore.getState().selectedMessageId, MESSAGE.id);
});

test('row keys preserve explicit mappings, composition, modifier defaults and repeat protection', async () => {
  await mount({ rows: [MESSAGE, second], threadedView: false });
  await focus(row(MESSAGE.id));
  await React.act(async () => useStore.setState({ shortcuts: { compose: 'Enter' } }));
  assert.equal((await key(row(MESSAGE.id), 'Enter')).defaultPrevented, false);
  assert.equal(useStore.getState().selectedMessageId, null);
  await React.act(async () => useStore.setState({ shortcuts: {} }));
  for (const options of [{ isComposing: true }, { keyCode: 229 }, { altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
    assert.equal((await key(row(MESSAGE.id), 'ArrowDown', options)).defaultPrevented, false);
    assert.equal(focusedRow(), row(MESSAGE.id));
  }
  await key(row(MESSAGE.id), ' ', { repeat: true });
  assert.deepEqual(checkedIds(), []);
  await key(row(MESSAGE.id), ' ');
  await key(row(MESSAGE.id), 'Escape', { repeat: true });
  assert.deepEqual(checkedIds(), [MESSAGE.id]);
});

test('roving focus skips hidden rows, and disabled embedded controls keep native behavior', async () => {
  const third = { ...second, id: 'third', uid: 3, message_id: '<third@test>' };
  await mount({ rows: [MESSAGE, second, third], threadedView: false });
  row(second.id).hidden = true;
  await focus(row(MESSAGE.id));
  await key(row(MESSAGE.id), 'ArrowDown');
  assert.equal(focusedRow(), row(third.id));
  const button = row(third.id).querySelector('button');
  button.disabled = true;
  assert.equal((await key(button, 'Enter')).defaultPrevented, false);
  assert.equal((await key(button, 'ArrowDown')).defaultPrevented, false);
  assert.equal(useStore.getState().selectedMessageId, null);
});

test('keyboard context opens for the focused row and cancellation restores focus without clearing its selection', async () => {
  await mount({ rows: [MESSAGE, second], threadedView: false });
  row(second.id).getClientRects = () => [{ width: 500, height: 40 }];
  await focus(row(second.id));
  await key(row(second.id), 'F10', { shiftKey: true });
  assert.deepEqual(checkedIds(), [second.id]);
  assert.ok(document.querySelector('[data-mailflow-context-menu]'));
  await key(document.activeElement, 'Escape');
  assert.equal(document.querySelector('[data-mailflow-context-menu]'), null);
  assert.equal(document.activeElement === row(second.id), true, document.activeElement?.outerHTML?.slice(0, 300));
  assert.deepEqual(checkedIds(), [second.id]);
});

for (const aggregate of [false, true]) test(`expanded focus reveals working individual quick actions with aggregate metadata ${aggregate}`, async () => {
  const child = aggregate ? { ...THREAD, is_read: false } : { ...MESSAGE, id: THREAD.id, thread_id: THREAD.thread_id };
  const originalRead = api.bulkRead, originalThread = api.getThread;
  const writes = [], resolutions = [];
  api.bulkRead = async ids => { writes.push(ids); };
  api.getThread = async (...args) => { resolutions.push(args); return { messages: [child, second] }; };
  try {
    await mount({ rows: [THREAD], threadedView: true });
    await React.act(async () => useStore.setState({ expandedThreadId: THREAD.thread_id, threadMessages: { [THREAD.thread_id]: [child] } }));
    const target = container.querySelector('.mailflow-thread-message-row');
    await focus(target);
    const read = target.querySelector('button[title="contextMenu.markRead"]');
    assert.ok(read);
    await React.act(async () => read.click());
    assert.deepEqual(writes, [[child.id]]);
    assert.deepEqual(resolutions, []);
  } finally { api.bulkRead = originalRead; api.getThread = originalThread; }
});

for (const preset of ['All', 'None', 'Read', 'Unread', 'Starred', 'Unstarred']) {
  test(`selection preset ${preset} keeps the top-level pool distinct from a same-ID child selection`, async () => {
    const parent = { ...THREAD, is_read: true, is_starred: true, unread_count: 0 };
    const child = { ...MESSAGE, id: parent.id, thread_id: parent.thread_id, is_read: false, is_starred: false };
    await mount({ rows: [parent, second], threadedView: true });
    await React.act(async () => useStore.setState({ expandedThreadId: parent.thread_id, threadMessages: { [parent.thread_id]: [child] } }));
    const childRow = container.querySelector('.mailflow-thread-message-row');
    await key(childRow, ' ');
    assert.equal(container.querySelector('[data-gmail-select-all]').getAttribute('aria-checked'), 'mixed');
    assert.equal(row(parent.id).dataset.checked, 'false');
    const options = container.querySelector('button[aria-label="Selection options"]');
    await React.act(async () => options.click());
    const choice = [...document.querySelectorAll('[role=menuitem]')].find(item => item.textContent === preset);
    assert.ok(choice);
    await React.act(async () => choice.click());
    const expected = preset === 'All' ? [parent.id, second.id] : ['Read', 'Starred'].includes(preset) ? [parent.id]
      : ['Unread', 'Unstarred'].includes(preset) ? [second.id] : [];
    assert.deepEqual(checkedIds(), expected);
    assert.equal(childRow.dataset.checked, 'false');
    assert.equal(container.querySelector('.gmail-toolbar-range').textContent, '1–2 of 2', 'pagination counts top-level rows only');
  });
}

for (const action of ['markRead', 'markSpam', 'toggleStar']) {
  for (const field of ['user', 'isLocked', 'accounts']) {
    test(`${action} rejects a synchronous ${field} away-and-back transition during resolution`, async () => {
      const original = { getThread: api.getThread, bulkRead: api.bulkRead, markSpam: api.markSpam, markStarred: api.markStarred };
      const writes = []; let finish;
      api.getThread = () => new Promise(resolve => { finish = resolve; });
      api.bulkRead = async ids => { writes.push(ids); };
      api.markSpam = async id => { writes.push([id]); };
      api.markStarred = async id => { writes.push([id]); };
      try {
        await mount({ rows: [THREAD], threadedView: true });
        await focus(row(THREAD.id));
        if (action !== 'toggleStar') await key(row(THREAD.id), ' ');
        await React.act(async () => shortcutBus.emit(action));
        assert.equal(typeof finish, 'function');
        const before = useStore.getState()[field];
        const changed = field === 'user' ? { id: 'replacement' } : field === 'accounts' ? [{ ...ACCOUNT, storage_generation: 'replacement' }] : true;
        await React.act(async () => { useStore.setState({ [field]: changed }); useStore.setState({ [field]: before }); });
        await React.act(async () => finish({ messages: [{ ...MESSAGE, id: THREAD.id, thread_id: THREAD.thread_id }, second] }));
        await React.act(async () => flushUndoables());
        assert.deepEqual(writes, []);
      } finally { Object.assign(api, original); }
    });
  }
}

test('queued spam rejects a transient replacement identity before dispatch', async () => {
  const original = api.markSpam, writes = [];
  api.markSpam = async id => { writes.push(id); return {}; };
  try {
    await mount({ rows: [MESSAGE], threadedView: false });
    await key(row(MESSAGE.id), ' ');
    await React.act(async () => shortcutBus.emit('markSpam'));
    assert.ok(useStore.getState().notifications.some(item => item.onUndo));
    const user = useStore.getState().user;
    await React.act(async () => { useStore.setState({ user: { id: 'other' } }); useStore.setState({ user }); });
    await React.act(async () => flushUndoables());
    assert.deepEqual(writes, []);
  } finally { api.markSpam = original; }
});

test('a replacement identity triggered by the first spam send prevents remaining per-message sends', async () => {
  const original = api.markSpam, writes = [];
  api.markSpam = async id => { writes.push(id); useStore.setState({ user: { id: 'other' } }); return {}; };
  try {
    await mount({ rows: [MESSAGE, second], threadedView: false });
    await key(row(MESSAGE.id), ' '); await key(row(second.id), ' ');
    await React.act(async () => shortcutBus.emit('markSpam'));
    await React.act(async () => flushUndoables());
    assert.deepEqual(writes, [MESSAGE.id]);
  } finally { api.markSpam = original; }
});

test('spam Undo restores copied original rows instead of later-mutated source objects', async () => {
  const source = { ...MESSAGE }, id = source.id, originalSubject = source.subject;
  await mount({ rows: [source], threadedView: false });
  await key(row(id), ' ');
  await React.act(async () => shortcutBus.emit('markSpam'));
  const undo = useStore.getState().notifications.find(item => item.onUndo).onUndo;
  source.id = 'mutated'; source.subject = 'Later mutation';
  await React.act(async () => undo());
  assert.equal(useStore.getState().messages[0].id, id);
  assert.equal(useStore.getState().messages[0].subject, originalSubject);
});

test('toolbar snooze interrupts remaining sends and refreshes when identity changes during its first request', async () => {
  const original = { snoozeMessage: api.snoozeMessage, getUnreadCounts: api.getUnreadCounts };
  let finish; const writes = [], refreshes = [];
  api.snoozeMessage = id => { writes.push(id); return new Promise(resolve => { finish = resolve; }); };
  api.getUnreadCounts = async () => { refreshes.push('counts'); return {}; };
  try {
    await mount({ rows: [MESSAGE, second], threadedView: false });
    await key(row(MESSAGE.id), ' '); await key(row(second.id), ' ');
    const snooze = container.querySelector('.gmail-toolbar button[aria-label="Snooze"]');
    await React.act(async () => snooze.click());
    const tomorrow = [...document.querySelectorAll('.gmail-toolbar-menu button')].find(button => button.textContent.startsWith('Tomorrow'));
    await React.act(async () => tomorrow.click());
    assert.equal(typeof finish, 'function');
    await React.act(async () => useStore.setState({ user: { id: 'replacement' } }));
    await React.act(async () => finish({}));
    assert.deepEqual(writes, [MESSAGE.id]);
    assert.deepEqual(refreshes, []);
    assert.equal(useStore.getState().messages.length, 2, 'late result does not remove replacement-session rows');
  } finally { Object.assign(api, original); }
});

test('explicit unread cancels pending automatic read even when a checked row is already unread', async () => {
  const { scheduleMarkReadTimer } = await import('../utils/markRead.js');
  let automaticReads = 0;
  await mount({ rows: [MESSAGE], threadedView: false });
  await key(row(MESSAGE.id), ' ');
  scheduleMarkReadTimer(MESSAGE.id, () => { automaticReads++; }, 5);
  await React.act(async () => shortcutBus.emit('markUnread'));
  await React.act(async () => new Promise(resolve => setTimeout(resolve, 15)));
  assert.equal(automaticReads, 0);
});

for (const threadedView of [false, true]) {
  test(`same-ID ${threadedView ? 'thread' : 'flat'} locator replacement relinquishes focus without selecting or opening replacement mail`, async () => {
    const original = threadedView ? THREAD : MESSAGE;
    const replacement = { ...original, uid: 99, subject: 'Replacement mailbox item' };
    await mount({ rows: [original, second], threadedView });
    await focus(row(original.id));
    await key(row(original.id), ' ');
    const reusedElement = row(original.id);
    await React.act(async () => useStore.setState({ messages: [replacement, second] }));
    assert.equal(row(original.id) === reusedElement, true, 'React reused the same id DOM node');
    assert.equal(document.activeElement === reusedElement, false, 'replacement mail does not inherit focus');
    assert.equal(document.activeElement === row(second.id), false, 'replacement does not promote another row into focus');
    assert.deepEqual(checkedIds(), [], 'the replaced selected source is discarded');
    assert.equal(useStore.getState().selectedMessageId, null);
    assert.equal(reusedElement.querySelector('button[title="common.delete"], button[title="message.delete"]'), null, 'focus-only actions hide after source replacement');
  });
}
