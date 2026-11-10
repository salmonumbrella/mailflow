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
const GtdTriageRow = (await import('./GtdTriageRow.jsx')).default;
const { dispatchHoveredGtdShortcut } = await import('../utils/gtdHoveredRow.js');

afterEach(async () => {
  if (root) await React.act(async () => root.unmount());
  root = null;
  window.dispatchEvent(new window.Event('pagehide'));
});

async function switchLayout(layout) {
  await React.act(async () => useStore.getState().setLayout(layout));
}

async function clickRow(id, options = {}) {
  const target = container.querySelector(`[data-msgid="${id}"] [draggable]`);
  assert.ok(target, 'the existing drag/click target remains available');
  await React.act(async () => target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, ...options })));
}

for (const threadedView of [false, true]) {
  test(`Gmail ${threadedView ? 'thread' : 'message'} rows retain selection, modifiers, and drag after repeated layout switches`, async () => {
    const first = threadedView ? THREAD : MESSAGE;
    const second = { ...first, id: 'second', uid: 2, message_id: '<second@example.invalid>', thread_id: 'second-thread', subject: 'Second subject' };
    await mount({ rows: [first, second], threadedView });
    for (const layout of ['gmail', 'list', 'comfortable', 'gmail']) {
      await switchLayout(layout);
      const row = container.querySelector(`[data-msgid="${first.id}"] .mailflow-message-row`);
      assert.ok(row, 'both message and thread rows expose the shared presentation hook');
      assert.equal(row.dataset.unread, 'true');
      assert.equal(row.getAttribute('draggable'), 'true');
      assert.ok(row.querySelector('.mailflow-row-sender'));
      assert.ok(row.querySelector('.mailflow-row-subject'));
      assert.ok(row.querySelector('.mailflow-row-preview'));
    }
    await clickRow(first.id);
    assert.equal(useStore.getState().selectedMessageId, first.id);
    assert.equal(container.querySelector(`[data-msgid="${first.id}"] .mailflow-message-row`).dataset.selected, 'true');
    await clickRow(second.id, { ctrlKey: true });
    assert.equal(useStore.getState().selectedMessageId, first.id, 'modifier click must not open another message');
    const checked = [...container.querySelectorAll('.mailflow-message-row[data-checked="true"]')];
    assert.equal(checked.length, 2, 'the open row and clicked row stay selected for bulk actions');
    const payload = {};
    const drag = new window.Event('dragstart', { bubbles: true });
    Object.defineProperty(drag, 'dataTransfer', { value: { setData: (type, data) => { payload[type] = data; }, setDragImage() {} } });
    await React.act(async () => checked[0].dispatchEvent(drag));
    assert.ok(Object.keys(payload).length, 'drag still carries the message payload');
  });
}

test('Gmail preserves selected-message keyboard shortcuts', async () => {
  await mount({ rows: [{ ...MESSAGE, is_read: true }], threadedView: false });
  await switchLayout('gmail');
  await clickRow(MESSAGE.id);
  assert.equal(useStore.getState().messages[0].is_read, true);
  CALLS = [];
  await React.act(async () => shortcutBus.emit('markUnread'));
  assert.equal(useStore.getState().selectedMessageId, MESSAGE.id);
  assert.equal(useStore.getState().messages[0].is_read, false);
  assert.ok(CALLS.some(call => call.body?.read === false), 'the shortcut writes the unread change');
});

