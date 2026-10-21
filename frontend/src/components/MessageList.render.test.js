// Render test for MessageList's drag source (#130).
//
// Drag-to-folder was reported broken in Edge, with message rows selecting text instead of
// dragging. Selecting text is what a browser does when an element is NOT draggable, so the
// first question is whether we render the attribute at all. Every other test of this feature
// is a util test and none of them mount a row, so none could answer that.
//
// The harness mirrors MessagePane.render.test.js: node --test cannot parse JSX, so the loader
// hook transforms .jsx with sucrase, and react-i18next is stubbed because the component only
// needs t() to return something.

import { test, describe } from 'node:test';
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
let listResponse = null;
globalThis.fetch = async (url, opts = {}) => {
  const path = String(url);
  let sent = null;
  try { sent = typeof opts.body === 'string' ? JSON.parse(opts.body) : null; } catch { /* not JSON */ }
  CALLS.push({ path, method: opts.method || 'GET', body: sent });
  if (listResponse && path.includes('/mail/messages?')) return listResponse(new URL(path, window.location.origin));
  const [status, body] = Object.entries(ROUTES).find(([p]) => path.endsWith(p))?.[1]
    ?? [200, path.includes('/mail/messages?') ? { messages: SERVED, total: SERVED.length } : {}];
  return { ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { shortcutBus } = await import('../utils/shortcutBus.js');
const { resolveConversationSelection } = await import('../utils/conversation.js');
const { openAdjacentRow } = await import('../utils/listSelection.js');
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
async function mount({ rows, threadedView, folder = 'INBOX', accountId = 'acct-1', accounts = [ACCOUNT], accountsReady = true, hasMoreMessages = false }) {
  SERVED = rows;
  if (root) await React.act(async () => root.unmount());
  container = dom.window.document.getElementById('root');
  useStore.setState({
    accounts, accountsReady,
    selectedAccountId: accountId, selectedFolder: folder,
    messages: rows, messagesTotal: rows.length, hasMoreMessages, loadingMessages: false,
    searchQuery: '', threadedView,
    folders: { 'acct-1': [{ path: 'INBOX', name: 'INBOX' }, { path: 'Archive', name: 'Archive' }, { path: 'Drafts', name: 'Drafts', special_use: '\\Drafts' }] },
  });
  await React.act(async () => {
    root = createRoot(container);
    root.render(React.createElement(MessageList));
  });
}

const draggableIn = (msgid) => {
  const row = container.querySelector(`[data-msgid="${msgid}"]`);
  assert.ok(row, `expected a row for ${msgid}`);
  return row.querySelector('[draggable]');
};

describe('MessageList — drag source (#130)', () => {
  test('an ordinary message row is draggable', async () => {
    await mount({ rows: [MESSAGE], threadedView: false });
    const el = draggableIn('msg-1');
    assert.ok(el, 'expected a draggable element inside the message row');
    assert.equal(el.getAttribute('draggable'), 'true');
  });

  test('a conversation row is draggable too', async () => {
    // The actual #130 bug. Threading renders rows through ThreadRow, which had no draggable
    // attribute and no onDragStart, so with conversations on nothing could be dragged and the
    // browser fell back to selecting the row's text. Asserting only on the non-threaded row
    // is what let this pass while the feature was broken for anyone using threading.
    await mount({ rows: [THREAD], threadedView: true });
    const el = draggableIn('msg-2');
    assert.ok(el, 'expected a conversation row to be draggable');
    assert.equal(el.getAttribute('draggable'), 'true');
  });
});

// The server never groups the Snoozed view (#269): each snoozed message is its own row with when it
// comes back. Drawn as conversation rows, with conversations on, unread mail showed as read and the
// rows of one snoozed conversation shared a key.
describe('MessageList — the Snoozed view with conversations on', () => {
  test('lists each snoozed message on its own, with when it comes back', async () => {
    const until = new Date(Date.now() + 86_400_000).toISOString();
    const a = { ...MESSAGE, id: 'sz-a', folder: 'Snoozed', thread_id: 'thr-s', snooze_until: until };
    const b = { ...MESSAGE, id: 'sz-b', folder: 'Snoozed', thread_id: 'thr-s', snooze_until: until, message_id: '<m2@example.com>' };
    await mount({ rows: [a, b], threadedView: true, folder: 'Snoozed' });
    assert.ok(container.querySelector('[data-msgid="sz-a"]') && container.querySelector('[data-msgid="sz-b"]'), 'both rows');
    const shown = container.querySelectorAll('[title^="messageList.snoozedUntil"]').length;
    assert.equal(shown, 2, 'each row says when it comes back');
    // Unread, so the sender is bold; a conversation row read that from a count this view lacks.
    const sender = [...container.querySelector('[data-msgid="sz-a"]').querySelectorAll('*')]
      .find(el => el.children.length === 0 && el.textContent === 'Sender');
    assert.ok(sender, 'the sender is shown');
    assert.equal(sender.style.fontWeight, '600', 'and shown unread');
  });
});

describe('MessageList — selected-row shortcuts', () => {
  test('mark unread updates a selected GTD rail copy and its section row', async () => {
    await mount({ rows: [MESSAGE], threadedView: false });
    const rail = { ...MESSAGE, id: 'rail-copy', message_id: '<rail@example.com>', is_read: true };
    await React.act(async () => {
      useStore.setState({ gtdSections: { reference: { threads: [rail] } } });
      useStore.getState().setSelectedMessage(rail.id);
    });
    await React.act(async () => { shortcutBus.emit('markUnread'); });
    assert.equal(useStore.getState().gtdSections.reference.threads[0].is_read, false);
    await React.act(async () => { useStore.setState({ gtdSections: null, selectedMessageId: null }); });
  });

  test('forward and Reply All act on the selected row; no selection does nothing', async () => {
    await mount({ rows: [MESSAGE], threadedView: false });
    const drafts = [];
    useStore.setState({ openCompose: draft => drafts.push(draft) });
    await React.act(async () => { useStore.getState().setSelectedMessage('msg-1'); });
    await React.act(async () => { shortcutBus.emit('forward'); await new Promise(r => setTimeout(r, 10)); });
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].isForward, true);
    assert.equal(useStore.getState().selectedMessageId, 'msg-1');
    await React.act(async () => { shortcutBus.emit('replyAllFromSelection'); await new Promise(r => setTimeout(r, 10)); });
    assert.equal(drafts.length, 2);
    assert.equal(drafts[1].isReplyAll, true);
    useStore.getState().setSelectedMessage(null);
    await React.act(async () => { shortcutBus.emit('forward'); shortcutBus.emit('replyAllFromSelection'); await new Promise(r => setTimeout(r, 10)); });
    assert.equal(drafts.length, 2);
  });
});

