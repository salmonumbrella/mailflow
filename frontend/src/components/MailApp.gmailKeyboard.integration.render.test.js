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
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = dom.window.matchMedia;
dom.window.ResizeObserver = globalThis.ResizeObserver;
dom.window.Element.prototype.scrollIntoView = () => {};
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}), text: async () => '{}' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { api } = await import('../utils/api.js');
const { useStore } = await import('../store/index.js');
const MailApp = (await import('./MailApp.jsx')).default;
const originalApi = { ...api, todoist: api.todoist };
let root;
const ACCOUNT = { id: 'a1', email_address: 'owner@example.invalid', enabled: true, include_in_unified_inbox: true };
const FIRST = { id: 'm1', account_id: 'a1', folder: 'INBOX', uid: 1, subject: 'First subject', from_address: 'sender@example.invalid', message_id: '<first@example.invalid>', is_read: false, is_starred: false };
const SECOND = { ...FIRST, id: 'm2', uid: 2, subject: 'Second subject', message_id: '<second@example.invalid>' };
let calls;


beforeEach(async () => {
  history.replaceState(null, '', '/');
  calls = [];
  Object.assign(api, {
    getAccounts: async () => [ACCOUNT],
    getMessages: async () => ({ messages: [FIRST, SECOND], total: 2 }),
    bulkRead: async (ids, read) => { calls.push({ action: 'read', ids, read }); },
    markStarred: async (id, starred) => { calls.push({ action: 'star', id, starred }); },
    bulkStar: async (ids, starred) => { calls.push({ action: 'star', ids, starred }); },
    markSpam: async id => { calls.push({ action: 'spam', id }); },
    getUnreadCounts: async () => ({ total: 0, byAccount: {}, snapshots: {}, complete: true }),
    getFolders: async () => [{ path: 'INBOX' }, { path: 'Archive', special_use: '\\Archive' }, { path: 'Spam', special_use: '\\Junk' }],
    getRules: async () => [],
    savePreferencesOnExit: () => {},
    todoist: { ...originalApi.todoist, status: async () => ({ connected: false }) },
  });
  useStore.setState({
    user: { id: 'user-one' }, gmailDensitySaveState: 'idle', layout: 'comfortable', selectedMessageId: null, composing: false, showContacts: false,
    showAdmin: false, isLocked: false, accounts: [ACCOUNT], accountsReady: true, messages: [FIRST, SECOND], threadedView: false, enabledPlugins: [], markReadBehavior: 'manual', expandedThreadId: null, threadMessages: {}, shortcuts: {}, searchQuery: '', searchResults: [], selectedAccountId: 'a1', selectedFolder: 'INBOX', activeLabel: null, nativeLabelFeed: null,
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

const row = id => document.querySelector(`[data-mailflow-keyboard-row][data-gmail-row-id="${id}"]`);
const press = (value, options) => key(value, options, document.activeElement || document.body);

test('MailApp J/K/X/S route once through the actual Gmail rows without opening or marking read', async () => {
  assert.ok(row('m1'));
  await press('k');
  assert.equal(document.activeElement, row('m1'), 'initial K enters the first row like the reference');
  await press('j');
  assert.equal(document.activeElement, row('m2'));
  await press('j', { repeat: true });
  assert.equal(document.activeElement, row('m2'), 'last row clamps');
  await press('x');
  assert.equal(row('m2').dataset.checked, 'true');
  assert.equal(row('m1').dataset.checked, 'false');
  await press('s');
  assert.equal(calls.filter(call => call.action === 'star').length, 1);
  assert.equal(useStore.getState().selectedMessageId, null);
  assert.equal(calls.some(call => call.action === 'read'), false);
  await press('k');
  assert.equal(document.activeElement, row('m1'));
  await press('o');
  assert.equal(useStore.getState().selectedMessageId, 'm1');
});

test('Gmail read/unread keys use checked rows and leave merely focused rows alone', async () => {
  await press('j');
  await press('I', { shiftKey: true });
  await press('U', { shiftKey: true });
  await press('!', { shiftKey: true });
  assert.deepEqual(calls, []);
  await press('j');
  await press('x');
  await press('I', { shiftKey: true });
  assert.deepEqual(calls.filter(call => call.action === 'read'), [{ action: 'read', ids: ['m2'], read: true }]);
  assert.equal(useStore.getState().messages.find(message => message.id === 'm1').is_read, false);
  await press('U', { shiftKey: true });
  assert.deepEqual(calls.filter(call => call.action === 'read').at(-1), { action: 'read', ids: ['m2'], read: false });
});


test('Gmail explicit custom Enter wins on a row group, but not on its embedded button', async () => {
  await React.act(async () => useStore.setState({ shortcuts: { compose: 'Enter' } }));
  await press('j');
  await press('Enter');
  assert.equal(useStore.getState().composing, true);
  assert.equal(useStore.getState().selectedMessageId, null);
  await React.act(async () => useStore.getState().closeCompose());
  const button = row('m1').querySelector('button');
  assert.ok(button);
  await React.act(async () => button.focus());
  assert.equal((await press('Enter')).defaultPrevented, false);
  assert.equal(useStore.getState().composing, false);
});