test('Gmail GTD row retains open, context-menu scope, hover shortcuts, and cleanup', async () => {
  const calls = [];
  const row = { ...MESSAGE, account_id: ACCOUNT.id };
  useStore.setState({
    enabledPlugins: ['gtd'], accounts: [{ ...ACCOUNT, gtd_enabled: true }],
    gtdSections: { todo: { threads: [row] } }, messages: [], threadMessages: {},
  });
  await switchLayout('gmail');
  container = document.getElementById('root');
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(GtdTriageRow, {
    thread: row, sectionKey: 'todo', variant: 'sidebar', selected: false,
    t: key => key, hoverQuickActions: false,
    onOpen: () => calls.push(['open']),
    rowActions: {
      openMenu: details => calls.push(['menu', details.message.id, details.doneStates]),
      classifyRow: (message, state) => calls.push(['classify', message.id, state]),
      done: (message, states) => calls.push(['done', message.id, states]),
    },
  })));
  const element = container.firstElementChild;
  await React.act(async () => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    element.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  });
  assert.equal(dispatchHoveredGtdShortcut('gtdWatch', useStore.getState()), true);
  assert.equal(dispatchHoveredGtdShortcut('archive', useStore.getState()), true);
  assert.deepEqual(calls, [
    ['open'], ['menu', MESSAGE.id, ['todo']],
    ['classify', MESSAGE.id, 'watch'], ['done', MESSAGE.id, ['todo']],
  ]);
  await switchLayout('comfortable');
  await React.act(async () => root.unmount());
  root = null;
  assert.equal(dispatchHoveredGtdShortcut('gtdWatch', useStore.getState()), false);
});

test('Gmail header search uses the native query and reveals results from an open reader', async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  try {
    await mount({ rows: [MESSAGE], threadedView: false, gmailSearchTarget: host });
    await switchLayout('gmail');
    await React.act(async () => useStore.setState({ selectedMessageId: MESSAGE.id, showContacts: true }));
    const input = host.querySelector('input');
    assert.ok(input, 'the existing search input is portaled into the header');
    assert.equal(container.querySelector('.mailflow-mail-search'), null, 'there is no duplicate search below the header');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'invoice');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    assert.equal(useStore.getState().searchQuery, 'invoice');
    assert.equal(useStore.getState().selectedMessageId, null);
    assert.equal(useStore.getState().showContacts, false);
    const clear = host.querySelector('button[aria-label="messageList.clearSearch"]');
    assert.ok(clear);
    await React.act(async () => clear.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    assert.equal(useStore.getState().searchQuery, '');
  } finally {
    if (root) await React.act(async () => root.unmount());
    root = null;
    host.remove();
  }
});

