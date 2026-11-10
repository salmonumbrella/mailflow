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
