import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

const STUBS = {
  '/components/Sidebar.jsx': "import { createElement } from 'react'; export default function Sidebar({ expanded, onToggle }) { return createElement('button', { 'data-native-sidebar': '', 'data-expanded': String(expanded), onClick: onToggle }, 'Native folders'); }",
  '/components/MessageList.jsx': "import { createElement } from 'react'; export default function MessageList() { return createElement('div', { 'data-native-list': '' }); }",
  '/components/ReadingPane.jsx': "import { createElement } from 'react'; export default function ReadingPane() { return createElement('div', { 'data-native-reader': '' }); }",
  '/components/NotificationToasts.jsx': 'export default function NotificationToasts() { return null; }',
  '/components/CommandPalette.jsx': 'export default function CommandPalette() { return null; }',
  '/components/ComposeModal.jsx': 'export default function ComposeModal() { return null; }',
  '/components/ContactsPage.jsx': 'export default function ContactsPage() { return null; }',
  '/components/WindowLayer.jsx': 'export default function WindowLayer() { return null; }',
  '/components/AdminPanel.jsx': 'export default function AdminPanel() { return null; }',
  '/components/ElectronNotificationBridge.jsx': 'export default function ElectronNotificationBridge() { return null; }',
  '/components/InboxReplyDraftObserver.js': 'export default function InboxReplyDraftObserver() { return null; }',
  '/plugins/PluginSlot.jsx': 'export const usePluginSlot = (name, ctx) => globalThis.__TEST_PLUGIN_SLOTS__?.(name, ctx) || []; export const usePluginCollected = () => []; export function PluginSlot() { return null; } export function PluginRuntime() { return null; }',
  // An open socket, so the fallback list refresh for a socket that is down stays quiet.
  '/hooks/useWebSocket.js': 'export const useWebSocket = () => ({ current: { readyState: 1 } });',
};

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k, d) => typeof d === "string" ? d : k, i18n: { language: "en", changeLanguage: () => {} } });',
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
  localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, history: dom.window.history,
  CustomEvent: dom.window.CustomEvent, Event: dom.window.Event,
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
const { shortcutBus } = await import('../utils/shortcutBus.js');
const MailApp = (await import('./MailApp.jsx')).default;
const ACCOUNT = { id: 'a', enabled: true };
const MESSAGE = { id: 'm1', account_id: 'a', folder: 'INBOX', from_name: 'Real sender', subject: 'Session message', is_read: true };
const original = { ...api };
let root;
beforeEach(async () => {
  Object.assign(api, { getAccounts: async () => [ACCOUNT], getUnreadCounts: async () => ({ total: 0, byAccount: {}, snapshots: {}, complete: true }), getFolders: async () => [], todoist: { status: async () => ({ connected: false }) } });
  window.innerWidth = 1440;
  localStorage.clear();
  history.replaceState(null, '', '/');
  useStore.setState({ ...useStore.getInitialState(), user: { id: 'user-a' }, layout: 'superhuman', theme: 'light', sidebarCollapsed: true, messages: [MESSAGE], rightSidebarHidden: false, markReadBehavior: 'manual' });
  root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(MailApp)));
});
afterEach(async () => { await React.act(async () => root.unmount()); Object.assign(api, original); delete globalThis.__TEST_PLUGIN_SLOTS__; });
const update = async state => React.act(async () => useStore.setState(state));
const click = async selector => React.act(async () => { const node = document.querySelector(selector); assert.ok(node, selector); node.click(); });