for (const threadedView of [false, true]) {
  test(`Gmail ${threadedView ? 'thread' : 'message'} checkboxes support ranges and stars do not open mail`, async () => {
    const first = threadedView ? THREAD : MESSAGE;
    const rows = [first, ...['middle', 'last'].map((id, index) => ({
      ...first, id, uid: index + 10, message_id: `<${id}@example.invalid>`, thread_id: `${id}-thread`,
    }))];
    await mount({ rows, threadedView });
    await switchLayout('gmail');
    const controls = id => container.querySelector(`[data-msgid="${id}"] .mailflow-gmail-row-controls`);
    await React.act(async () => controls(first.id).querySelector('input').dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    await React.act(async () => controls('last').querySelector('input').dispatchEvent(new window.MouseEvent('click', { bubbles: true, shiftKey: true })));
    assert.equal(container.querySelectorAll('.mailflow-gmail-row-controls input:checked').length, 3);
    assert.equal(useStore.getState().selectedMessageId, null, 'checkboxes do not open a reader');
    await React.act(async () => controls('middle').querySelector('button').dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    assert.equal(useStore.getState().messages.find(message => message.id === 'middle').is_starred, true);
    assert.equal(useStore.getState().selectedMessageId, null, 'starring does not open a reader');
    assert.equal(controls('middle').querySelector('button').getAttribute('aria-pressed'), 'true');
    await switchLayout('comfortable');
    assert.equal(container.querySelector('.mailflow-gmail-row-controls'), null, 'native layouts keep their original row controls');
    await switchLayout('gmail');
    assert.ok(controls('middle'), 'Gmail restores the native row controls after a layout switch');
    await React.act(async () => controls('middle').querySelector('button').dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    assert.equal(useStore.getState().messages.find(message => message.id === 'middle').is_starred, false);
    assert.equal(useStore.getState().selectedMessageId, null);
  });
}

test('Gmail search stays usable across repeated Scheduled and mailbox transitions', async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  try {
    await mount({ rows: [MESSAGE], threadedView: false, gmailSearchTarget: host });
    await switchLayout('gmail');
    for (const query of ['first', 'second']) {
      await React.act(async () => {
        useStore.getState().setSelectedAccount(null, '__scheduled__');
        useStore.setState({ scheduledList: { messages: [] } });
      });
      const scheduledInput = host.querySelector('input');
      assert.ok(scheduledInput, 'the Scheduled view keeps a header search input');
      await React.act(async () => shortcutBus.emit('focusSearch'));
      assert.equal(document.activeElement, scheduledInput);
      await React.act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(scheduledInput, query);
        scheduledInput.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
      assert.equal(useStore.getState().selectedFolder, 'INBOX');
      assert.equal(useStore.getState().searchQuery, query);
      assert.equal(host.querySelectorAll('input').length, 1);
      assert.equal(document.activeElement, host.querySelector('input'), 'typing focus follows the new native mailbox search');
    }
  } finally {
    if (root) await React.act(async () => root.unmount());
    root = null;
    host.remove();
  }
});

test('Gmail archive uses native delayed commit and Undo restores the message', async () => {
  await mount({ rows: [{ ...MESSAGE, id: 'archive-gmail', message_id: '<archive-gmail@example.invalid>' }], threadedView: false });
  await switchLayout('gmail');
  await clickRow('archive-gmail');
  CALLS = [];
  await React.act(async () => shortcutBus.emit('archive'));
  assert.equal(useStore.getState().messages.some(message => message.id === 'archive-gmail'), false);
  const undo = useStore.getState().notifications.find(notification => typeof notification.onUndo === 'function');
  assert.ok(undo, 'native archive offers Undo');
  assert.equal(CALLS.some(call => call.path.includes('archive') && call.method !== 'GET'), false, 'archive is not committed before its Undo window');
  await React.act(async () => undo.onUndo());
  assert.ok(useStore.getState().messages.some(message => message.id === 'archive-gmail'));
});

test('Gmail archive commits the correct message through the existing archive endpoint', async () => {
  await mount({ rows: [{ ...MESSAGE, id: 'archive-gmail-commit', message_id: '<archive-gmail-commit@example.invalid>' }], threadedView: false });
  await switchLayout('gmail');
  await clickRow('archive-gmail-commit');
  CALLS = [];
  await React.act(async () => shortcutBus.emit('archive'));
  const { flushUndoables } = await import('../utils/undoableAction.js');
  await React.act(async () => { flushUndoables(); await new Promise(resolve => setTimeout(resolve, 20)); });
  const archived = CALLS.find(call => call.path.endsWith('/mail/messages/bulk-archive'));
  assert.ok(archived, 'the page-exit flush commits the pending native archive');
  assert.deepEqual(archived.body.ids, ['archive-gmail-commit']);
});

test('Gmail GTD triage reaches the native classify and Undo APIs without changing the selected email', async () => {
  const { useGtdTriage } = await import('../hooks/useGtdTriage.js');
  const originalClassify = api.gtdClassify;
  const originalUndo = api.gtdUndoClassify;
  const calls = [];
  const row = { ...MESSAGE, id: 'gmail-gtd', message_id: '<gmail-gtd@example.invalid>' };
  const undoToken = { messageId: row.id, state: 'watch', folder: 'Watch', uid: 123 };
  api.gtdClassify = async (id, state) => { calls.push(['classify', id, state]); return { applied: true, undoToken }; };
  api.gtdUndoClassify = async token => { calls.push(['undo', token]); };
  const originalSchedule = useStore.getState().scheduleGtdSectionsFetch;
  useStore.setState({
    enabledPlugins: ['gtd'], accounts: [{ ...ACCOUNT, gtd_enabled: true }],
    gtdSections: { todo: { threads: [row] } }, messages: [], threadMessages: {},
    selectedMessageId: 'reader-elsewhere', notifications: [], scheduleGtdSectionsFetch() {},
  });
  await switchLayout('gmail');
  function NativeTriage() {
    const { rowActions } = useGtdTriage();
    return React.createElement(GtdTriageRow, {
      thread: row, sectionKey: 'todo', variant: 'sidebar', selected: false,
      t: key => key, onOpen() {}, hoverQuickActions: false, rowActions,
    });
  }
  container = document.getElementById('root');
  root = createRoot(container);
  try {
    await React.act(async () => root.render(React.createElement(NativeTriage)));
    await React.act(async () => container.firstElementChild.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })));
    await React.act(async () => { assert.equal(dispatchHoveredGtdShortcut('gtdWatch', useStore.getState()), true); });
    assert.deepEqual(calls, [['classify', row.id, 'watch']]);
    const undo = useStore.getState().notifications.find(notification => notification.onUndo);
    assert.ok(undo);
    await React.act(async () => undo.onUndo());
    assert.deepEqual(calls[1], ['undo', undoToken]);
    assert.equal(useStore.getState().selectedMessageId, 'reader-elsewhere');
  } finally {
    await React.act(async () => root.unmount());
    root = null;
    api.gtdClassify = originalClassify;
    api.gtdUndoClassify = originalUndo;
    useStore.setState({ scheduleGtdSectionsFetch: originalSchedule });
  }
});

