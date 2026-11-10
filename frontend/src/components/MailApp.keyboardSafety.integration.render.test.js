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
  '/components/ReadingPane.jsx': 'import React, { useState } from "react"; import ContextMenu from "./ContextMenu.jsx"; import { useStore } from "../store/index.js"; export default function ReadingPane() { const state = useStore(); const [open, setOpen] = useState(false); const message = state.messages.find(item => item.id === state.selectedMessageId); return React.createElement("div", { "data-test-reader": "" }, React.createElement("button", { "data-reader-menu": "", onClick: () => setOpen(true) }, "Reader menu"), open && message && React.createElement(ContextMenu, { x: 20, y: 20, message, variant: "messagePane", onClose: () => setOpen(false), onAction: () => {} })); }',
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
const FIRST = { id: 'm1', account_id: 'a1', folder: 'INBOX', uid: 1, subject: 'First subject', from_address: 'sender@example.invalid', from_email: 'sender@example.invalid', message_id: '<first@example.invalid>', is_read: false, is_starred: false };
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
    showAdmin: false, isLocked: false, accounts: [ACCOUNT], accountsReady: true, messages: [FIRST, SECOND], threadedView: false, enabledPlugins: [], categorizationEnabled: true, notifications: [], markReadBehavior: 'manual', expandedThreadId: null, threadMessages: {}, shortcuts: {}, searchQuery: '', searchResults: [], selectedAccountId: 'a1', selectedFolder: 'INBOX', activeLabel: null, nativeLabelFeed: null,
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


// Real MailApp, MessageList and ContextMenu are mounted together. The reader shell
// deliberately isolates content-loading from global Escape and menu ownership.
const command = label => [...document.querySelectorAll('[data-context-command]')].find(el => el.textContent.trim() === label);
async function choose(label) {
  assert.ok(command(label), `expected ${label}`);
  await React.act(async () => command(label).focus());
  await press('Enter');
}

test('independent integration: held Escape leaves only one submenu layer and preserves checked rows after menu close', async () => {
  await press('j');
  row('m1').getClientRects = () => [{ width: 20, height: 20 }];
  await press(' ');
  assert.equal(row('m1').dataset.checked, 'true');
  await press('ContextMenu');
  await choose('contextMenu.categorize');
  await press('Escape');
  assert.ok(document.querySelector('[data-mailflow-context-menu]'));
  assert.ok(command('contextMenu.delete'), 'back at main commands');
  await press('Escape', { repeat: true });
  assert.ok(document.querySelector('[data-mailflow-context-menu]'), 'held Escape does not close another layer');
  await press('Escape');
  assert.equal(document.querySelector('[data-mailflow-context-menu]'), null);
  await key('Escape', { repeat: true });
  assert.equal(row('m1').dataset.checked, 'true', 'held Escape does not clear underlying selection');
  await key('Escape');
  assert.equal(row('m1').dataset.checked, 'false', 'a separate Escape may clear selection');
  assert.equal(useStore.getState().selectedMessageId, null);
});

test('independent integration: held Escape after reader menu closes cannot close the underlying reader', async () => {
  await React.act(async () => useStore.getState().setSelectedMessage(FIRST.id));
  const opener = document.querySelector('[data-reader-menu]');
  opener.getClientRects = () => [{ width: 20, height: 20 }];
  await React.act(async () => { opener.focus(); opener.click(); });
  await choose('contextMenu.categorize');
  await press('Escape');
  await press('Escape', { repeat: true });
  assert.ok(document.querySelector('[data-mailflow-context-menu]'));
  assert.equal(useStore.getState().selectedMessageId, FIRST.id);
  await press('Escape');
  assert.equal(document.querySelector('[data-mailflow-context-menu]'), null);
  await key('Escape', { repeat: true });
  await React.act(async () => new Promise(resolve => setTimeout(resolve, 30)));
  assert.equal(useStore.getState().selectedMessageId, FIRST.id, 'reader belongs to the next independent Escape');
  await key('Escape');
  await React.act(async () => new Promise(resolve => setTimeout(resolve, 30)));
  assert.equal(useStore.getState().selectedMessageId, null);
});

test('independent integration: ContextMenu blocks body shortcuts and native controls do not double-dispatch row activation', async () => {
  await press('j');
  const checkbox = row('m1').querySelector('input[type="checkbox"]');
  await React.act(async () => checkbox.focus());
  assert.equal((await press(' ')).defaultPrevented, false);
  await React.act(async () => checkbox.click());
  assert.equal(row('m1').dataset.checked, 'true');
  assert.equal(useStore.getState().selectedMessageId, null);
  await React.act(async () => row('m1').focus());
  await press('ContextMenu');
  for (const value of ['c', 'e', '#', '!']) await key(value, { shiftKey: ['#', '!'].includes(value) });
  assert.equal(useStore.getState().composing, false);
  assert.deepEqual(calls, []);
  assert.equal(row('m1').dataset.checked, 'true');
  assert.ok(document.querySelector('[data-mailflow-context-menu]'));
});

test('independent integration: nonmodal quick settings permits list navigation after focus returns to mail', async () => {
  const gear = document.querySelector('.mailflow-gmail-header button[aria-label="sidebar.settings"]');
  assert.ok(gear);
  await React.act(async () => gear.click());
  const drawer = document.getElementById('mailflow-gmail-quick-settings');
  assert.ok(drawer); assert.equal(drawer.getAttribute('aria-modal'), 'false');
  await React.act(async () => row('m1').focus());
  await press('j');
  assert.equal(document.activeElement === row('m2'), true, 'nonmodal drawer does not disable focused mailbox navigation');
  await React.act(async () => drawer.querySelector('button').focus());
  await press('c'); await press('e');
  assert.equal(useStore.getState().composing, false);
  assert.deepEqual(calls, [], 'drawer controls still suppress background mail commands');
});

