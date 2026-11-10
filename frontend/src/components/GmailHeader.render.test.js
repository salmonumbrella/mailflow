import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) return { format: 'module', shortCircuit: true, source: 'export const useTranslation = () => ({ t: (key, fallback) => typeof fallback === "string" ? fallback : fallback?.defaultValue?.replace(/{{(\\w+)}}/g, (_, name) => fallback[name]) || key }); export const initReactI18next = {type: "3rdParty", init() {}};' };
    if (url.endsWith('/components/ProfileModal.jsx')) return { format: 'module', shortCircuit: true, source: 'import React from "react"; export default function ProfileModal({onClose}) { return React.createElement("div", {role:"dialog", "aria-label":"Native profile"}, React.createElement("button", {onClick:onClose}, "Close profile")); }' };
    if (url.endsWith('/components/GmailSettings.jsx')) return { format: 'module', shortCircuit: true, source: 'import React from "react"; export default function GmailSettings({onClose}) { return React.createElement("div", {role:"dialog", "aria-label":"Settings"}, React.createElement("button", {onClick:onClose}, "Close settings")); }' };
    if (url.endsWith('.json')) return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    if (url.endsWith('.jsx')) return { format: 'module', shortCircuit: true, source: transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url }).code };
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
    }
    return nextLoad(url, context);
  },
});
const dom = new JSDOM('<div id="root"></div><button id="outside">Outside</button>', { url: 'https://mail.example.invalid/', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, CustomEvent: dom.window.CustomEvent, Event: dom.window.Event, Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const GmailHeader = (await import('./GmailHeader.jsx')).default;
const originalGetContacts = api.getContacts;
const originalGetRules = api.getRules;
let root, shortcutCount, contactsCalls;
const button = text => [...document.querySelectorAll('button')].find(el => { const clone = el.cloneNode(true); clone.querySelectorAll('[aria-hidden="true"]').forEach(node => node.remove()); return clone.textContent.trim() === text || el.getAttribute('aria-label') === text; });
const click = async el => { assert.ok(el, 'Expected button'); await React.act(async () => { el.focus(); el.click(); }); };
const press = async (el, key, extra = {}) => React.act(async () => el.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })));
const settle = async (ms = 10) => React.act(async () => new Promise(resolve => setTimeout(resolve, ms)));
const input = async (el, value) => {
  assert.ok(el);
  await React.act(async () => {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
};
const menu = () => document.getElementById('mailflow-gmail-header-popover');
const openSupport = async (topic = 'Help') => { await click(button('Support')); await click(button(topic)); };
const supportDialog = () => document.querySelector('.mailflow-gmail-support');

beforeEach(async () => {
  shortcutCount = 0; contactsCalls = [];
  api.getRules = async () => [];
  sessionStorage.clear();
  document.documentElement.dataset.mailflowLayout = 'gmail';
  useStore.setState({ user: { id: 'u1', username: 'alex', displayName: 'Alex Mailflow' }, accounts: [{ id: 'a1', name: 'Personal', email_address: 'alex@example.com', enabled: true }, { id: 'a2', name: 'Work', email_address: 'alex@work.example', enabled: true }], selectedAccountId: 'a1', selectedFolder: 'INBOX', selectedMessageId: null, sidebarCollapsed: false, sidebarWidth: 220, searchQuery: '', searchAllFolders: false, showContacts: false, layout: 'gmail' });
  api.getContacts = async args => { contactsCalls.push(args); return { contacts: [{ id: 'c1', display_name: 'Pat Friend', primary_email: 'pat@example.com' }], total: 1 }; };
  root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(GmailHeader, { onShowShortcutHelp: () => shortcutCount++ })));
});
afterEach(async () => { await React.act(async () => root.unmount()); api.getContacts = originalGetContacts; api.getRules = originalGetRules; });