test('Gmail persistent selection control supports mixed state and every selection preset', async () => {
  const rows = [MESSAGE, { ...MESSAGE, id: 'read-star', uid: 2, message_id: '<read-star>', is_read: true, is_starred: true }, { ...MESSAGE, id: 'read', uid: 3, message_id: '<read>', is_read: true }];
  await mount({ rows, threadedView: false });
  await switchLayout('gmail');
  const checkbox = () => container.querySelector('[data-gmail-select-all]');
  assert.ok(checkbox(), 'select-all is present without entering selection mode');
  assert.equal(checkbox().checked, false);
  const selectPreset = async name => {
    await React.act(async () => container.querySelector('[aria-label="Selection options"]').click());
    const option = [...container.querySelectorAll('[role="menuitem"]')].find(el => el.textContent === name);
    assert.ok(option, name);
    await React.act(async () => option.click());
    return [...container.querySelectorAll('.mailflow-message-row[data-checked="true"]')].length;
  };
  assert.equal(await selectPreset('Read'), 2);
  assert.equal(checkbox().indeterminate, true);
  assert.equal(await selectPreset('Unread'), 1);
  assert.equal(await selectPreset('Starred'), 1);
  assert.equal(await selectPreset('Unstarred'), 2);
  assert.equal(await selectPreset('All'), 3);
  assert.equal(checkbox().checked, true);
  assert.equal(checkbox().indeterminate, false);
  assert.equal(await selectPreset('None'), 0);
  assert.equal(checkbox().indeterminate, false);
  await switchLayout('comfortable');
  assert.equal(checkbox(), null);
});

test('Gmail selection menu keyboard navigation, Escape and outside dismissal preserve selection', async () => {
  await mount({ rows: [MESSAGE], threadedView: false });
  await switchLayout('gmail');
  const trigger = container.querySelector('[aria-label="Selection options"]');
  await React.act(async () => trigger.click());
  const key = async value => React.act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true })));
  assert.equal(document.activeElement.textContent, 'All');
  await key('End'); assert.equal(document.activeElement.textContent, 'Unstarred');
  await key('ArrowDown'); assert.equal(document.activeElement.textContent, 'All');
  await key('ArrowUp'); assert.equal(document.activeElement.textContent, 'Unstarred');
  await key('Home'); assert.equal(document.activeElement.textContent, 'All');
  await key('Escape');
  assert.equal(document.activeElement, trigger);
  assert.equal(container.querySelector('[role="menu"][aria-label="Select messages"]'), null);
  await React.act(async () => trigger.click());
  await React.act(async () => document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true })));
  assert.equal(container.querySelector('[role="menu"][aria-label="Select messages"]'), null);
  assert.equal(container.querySelectorAll('.mailflow-message-row[data-checked="true"]').length, 0);
});