describe('MessageList — modifier-click enters multi-select (#220)', () => {
  // Before this, modifiers only worked once ALREADY in selection mode; entering it took the
  // avatar or the toolbar button. A Ctrl/Cmd- or Shift-click on a row must now enter it in
  // one action, seeded with the open message as anchor, instead of opening the clicked mail.
  const M2 = { ...MESSAGE, id: 'msg-b', uid: 2, message_id: '<m2@example.com>', subject: 'Second' };
  const M3 = { ...MESSAGE, id: 'msg-c', uid: 3, message_id: '<m3@example.com>', subject: 'Third' };
  // Checked and unchecked checkboxes draw the same polyline; stroke-width 3 vs 2.5 is what
  // distinguishes a CHECKED row's checkmark.
  const CHECK = 'svg[stroke-width="3"] polyline[points="20 6 9 17 4 12"]';

  const clickRow = async (msgid, init = {}) => {
    // The click handler sits on the inner draggable element, and DOM events bubble upward,
    // so the dispatch has to start there, not on the [data-msgid] wrapper.
    const row = container.querySelector(`[data-msgid="${msgid}"]`);
    assert.ok(row, `expected a row for ${msgid}`);
    const target = row.querySelector('[draggable]') || row;
    await React.act(async () => {
      target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
    });
  };
  const checkedRows = () => [...container.querySelectorAll('[data-msgid]')]
    .filter(r => r.querySelector(CHECK)).map(r => r.getAttribute('data-msgid'));

  test('ctrl-click seeds {open message, clicked row} and does not open the clicked mail', async () => {
    await mount({ rows: [MESSAGE, M2, M3], threadedView: false });
    await React.act(async () => { useStore.getState().setSelectedMessage('msg-1'); });

    await clickRow('msg-c', { ctrlKey: true });

    assert.equal(useStore.getState().selectedMessageId, 'msg-1'); // clicked mail did NOT open
    assert.deepEqual(checkedRows().sort(), ['msg-1', 'msg-c']);   // anchor + clicked selected
  });

  test('shift-click seeds the whole range from the open message', async () => {
    await mount({ rows: [MESSAGE, M2, M3], threadedView: false });
    await React.act(async () => { useStore.getState().setSelectedMessage('msg-1'); });

    await clickRow('msg-c', { shiftKey: true });

    assert.deepEqual(checkedRows().sort(), ['msg-1', 'msg-b', 'msg-c']);
  });

  test('threaded view: ctrl-click on a ThreadRow enters selection too', async () => {
    // The browser smoke caught ThreadRow missing the modifier branch — dev defaults to
    // conversations on, so every earlier assertion here (threadedView: false) passed while
    // the shipped default was broken. Conversations render through ThreadRow, not MessageRow.
    const T1 = { ...MESSAGE, id: 'thr-a', thread_id: 't-a', message_count: 2, unread_count: 1 };
    const T2 = { ...MESSAGE, id: 'thr-b', uid: 9, message_id: '<t2@example.com>', thread_id: 't-b', message_count: 3, unread_count: 0 };
    await mount({ rows: [T1, T2], threadedView: true });
    await React.act(async () => { useStore.getState().setSelectedMessage('thr-a'); });

    await clickRow('thr-b', { ctrlKey: true });

    assert.deepEqual(checkedRows().sort(), ['thr-a', 'thr-b']);
  });

  test('a plain click still just opens the message', async () => {
    await mount({ rows: [MESSAGE, M2], threadedView: false });
    await clickRow('msg-b');
    assert.equal(useStore.getState().selectedMessageId, 'msg-b');
    assert.deepEqual(checkedRows(), []); // no selection mode entered
  });
});

describe('MessageList — Ctrl+Z undo shortcut (#449)', () => {
  // The shortcut runs the same onUndo the visible toast button runs, newest first, and is
  // a no-op once nothing is pending — the keyboard can never undo more than the toasts offer.
  test('undoAction fires the newest pending undo, then the next, then nothing', async () => {
    await mount({ rows: [MESSAGE], threadedView: false });
    const undone = [];
    await React.act(async () => {
      useStore.getState().addNotification({ title: 'older', onUndo: () => undone.push('older') });
      useStore.getState().addNotification({ title: 'newer', onUndo: () => undone.push('newer') });
    });

    await React.act(async () => { shortcutBus.emit('undoAction'); });
    assert.deepEqual(undone, ['newer']);
    assert.deepEqual(useStore.getState().notifications.filter(n => n.onUndo).map(n => n.title), ['older']);

    await React.act(async () => { shortcutBus.emit('undoAction'); });
    await React.act(async () => { shortcutBus.emit('undoAction'); }); // nothing left — no throw, no change
    assert.deepEqual(undone, ['newer', 'older']);
  });
});

describe('MessageList — undo bar length', () => {
  // Undo send holds a message for 10 s, longer than the standard window, and its bar must stay
  // up (and its progress run) for exactly that long, or Undo vanishes while it would still work.
  test('a bar lasts as long as its notification asks, the rest the standard window', async () => {
    await mount({ rows: [MESSAGE], threadedView: false });
    await React.act(async () => {
      useStore.setState({ notifications: [] });
      useStore.getState().addNotification({ title: 'standard', onUndo: () => {} });
      useStore.getState().addNotification({ title: 'held send', onUndo: () => {}, undoMs: 9876 });
    });
    const progress = [...container.querySelectorAll('div')]
      .map(el => el.style.animation)
      .filter(a => a.startsWith('action-bar-progress'));
    assert.deepEqual(progress.sort(), ['action-bar-progress 4500ms linear forwards', 'action-bar-progress 9876ms linear forwards']);
    await React.act(async () => { useStore.setState({ notifications: [] }); });
  });
});

describe('MessageList — configurable hover quick actions (#440)', () => {
  // The stubbed t() returns key paths, so button titles ARE their i18n keys here.
  const TITLES = {
    markRead: 'contextMenu.markRead', star: 'contextMenu.star',
    archive: 'shortcuts.actions.archive.label', snooze: 'contextMenu.snooze.label',
    delete: 'common.delete', move: 'contextMenu.moveToFolder',
  };
  const hoverTitles = async (msgid) => {
    const row = container.querySelector(`[data-msgid="${msgid}"]`);
    assert.ok(row, `expected a row for ${msgid}`);
    await React.act(async () => {
      row.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
    });
    return [...row.querySelectorAll('button[title]')].map(b => b.getAttribute('title'));
  };

  test('the configured set picks which buttons render, in canonical order', async () => {
    await mount({ rows: [MESSAGE], threadedView: false });
    await React.act(async () => { useStore.setState({ hoverActionSet: ['archive', 'snooze', 'delete'] }); });
    const titles = await hoverTitles('msg-1');
    assert.deepEqual(titles, [TITLES.archive, TITLES.snooze, TITLES.delete]);
  });

  test('the default set is the pre-#440 cluster exactly', async () => {
    await mount({ rows: [MESSAGE], threadedView: false });
    await React.act(async () => { useStore.setState({ hoverActionSet: ['markRead', 'star', 'delete', 'move'] }); });
    const titles = await hoverTitles('msg-1');
    assert.deepEqual(titles, [TITLES.markRead, TITLES.star, TITLES.delete, TITLES.move]);
  });
});

describe('MessageList — reopening a saved draft keeps its Bcc', () => {
  // The Bcc lives only in the draft on the server, and saving a reopened draft replaces that copy.
  // Compose used to open with an empty Bcc, so the next save erased the recipients for good.
  const DRAFT = { ...MESSAGE, id: 'draft-1', folder: 'Drafts', uid: 7, is_read: true, subject: 'Draft subject',
    to_addresses: [{ name: '', email: 'alice@example.com' }], cc_addresses: [],
    in_reply_to: '<parent@example.com>', thread_references: '<root@example.com> <parent@example.com>' };

  const openDraft = async ({ bcc }) => {
    ROUTES = { '/mail/messages/draft-1/body': [200, { html: '<p>hello</p>', text: 'hello' }], '/mail/messages/draft-1/bcc': bcc };
    const opened = [];
    await React.act(async () => { useStore.setState({ openCompose: d => opened.push(d), notifications: [], selectedMessageId: null }); });
    await mount({ rows: [DRAFT], threadedView: false, folder: 'Drafts' });
    const row = container.querySelector('[data-msgid="draft-1"]');
    assert.ok(row, 'expected a row for the draft');
    await React.act(async () => {
      (row.querySelector('[draggable]') || row).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 10));
    });
    ROUTES = {};
    return opened;
  };

  test('compose opens with the Bcc, as recipients rather than text to re-split', async () => {
    const bcc = [{ name: 'Doe, Jane', email: 'jane@example.com' }];
    const opened = await openDraft({ bcc: [200, { bcc }] });
    assert.equal(opened.length, 1);
    assert.equal(opened[0].draftUid, 7);
    assert.deepEqual(opened[0].bcc, bcc);
    assert.equal(opened[0].inReplyTo, DRAFT.in_reply_to);
    assert.equal(opened[0].references, DRAFT.thread_references);
  });

  test('a draft whose Bcc cannot be read opens read-only, with an error, never in compose', async () => {
    const opened = await openDraft({ bcc: [502, { error: "Could not read this draft's Bcc recipients from the mail server." }] });
    assert.equal(opened.length, 0);
    assert.equal(useStore.getState().selectedMessageId, 'draft-1');
    assert.ok(useStore.getState().notifications.some(n => n.type === 'error' && n.title === 'messageList.draftBcc.failTitle'));
    await React.act(async () => { useStore.setState({ selectedMessageId: null, notifications: [] }); });
  });
});