test('shell preserves native sidebar and contacts routes, home clears reader/search and search host persists', async () => {
  const host = document.getElementById('mailflow-gmail-search');
  await click(button('sidebar.toggleSidebar'));
  assert.equal(useStore.getState().sidebarCollapsed, true);
  assert.equal(button('sidebar.toggleSidebar').getAttribute('aria-expanded'), 'false');
  await click(button('contacts.title'));
  assert.equal(useStore.getState().showContacts, true);
  await React.act(async () => useStore.setState({ searchQuery: 'old', selectedFolder: '__scheduled__', selectedMessageId: 'm1' }));
  await click(document.querySelector('.mailflow-gmail-home'));
  assert.equal(useStore.getState().showContacts, false);
  assert.equal(useStore.getState().searchQuery, '');
  assert.equal(useStore.getState().selectedMessageId, null);
  assert.equal(useStore.getState().selectedFolder, 'INBOX');
  assert.equal(document.getElementById('mailflow-gmail-search'), host);
});

test('status menu has checked state, keyboard traversal, Escape and outside dismissal with focus return', async () => {
  const trigger = button('Status: Active');
  await press(trigger, 'ArrowDown');
  assert.equal(document.activeElement.textContent, 'Active✓');
  assert.equal(menu().querySelector('[aria-checked="true"]').textContent, 'Active✓');
  await press(document.activeElement, 'End');
  assert.equal(document.activeElement.textContent, 'Away');
  await click(document.activeElement);
  assert.ok(button('Status: Away'));
  assert.equal(document.activeElement, trigger);
  await click(trigger);
  assert.match(menu().textContent, /does not change notifications/);
  await press(document.activeElement, 'Escape');
  assert.equal(menu(), null);
  assert.equal(document.activeElement, trigger);
  await click(trigger);
  await React.act(async () => document.getElementById('outside').dispatchEvent(new window.Event('pointerdown', { bubbles: true })));
  assert.equal(menu(), null);
  assert.equal(document.activeElement, trigger);
});

test('support menu supports arrows, shortcuts and toggles without losing focus', async () => {
  const trigger = button('Support');
  await click(trigger);
  assert.equal(document.activeElement.textContent, 'Help');
  await press(document.activeElement, 'ArrowDown');
  assert.equal(document.activeElement.textContent, 'Training');
  await press(document.activeElement, 'ArrowUp');
  assert.equal(document.activeElement.textContent, 'Help');
  await click(button('Keyboard shortcuts'));
  assert.equal(shortcutCount, 1);
  assert.equal(menu(), null);
  await click(trigger); await click(trigger);
  assert.equal(menu(), null);
});

test('apps show real contacts, search by identity, attachment search and native contact management', async () => {
  await click(button('Apps')); await click(button('Contacts')); await settle();
  assert.equal(contactsCalls[0].limit, 12);
  assert.match(menu().textContent, /Pat Friend/);
  await click(menu().querySelector('.mailflow-gmail-header-contact-list button'));
  assert.equal(useStore.getState().searchQuery, 'from:"pat@example.com"');
  assert.equal(useStore.getState().searchAllFolders, true);
  assert.equal(menu(), null);
  await click(button('Apps')); await click(button('Contacts')); await settle();
  await click(button('Back to apps'));
  assert.equal(menu().getAttribute('aria-label'), 'Apps');
  await React.act(async () => useStore.setState({ searchAllFolders: false }));
  await click(button('Attachments'));
  assert.equal(useStore.getState().searchAllFolders, true);
  assert.equal(useStore.getState().searchQuery, 'has:attachment');
  await click(button('Apps')); await click(button('Contacts')); await settle();
  await click(button('Open all contacts'));
  assert.equal(useStore.getState().showContacts, true);
});

