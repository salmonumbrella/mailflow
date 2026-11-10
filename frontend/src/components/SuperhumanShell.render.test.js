import { test, beforeEach, afterEach } from 'node:test';
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
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.matchMedia = dom.window.matchMedia;
dom.window.Element.prototype.scrollIntoView = () => {};
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}), text: async () => '{}' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const Sidebar = (await import('./Sidebar.jsx')).default;

const { api } = await import('../utils/api.js');
const { SuperhumanRail, SuperhumanRecent, SuperhumanFooter } = await import('./SuperhumanShell.jsx');
const ACCOUNT = { id: 'a', enabled: true, email_address: 'a@example.invalid' };
const MESSAGE = { id: 'm1', account_id: 'a', folder: 'INBOX', from_name: 'Real sender', subject: 'Opened message', is_read: true };
const originalApi = { ...api };
let root;
beforeEach(() => {
  localStorage.clear();
  useStore.setState({ ...useStore.getInitialState(), user: { id: 'user-a' }, accounts: [ACCOUNT], accountsReady: true, selectedAccountId: 'a', selectedFolder: 'INBOX', messages: [MESSAGE], markReadBehavior: 'manual', layout: 'superhuman' });
  root = createRoot(document.getElementById('root'));
});
afterEach(async () => {
  await React.act(async () => root.unmount());
  Object.assign(api, originalApi);
});
const render = async (Component, props = {}) => React.act(async () => root.render(React.createElement(Component, props)));
const update = async state => React.act(async () => useStore.setState(state));
const click = async node => React.act(async () => { assert.ok(node); node.click(); });
const byLabel = label => document.querySelector(`[aria-label="${label}"]`);

test('the rail invokes native compose, inbox and settings and calls shell-only controls', async () => {
  let folders = 0; let search = 0; let commands = 0;
  await render(SuperhumanRail, { onToggleFolders: () => folders++, onSearch: () => search++, onCommands: () => commands++, onHelp() {} });
  await click(byLabel('Compose'));
  assert.equal(useStore.getState().composing, true);
  await click(byLabel('All inboxes'));
  assert.equal(useStore.getState().selectedAccountId, null);
  assert.equal(useStore.getState().selectedFolder, 'INBOX');
  await click(byLabel('Manage accounts'));
  assert.equal(useStore.getState().adminTab, 'accounts');
  assert.equal(useStore.getState().showAdmin, true);
  await click(byLabel('Settings'));
  assert.equal(useStore.getState().adminTab, 'appearance');
  await click(byLabel('Folders and accounts'));
  await click(byLabel('Search mail'));
  await click(byLabel('Commands'));
  assert.deepEqual([folders, search, commands], [1, 1, 1]);
});

test('recent opens starts empty and records actual selections only, without duplicate subjects', async () => {
  await render(SuperhumanRecent);
  assert.equal(document.querySelectorAll('.superhuman-recent-message').length, 0);
  assert.match(document.body.textContent, /history stays in this session/);
  await update({ selectedMessageId: 'unknown' });
  assert.equal(document.querySelectorAll('.superhuman-recent-message').length, 0);
  await update({ selectedMessageId: MESSAGE.id });
  assert.equal(document.querySelectorAll('.superhuman-recent-message').length, 1);
  assert.match(document.body.textContent, /Opened message/);
  await update({ selectedMessageId: null });
  await update({ selectedMessageId: MESSAGE.id });
  assert.equal(document.querySelectorAll('.superhuman-recent-message').length, 1);
  assert.equal(localStorage.length, 0, 'no message history is persisted');
});

test('reopening a listed message uses native selection and clears old parked metadata', async () => {
  await render(SuperhumanRecent);
  await update({ selectedMessageId: MESSAGE.id });
  await update({ selectedMessageId: null, threadMessages: { __dl_m1: [MESSAGE] } });
  api.resolveMessage = async () => { throw new Error('listed messages need no lookup'); };
  await click(document.querySelector('.superhuman-recent-message'));
  assert.equal(useStore.getState().selectedMessageId, MESSAGE.id);
  assert.equal(useStore.getState().threadMessages.__dl_m1, undefined);
});

test('reopening across folders resolves current metadata and parks in native reader scope', async () => {
  await render(SuperhumanRecent);
  await update({ selectedMessageId: MESSAGE.id });
  await update({ selectedMessageId: null, messages: [], searchQuery: 'old search' });
  const moved = { ...MESSAGE, id: 'moved', folder: 'Archive' };
  api.resolveMessage = async id => { assert.equal(id, MESSAGE.id); return moved; };
  await click(document.querySelector('.superhuman-recent-message'));
  const state = useStore.getState();
  assert.equal(state.selectedMessageId, 'moved');
  assert.equal(state.selectedAccountId, 'a');
  assert.equal(state.selectedFolder, 'Archive');
  assert.equal(state.searchQuery, '');
  assert.deepEqual(state.threadMessages.__dl_moved, [moved]);
  assert.deepEqual(state.messages, [], 'recent history never fabricates a mailbox row');
});