describe('MessageList — bulk move picker offers Recent and Favorites (#551)', () => {
  // The single-message pickers list recent and favorite folders above the full list; the bulk
  // picker listed only the full list. Both now read the same helpers.
  const M2 = { ...MESSAGE, id: 'msg-b', uid: 2, message_id: '<m2@example.com>', subject: 'Second' };
  const FOLDERS = [
    { path: 'INBOX', name: 'INBOX' },
    { path: 'Archive', name: 'Archive' },
    { path: 'Work/Receipts', name: 'Receipts' },
    { path: 'Clients', name: 'Clients' },
  ];

  // Selection by modifier-click is desktop-only, so a phone test selects first and then
  // narrows the window through the matchMedia listener useMobile subscribes to.
  const openBulkPicker = async ({ phone = false } = {}) => {
    const listeners = new Set();
    const desktopMatchMedia = dom.window.matchMedia;
    dom.window.matchMedia = () => ({ matches: false, addEventListener: (_, h) => listeners.add(h), removeEventListener: (_, h) => listeners.delete(h), addListener() {}, removeListener() {} });
    try {
      await mount({ rows: [MESSAGE, M2], threadedView: false });
    } finally {
      dom.window.matchMedia = desktopMatchMedia;
    }
    useStore.setState({
      recentFolders: [{ accountId: 'acct-1', path: 'Archive' }, { accountId: 'other', path: 'Clients' }],
      favoriteFolders: [{ accountId: 'acct-1', path: 'Work/Receipts', label: 'Tax 2026' }, { accountId: 'acct-1', path: 'Archive' }],
    });
    ROUTES = { '/accounts/acct-1/folders': [200, FOLDERS] };
    await React.act(async () => { useStore.getState().setSelectedMessage('msg-1'); });
    const row = container.querySelector('[data-msgid="msg-b"]');
    await React.act(async () => {
      (row.querySelector('[draggable]') || row).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    });
    if (phone) await React.act(async () => { for (const h of listeners) h({ matches: true }); });
    const moveBtn = container.querySelector('[title="messageList.moveToFolder"]');
    assert.ok(moveBtn, 'expected the bulk Move button');
    await React.act(async () => { moveBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  };
  // The picker's rows in order: section headings as "# key", folders by their label text.
  const pickerLines = () => {
    const input = [...container.ownerDocument.querySelectorAll('input')].find(i => i.placeholder === 'contextMenu.folders.search');
    assert.ok(input, 'expected the picker search box');
    const list = input.parentElement.nextElementSibling;
    return [...list.children].map(el => el.tagName === 'BUTTON' ? el.textContent.trim()
      : el.textContent.trim() ? `# ${el.textContent.trim()}` : '---');
  };

  test('lists Recent, then Favorites without repeats, then every folder but the current one', async () => {
    await openBulkPicker();
    assert.deepEqual(pickerLines(), [
      '# contextMenu.folders.recent', 'Archive', '---',
      '# contextMenu.folders.favorites', 'Tax 2026', '---',
      '# messageList.moveToFolder', 'Archive', 'Work / Receipts', 'Clients',
    ]);
  });

  test('the phone bottom sheet lists the same sections, then the full list under Folders', async () => {
    await openBulkPicker({ phone: true });
    assert.deepEqual(pickerLines(), [
      '# contextMenu.folders.recent', 'Archive',
      '# contextMenu.folders.favorites', 'Tax 2026',
      '# messageList.foldersHeading', 'Archive', 'Work / Receipts', 'Clients',
    ]);
  });

  test('a search shows only the matching folders, without the sections', async () => {
    await openBulkPicker();
    const input = [...container.ownerDocument.querySelectorAll('input')].find(i => i.placeholder === 'contextMenu.folders.search');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, 'arch');
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    assert.deepEqual(pickerLines(), ['Archive']);
  });
});

describe('MessageList reply draft indicators', () => {
  test('renders the action in both message and collapsed conversation rows', async () => {
    for (const [row, threadedView] of [[MESSAGE, false], [THREAD, true]]) {
      useStore.setState({ replyDrafts: { [row.id]: { exists: true } } });
      await mount({ rows: [row], threadedView });
      assert.ok(container.querySelector(`[data-msgid="${row.id}"] [aria-label="Open reply draft"]`));
    }
  });
  test('hides indicators outside the inbox', async () => {
    useStore.setState({ replyDrafts: { [MESSAGE.id]: { exists: true } } });
    await mount({ rows: [{ ...MESSAGE, folder: 'Archive' }], threadedView: false, folder: 'Archive' });
    assert.equal(container.querySelector('[aria-label="Open reply draft"]'), null);
  });
});

describe('MessageList — a conversation another account also received (#476)', () => {
  // One email delivered to two of the reader's accounts is two mailbox items, and the thread
  // route returns both so the conversation can show them. In acct-1's own view its row
  // stands for acct-1's copies only, so that is all a conversation action may touch.
  // Each test uses its own thread number: the read and delete guards are module state. The thread
  // route marks every message is_draft.
  const ACCOUNT_B = { ...ACCOUNT, id: 'acct-2', email_address: 'b@example.com', name: 'B' };
  const conversation = (n, { unified = false } = {}) => {
    const date = new Date(Date.now() - n * 60_000).toISOString();
    const older = { ...MESSAGE, id: `a-old-${n}`, uid: 100 + n, message_id: `<old-${n}@example.com>`, thread_id: `thr-${n}`, date: new Date(Date.now() - n * 60_000 - 3_600_000).toISOString() };
    const newest = { ...MESSAGE, id: `a-new-${n}`, uid: 200 + n, message_id: `<new-${n}@example.com>`, thread_id: `thr-${n}`, date };
    const copy = { ...newest, id: `b-new-${n}`, account_id: 'acct-2' };
    ROUTES[`/mail/thread?id=thr-${n}&folder=INBOX${unified ? '&unified=true' : ''}`] = [200, { messages: [older, newest, copy].map(m => ({ ...m, is_draft: false })) }];
    return { ...newest, message_count: 2, unread_count: 2 };
  };
  const settle = () => React.act(async () => { await new Promise(r => setTimeout(r, 30)); });
  // ThreadRow shows its hover cluster from the header's onMouseEnter, so the event starts there.
  const hoverClick = async (msgid, title) => {
    const header = container.querySelector(`[data-msgid="${msgid}"] [draggable]`);
    await React.act(async () => { header.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })); });
    const button = container.querySelector(`[data-msgid="${msgid}"] button[title="${title}"]`);
    assert.ok(button, `expected a ${title} button on ${msgid}`);
    await React.act(async () => { button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await settle();
  };
  const idsSentTo = pattern => CALLS.filter(c => pattern.test(c.path)).flatMap(c => c.body?.ids || []).sort();
  // Unmounting sends a pending delete at once instead of after the 4.5 s undo window. Its undo
  // toast is dropped too, or the next mount renders it with a timer that outlives the file.
  const flushDeletes = async () => {
    await React.act(async () => root.unmount());
    root = null;
    useStore.setState({ notifications: [] });
    await settle();
    const single = CALLS.filter(c => c.method === 'DELETE').map(c => c.path.split('/').pop());
    return [...idsSentTo(/bulk-delete/), ...single].sort();
  };
  const start = async (rows, opts = {}) => {
    await mount({ rows, threadedView: true, accounts: [ACCOUNT, ACCOUNT_B], ...opts });
    await React.act(async () => { useStore.setState({ hoverQuickActions: true, hoverActionSet: ['markRead', 'star', 'delete', 'move'] }); });
    CALLS = [];
  };

  test('mark read sends only the row account\'s copies', async () => {
    const row = conversation(1);
    await start([row]);
    await hoverClick(row.id, 'contextMenu.markRead');
    assert.deepEqual(idsSentTo(/bulk-read/), ['a-new-1', 'a-old-1']);
  });

  test('star sends only the row account\'s copies', async () => {
    const row = conversation(2);
    await start([row]);
    await hoverClick(row.id, 'contextMenu.star');
    const starred = CALLS.map(c => c.path.match(/messages\/([^/]+)\/star$/)?.[1]).filter(Boolean).sort();
    assert.deepEqual(starred, ['a-new-2', 'a-old-2']);
  });

  test('delete from the keyboard sends only the row account\'s copies', async () => {
    const row = conversation(3);
    await start([row]);
    await React.act(async () => { useStore.getState().setSelectedMessage(row.id); });
    await React.act(async () => { shortcutBus.emit('delete'); });
    await settle();
    assert.deepEqual(await flushDeletes(), ['a-new-3', 'a-old-3']);
  });

  test('deleting selected conversation rows sends only each row account\'s copies', async () => {
    const one = conversation(4);
    const two = conversation(5);
    await start([one, two]);
    await React.act(async () => { useStore.getState().setSelectedMessage(one.id); });
    const header = container.querySelector(`[data-msgid="${two.id}"] [draggable]`);
    await React.act(async () => {
      header.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    });
    await React.act(async () => { shortcutBus.emit('delete'); });
    await settle();
    assert.deepEqual(await flushDeletes(), ['a-new-4', 'a-new-5', 'a-old-4', 'a-old-5']);
  });

  test('an expanded conversation shows the other account\'s copy as the server left it', async () => {
    const row = conversation(6);
    await start([row]);
    const toggle = container.querySelector(`[data-msgid="${row.id}"] button[aria-expanded]`);
    await React.act(async () => { toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await settle();
    await hoverClick(row.id, 'contextMenu.markRead');
    await hoverClick(row.id, 'contextMenu.star');
    const cached = id => useStore.getState().threadMessages['thr-6'].find(m => m.id === id);
    assert.equal(cached('a-old-6').is_read, true, 'the row account\'s copies show as read');
    assert.equal(cached('a-old-6').is_starred, true, 'and as starred');
    assert.equal(cached('b-new-6').is_read, false, 'the copy the server left unread is not shown as read');
    assert.equal(cached('b-new-6').is_starred, false, 'nor as starred');
  });

  test('in the unified inbox a conversation row still marks every account\'s copy read', async () => {
    const row = conversation(7, { unified: true });
    await start([row], { accountId: null });
    await hoverClick(row.id, 'contextMenu.markRead');
    assert.deepEqual(idsSentTo(/bulk-read/), ['a-new-7', 'a-old-7', 'b-new-7']);
  });

  test('in the unified inbox marking a row read still shows every cached copy read', async () => {
    // A sent reply refreshes the cached conversation across every enabled account (ComposeModal),
    // so it can hold a copy from an account left out of the unified inbox, which the unified
    // action never fetches. Left unread, that copy would turn the row unread again on the next echo.
    const row = conversation(8, { unified: true });
    await start([row], { accountId: null });
    const served = ROUTES['/mail/thread?id=thr-8&folder=INBOX&unified=true'][1].messages;
    const leftOut = { ...served[1], id: 'c-new-8', account_id: 'acct-3' };
    await React.act(async () => { useStore.getState().setThreadMessages('thr-8', [...served, leftOut]); });
    await hoverClick(row.id, 'contextMenu.markRead');
    const unread = useStore.getState().threadMessages['thr-8'].filter(m => !m.is_read).map(m => m.id);
    assert.deepEqual(unread, [], 'every cached copy shows as read');
    // The WebSocket echo of the mark-read, for a copy that is not the row.
    await React.act(async () => { useStore.getState().updateMessage('a-old-8', { is_read: true }); });
    const after = useStore.getState().messages.find(m => m.id === row.id);
    assert.equal(after.unread_count, 0, 'and the row stays read');
  });

  test('in the unified inbox starring a row still shows every cached copy starred', async () => {
    // The unified row stars every unified account's copy on the server, so the cached conversation
    // shows them all starred, the other account's included.
    const row = conversation(12, { unified: true });
    await start([row], { accountId: null });
    const served = ROUTES['/mail/thread?id=thr-12&folder=INBOX&unified=true'][1].messages;
    await React.act(async () => { useStore.getState().setThreadMessages('thr-12', served); });
    await hoverClick(row.id, 'contextMenu.star');
    const starred = CALLS.map(c => c.path.match(/messages\/([^/]+)\/star$/)?.[1]).filter(Boolean).sort();
    assert.deepEqual(starred, ['a-new-12', 'a-old-12', 'b-new-12'], 'every copy is starred on the server');
    const unstarred = useStore.getState().threadMessages['thr-12'].filter(m => !m.is_starred).map(m => m.id);
    assert.deepEqual(unstarred, [], 'and every cached copy shows as starred');
  });

  test('picking the other account\'s copy under the row ends what an earlier notification parked', async () => {
    // A notification tap parks the copy it opens under __dl_<id>, and the entry outlives the
    // open. Left in place, picking the same copy under acct-1's row later still counted as parked,
    // and the reading pane acted for acct-2's conversation from acct-1's row.
    const row = conversation(9);
    await start([row]);
    const copy = ROUTES['/mail/thread?id=thr-9&folder=INBOX'][1].messages[2];
    await React.act(async () => { useStore.getState().setThreadMessages(`__dl_${copy.id}`, [copy]); });
    const toggle = container.querySelector(`[data-msgid="${row.id}"] button[aria-expanded]`);
    await React.act(async () => { toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await settle();
    // The expanded block lists the cached conversation in order: older, newest, then the copy.
    const subRows = container.querySelector(`[data-msgid="${row.id}"]`).lastElementChild.children;
    await React.act(async () => { subRows[2].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await settle();
    const { selectedMessageId, messages, threadMessages } = useStore.getState();
    assert.equal(selectedMessageId, copy.id, 'the copy is selected');
    const { parked } = resolveConversationSelection({ selectedMessageId, pool: messages, threadMessages });
    assert.equal(parked, false, 'it stands for the row it was picked under');
  });

  // Every other pick of a row ends a leftover park the same way. While the row is listed the entry
  // does nothing, but once a refresh drops the row (another account's message an undo put in this
  // list), the entry alone would still count the open message as parked.
  const park = message => React.act(async () => { useStore.getState().setThreadMessages(`__dl_${message.id}`, [message]); });
  const stillParked = id => {
    const { selectedMessageId, threadMessages } = useStore.getState();
    assert.equal(selectedMessageId, id, `${id} is picked`);
    return resolveConversationSelection({ selectedMessageId, pool: [], threadMessages }).parked;
  };

  test('opening a row\'s reply draft picks the row as a click does', async (t) => {
    // The server here has no draft to open, which the reader is told; later tests expect no notices.
    t.after(() => React.act(async () => { useStore.setState({ notifications: [], replyDrafts: {} }); }));
    for (const [row, threadedView] of [[{ ...MESSAGE, id: 'b-row', account_id: 'acct-2' }, false], [conversation(14), true]]) {
      await start([row], { threadedView });
      await React.act(async () => { useStore.setState({ replyDrafts: { [row.id]: { exists: true } } }); });
      await park(row);
      const draftButton = container.querySelector(`[data-msgid="${row.id}"] [aria-label="Open reply draft"]`);
      await React.act(async () => { draftButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
      await settle();
      assert.equal(stillParked(row.id), false, threadedView ? 'from a conversation row' : 'from a message row');
    }
  });

  test('j, k and o pick a row as a click does', async () => {
    const rows = [{ ...MESSAGE, id: 'b-j1', account_id: 'acct-2' }, { ...MESSAGE, id: 'b-j2', account_id: 'acct-2', uid: 2, message_id: '<j2@example.com>' }];
    await start(rows, { threadedView: false });
    await React.act(async () => { useStore.getState().setSelectedMessage(null); });
    for (const [key, id] of [['openMessage', 'b-j1'], ['nextMessage', 'b-j2'], ['prevMessage', 'b-j1']]) {
      await park(rows.find(r => r.id === id));
      await React.act(async () => { shortcutBus.emit(key); });
      assert.equal(stillParked(id), false, key);
    }
  });

  test('in Drafts the move to the next row picks it from the list too', async () => {
    // In Drafts a click opens the composer, so the list's row opener, behind the advance after a
    // removal and a swipe, only selects the row.
    const drafts = [{ ...MESSAGE, id: 'd-1', folder: 'Drafts' }, { ...MESSAGE, id: 'd-2', uid: 2, folder: 'Drafts', message_id: '<d2@example.com>' }];
    await start(drafts, { threadedView: false, folder: 'Drafts' });
    await React.act(async () => { useStore.getState().setSelectedMessage('d-1'); });
    await park(drafts[1]);
    await React.act(async () => { openAdjacentRow('next'); });
    assert.equal(stillParked('d-2'), false);
  });

  test('in Drafts a draft that cannot open in the composer is picked from the list too', async (t) => {
    // A click opens the composer. When the draft's Bcc cannot be read, or its body cannot be fetched
    // at all, the draft is selected instead, and that is a pick from the list as much as the click.
    t.mock.method(console, 'error', () => {});
    const draft = { ...MESSAGE, id: 'd-9', folder: 'Drafts' };
    const failures = {
      'its Bcc cannot be read': { '/mail/messages/d-9/bcc': [502, { error: 'Bcc unreadable' }] },
      'its body cannot be fetched': {
        '/mail/messages/d-9/body?remoteImages=1': [500, { error: 'Body unavailable' }],
        '/mail/messages/d-9/bcc': [200, { bcc: [] }],
      },
    };
    t.after(() => React.act(async () => {
      for (const routes of Object.values(failures)) for (const path of Object.keys(routes)) delete ROUTES[path];
      useStore.setState({ notifications: [], selectedMessageId: null });
    }));
    for (const [when, routes] of Object.entries(failures)) {
      Object.assign(ROUTES, routes);
      await start([draft], { threadedView: false, folder: 'Drafts' });
      await park(draft);
      const row = container.querySelector('[data-msgid="d-9"]');
      await React.act(async () => {
        (row.querySelector('[draggable]') || row).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      await settle();
      assert.equal(stillParked('d-9'), false, when);
      for (const path of Object.keys(routes)) delete ROUTES[path];
    }
  });

  // A notification tap parks the copy it opens, and the reading pane acts for that copy's account
  // even when the row's cached conversation holds it too. 'e' must not archive the row instead.
  const archiveParked = async (row, parked) => {
    const toggle = container.querySelector(`[data-msgid="${row.id}"] button[aria-expanded]`);
    await React.act(async () => { toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await settle();
    await React.act(async () => {
      useStore.getState().setThreadMessages(`__dl_${parked.id}`, [parked]);
      useStore.getState().setSelectedMessage(parked.id);
    });
    await React.act(async () => { shortcutBus.emit('archive'); });
    await settle();
  };

  test('archive from the keyboard leaves the row alone when the opened copy is another account\'s, and says so', async (t) => {
    t.after(() => React.act(async () => { useStore.setState({ notifications: [] }); }));
    const row = conversation(10);
    await start([row]);
    await archiveParked(row, ROUTES['/mail/thread?id=thr-10&folder=INBOX'][1].messages[2]);
    assert.ok(useStore.getState().messages.some(m => m.id === row.id), 'acct-1\'s row is not archived');
    // A notice and nothing else: no undo toast, so nothing is pending.
    assert.deepEqual(useStore.getState().notifications.map(n => n.title), ['message.archived.otherAccountMessage']);
  });

  test('archive from the keyboard still archives the row when the opened copy is the row account\'s', async () => {
    const row = conversation(11);
    await start([row]);
    await archiveParked(row, ROUTES['/mail/thread?id=thr-11&folder=INBOX'][1].messages[0]);
    assert.ok(!useStore.getState().messages.some(m => m.id === row.id), 'the row is archived');
    // Taken back, so the archive does not commit after the file has finished.
    const toast = useStore.getState().notifications.find(n => n.onUndo);
    await React.act(async () => { toast.onUndo(); useStore.setState({ notifications: [] }); });
    await settle();
  });

  test('in the unified inbox archive from the keyboard archives the row whichever account\'s copy is opened', async () => {
    // A unified row stands for every unified account's copies, as the reading pane's Archive does there.
    const row = conversation(13, { unified: true });
    await start([row], { accountId: null });
    await archiveParked(row, ROUTES['/mail/thread?id=thr-13&folder=INBOX&unified=true'][1].messages[2]);
    assert.ok(!useStore.getState().messages.some(m => m.id === row.id), 'the row is archived');
    assert.ok(!useStore.getState().notifications.some(n => n.title === 'message.archived.otherAccountMessage'), 'and nothing is refused');
    const toast = useStore.getState().notifications.find(n => n.onUndo);
    await React.act(async () => { toast.onUndo(); useStore.setState({ notifications: [] }); });
    await settle();
  });
});


test('mobile sent swipe replies to external To using the delivery alias without a body fetch', async () => {
  const width = window.innerWidth;
  const openCompose = useStore.getState().openCompose;
  let draft;
  window.innerWidth = 375;
  try {
    const account = { ...ACCOUNT, email_address: 'owner@example.test', aliases: [{ id: 'delivered', email: 'alias@example.test' }] };
    const to = [{ email: 'external@example.test' }];
    const cc = [{ email: 'extra@example.test' }];
    useStore.setState({ swipeActions: { left: 'reply', right: 'replyAll' }, openCompose: p => { draft = p; } });
    for (const threadedView of [false, true]) {
      const target = threadedView ? [{ email: 'reply@example.test' }] : to;
      await mount({ rows: [{ ...MESSAGE, from_email: account.email_address, reply_from_email: threadedView ? 'sender@example.test' : account.email_address, reply_from_name: 'Latest', reply_to: threadedView ? target : [{ email: account.email_address }], to_addresses: threadedView ? [{ email: account.email_address }] : to, cc_addresses: cc, delivery_addresses: ['alias@example.test'], thread_id: 'synthetic-thread', message_count: threadedView ? 2 : 1 }], accounts: [account], threadedView });
      for (const replyAll of [false, true]) {
        draft = null;
        CALLS = [];
        const row = container.querySelector('[data-msgid="msg-1"] .no-callout');
        assert.ok(row);
        await React.act(async () => {
          for (const [type, x] of [['touchstart', 200], ['touchmove', replyAll ? 300 : 100], ['touchend', 100]]) {
            const event = new window.Event(type, { bubbles: true, cancelable: true });
            Object.defineProperty(event, 'touches', { value: [{ clientX: x, clientY: 100 }] });
            row.dispatchEvent(event);
          }
        });
        assert.ok(draft, 'swipe opens compose');
        assert.deepEqual(draft.to, target);
        assert.deepEqual(draft.cc, replyAll ? cc : []);
        assert.deepEqual(draft.originalFrom, target);
        assert.deepEqual(draft.allRecipients, cc);
        assert.equal(draft.aliasId, 'delivered');
        assert.equal(draft.threadId, 'synthetic-thread');
        assert.equal(CALLS.some(c => c.path.includes('/body')), false);
      }
    }
  } finally {
    window.innerWidth = width;
    await React.act(async () => { root.unmount(); root = null; useStore.setState({ composing: false, composeData: null, openCompose, swipeActions: { left: 'archive', right: 'markRead' } }); });
  }
});


describe('MessageList — archive page continuation', () => {
  const rows = n => Array.from({ length: n }, (_, i) => ({ ...MESSAGE, id: `continuation-${i}`, uid: i + 1,
    message_id: `<continuation-${i}@mail.test>`, from_address: 'sender@mail.test' }));
  const ids = () => useStore.getState().messages.map(m => m.id);
  const response = body => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body });
  const button = key => [...container.querySelectorAll('button')].find(b => b.textContent.includes(key));
  const click = async key => {
    const b = button(key);
    assert.ok(b && !b.disabled, `enabled ${key}`);
    await React.act(async () => b.click());
  };
  const refresh = async () => React.act(async () => {
    useStore.setState(s => ({ messagesRefreshToken: s.messagesRefreshToken + 1 }));
  });
  const start = async (t, mailbox, settings = {}) => {
    const { setPendingDelete, clearDeleteGuard } = await import('../utils/pendingDeletes.js');
    const requests = [];
    const originalIds = mailbox.map(m => m.id);
    listResponse = async url => {
      requests.push(url);
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      return response({ messages: mailbox.slice(offset, offset + limit), total: mailbox.length });
    };
    const { folder = 'INBOX', ...preferences } = settings;
    useStore.setState({ pageSize: 50, scrollMode: 'infinite', categorizationEnabled: false, notifications: [], ...preferences });
    await mount({ rows: mailbox.slice(0, 50), threadedView: settings.threadedView ?? false, folder });
    t.after(async () => {
      await React.act(async () => { root.unmount(); root = null; });
      originalIds.forEach(clearDeleteGuard);
      listResponse = null;
      useStore.setState({ notifications: [], pageSize: 50, scrollMode: 'infinite', categorizationEnabled: false });
    });
    return { requests, setPendingDelete, clearDeleteGuard };
  };

  test('cold start cannot load an unscoped continuation before accounts are ready', async t => {
    const messageCalls = () => CALLS.filter(c => c.path.includes('/mail/messages?'));
    const before = messageCalls().length;
    await mount({ rows: [], threadedView: false, accounts: [], accountId: null, accountsReady: false, hasMoreMessages: true });
    t.after(async () => {
      await React.act(async () => { root.unmount(); root = null; });
      useStore.setState({ accountsReady: true, hasMoreMessages: false });
    });
    const premature = button('messageList.loadMore');
    if (premature) await React.act(async () => premature.click());
    assert.equal(messageCalls().length, before, 'no messages request before account discovery');
    assert.ok(!button('messageList.loadMore'));
    assert.ok(container.textContent.includes('messageList.noAccounts'), 'preserve the no-accounts presentation');
    await React.act(async () => useStore.setState({ accounts: [ACCOUNT], selectedAccountId: ACCOUNT.id, accountsReady: true }));
    assert.equal(messageCalls().length, before + 1, 'normal initial load begins once ready');
    assert.equal(new URL(messageCalls().at(-1).path, window.location.origin).searchParams.get('accountId'), ACCOUNT.id);
  });

  for (const total of [150, 200]) for (const failed of ['append', 'background']) for (const recovery of ['append', 'background']) {
    test(`transient failure preserves loaded window: ${total}, ${failed} to ${recovery}`, async t => {
      t.mock.method(console, 'error', () => {});
      const mailbox = rows(total);
      const { setPendingDelete } = await start(t, mailbox);
      await click('messageList.loadMore');
      // A pending final-row guard exposes a real retry even at raw exhaustion.
      const guardedId = total === 150 && failed === 'append' ? mailbox[149].id : null;
      if (guardedId) setPendingDelete(guardedId);
      await click('messageList.loadMore');
      const prefix = mailbox.slice(0, 150).filter(m => m.id !== guardedId).map(m => m.id);
      assert.deepEqual(ids(), prefix);
      assert.equal(useStore.getState().messagesOffset, 150);
      const request = async kind => kind === 'append'
        ? click('messageList.loadMore')
        : React.act(async () => window.dispatchEvent(new window.Event('mailflow:refresh')));
      listResponse = async () => { throw new Error('synthetic transient failure'); };
      await request(failed);
      assert.deepEqual(ids(), prefix, 'failure retains displayed identities');
      const calls = [];
      listResponse = async url => {
        const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'));
        calls.push({ offset, limit });
        return response({ messages: mailbox.slice(offset, offset + limit), total });
      };
      await request(recovery);
      const expectedLength = total === 200 && recovery === 'append' ? 200 : 150;
      assert.deepEqual(ids(), mailbox.slice(0, expectedLength).filter(m => m.id !== guardedId).map(m => m.id), 'retain the loaded prefix and append only the next page');
      assert.deepEqual(calls, recovery === 'append' && total === 200 ? [{ offset: 150, limit: 50 }] : [{ offset: 0, limit: 150 }], 'one bounded request preserves the raw window');
      assert.equal(useStore.getState().loadingMessages, false);
    });
  }

  test('empty loaded page keeps continuation while 91 remain, then token restarts OFFSET without skips', async t => {
    const mailbox = rows(141);
    const { setPendingDelete } = await start(t, mailbox);
    await React.act(async () => {
      mailbox.slice(0, 50).forEach(m => setPendingDelete(m.id));
      useStore.getState().removeMessages(mailbox.slice(0, 50).map(m => m.id));
    });
    assert.equal(ids().length, 0);
    assert.ok(button('messageList.loadMore'), 'no reload needed while removals await commit');
    assert.doesNotMatch(container.textContent, /Inbox is empty|You're all caught up|messageList.emptyInbox/, 'no false empty Inbox');
    await click('messageList.loadMore');
    assert.deepEqual(ids(), rows(141).slice(50, 100).map(m => m.id), 'stable total advances past guarded rows');
    mailbox.splice(0, 50); // provider commit shifts every later OFFSET
    await refresh();
    assert.deepEqual(ids(), rows(141).slice(50, 100).map(m => m.id));
    await click('messageList.loadMore');
    assert.deepEqual(ids(), rows(141).slice(50).map(m => m.id));
    assert.equal(new Set(ids()).size, 91);
    assert.ok(!button('messageList.loadMore'), 'true end of remaining mailbox');
  });

  test('provider removal before commit token cannot skip a forward page', async t => {
    for (const removedCount of [1, 50]) {
      await t.test(`${removedCount} committed rows`, async t => {
        const mailbox = rows(141);
        const { requests, setPendingDelete } = await start(t, mailbox);
        const removed = mailbox.slice(0, removedCount);
        await React.act(async () => {
          removed.forEach(m => setPendingDelete(m.id));
          useStore.getState().removeMessages(removed.map(m => m.id));
        });
        const token = useStore.getState().messagesRefreshToken;
        mailbox.splice(0, removedCount); // provider truth arrives before archive response/token
        const before = requests.length;
        await click('messageList.loadMore');
        assert.deepEqual(ids(), mailbox.slice(0, 50).map(m => m.id), 'refill the shifted prefix');
        assert.equal(requests.length, before + 2, 'one bounded correction request');
        for (let step = 0; button('messageList.loadMore') && step < 3; step++) await click('messageList.loadMore');
        assert.deepEqual(ids(), mailbox.map(m => m.id), 'every remaining identity stays reachable once');
        assert.equal(useStore.getState().messagesRefreshToken, token, 'no token required for forward recovery');
      });
    }
  });

  test('guard-filled final page stays retryable with bounded requests; Undo and true exhaustion recover', async t => {
    const mailbox = rows(50);
    const { requests, setPendingDelete, clearDeleteGuard } = await start(t, mailbox);
    mailbox.forEach(m => setPendingDelete(m.id));
    await refresh();
    assert.deepEqual(ids(), []);
    const before = requests.length;
    await click('messageList.loadMore');
    assert.equal(requests.length, before + 1, 'one request per click, no mailbox scan');
    assert.ok(button('messageList.loadMore'));
    mailbox.forEach(m => clearDeleteGuard(m.id));
    await React.act(async () => useStore.getState().restoreMessages(mailbox));
    await refresh();
    assert.deepEqual(ids(), mailbox.map(m => m.id), 'Undo restores every identity once');
    mailbox.splice(0);
    await refresh();
    assert.deepEqual(ids(), []);
    assert.ok(!button('messageList.loadMore'), 'confirmed empty mailbox');
    assert.ok(container.textContent.includes('Inbox is empty'), 'true exhaustion renders the empty state');
  });

  test('failed shrink correction retains the raw extent without applying the skipped page', async t => {
    t.mock.method(console, 'error', () => {});
    const mailbox = rows(141);
    await start(t, mailbox);
    await React.act(async () => useStore.getState().removeMessages(ids()));
    mailbox.splice(0, 50);
    let calls = 0;
    listResponse = async url => {
      if (++calls === 2) throw new Error('synthetic correction failure');
      const offset = Number(url.searchParams.get('offset'));
      return response({ messages: mailbox.slice(offset, offset + 50), total: mailbox.length });
    };
    await click('messageList.loadMore');
    assert.deepEqual(ids(), [], 'never apply the discontinuous forward response');
    assert.equal(calls, 2);
    assert.equal(useStore.getState().messagesOffset, 50, 'retain the last successful raw extent');
    await click('messageList.loadMore');
    assert.deepEqual(ids(), mailbox.slice(0, 50).map(m => m.id));
  });

  test('scope change during shrink correction cancels its replacement', async t => {
    const mailbox = rows(141);
    await start(t, mailbox);
    mailbox.splice(0, 50);
    let deliver;
    listResponse = async url => Number(url.searchParams.get('offset')) > 0
      ? response({ messages: mailbox.slice(50), total: mailbox.length })
      : new Promise(resolve => { deliver = resolve; });
    await React.act(async () => { button('messageList.loadMore').click(); });
    const oldDeliver = deliver;
    assert.equal(typeof oldDeliver, 'function', 'correction is pending');
    await React.act(async () => useStore.setState({ selectedFolder: 'Archive' }));
    const newDeliver = deliver;
    await React.act(async () => oldDeliver(response({ messages: mailbox.slice(0, 50), total: mailbox.length })));
    assert.equal(useStore.getState().loadingMessages, true, 'new scope retains loading ownership');
    await React.act(async () => newDeliver(response({ messages: [], total: 0 })));
    assert.deepEqual(ids(), []);
    assert.equal(useStore.getState().loadingMessages, false);
  });

  test('late load-more response cannot append a prior folder or clear new loading state', async t => {
    const mailbox = rows(141);
    await start(t, mailbox);
    let deliver;
    listResponse = () => new Promise(resolve => { deliver = resolve; });
    await React.act(async () => { button('messageList.loadMore').click(); });
    const oldDeliver = deliver;
    const next = { ...MESSAGE, id: 'other-folder', folder: 'Archive', message_id: '<other@mail.test>' };
    await React.act(async () => useStore.setState({ selectedFolder: 'Archive' }));
    const newDeliver = deliver;
    await React.act(async () => oldDeliver(response({ messages: mailbox.slice(50, 100), total: 141 })));
    assert.equal(useStore.getState().loadingMessages, true, 'new folder still loading');
    await React.act(async () => newDeliver(response({ messages: [next], total: 1 })));
    assert.deepEqual(ids(), ['other-folder']);
  });

  test('request failure on an empty view leaves an enabled retry', async t => {
    const logged = t.mock.method(console, 'error', () => {});
    const mailbox = rows(1);
    await start(t, mailbox);
    await React.act(async () => useStore.getState().removeMessages(ids()));
    listResponse = async () => { throw new Error('synthetic refill failure'); };
    await refresh();
    assert.ok(button('messageList.loadMore'));
    assert.equal(logged.mock.callCount(), 1);
    listResponse = async () => response({ messages: mailbox, total: 1 });
    await click('messageList.loadMore');
    assert.deepEqual(ids(), mailbox.map(m => m.id));
  });

  test('paginated refresh clamps a deleted last page to a remaining page', async t => {
    const mailbox = rows(51);
    await start(t, mailbox, { scrollMode: 'paginated' });
    await click('messageList.nextPage');
    assert.deepEqual(ids(), ['continuation-50']);
    mailbox.splice(50);
    await React.act(async () => window.dispatchEvent(new window.Event('mailflow:refresh')));
    assert.deepEqual(ids(), mailbox.map(m => m.id));
    assert.ok(button('messageList.nextPage').disabled);
  });

  test('seeded partial commits preserve every remaining identity across page sizes', async t => {
    let seed = 0xc110;
    const draw = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor(seed / 0x100000000 * n); };
    for (let run = 0; run < 12; run++) {
      const pageSize = [1, 50, 200][run] ?? 1 + draw(200), size = pageSize + draw(pageSize * 2 + 1);
      await t.test(`seed c110 case ${run}: ${size}/${pageSize}`, async t => {
        const mailbox = rows(size);
        const { setPendingDelete, clearDeleteGuard } = await start(t, mailbox, { pageSize });
        const loaded = mailbox.slice(0, pageSize), committed = loaded.filter(() => draw(2));
        await React.act(async () => {
          loaded.forEach(m => setPendingDelete(m.id));
          useStore.getState().removeMessages(loaded.map(m => m.id));
        });
        const removed = new Set(committed.map(m => m.id));
        mailbox.splice(0, mailbox.length, ...mailbox.filter(m => !removed.has(m.id)));
        loaded.filter(m => !removed.has(m.id)).forEach(m => clearDeleteGuard(m.id));
        await refresh();
        for (let steps = 0; button('messageList.loadMore') && steps < 5; steps++) await click('messageList.loadMore');
        assert.deepEqual(ids(), mailbox.map(m => m.id), 'no skips, duplicates, or resurrected commits');
      });
    }
  });

  test('refill retains unread, category, account, folder and conversation scopes', async t => {
    const mailbox = rows(3);
    const { requests } = await start(t, mailbox, { categorizationEnabled: true, threadedView: true });
    const unread = container.querySelector('button[title="messageList.unreadOnly"]');
    assert.ok(unread);
    await React.act(async () => unread.click());
    await click('messageList.categories.newsletter');
    await refresh();
    const params = requests.at(-1).searchParams;
    assert.deepEqual(Object.fromEntries(['accountId', 'folder', 'unreadOnly', 'category', 'threaded', 'offset'].map(k => [k, params.get(k)])),
      { accountId: 'acct-1', folder: 'INBOX', unreadOnly: 'true', category: 'newsletter', threaded: 'true', offset: '0' });
    assert.deepEqual(ids(), mailbox.map(m => m.id));
  });


  test('paginated background failure leaves retry even when old rows remain visible', async t => {
    t.mock.method(console, 'error', () => {});
    const mailbox = rows(1);
    await start(t, mailbox, { scrollMode: 'paginated' });
    listResponse = async () => { throw new Error('synthetic background failure'); };
    await React.act(async () => window.dispatchEvent(new window.Event('mailflow:refresh')));
    assert.deepEqual(ids(), ['continuation-0']);
    assert.ok(button('messageList.loadMore'), 'failed reconciliation remains explicitly retryable');
    listResponse = async () => response({ messages: [], total: 0 });
    await click('messageList.loadMore');
    assert.deepEqual(ids(), []);
  });

  test('a second shrink during page clamp keeps a valid page and bounded retry', async t => {
    const mailbox = rows(101);
    const { requests } = await start(t, mailbox, { scrollMode: 'paginated' });
    await click('messageList.nextPage');
    await click('messageList.nextPage');
    let calls = 0;
    listResponse = async () => { calls++; return response({ messages: [], total: calls === 1 ? 51 : 1 }); };
    await React.act(async () => window.dispatchEvent(new window.Event('mailflow:refresh')));
    assert.equal(calls, 2, 'one bounded correction, no scan loop');
    assert.ok(button('messageList.prevPage').disabled, 'page is clamped against latest total');
    listResponse = async url => { requests.push(url); return response({ messages: mailbox.slice(0, 1), total: 1 }); };
    await click('messageList.loadMore');
    assert.equal(requests.at(-1).searchParams.get('offset'), '0');
    assert.deepEqual(ids(), ['continuation-0']);
  });


  test('the E shortcut action can exhaust 50 loaded rows and Undo restores them once', async t => {
    const mailbox = rows(141);
    await start(t, mailbox);
    const { resolveShortcutAction } = await import('../utils/defaultShortcuts.js');
    const action = resolveShortcutAction(new window.KeyboardEvent('keydown', { key: 'e' }));
    assert.equal(action, 'archive');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const undo = [];
    for (const row of mailbox.slice(0, 50)) {
      await React.act(async () => useStore.getState().setSelectedMessage(row.id));
      await React.act(async () => shortcutBus.emit(action));
      undo.push(useStore.getState().notifications[0].onUndo);
    }
    assert.deepEqual(ids(), []);
    assert.ok(button('messageList.loadMore'), 'keyboard exhaustion preserves continuation during Undo');
    await React.act(async () => undo.forEach(restore => assert.equal(restore(), true)));
    await refresh();
    assert.deepEqual(ids(), mailbox.slice(0, 50).map(m => m.id));
    assert.equal(new Set(ids()).size, 50);
  });


  test('entering search cancels a normal append without leaving normal loading stuck', async t => {
    const mailbox = rows(141);
    await start(t, mailbox);
    let deliver;
    listResponse = () => new Promise(resolve => { deliver = resolve; });
    await React.act(async () => button('messageList.loadMore').click());
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await React.act(async () => useStore.setState({ searchQuery: 'needle', searchResults: [] }));
    assert.equal(useStore.getState().loadingMessages, false);
    await React.act(async () => deliver(response({ messages: mailbox.slice(50, 100), total: 141 })));
    assert.deepEqual(ids(), mailbox.slice(0, 50).map(m => m.id));
  });


  test('infinite background retry replaces rows removed from the server', async t => {
    const mailbox = rows(1);
    await start(t, mailbox);
    listResponse = async () => { throw new Error('synthetic refresh failure'); };
    await React.act(async () => window.dispatchEvent(new window.Event('mailflow:refresh')));
    listResponse = async () => response({ messages: [], total: 0 });
    await click('messageList.loadMore');
    assert.deepEqual(ids(), [], 'retry reconciles server-deleted rows');
    assert.ok(container.textContent.includes('Inbox is empty'));
  });

  test('superseded background rejection preserves newer resolved exhaustion', async t => {
    await start(t, rows(1));
    let rejectOld, resolveNew;
    listResponse = () => new Promise((resolve, reject) => { rejectOld = reject; });
    await React.act(async () => window.dispatchEvent(new window.Event('mailflow:refresh')));
    listResponse = () => new Promise(resolve => { resolveNew = resolve; });
    await React.act(async () => window.dispatchEvent(new window.Event('mailflow:refresh')));
    await React.act(async () => resolveNew(response({ messages: [], total: 0 })));
    await React.act(async () => rejectOld(new Error('superseded refresh failed')));
    assert.ok(!button('messageList.loadMore'), 'old rejection cannot reopen confirmed exhaustion');
    assert.ok(container.textContent.includes('Inbox is empty'));
  });

  for (const control of ['retain', 'account', 'folder', 'generation', 'pending-delete']) {
    test(`offset-zero unread retention: ${control}`, async t => {
      const mailbox = rows(1);
      const { setPendingDelete } = await start(t, mailbox);
      await React.act(async () => container.querySelector('button[title="messageList.unreadOnly"]').click());
      await React.act(async () => useStore.setState({ selectedMessageId: mailbox[0].id, messages: [{ ...mailbox[0], is_read: true }] }));
      listResponse = async () => response({ messages: [], total: 1 });
      await React.act(async () => window.dispatchEvent(new window.Event('mailflow:refresh')));
      assert.deepEqual(ids(), [mailbox[0].id], 'background retained the row currently being read');
      assert.equal(useStore.getState().messagesOffset, 0);
      if (control === 'account' || control === 'folder') {
        await React.act(async () => useStore.setState(s => ({ messages: s.messages.map(m => ({ ...m,
          ...(control === 'account' ? { account_id: 'other-account' } : { folder: 'Archive' }),
        })) })));
      }
      if (control === 'pending-delete') setPendingDelete(mailbox[0].id);
      if (control === 'generation') {
        let deliver;
        listResponse = () => new Promise(resolve => { deliver = resolve; });
        await React.act(async () => button('messageList.loadMore').click());
        const oldDeliver = deliver;
        await React.act(async () => useStore.setState({ selectedFolder: 'Archive' }));
        const newDeliver = deliver;
        const next = { ...mailbox[0], id: 'new-scope', folder: 'Archive' };
        await React.act(async () => newDeliver(response({ messages: [next], total: 1 })));
        await React.act(async () => oldDeliver(response({ messages: [], total: 1 })));
        assert.deepEqual(ids(), ['new-scope'], 'old retry cannot replace the new scope');
      } else {
        await click('messageList.loadMore');
        assert.deepEqual(ids(), control === 'retain' ? [mailbox[0].id] : [], 'retain only the current unguarded scope row');
      }
    });
  }

  test('retained selected unread row cannot hide an unresolved clamped page', async t => {
    const mailbox = rows(101);
    await start(t, mailbox, { scrollMode: 'paginated' });
    await React.act(async () => container.querySelector('button[title="messageList.unreadOnly"]').click());
    await click('messageList.nextPage');
    await click('messageList.nextPage');
    await React.act(async () => useStore.setState({ selectedMessageId: 'continuation-100' }));
    let calls = 0;
    listResponse = async () => response({ messages: [], total: ++calls === 1 ? 51 : 1 });
    await React.act(async () => window.dispatchEvent(new window.Event('mailflow:refresh')));
    assert.equal(calls, 2, 'bounded clamp');
    assert.deepEqual(ids(), ['continuation-100'], 'keep the selected row while reading');
    assert.ok(button('messageList.loadMore'), 'retained row cannot hide remaining unread mail');
    listResponse = async () => response({ messages: mailbox.slice(0, 1), total: 1 });
    await click('messageList.loadMore');
    assert.deepEqual(ids(), ['continuation-0']);
  });


  for (const mode of ['infinite', 'paginated']) {
    test(`deferred refresh cannot strand ${mode} foreground loading`, async t => {
      const mailbox = rows(141);
      await start(t, mailbox, { scrollMode: mode });
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const requests = [];
      listResponse = url => new Promise(resolve => requests.push({ resolve, url }));
      await React.act(async () => {
        window.dispatchEvent(new window.Event('mailflow:message-opening'));
        window.dispatchEvent(new window.Event('mailflow:refresh'));
      });
      assert.equal(requests.length, 0, 'refresh defers behind message body');
      await click(mode === 'infinite' ? 'messageList.loadMore' : 'messageList.nextPage');
      await React.act(async () => t.mock.timers.tick(1600));
      assert.equal(requests.length, 1, 'deferred refresh honors the foreground busy guard');
      for (const req of requests) {
        const offset = Number(req.url.searchParams.get('offset'));
        const limit = Number(req.url.searchParams.get('limit'));
        await React.act(async () => req.resolve(response({ messages: mailbox.slice(offset, offset + limit), total: mailbox.length })));
      }
      assert.equal(useStore.getState().loadingMessages, false, 'foreground releases loading after requests finish');
      assert.deepEqual(ids(), mailbox.slice(mode === 'infinite' ? 0 : 50, 100).map(m => m.id));
      assert.ok(button(mode === 'infinite' ? 'messageList.loadMore' : 'messageList.nextPage'));
    });
  }


  test('entering search during a folder sync cannot mask settled no-results', async t => {
    const { api } = await import('../utils/api.js');
    let finishSync;
    t.mock.method(api, 'syncFolder', () => new Promise(resolve => { finishSync = resolve; }));
    t.mock.method(api, 'search', async () => ({ messages: [], nextCursor: null }));
    await start(t, rows(1).map(m => ({ ...m, folder: 'Archive' })), { folder: 'Archive' });
    assert.ok(finishSync, 'non-Inbox on-open sync is in flight');
    t.after(() => finishSync({}));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await React.act(async () => useStore.setState({ searchQuery: 'no-match', searchResults: [] }));
    await React.act(async () => t.mock.timers.tick(300));
    assert.equal(useStore.getState().isSearching, false);
    assert.ok(container.textContent.includes('messageList.noSearchResults'), 'folder spinner cannot override completed search');
    await React.act(async () => finishSync({}));
    assert.ok(container.textContent.includes('messageList.noSearchResults'));
  });

});