test('contacts failure, retry, empty search and stale request dismissal are safe', async () => {
  let fail = true;
  api.getContacts = async ({ q }) => { if (fail) throw new Error('Connection unavailable'); return { contacts: q ? [] : [{ id: 'c1', display_name: 'Pat', primary_email: 'pat@example.com' }] }; };
  await click(button('Apps')); await click(button('Contacts')); await settle();
  assert.match(menu().querySelector('[role="alert"]').textContent, /Connection unavailable/);
  fail = false; await click(button('Retry')); await settle();
  assert.match(menu().textContent, /pat@example.com/);
  await input(menu().querySelector('input'), 'missing'); await settle(210);
  assert.match(menu().textContent, /No contacts found/);
  await press(document.activeElement, 'Escape');
  assert.equal(menu(), null);
});

test('account identity and switching use native account IDs, with native profile/settings entry points', async () => {
  const trigger = button('Account: Alex Mailflow');
  await click(trigger);
  assert.match(menu().textContent, /alex@example.com/);
  assert.match(menu().textContent, /does not sign you in to Google/);
  await click([...menu().querySelectorAll('.mailflow-gmail-connected-accounts button')][1]);
  assert.equal(useStore.getState().selectedAccountId, 'a2');
  await click(trigger); await click(button('Edit profile'));
  assert.ok(document.querySelector('[aria-label="Native profile"]'));
  await click(button('Close profile'));
  assert.equal(document.activeElement, trigger);
  await click(button('Settings'));
  assert.ok(document.querySelector('[aria-labelledby="mf-gmail-quick-title"][role="dialog"]'));
  await click(button('See all settings'));
  assert.ok(document.querySelector('[aria-label="Settings"][role="dialog"]'));
  await click(button('Close settings'));
  await click(trigger); await click(button('Close account menu'));
  assert.equal(menu(), null);
});

test('help search, article/back, local community notice and training are interactive', async () => {
  await openSupport();
  await input(supportDialog().querySelector('input'), 'signature');
  assert.ok(button('Create a signature'));
  assert.equal(button('Manage connected accounts'), undefined);
  await click(button('Create a signature'));
  assert.match(supportDialog().textContent, /signature for each connected mail account/);
  await click(button('Back'));
  assert.equal(supportDialog().querySelector('input').value, 'signature');
  await input(supportDialog().querySelector('input'), 'no match here');
  assert.match(supportDialog().textContent, /No matching help articles/);
  await click(button('Visit help forum'));
  assert.match(supportDialog().textContent, /No question has been posted/);
  await press(document.activeElement, 'Escape');
  assert.equal(supportDialog(), null);
  assert.equal(document.activeElement, button('Support'));
  await openSupport('Training');
  assert.match(supportDialog().textContent, /Google training and account services are not connected/);
});

test('feedback validates required issue fields, retains edits through review/back and saves only local fields', async () => {
  await openSupport('Send feedback'); await click(button('Report an issue'));
  assert.equal(button('Next: Review').disabled, true);
  await input(supportDialog().querySelector('textarea'), 'Search misses a message');
  assert.equal(button('Next: Review').disabled, true);
  await input(supportDialog().querySelector('select'), 'Find messages or attachments');
  await click(button('Next: Review'));
  assert.match(supportDialog().textContent, /Search misses a message/);
  await click(button('Back'));
  assert.equal(supportDialog().querySelector('textarea').value, 'Search misses a message');
  await click(button('Add blank screenshot preview'));
  assert.match(supportDialog().querySelector('[role="img"]').getAttribute('aria-label'), /no mail captured/);
  await click(supportDialog().querySelector('input[type="checkbox"]'));
  await click(button('Privacy'));
  assert.match(supportDialog().textContent, /Nothing is transmitted/);
  await click(button('Dismiss notice'));
  assert.equal(supportDialog().querySelector('textarea').value, 'Search misses a message');
  await click(button('Next: Review')); await click(button('Save feedback locally'));
  assert.match(supportDialog().textContent, /Feedback saved locally/);
  const record = JSON.parse(sessionStorage.getItem('mailflow.feedback.u1'));
  assert.equal(record.description, 'Search misses a message');
  assert.equal(record.screenshot, 'blank-local-preview');
  assert.equal(record.emailUpdates, true);
  assert.equal(record.category, 'Find messages or attachments');
  assert.equal(record.email, undefined);
  await click(button('Done'));
  assert.equal(document.activeElement, button('Support'));
});