const toolbarButton = label => container.querySelector(`.gmail-toolbar [aria-label="${label}"]`);
const toolbarClick = async label => { const el = toolbarButton(label); assert.ok(el, label); await React.act(async () => el.click()); };
const menuClick = async label => { const el = [...document.querySelectorAll('.gmail-toolbar-menu button')].find(button => button.textContent === label); assert.ok(el, label); await React.act(async () => el.click()); };
async function selectToolbarRows(rows, threadedView = false) {
  useStore.setState({ notifications: [], layout: 'gmail', scrollMode: 'infinite', enabledPlugins: [] });
  await mount({ rows, threadedView });
  await React.act(async () => container.querySelector('[data-gmail-select-all]').click());
}

test('Gmail toolbar More and Escape preserve selected identity and restore focus across layout changes', async () => {
  await selectToolbarRows([MESSAGE]);
  const trigger = toolbarButton('More');
  await toolbarClick('More');
  assert.equal(document.activeElement.textContent, 'Mark as read');
  await React.act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true })));
  assert.equal(document.activeElement.textContent, 'Forward as attachment');
  await React.act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(document.activeElement, trigger);
  assert.equal(document.querySelector('.gmail-toolbar-menu'), null);
  assert.ok(toolbarButton('Archive'), 'Escape only dismisses the menu, not the selection');
  await toolbarClick('More');
  await switchLayout('comfortable');
  assert.equal(document.querySelector('.gmail-toolbar-menu'), null);
  assert.equal(document.querySelector('.gmail-toolbar'), null);
  await switchLayout('gmail');
  assert.ok(toolbarButton('Archive'));
});

test('Gmail toolbar read resolves the selected thread and excludes unselected conversations', async () => {
  const originalThread = api.getThread, originalRead = api.bulkRead;
  const calls = [];
  const member = { ...MESSAGE, id: 'member', thread_id: THREAD.thread_id, is_read: true };
  api.getThread = async (...args) => { calls.push(['thread', ...args]); return { messages: [THREAD, member] }; };
  api.bulkRead = async (...args) => { calls.push(['read', ...args]); };
  try {
    const { clearReadGuard } = await import('../utils/pendingReads.js');
    clearReadGuard(THREAD.id);
    await selectToolbarRows([THREAD], true);
    await toolbarClick('Mark as read');
    assert.deepEqual(calls[0], ['thread', 'thr-1', 'INBOX', false]);
    assert.deepEqual(calls[1], ['read', ['msg-2', 'member'], true]);
    assert.equal(useStore.getState().messages[0].is_read, true);
  } finally { api.getThread = originalThread; api.bulkRead = originalRead; }
});

test('Gmail toolbar delete fails closed when selected thread cannot resolve', async () => {
  const original = api.getThread; const originalDelete = api.bulkDelete; let deleted = 0;
  api.getThread = async () => { throw new Error('Thread unavailable'); };
  api.bulkDelete = async () => { deleted++; return { deleted: [] }; };
  try {
    await selectToolbarRows([THREAD], true);
    await toolbarClick('Delete');
    assert.equal(deleted, 0);
    assert.equal(useStore.getState().messages[0].id, THREAD.id);
    assert.ok(toolbarButton('Delete'), 'selection is retained for retry');
    assert.match(useStore.getState().notifications.at(-1).body, /Thread unavailable/);
  } finally { api.getThread = original; api.bulkDelete = originalDelete; }
});