describe('Superhuman shell integration', () => {
  test('switching layouts preserves manual theme and sidebar preferences', async () => {
    assert.ok(document.querySelector('.superhuman-rail'));
    assert.equal(document.querySelector('[data-native-sidebar]'), null);
    await update({ layout: 'comfortable' });
    assert.equal(document.querySelector('.superhuman-rail'), null);
    assert.ok(document.querySelector('[data-native-sidebar]'));
    assert.equal(useStore.getState().theme, 'light');
    assert.equal(useStore.getState().sidebarCollapsed, true);
    await update({ layout: 'superhuman' });
    assert.ok(document.querySelector('.superhuman-rail'));
    assert.equal(useStore.getState().sidebarCollapsed, true);
  });

  test('native sidebar expansion and shortcut toggles only change the local drawer', async () => {
    await click('[aria-label="Folders and accounts"]');
    assert.equal(document.querySelector('[data-native-sidebar]').dataset.expanded, 'true');
    assert.equal(useStore.getState().sidebarCollapsed, true);
    await React.act(async () => shortcutBus.emit('toggleLeftSidebar'));
    assert.equal(document.querySelector('#superhuman-folders'), null);
    await React.act(async () => shortcutBus.emit('toggleLeftSidebar'));
    assert.ok(document.querySelector('#superhuman-folders'));
    await React.act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    assert.equal(document.querySelector('#superhuman-folders'), null);
    assert.equal(useStore.getState().sidebarCollapsed, true);
    assert.equal(localStorage.getItem('mailflow_sidebar_collapsed'), null);
  });

  test('the native reader replaces the list while recent opens remains mounted and hidden', async () => {
    const list = document.querySelector('[data-native-list]').parentElement;
    const reader = document.querySelector('[data-native-reader]').parentElement;
    assert.equal(list.style.display, 'flex');
    assert.equal(reader.style.display, 'none');
    await update({ selectedMessageId: 'm1' });
    assert.equal(list.style.display, 'none');
    assert.equal(reader.style.display, 'flex');
    assert.equal(document.querySelector('.superhuman-recent').parentElement.parentElement.style.display, 'none');
    await update({ selectedMessageId: null });
    assert.equal(list.style.display, 'flex');
    assert.match(document.querySelector('.superhuman-recent').textContent, /Session message/);
  });

  test('mobile retains native navigation without desktop rail or recent sidebar', async () => {
    await React.act(async () => root.unmount());
    window.innerWidth = 390;
    root = createRoot(document.getElementById('root'));
    await React.act(async () => root.render(React.createElement(MailApp)));
    assert.equal(document.querySelector('.superhuman-rail'), null);
    assert.equal(document.querySelector('.superhuman-recent'), null);
    assert.equal(document.querySelector('.superhuman-footer'), null);
    assert.ok(document.querySelector('[data-native-sidebar]'));
  });

  test('folder navigation closes the drawer and history does not survive leaving the layout', async () => {
    await update({ selectedMessageId: 'm1' });
    await update({ selectedMessageId: null });
    assert.ok(document.querySelector('.superhuman-recent-message'));
    await click('[aria-label="Folders and accounts"]');
    await React.act(async () => useStore.getState().setSelectedAccount('a', 'Archive'));
    assert.equal(document.querySelector('#superhuman-folders'), null);
    await update({ layout: 'comfortable' });
    await update({ layout: 'superhuman' });
    assert.equal(document.querySelector('.superhuman-recent-message'), null);
  });

  test('rail search leaves contacts and dispatches the native search focus action', async () => {
    await update({ showContacts: true });
    let searches = 0;
    const handler = () => searches++;
    shortcutBus.on('focusSearch', handler);
    await click('[aria-label="Search mail"]');
    shortcutBus.off('focusSearch', handler);
    assert.equal(searches, 1);
    assert.equal(useStore.getState().showContacts, false);
  });
});

test('native buttons keep Enter and handled or composing keystrokes never reach mail shortcuts', async () => {
  let opens = 0;
  const onOpen = () => opens++;
  shortcutBus.on('openMessage', onOpen);
  try {
    const button = document.querySelector('[aria-label="Settings"]');
    await React.act(async () => {
      button.focus();
      button.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    assert.equal(opens, 0, 'Enter belongs to the focused button');
    const handled = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    handled.preventDefault();
    const composing = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true });
    const composingLegacy = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, keyCode: 229 });
    await React.act(async () => { document.body.dispatchEvent(handled); document.body.dispatchEvent(composing); document.body.dispatchEvent(composingLegacy); });
    assert.equal(opens, 0, 'already handled and IME events do not open mail');
  } finally { shortcutBus.off('openMessage', onOpen); }
});

test('Superhuman numeric account shortcuts work with the drawer closed, honor overrides and ignore editing', async () => {
  await update({ accounts: [ACCOUNT, { id: 'off', enabled: false }, { id: 'b', enabled: true }], selectedAccountId: 'a', searchQuery: 'old search' });
  const press = (target, options = {}) => React.act(async () => target.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: '2', ctrlKey: true, bubbles: true, cancelable: true, ...options,
  })));
  await press(document.body);
  assert.equal(useStore.getState().selectedAccountId, 'b');
  assert.equal(useStore.getState().selectedFolder, 'INBOX');
  assert.equal(useStore.getState().searchQuery, '');
  assert.equal(document.querySelector('#superhuman-folders'), null);
  await click('[aria-label="Folders and accounts"]');
  await press(document.activeElement, { key: '1' });
  assert.equal(useStore.getState().selectedAccountId, 'a');
  assert.equal(document.querySelector('#superhuman-folders'), null);
  const field = document.createElement('input'); document.body.append(field);
  try { await press(field); assert.equal(useStore.getState().selectedAccountId, 'a'); }
  finally { field.remove(); }
  await press(document.body, { isComposing: true });
  assert.equal(useStore.getState().selectedAccountId, 'a');
  await update({ shortcuts: { goAccount2: null } });
  await press(document.body);
  assert.equal(useStore.getState().selectedAccountId, 'a', 'explicitly disabled binding remains disabled');
});

