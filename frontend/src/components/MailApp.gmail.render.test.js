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
    showAdmin: false, isLocked: false, accounts: [], messages: [],
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

const list = () => document.querySelector('[data-test-list]');
const reader = () => document.querySelector('[data-test-reader]');
const escape = async () => React.act(async () => {
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 30));
});
const openMessage = async () => React.act(async () => useStore.getState().setSelectedMessage('message-1'));

test('Gmail opens a full-width reader and Escape returns to the same mounted list', async () => {
  assert.ok(document.querySelector('.mailflow-workspace'));
  const header = document.querySelector('.mailflow-gmail-header');
  assert.ok(header);
  const listElement = list();
  listElement.value = 'list state survives';
  assert.equal(listElement.parentElement.style.display, 'flex');
  assert.equal(reader().parentElement.style.display, 'none');
  await openMessage();
  assert.equal(listElement.parentElement.style.display, 'none');
  assert.equal(reader().parentElement.style.display, 'flex');
  assert.equal(document.querySelector('.mailflow-gmail-header'), header, 'header persists above an open message');
  await escape();
  assert.equal(useStore.getState().selectedMessageId, null);
  assert.equal(list(), listElement);
  assert.equal(list().value, 'list state survives');
  assert.equal(listElement.parentElement.style.display, 'flex');
});

test('Gmail Escape leaves dialogs and unsent composition alone, then closes the reader after dismissal', async () => {
  await openMessage();
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  document.body.appendChild(dialog);
  try {
    await escape();
    assert.equal(useStore.getState().selectedMessageId, 'message-1');
  } finally { dialog.remove(); }
  await React.act(async () => useStore.setState({ composing: true }));
  await escape();
  assert.equal(useStore.getState().selectedMessageId, 'message-1');
  await React.act(async () => useStore.setState({ composing: false }));
  await escape();
  assert.equal(useStore.getState().selectedMessageId, null);
});

test('Gmail browser Back closes the reader and leaving Gmail removes single-view Escape behavior', async () => {
  await openMessage();
  await React.act(async () => { history.back(); await new Promise(resolve => setTimeout(resolve, 30)); });
  assert.equal(useStore.getState().selectedMessageId, null);
  await React.act(async () => useStore.getState().setLayout('comfortable'));
  await openMessage();
  await escape();
  assert.equal(useStore.getState().selectedMessageId, 'message-1');
  assert.equal(document.documentElement.dataset.mailflowLayout, 'comfortable');
  await React.act(async () => useStore.getState().setLayout('gmail'));
  await escape();
  assert.equal(useStore.getState().selectedMessageId, null);
});

test('Gmail header operates native sidebar, contacts, settings surface, and account profile', async () => {
  const click = async selector => {
    const button = document.querySelector(selector);
    assert.ok(button, selector);
    await React.act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  };
  const collapsed = useStore.getState().sidebarCollapsed;
  await click('.mailflow-gmail-header button[aria-label="sidebar.toggleSidebar"]');
  assert.equal(useStore.getState().sidebarCollapsed, !collapsed);
  await click('.mailflow-gmail-header button[aria-label="contacts.title"]');
  assert.equal(useStore.getState().showContacts, true);
  await click('.mailflow-gmail-home');
  assert.equal(useStore.getState().showContacts, false);
  assert.equal(useStore.getState().selectedFolder, 'INBOX');
  await click('.mailflow-gmail-header button[aria-label="sidebar.settings"]');
  assert.ok(document.getElementById('mailflow-gmail-quick-settings'));
  await React.act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'gmail.quick_settings.see_all').click());
  assert.ok(document.querySelector('[data-test-close-settings]'));
  await click('[data-test-close-settings]');
  await click('.mailflow-gmail-account');
  await click('.mailflow-gmail-header-action');
  assert.ok(document.querySelector('[data-test-close-profile]'));
  await click('[data-test-close-profile]');
  assert.equal(document.querySelector('[data-test-close-profile]'), null);
  await React.act(async () => useStore.getState().setLayout('comfortable'));
  assert.equal(document.querySelector('.mailflow-gmail-header'), null);
});

test('Gmail header menus and help prevent underlying compose and command-palette shortcuts', async () => {
  const click = async selector => {
    const node = document.querySelector(selector);
    assert.ok(node, selector);
    await React.act(async () => { node.focus(); node.click(); });
  };
  const keys = async target => React.act(async () => {
    target.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    target.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
  });
  await click('.mailflow-gmail-account');
  await keys(document.activeElement);
  assert.equal(useStore.getState().composing, false);
  assert.equal(document.querySelector('[data-test-palette]'), null);
  await click('.mailflow-gmail-header button[aria-label="gmail.header.support"]');
  await click('[role="menuitem"]');
  assert.ok(document.querySelector('.mailflow-gmail-support'));
  await keys(document.activeElement);
  assert.equal(useStore.getState().composing, false);
  assert.equal(document.querySelector('[data-test-palette]'), null);
});


test('quick settings sits beside mail and shortcut help Escape preserves the open reader and gear focus', async () => {
  await openMessage();
  const gear = document.querySelector('button[aria-label="sidebar.settings"]');
  await React.act(async () => { gear.focus(); gear.click(); });
  const drawer = document.getElementById('mailflow-gmail-quick-settings');
  assert.ok(drawer);
  assert.equal(drawer.parentElement.className, 'mailflow-mail-body');
  assert.equal(document.querySelectorAll('#mailflow-gmail-quick-settings').length, 1);
  await React.act(async () => [...drawer.querySelectorAll('button')].find(button => button.textContent === 'gmail.quick_settings.view_shortcuts').click());
  assert.equal(document.getElementById('mailflow-gmail-quick-settings'), null);
  const help = document.querySelector('[role="dialog"][aria-label="shortcuts.title"]');
  assert.ok(help, 'help must identify itself as the active dialog');
  assert.ok(help.contains(document.activeElement), 'help receives focus');
  const event = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  await React.act(async () => document.activeElement.dispatchEvent(event));
  assert.equal(document.querySelector('[role="dialog"][aria-label="shortcuts.title"]'), null);
  assert.equal(useStore.getState().selectedMessageId, 'message-1');
  assert.equal(document.activeElement, gear);
});