test('idea flow needs no category, traps focus, suppresses mailbox keys and restores focus after Escape', async () => {
  await openSupport('Send feedback'); await click(button('Suggest an idea'));
  assert.equal(supportDialog().querySelector('select'), null);
  await input(supportDialog().querySelector('textarea'), 'A useful idea');
  const first = supportDialog().querySelector('button');
  const last = button('Next: Review');
  await React.act(async () => last.focus());
  await press(last, 'Tab'); assert.equal(document.activeElement, first);
  await press(first, 'Tab', { shiftKey: true }); assert.equal(document.activeElement, last);
  let bubbled = 0;
  const listener = () => bubbled++;
  document.addEventListener('keydown', listener);
  await press(last, 'e');
  document.removeEventListener('keydown', listener);
  assert.equal(bubbled, 0);
  await press(last, 'Escape');
  assert.equal(supportDialog(), null);
  assert.equal(document.activeElement, button('Support'));
  assert.equal(sessionStorage.getItem('mailflow.feedback.u1'), null);
});

test('feedback storage failure is explicit and preserves the entered feedback', async () => {
  await openSupport('Send feedback'); await click(button('Suggest an idea'));
  await input(supportDialog().querySelector('textarea'), 'Keep this text');
  await click(button('Next: Review'));
  const original = window.Storage.prototype.setItem;
  window.Storage.prototype.setItem = () => { throw new Error('Storage disabled'); };
  try { await click(button('Save feedback locally')); } finally { window.Storage.prototype.setItem = original; }
  assert.match(supportDialog().querySelector('[role="alert"]').textContent, /could not be saved/);
  assert.match(supportDialog().textContent, /Keep this text/);
  assert.equal(sessionStorage.getItem('mailflow.feedback.u1'), null);
});

test('late contacts response cannot overwrite a newly opened contact panel', async () => {
  let resolveOld;
  let requests = 0;
  api.getContacts = async () => {
    requests++;
    if (requests === 1) return new Promise(resolve => { resolveOld = resolve; });
    return { contacts: [{ id: 'new', display_name: 'Current Contact', primary_email: 'current@example.com' }] };
  };
  await click(button('Apps')); await click(button('Contacts')); await settle();
  assert.match(menu().textContent, /Loading contacts/);
  await click(button('Back to apps')); await click(button('Contacts')); await settle();
  assert.match(menu().textContent, /Current Contact/);
  await React.act(async () => resolveOld({ contacts: [{ id: 'old', display_name: 'Stale Contact', primary_email: 'stale@example.com' }] }));
  assert.match(menu().textContent, /Current Contact/);
  assert.doesNotMatch(menu().textContent, /Stale Contact/);
});

test('account switcher excludes disabled accounts and handles no enabled accounts', async () => {
  await React.act(async () => useStore.setState({ accounts: [
    { id: 'a1', name: 'Personal', email_address: 'alex@example.com', enabled: true },
    { id: 'disabled', name: 'Disabled Work', email_address: 'disabled@example.com', enabled: false },
  ] }));
  await click(button('Account: Alex Mailflow'));
  assert.equal(menu().querySelectorAll('.mailflow-gmail-connected-accounts button').length, 1);
  assert.doesNotMatch(menu().textContent, /Disabled Work|disabled@example.com/);
  assert.equal(useStore.getState().selectedAccountId, 'a1');
  await React.act(async () => useStore.setState({ accounts: [
    { id: 'disabled', name: 'Disabled Work', email_address: 'disabled@example.com', enabled: false },
  ] }));
  assert.equal(menu().querySelectorAll('.mailflow-gmail-connected-accounts button').length, 0);
  assert.match(menu().textContent, /No enabled mail accounts/);
  assert.equal(useStore.getState().selectedAccountId, 'a1');
});