test('plain keys respect links, summaries and editable descendants but modifier navigation still works', async () => {
  let opens = 0;
  const onOpen = () => opens++;
  shortcutBus.on('openMessage', onOpen);
  const holder = document.createElement('div');
  holder.innerHTML = '<a href="#"><span>Link</span></a><details><summary>Options</summary></details><div contenteditable="true"><span>Edit</span></div>';
  document.body.append(holder);
  try {
    for (const target of [holder.querySelector('a span'), holder.querySelector('summary'), holder.querySelector('div span')]) {
      await React.act(async () => target.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    }
    assert.equal(opens, 0);
    await React.act(async () => document.querySelector('[aria-label="Settings"]').dispatchEvent(new window.KeyboardEvent('keydown', { key: '\\', ctrlKey: true, bubbles: true, cancelable: true })));
    assert.ok(document.querySelector('#superhuman-folders'), 'the global modifier shortcut still opens navigation');
  } finally { holder.remove(); shortcutBus.off('openMessage', onOpen); }
});

test('mail actions are blocked behind menus, help and the folder drawer', async () => {
  const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); document.body.append(menu);
  await React.act(async () => document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true })));
  assert.equal(useStore.getState().composing, false);
  menu.remove();
  await click('[aria-label="Folders and accounts"]');
  await React.act(async () => document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true })));
  assert.equal(useStore.getState().composing, false);
  await React.act(async () => shortcutBus.emit('toggleLeftSidebar'));
  await update({ selectedMessageId: MESSAGE.id });
  await click('[aria-label="Keyboard shortcuts"]');
  await React.act(async () => document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true })));
  assert.equal(useStore.getState().composing, false);
  await React.act(async () => document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  assert.equal(useStore.getState().selectedMessageId, MESSAGE.id, 'Escape dismisses help without closing the reader');
});

test('palette and slash search requests leave the full reader before refocusing the list', async () => {
  await update({ selectedMessageId: MESSAGE.id });
  // A selection restored without an in-app history entry takes the native close fallback.
  history.replaceState(null, '', '/');
  let visibleSearches = 0;
  const onSearch = () => { if (!useStore.getState().selectedMessageId) visibleSearches++; };
  shortcutBus.on('focusSearch', onSearch);
  try {
    await React.act(async () => shortcutBus.emit('focusSearch'));
    assert.equal(useStore.getState().selectedMessageId, null);
    assert.ok(visibleSearches >= 1, 'native search is focused again after the list becomes visible');
    assert.equal(document.querySelector('[data-native-list]').parentElement.style.display, 'flex');
  } finally { shortcutBus.off('focusSearch', onSearch); }
});



test('an already-active plugin keeps its native sidebar in the list and full reader', async () => {
  globalThis.__TEST_PLUGIN_SLOTS__ = name => name === 'right-sidebar' ? [{ render: () => React.createElement('div', { 'data-existing-plugin': '' }, 'Native plugin') }] : [];
  await update({ selectedMessageId: 'm1' });
  const plugin = document.querySelector('[data-existing-plugin]');
  assert.ok(plugin);
  assert.equal(plugin.parentElement.parentElement.style.display, '');
  assert.equal(document.querySelector('.superhuman-recent'), null);
  await update({ selectedMessageId: null });
  assert.ok(document.querySelector('[data-existing-plugin]'));
  assert.equal(useStore.getState().enabledPlugins.length, 0, 'the layout never activates a plugin');
});

test('choosing the layout persists only the native layout preference', async () => {
  const before = useStore.getState();
  await React.act(async () => before.setLayout('superhuman'));
  assert.equal(localStorage.getItem('mailflow_layout'), 'superhuman');
  assert.equal(useStore.getState().theme, before.theme);
  assert.equal(useStore.getState().categorizationEnabled, before.categorizationEnabled);
  assert.deepEqual(useStore.getState().enabledPlugins, before.enabledPlugins);
  await React.act(async () => useStore.getState().setLayout('comfortable'));
  assert.equal(localStorage.getItem('mailflow_layout'), 'comfortable');
  assert.equal(document.querySelector('.superhuman-shell'), null);
});
