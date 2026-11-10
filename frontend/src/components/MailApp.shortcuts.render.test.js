import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

const STUBS = {
  '/components/GmailSettings.jsx': 'import React from "react"; export default function GmailSettings({ onClose }) { return React.createElement("div", { role: "dialog" }, React.createElement("button", { onClick: onClose, "data-test-close-settings": "" }, "Close settings")); }',
  '/components/ProfileModal.jsx': 'import React from "react"; export default function ProfileModal({ onClose }) { return React.createElement("div", { role: "dialog" }, React.createElement("button", { onClick: onClose, "data-test-close-profile": "" }, "Close")); }',
  '/components/Sidebar.jsx': 'export default function Sidebar() { return null; }',
  '/components/MessageList.jsx': 'import React from "react"; export default function MessageList() { return React.createElement("input", { "data-test-list": "", defaultValue: "" }); }',
  '/components/ReadingPane.jsx': 'import React from "react"; export default function ReadingPane() { return React.createElement("div", { "data-test-reader": "" }, "Reader"); }',
  '/components/NotificationToasts.jsx': 'export default function NotificationToasts() { return null; }',
  '/components/CommandPalette.jsx': 'import React from "react"; export default function CommandPalette({open}) { return open ? React.createElement("div", {"data-test-palette": ""}) : null; }',
  '/components/ComposeModal.jsx': 'export default function ComposeModal() { return null; }',
  '/components/ContactsPage.jsx': 'export default function ContactsPage() { return null; }',
  '/components/WindowLayer.jsx': 'export default function WindowLayer() { return null; }',
  '/components/AdminPanel.jsx': 'export default function AdminPanel() { return null; }',
  '/components/ElectronNotificationBridge.jsx': 'export default function ElectronNotificationBridge() { return null; }',
  '/components/InboxReplyDraftObserver.js': 'export default function InboxReplyDraftObserver() { return null; }',
  '/plugins/PluginSlot.jsx': 'export const usePluginSlot = () => []; export const usePluginCollected = () => []; export function PluginSlot() { return null; } export function PluginRuntime() { return null; }',
  // An open socket, so the fallback list refresh for a socket that is down stays quiet.
  '/hooks/useWebSocket.js': 'export const useWebSocket = () => ({ current: { readyState: 1 } });',
};

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k) => k, i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export const Trans = ({ children }) => children ?? null;',
        'export const I18nextProvider = ({ children }) => children ?? null;',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    const stub = Object.keys(STUBS).find(path => url.endsWith(path));
    if (stub) return { format: 'module', shortCircuit: true, source: STUBS[stub] };
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    const shimViteEnv = (code) => code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
    if (url.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: shimViteEnv(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: shimViteEnv(code) };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid/', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
  CustomEvent: dom.window.CustomEvent, Event: dom.window.Event, history: dom.window.history,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = dom.window.matchMedia;
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}), text: async () => '{}' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { api } = await import('../utils/api.js');
const { useStore } = await import('../store/index.js');
const { ACTION_DEFS } = await import('../utils/defaultShortcuts.js');
const { shortcutBus } = await import('../utils/shortcutBus.js');
const MailApp = (await import('./MailApp.jsx')).default;
const originalApi = { ...api, todoist: api.todoist };
let root;

beforeEach(async () => {
  history.replaceState(null, '', '/');
  Object.assign(api, {
    getAccounts: async () => [],
    getUnreadCounts: async () => ({ total: 0, byAccount: {}, snapshots: {}, complete: true }),
    getFolders: async () => [],
    getRules: async () => [],
    savePreferencesOnExit: () => {},
    todoist: { ...originalApi.todoist, status: async () => ({ connected: false }) },
  });
  useStore.setState({
    user: { id: 'user-one' }, gmailDensitySaveState: 'idle', layout: 'comfortable', selectedMessageId: null, composing: false, showContacts: false,
    showAdmin: false, isLocked: false, accounts: [], messages: [], shortcuts: {}, searchQuery: '', searchResults: [], selectedAccountId: null, selectedFolder: 'INBOX', activeLabel: null, nativeLabelFeed: null,
  });
  useStore.getState().setLayout('gmail');
  root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(MailApp)));
});

afterEach(async () => {
  await React.act(async () => root.unmount());
  window.dispatchEvent(new window.Event('pagehide'));
  Object.assign(api, originalApi);
});


const key = async (value, options = {}, target = document.body) => {
  const event = new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options });
  await React.act(async () => target.dispatchEvent(event));
  return event;
};
const observeActions = (...names) => {
  const seen = [];
  const handlers = names.map(name => {
    const handler = () => seen.push(name);
    shortcutBus.on(name, handler);
    return [name, handler];
  });
  return { seen, close: () => handlers.forEach(([name, handler]) => shortcutBus.off(name, handler)) };
};

test('Gmail U closes only the reader and explicit old U override still marks unread', async () => {
  const actions = observeActions('markUnread');
  try {
    await React.act(async () => useStore.getState().setSelectedMessage('message-1'));
    await key('u');
    await React.act(async () => new Promise(resolve => setTimeout(resolve, 30)));
    assert.equal(useStore.getState().selectedMessageId, null);
    assert.deepEqual(actions.seen, []);
    await React.act(async () => useStore.setState({ messages: [{ id: 'message-1', account_id: 'a1' }], selectedMessageId: 'message-1', shortcuts: { markUnread: 'u' } }));
    await key('u');
    assert.equal(useStore.getState().selectedMessageId, 'message-1');
    assert.deepEqual(actions.seen, ['markUnread']);
  } finally { actions.close(); }
});