test('a lookup that returns after newer navigation cannot take over the reader', async () => {
  await render(SuperhumanRecent);
  await update({ selectedMessageId: MESSAGE.id });
  await update({ selectedMessageId: null, messages: [] });
  let resolve;
  api.resolveMessage = () => new Promise(done => { resolve = done; });
  await click(document.querySelector('.superhuman-recent-message'));
  await React.act(async () => useStore.getState().setSelectedAccount('a', 'Sent'));
  await React.act(async () => resolve(MESSAGE));
  assert.equal(useStore.getState().selectedFolder, 'Sent');
  assert.equal(useStore.getState().selectedMessageId, null);
});

test('history clears when identity changes and hides disconnected accounts', async () => {
  await render(SuperhumanRecent);
  await update({ selectedMessageId: MESSAGE.id });
  await update({ accounts: [] });
  assert.equal(document.querySelectorAll('.superhuman-recent-message').length, 0);
  await update({ accounts: [ACCOUNT] });
  assert.equal(document.querySelectorAll('.superhuman-recent-message').length, 1);
  await update({ user: { id: 'user-b' }, selectedMessageId: null, messages: [] });
  assert.equal(document.querySelectorAll('.superhuman-recent-message').length, 0);
});

test('drafts are not recorded as ordinary recent message opens', async () => {
  await update({ accounts: [{ ...ACCOUNT, folder_mappings: { drafts: 'Drafts' } }], messages: [{ ...MESSAGE, folder: 'Drafts' }] });
  await render(SuperhumanRecent);
  await update({ selectedMessageId: MESSAGE.id });
  assert.equal(document.querySelectorAll('.superhuman-recent-message').length, 0);
});

test('a failed lookup reports an error without changing mailbox or selection', async () => {
  await render(SuperhumanRecent);
  await update({ selectedMessageId: MESSAGE.id });
  await update({ selectedMessageId: null, messages: [] });
  api.resolveMessage = async () => { throw new Error('Not found'); };
  await click(document.querySelector('.superhuman-recent-message'));
  assert.equal(useStore.getState().selectedMessageId, null);
  assert.equal(useStore.getState().selectedFolder, 'INBOX');
  assert.equal(useStore.getState().notifications[0].type, 'error');
});

test('the sidebar expanded override and local toggle leave native preferences untouched', async () => {
  let toggles = 0;
  await update({ sidebarCollapsed: true });
  await render(Sidebar, { expanded: true, onToggle: () => toggles++ });
  assert.equal(document.getElementById('root').firstElementChild.style.width, `${useStore.getState().sidebarWidth}px`);
  await click(document.querySelector('[title="sidebar.toggleSidebar"]'));
  assert.equal(toggles, 1);
  assert.equal(useStore.getState().sidebarCollapsed, true);
  assert.equal(localStorage.getItem('mailflow_sidebar_collapsed'), null);
});

test('footer hints use live shortcut overrides and omit unbound actions', async () => {
  await update({ shortcuts: { openMessage: 'p', compose: null } });
  await render(SuperhumanFooter);
  const badges = [...document.querySelectorAll('kbd')].map(el => el.textContent);
  assert.ok(badges.includes('p'));
  assert.ok(!badges.includes('c'));
});

test('list focus is ephemeral and cleared by navigation, identity change and lock', async () => {
  useStore.setState({ listFocusedMessageId: 'm1' });
  useStore.getState().setSelectedAccount('a', 'Archive');
  assert.equal(useStore.getState().listFocusedMessageId, null);
  useStore.setState({ listFocusedMessageId: 'm1' });
  useStore.getState().setUser({ id: 'user-b' });
  assert.equal(useStore.getState().listFocusedMessageId, null);
  useStore.setState({ listFocusedMessageId: 'm1' });
  useStore.getState().setLocked(true);
  assert.equal(useStore.getState().listFocusedMessageId, null);
});


test('recent opens honors manual marking and cancels a delayed mark when selection changes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let reads = 0;
  api.bulkRead = async () => { reads++; };
  await update({ messages: [{ ...MESSAGE, is_read: false }] });
  await render(SuperhumanRecent);
  await update({ selectedMessageId: MESSAGE.id });
  await update({ selectedMessageId: null });
  await click(document.querySelector('.superhuman-recent-message'));
  assert.equal(reads, 0, 'manual marking is preserved');
  await update({ selectedMessageId: null, markReadBehavior: 'delay', markReadDelay: 2 });
  await click(document.querySelector('.superhuman-recent-message'));
  await React.act(async () => t.mock.timers.tick(1000));
  assert.equal(reads, 0);
  await update({ selectedMessageId: null });
  await React.act(async () => t.mock.timers.tick(2000));
  assert.equal(reads, 0, 'leaving the message cancels its deferred read');
  await click(document.querySelector('.superhuman-recent-message'));
  await React.act(async () => t.mock.timers.tick(2000));
  assert.equal(reads, 1, 'remaining in the message honors the saved delay');
});