test('Gmail toolbar move uses exact selected thread members, restores failed native move and counts', async () => {
  const originals = { getThread: api.getThread, bulkMove: api.bulkMove, getFolders: api.getFolders };
  const member = { ...MESSAGE, id: 'member', thread_id: THREAD.thread_id };
  const calls = [];
  api.getThread = async () => ({ messages: [THREAD, member] });
  api.getFolders = async () => [{ path: 'Archive', name: 'Archive' }];
  api.bulkMove = async (...args) => { calls.push(args); throw new Error('Move failed'); };
  try {
    await selectToolbarRows([THREAD], true);
    await toolbarClick('Move to'); await menuClick('Archive');
    assert.equal(useStore.getState().messages.length, 0);
    const { flushUndoables } = await import('../utils/undoableAction.js');
    await React.act(async () => { flushUndoables(); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.deepEqual(calls, [[['msg-2', 'member'], 'Archive']]);
    assert.equal(useStore.getState().messages[0].id, 'msg-2');
    assert.ok(useStore.getState().notifications.some(n => n.title === 'messageList.bulkMoved.failTitle'));
  } finally { Object.assign(api, originals); }
});

test('Gmail toolbar snooze cancel has no effects, failed snooze leaves row selected', async () => {
  const original = api.snoozeMessage; const calls = [];
  api.snoozeMessage = async (...args) => { calls.push(args); throw new Error('offline'); };
  try {
    await selectToolbarRows([MESSAGE]);
    await toolbarClick('Snooze'); await menuClick('Pick date & time'); await menuClick('Cancel');
    assert.equal(calls.length, 0); assert.ok(toolbarButton('Snooze'));
    await toolbarClick('Snooze');
    const tomorrow = [...document.querySelectorAll('.gmail-toolbar-menu button')].find(button => button.textContent.startsWith('Tomorrow'));
    await React.act(async () => tomorrow.click());
    assert.equal(calls[0][0], MESSAGE.id); assert.ok(Date.parse(calls[0][1]) > Date.now());
    assert.equal(useStore.getState().messages[0].id, MESSAGE.id);
    assert.ok(useStore.getState().notifications.some(n => n.body.includes('could not be updated')));
  } finally { api.snoozeMessage = original; }
});

test('Gmail toolbar unsupported capabilities explain boundaries without sending writes', async () => {
  await selectToolbarRows([MESSAGE]);
  CALLS = [];
  await toolbarClick('Labels'); assert.match(document.querySelector('.gmail-toolbar-menu').textContent, /not supported/);
  await toolbarClick('Add to Tasks'); assert.match(document.querySelector('.gmail-toolbar-menu').textContent, /Google Tasks is not connected/);
  assert.equal(CALLS.filter(call => call.method !== 'GET').length, 0);
  await React.act(async () => window.dispatchEvent(new window.Event('scroll')));
  assert.equal(document.querySelector('.gmail-toolbar-menu'), null);
});

test('Gmail toolbar folder lookup dismissed while pending cannot reopen or move mail', async () => {
  const original = api.getFolders; let resolveFolders;
  api.getFolders = () => new Promise(resolve => { resolveFolders = resolve; });
  try {
    await selectToolbarRows([MESSAGE]);
    await toolbarClick('Move to');
    assert.match(document.querySelector('.gmail-toolbar-menu').textContent, /Loading folders/);
    await React.act(async () => document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true })));
    assert.equal(document.querySelector('.gmail-toolbar-menu'), null);
    await React.act(async () => resolveFolders([{ path: 'stale', name: 'stale' }]));
    assert.equal(document.querySelector('.gmail-toolbar-menu'), null);
    assert.equal(useStore.getState().messages[0].id, MESSAGE.id);
  } finally { api.getFolders = original; }
});

test('Gmail toolbar newer/older and newest/oldest send native offsets and preserve page on failure', async () => {
  const original = api.getMessages; const calls = []; let fail = false;
  api.getMessages = async params => { calls.push(params); if (fail) throw new Error('offline'); return { messages: [MESSAGE], total: 125 }; };
  try {
    useStore.setState({ layout: 'gmail', scrollMode: 'paginated', pageSize: 50, notifications: [] });
    await mount({ rows: [MESSAGE], threadedView: false });
    assert.equal(toolbarButton('Newer').disabled, true);
    await toolbarClick('Older');
    assert.equal(calls.at(-1).offset, 50);
    assert.match(container.querySelector('.gmail-toolbar-range').textContent, /51–51 of 125/);
    await React.act(async () => container.querySelector('.gmail-toolbar-range').click());
    await menuClick('Oldest'); assert.equal(calls.at(-1).offset, 100);
    assert.equal(toolbarButton('Older').disabled, true);
    fail = true;
    await toolbarClick('Newer');
    assert.match(container.querySelector('.gmail-toolbar-range').textContent, /101–101 of 125/);
    assert.ok(useStore.getState().notifications.some(n => n.title === 'Could not load this page'));
    fail = false;
    await React.act(async () => container.querySelector('.gmail-toolbar-range').click());
    await menuClick('Newest'); assert.equal(calls.at(-1).offset, 0);
  } finally { api.getMessages = original; }
});