test('Gmail held action keys dispatch once but J/K navigation can repeat', async () => {
  const actions = observeActions('archive', 'delete', 'markSpam', 'nextMessage', 'prevMessage');
  try {
    for (const value of ['e', '#', '!']) {
      await key(value, { shiftKey: value !== 'e' });
      await key(value, { shiftKey: value !== 'e', repeat: true });
    }
    await key('j');
    await key('j', { repeat: true });
    await key('k', { repeat: true });
    assert.deepEqual(actions.seen, ['archive', 'delete', 'markSpam', 'nextMessage', 'nextMessage', 'prevMessage']);
  } finally { actions.close(); }
});

test('Gmail suppresses shortcuts and cancels prefixes across editing, forms, menus, dialogs and IME', async () => {
  const actions = observeActions('archive', 'goInbox');
  try {
    for (const markup of [
      '<input>', '<textarea></textarea>', '<select><option>x</option></select>',
      '<div contenteditable="true"><span>editing</span></div>',
      '<div contenteditable="plaintext-only"><span>editing</span></div>',
      '<div role="menu"><button>command</button></div>',
      '<div role="dialog"><button>form</button></div>',
      '<div aria-modal="true"><button>modal</button></div>',
    ]) {
      const fixture = document.createElement('div');
      fixture.innerHTML = markup;
      document.body.append(fixture);
      try {
        const target = fixture.querySelector('span, button, input, textarea, select');
        await key('e', {}, target);
        await key('g');
        await key('e', {}, target);
      } finally { fixture.remove(); }
      await key('i');
    }
    for (const options of [{ isComposing: true }, { keyCode: 229 }]) {
      await key('e', options);
      await key('g');
      await key('e', options);
      await key('i');
    }
    assert.deepEqual(actions.seen, []);
  } finally { actions.close(); }
});

test('Gmail pending prefixes cannot cross navigation, lock, user, layout or account-generation changes', async () => {
  const actions = observeActions('goInbox');
  const transitions = [
    { selectedFolder: 'Sent' }, { selectedAccountId: 'a2' }, { searchQuery: 'new query' },
    { selectedMessageId: 'another-message' }, { user: { id: 'user-two' } }, { user: null }, { isLocked: true },
    { layout: 'comfortable' }, { accounts: [{ id: 'a1', storage_generation: 'new' }] },
    { composing: true }, { showAdmin: true }, { showContacts: true },
  ];
  try {
    for (const change of transitions) {
      const state = useStore.getState();
      const restore = Object.fromEntries(Object.keys(change).map(name => [name, state[name]]));
      await key('g');
      await React.act(async () => { useStore.setState(change); useStore.setState(restore); });
      await key('i');
    }
    assert.deepEqual(actions.seen, []);
    await key('g');
    await key('i');
    assert.deepEqual(actions.seen, ['goInbox']);
  } finally { actions.close(); }
});

test('Gmail prefixes cancel on window blur, focus moves, prevented keys and repeated prefixes', async () => {
  const actions = observeActions('goInbox');
  try {
    await key('g');
    window.dispatchEvent(new window.Event('blur'));
    await key('i');
    await key('g');
    document.querySelector('[data-test-list]').focus();
    await key('i');
    document.activeElement.blur();
    await key('g');
    await key('g', { repeat: true });
    await key('i');
    await key('g');
    const event = new window.KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true });
    event.preventDefault();
    document.body.dispatchEvent(event);
    await key('i');
    assert.deepEqual(actions.seen, []);
  } finally { actions.close(); }
});

test('Gmail preserves native activation on controls even with custom key bindings', async () => {
  const actions = observeActions('archive');
  const button = document.createElement('button');
  document.body.append(button);
  try {
    await React.act(async () => useStore.setState({ shortcuts: { archive: 'Enter' } }));
    const event = await key('Enter', {}, button);
    assert.equal(event.defaultPrevented, false);
    assert.deepEqual(actions.seen, []);
  } finally { button.remove(); actions.close(); }
});


test('disabled shortcuts do not leave browser mailbox fallbacks or a hidden G prefix active', async () => {
  await React.act(async () => useStore.setState({ shortcuts: Object.fromEntries(Object.keys(ACTION_DEFS).map(action => [action, ''])) }));
  const actions = observeActions('goInbox', 'openLabelPicker');
  try {
    assert.equal((await key('g')).defaultPrevented, false);
    await key('i');
    await key('g');
    await key('l');
    assert.deepEqual(actions.seen, []);
  } finally { actions.close(); }
});

test('holding Escape after help closes does not close the underlying reader', async () => {
  await React.act(async () => useStore.getState().setSelectedMessage('message-1'));
  await key('?');
  const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
  assert.ok(dialog);
  await key('Escape', {}, dialog.querySelector('button'));
  await key('Escape', { repeat: true });
  await React.act(async () => new Promise(resolve => setTimeout(resolve, 30)));
  assert.equal(useStore.getState().selectedMessageId, 'message-1');
});


test('IME and locked or signed-out states do not dispatch fresh action keys or open the palette', async () => {
  const actions = observeActions('archive');
  try {
    for (const change of [{ isLocked: true }, { isLocked: false, user: null }]) {
      await React.act(async () => useStore.setState(change));
      await key('e');
      await key('k', { ctrlKey: true });
      assert.equal(document.querySelector('[data-test-palette]'), null);
    }
    await React.act(async () => useStore.setState({ user: { id: 'user-one' }, isLocked: false }));
    await key('k', { ctrlKey: true, isComposing: true });
    assert.equal(document.querySelector('[data-test-palette]'), null);
    assert.deepEqual(actions.seen, []);
  } finally { actions.close(); }
});