for (const threadedView of [false, true]) {
  for (const actionKey of ['s', 'Enter', 'x']) {
    test(`independent integration: ${threadedView ? 'thread' : 'flat'} locator replacement cancels focused ${actionKey} target until deliberate refocus`, async () => {
      const rows = threadedView
        ? [FIRST, SECOND].map(message => ({ ...message, thread_id: `thread-${message.id}`, message_count: 1, unread_count: 1 }))
        : [FIRST, SECOND];
      api.getMessages = async () => ({ messages: rows, total: rows.length });
      await React.act(async () => useStore.setState({ threadedView, messages: rows }));
      for (const message of rows) row(message.id).getClientRects = () => [{ width: 20, height: 20 }];
      await React.act(async () => row(SECOND.id).focus());
      const previousElement = row(SECOND.id);
      assert.equal(document.activeElement === previousElement, true);
      await React.act(async () => useStore.setState({ messages: [rows[0], { ...rows[1], uid: 99, subject: 'Replacement subject' }] }));
      assert.equal(row(SECOND.id) === previousElement, true, 'the source change reused the existing row DOM node');
      await press(actionKey);
      assert.deepEqual(calls, [], 'the stale focused target must not send a star or read mutation');
      assert.equal(useStore.getState().selectedMessageId, null, 'Enter must not open replacement or fallback mail');
      assert.equal(document.querySelectorAll('[data-mailflow-keyboard-row][data-checked="true"]').length, 0, 'X must not check replacement or fallback mail');
      assert.equal(document.activeElement === previousElement, false, 'replacement does not inherit focus');
      assert.equal(document.activeElement?.closest?.('[data-mailflow-keyboard-row]') || null, null, 'another row was not silently promoted');

      // The refusal is focus invalidation, not a broken shortcut: deliberate focus
      // on the replacement source restores its normal keyboard behavior.
      await React.act(async () => row(SECOND.id).focus());
      await press(actionKey);
      if (actionKey === 's') assert.deepEqual(calls, [{ action: 'star', id: SECOND.id, starred: true }]);
      if (actionKey === 'Enter') assert.equal(useStore.getState().selectedMessageId, SECOND.id);
      if (actionKey === 'x') assert.equal(row(SECOND.id).dataset.checked, 'true');
    });
  }
}

for (const threadedView of [false, true]) {
  for (const [identityPart, replacementFields] of [
    ['UID', { uid: 99 }],
    ['entity', { entityId: 'replacement-entity' }],
    ['generation', { storageGeneration: 'replacement-generation' }],
  ]) {
    test(`independent integration: selected ${threadedView ? 'conversation parent' : 'flat row'} does not survive ${identityPart} replacement`, async () => {
      const original = { ...SECOND, entityId: 'original-entity', storageGeneration: 'original-generation',
        ...(threadedView ? { thread_id: 'selected-thread', message_count: 2, unread_count: 2 } : {}) };
      const rows = [FIRST, original];
      api.getMessages = async () => ({ messages: rows, total: rows.length });
      api.bulkDelete = async ids => { calls.push({ action: 'delete', ids }); };
      api.deleteMessage = async id => { calls.push({ action: 'delete', id }); };
      await React.act(async () => useStore.setState({ threadedView, messages: rows }));
      row(SECOND.id).getClientRects = () => [{ width: 20, height: 20 }];
      await React.act(async () => row(SECOND.id).focus());
      await press('x');
      assert.equal(row(SECOND.id).dataset.checked, 'true');
      assert.ok(document.querySelector('.gmail-toolbar button[aria-label="gmailToolbar.delete"]'), 'checked source offers bulk delete');
      const replacement = { ...original, ...replacementFields };
      await React.act(async () => useStore.setState({ messages: [FIRST, replacement] }));
      assert.equal(row(SECOND.id).dataset.checked, 'false', 'the previous selected source was discarded');
      assert.equal(document.querySelector('.gmail-toolbar button[aria-label="gmailToolbar.delete"]'), null, 'bulk delete is not offered for the replacement');
      await press('s');
      await press('I', { shiftKey: true });
      await press('#', { shiftKey: true });
      assert.deepEqual(calls, [], 'replacement has neither a focused nor checked mutation target');
      assert.deepEqual(useStore.getState().messages.map(message => message.id), [FIRST.id, SECOND.id], 'no optimistic removal');
      assert.equal(useStore.getState().notifications.some(notification => notification.onUndo), false, 'no queued deletion');
    });
  }
}

test('independent integration: mutable flag refresh preserves the selected source and focus', async () => {
  row(SECOND.id).getClientRects = () => [{ width: 20, height: 20 }];
  await React.act(async () => row(SECOND.id).focus());
  await press('x');
  const originalElement = row(SECOND.id);
  await React.act(async () => useStore.setState({ messages: [FIRST, { ...SECOND, is_read: true, is_starred: true }] }));
  assert.equal(row(SECOND.id).dataset.checked, 'true');
  assert.equal(document.activeElement === originalElement, true, 'flag updates do not revoke focus');
  await press('U', { shiftKey: true });
  assert.deepEqual(calls, [{ action: 'read', ids: [SECOND.id], read: false }]);
});