test('Gmail toolbar validates snooze future and native 30-day boundary', async () => {
  const { validSnooze, snoozePresets } = await import('./GmailToolbar.jsx');
  const now = new Date('2026-11-10T10:00:00Z');
  assert.equal(validSnooze('bad', now), false);
  assert.equal(validSnooze(now.toISOString(), now), false);
  assert.equal(validSnooze('2026-12-11T10:00:00Z', now), false);
  assert.equal(validSnooze('2026-12-10T10:00:00Z', now), true);
  assert.equal(snoozePresets(now).length, 4);
  assert.ok(snoozePresets(now).every(([, date]) => validSnooze(date, now)));
});

test('Gmail toolbar Trash deletion requires a separate explicit confirmation and cancel keeps mail', async () => {
  await selectToolbarRows([{ ...MESSAGE, folder: 'Trash' }]);
  await React.act(async () => useStore.setState({ folders: { [ACCOUNT.id]: [{ path: 'Trash', special_use: '\\Trash' }] } }));
  CALLS = [];
  await toolbarClick('Delete permanently');
  assert.match(document.querySelector('.gmail-toolbar-menu').textContent, /cannot be recovered/);
  await menuClick('Cancel');
  assert.equal(useStore.getState().messages[0].id, MESSAGE.id);
  assert.equal(CALLS.filter(call => call.method !== 'GET').length, 0);
});

test('Gmail toolbar native read failure restores flags and reports an actionable error', async () => {
  const original = api.bulkRead;
  const { clearReadGuard } = await import('../utils/pendingReads.js'); clearReadGuard(MESSAGE.id);
  api.bulkRead = async () => { throw new Error('offline'); };
  try {
    await selectToolbarRows([MESSAGE]); await toolbarClick('Mark as read');
    assert.equal(useStore.getState().messages[0].is_read, false);
    assert.ok(useStore.getState().notifications.some(n => n.title === 'Could not complete the selected action'));
    assert.ok(toolbarButton('Mark as read'));
  } finally { api.bulkRead = original; }
});

test('Gmail toolbar filter uses clicked sender account and opens an editable native filter without writes', async () => {
  useStore.setState({ user: { id: 'user-toolbar' } });
  await selectToolbarRows([{ ...MESSAGE, from_email: 'sender@example.com' }]);
  CALLS = [];
  await toolbarClick('More'); await menuClick('Filter messages like this');
  const dialog = document.querySelector('[aria-label="Advanced search"]');
  assert.ok(dialog);
  assert.equal([...dialog.querySelectorAll('label')].find(label => label.querySelector('span')?.textContent === 'From').querySelector('input').value, 'sender@example.com');
  assert.equal(CALLS.filter(call => call.method !== 'GET').length, 0);
});

