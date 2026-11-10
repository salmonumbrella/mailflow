import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

const STUBS = {
  '/components/GmailSettings.jsx': 'import React from "react"; export default function GmailSettings({ onClose }) { return React.createElement("div", { role: "dialog" }, React.createElement("button", { onClick: onClose, "data-test-close-settings": "" }, "Close settings")); }',
  '/components/ProfileModal.jsx': 'import React from "react"; export default function ProfileModal({ onClose }) { return React.createElement("div", { role: "dialog" }, React.createElement("button", { onClick: onClose, "data-test-close-profile": "" }, "Close")); }',
  '/components/MessageList.jsx': 'import React from "react"; import { useStore } from "../store/index.js"; export default function MessageList() { return React.createElement("button", { "data-test-list": "", "aria-label": "messageList.menu", onClick: () => useStore.getState().setMobileSidebarOpen(true) }, "Menu"); }',
  '/components/ReadingPane.jsx': 'import React from "react"; export default function ReadingPane() { return React.createElement("button", { "data-test-reader": "", "aria-label": "Reader back" }, "Reader"); }',
  '/components/NotificationToasts.jsx': 'export default function NotificationToasts() { return null; }',
  '/components/CommandPalette.jsx': 'import React from "react"; export default function CommandPalette({open}) { return open ? React.createElement("div", {"data-test-palette": ""}) : null; }',
  '/components/ComposeModal.jsx': 'export default function ComposeModal() { return null; }',
  '/components/ContactsPage.jsx': 'export default function ContactsPage() { return null; }',
  '/components/WindowLayer.jsx': 'export default function WindowLayer() { return null; }',
  '/components/AdminPanel.jsx': 'import React from "react"; export default function AdminPanel() { return React.createElement("div", {"data-test-admin":""}, "Admin"); }',
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
dom.window.innerWidth = 390;
dom.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
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
    getAccounts: async () => [{ id: 'account-one', enabled: true, email_address: 'me@example.com' }],
    getNativeLabels: async () => ({ accountId: 'account-one', storageGeneration: 'gen', labels: [], treeRevision: '1' }),
    getNativeLabelCounts: async () => ({ accountId: 'account-one', storageGeneration: 'gen', counts: [] }),
    getUnreadCounts: async () => ({ total: 0, byAccount: {}, snapshots: {}, complete: true }),
    getFolders: async () => [],
    getRules: async () => [],
    savePreferencesOnExit: () => {},
    todoist: { ...originalApi.todoist, status: async () => ({ connected: false }) },
  });
  useStore.setState({
    user: { id: 'user-one', displayName: 'Mobile Owner' }, gmailDensitySaveState: 'idle', layout: 'comfortable', selectedMessageId: null, composing: false, showContacts: false,
    showAdmin: false, isLocked: false, accounts: [], messages: [], mobileSidebarOpen: false, selectedAccountId: 'account-one', selectedFolder: 'INBOX', folders: {}, nativeLabelSnapshots: {}, sidebarCollapsed: false,
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


const click = node => React.act(async () => { assert.ok(node, 'click target'); node.focus?.(); node.click(); });
const menu = () => document.querySelector('[data-test-list]');
const reader = () => document.querySelector('[data-test-reader]');
const settings = () => document.querySelector('.mailflow-sidebar button[aria-label="sidebar.settings"]');
const drawer = () => document.getElementById('mailflow-gmail-quick-settings');
const expandUser = async () => {
  if (settings()) return;
  const name = [...document.querySelectorAll('.mailflow-sidebar div')].find(node => node.children.length === 0 && node.textContent === 'Mobile Owner');
  assert.ok(name); await click(name.parentElement.parentElement);
};
const escape = () => React.act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));

test('fresh 390px Gmail opens quick settings from mobile sidebar and Escape returns focus to visible Menu', async () => {
  assert.equal(document.querySelector('.mailflow-gmail-header'), null);
  assert.equal(document.querySelector('.mailflow-shell').dataset.mobile, 'true');
  await click(menu()); assert.equal(useStore.getState().mobileSidebarOpen, true);
  await expandUser(); await click(settings());
  assert.ok(drawer()); assert.equal(useStore.getState().mobileSidebarOpen, false);
  assert.equal(useStore.getState().showAdmin, false);
  assert.ok(drawer().contains(document.activeElement));
  await escape();
  assert.equal(drawer(), null); assert.equal(document.activeElement, menu());
  assert.equal(menu().parentElement.style.display, 'flex');
});

test('repeated mobile Settings taps open one drawer and do not toggle it closed', async () => {
  await click(menu()); await expandUser();
  const button = settings();
  await React.act(async () => { button.click(); button.click(); });
  assert.ok(drawer()); assert.equal(document.querySelectorAll('#mailflow-gmail-quick-settings').length, 1);
  assert.equal(useStore.getState().mobileSidebarOpen, false);
  await escape(); assert.equal(document.activeElement, menu());
});

test('mobile reader stays selected and focus returns to its visible control instead of the hidden list or sidebar', async () => {
  await React.act(async () => useStore.getState().setSelectedMessage('message-one'));
  await React.act(async () => useStore.getState().setMobileSidebarOpen(true));
  await expandUser(); await click(settings());
  assert.ok(drawer());
  assert.equal(useStore.getState().selectedMessageId, 'message-one');
  await escape();
  assert.equal(useStore.getState().selectedMessageId, 'message-one');
  assert.equal(document.activeElement, reader());
  assert.equal(reader().parentElement.style.display, 'flex');
  assert.equal(menu().parentElement.style.display, 'none');
});

test('mobile Gmail full settings and direct Labels routes remain exclusive of the quick drawer', async () => {
  await click(menu()); await expandUser(); await click(settings());
  await click([...drawer().querySelectorAll('button')].find(button => button.textContent === 'gmail.quick_settings.see_all'));
  assert.equal(drawer(), null); assert.ok(document.querySelector('[data-test-close-settings]'));
  await click(document.querySelector('[data-test-close-settings]'));
  await React.act(async () => { window.dispatchEvent(new CustomEvent('mailflow:manage-native-labels', { detail: { accountId: 'account-one', create: true } })); await new Promise(resolve => setTimeout(resolve, 0)); });
  assert.equal(drawer(), null); assert.ok(document.querySelector('[data-test-close-settings]'));
});

test('non-Gmail mobile Settings still opens native Admin Accounts and closes the sidebar', async () => {
  await React.act(async () => useStore.getState().setLayout('comfortable'));
  await click(menu()); await expandUser(); await click(settings());
  assert.equal(drawer(), null); assert.equal(useStore.getState().showAdmin, true);
  assert.equal(useStore.getState().adminTab, 'accounts'); assert.equal(useStore.getState().mobileSidebarOpen, false);
  assert.ok(document.querySelector('[data-test-admin]'));
});