test('Gmail toolbar spam excludes own sent replies and Undo restores only the visible thread row', async () => {
  const originals = { getThread: api.getThread, markSpam: api.markSpam };
  const own = { ...MESSAGE, id: 'own-reply', from_email: ACCOUNT.email_address, folder: 'Sent', is_read: true };
  const incoming = { ...THREAD, from_email: 'sender@example.com' };
  const child = { ...MESSAGE, id: 'incoming-child', message_id: '<incoming-child@example.com>', from_email: 'sender@example.com' };
  const calls = [];
  api.getThread = async () => ({ messages: [incoming, child, own] });
  api.markSpam = async id => { calls.push(id); };
  try {
    await selectToolbarRows([incoming], true); await toolbarClick('Report spam');
    assert.equal(useStore.getState().messages.length, 0);
    await React.act(async () => useStore.getState().notifications.find(n => n.onUndo).onUndo());
    assert.deepEqual(useStore.getState().messages.map(m => m.id), [incoming.id]);
    assert.deepEqual(calls, []);
    await React.act(async () => container.querySelector('[data-gmail-select-all]').click());
    await toolbarClick('Report spam');
    const { flushUndoables } = await import('../utils/undoableAction.js');
    await React.act(async () => { flushUndoables(); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.deepEqual(calls.sort(), ['incoming-child', 'msg-2']);
  } finally { Object.assign(api, originals); }
});

test('Gmail mobile retains native paginated footer navigation', async () => {
  const width = window.innerWidth, original = api.getMessages; const calls = [];
  window.innerWidth = 375;
  api.getMessages = async params => { calls.push(params); return { messages: [MESSAGE], total: 125 }; };
  try {
    useStore.setState({ layout: 'gmail', scrollMode: 'paginated', pageSize: 50 });
    await mount({ rows: [MESSAGE], threadedView: false });
    assert.equal(container.querySelector('.gmail-toolbar'), null);
    const next = [...container.querySelectorAll('button')].find(button => button.textContent.includes('messageList.nextPage'));
    assert.ok(next);
    await React.act(async () => next.click());
    assert.equal(calls.at(-1).offset, 50);
  } finally { window.innerWidth = width; api.getMessages = original; }
});

test('Gmail retains and exposes native unread filter across layout switches', async () => {
  await selectToolbarRows([MESSAGE]);
  await toolbarClick('Unread only');
  assert.equal(toolbarButton('Unread only').getAttribute('aria-pressed'), 'true');
  await switchLayout('comfortable'); await switchLayout('gmail');
  assert.equal(toolbarButton('Unread only').getAttribute('aria-pressed'), 'true');
  await toolbarClick('Unread only');
  assert.equal(toolbarButton('Unread only').getAttribute('aria-pressed'), 'false');
});

test('Gmail move menu never offers native no_select containers', async () => {
  const original = api.getFolders;
  api.getFolders = async () => [{ path: 'Container', name: 'Container', no_select: true }, { path: 'Destination', name: 'Destination' }];
  try {
    await selectToolbarRows([MESSAGE]); await toolbarClick('Move to');
    const labels = [...document.querySelectorAll('.gmail-toolbar-menu [role="menuitem"]')].map(button => button.textContent);
    assert.deepEqual(labels, ['Destination']);
  } finally { api.getFolders = original; }
});

test('Gmail pagination labels follow ascending dates and nonchronological native sorts', async () => {
  const original = api.getMessages; const calls = [];
  api.getMessages = async params => { calls.push(params); return { messages: [MESSAGE], total: 125 }; };
  try {
    useStore.setState({ layout: 'gmail', scrollMode: 'paginated', pageSize: 50, listSort: { 'acct-1:INBOX': { sort: 'date', dir: 'asc' } } });
    await mount({ rows: [MESSAGE], threadedView: false });
    assert.equal(toolbarButton('Older').disabled, true);
    await toolbarClick('Newer'); assert.equal(calls.at(-1).offset, 50);
    await React.act(async () => container.querySelector('.gmail-toolbar-range').click());
    await menuClick('Newest'); assert.equal(calls.at(-1).offset, 100);
    await React.act(async () => useStore.setState({ listSort: { 'acct-1:INBOX': { sort: 'subject', dir: 'asc' } } }));
    assert.ok(toolbarButton('Previous page')); assert.ok(toolbarButton('Next page'));
    await React.act(async () => container.querySelector('.gmail-toolbar-range').click());
    assert.match(document.querySelector('.gmail-toolbar-menu').textContent, /First pageLast page/);
  } finally { api.getMessages = original; await React.act(async () => useStore.setState({ listSort: {} })); }
});
