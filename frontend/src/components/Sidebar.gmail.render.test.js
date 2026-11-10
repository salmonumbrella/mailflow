// Render test for the sidebar's folder unread badges (#536).
//
// A collapsed folder showed only its own count, so new mail in its subfolders was invisible
// until it was expanded. The harness mirrors MessageList.render.test.js: node --test cannot
// parse JSX, so the loader hook transforms .jsx with sucrase, and react-i18next is stubbed.

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


const ACCOUNT = { id: 'acct-1', email_address: 'a@example.com', name: 'A', color: '#6366f1', enabled: true, include_in_unified_inbox: true,
  folder_mappings: { sent: 'Mail/Sent items', drafts: 'Local drafts' } };
const FOLDERS = [
  { path: 'INBOX', name: 'INBOX', unread_count: 7, counts_known: true },
  { path: 'Server sent', name: 'Server sent', special_use: '\\Sent' },
  { path: 'Mail/Sent items', name: 'Sent items' },
  { path: 'Local drafts', name: 'Local drafts', unread_count: 0, total_count: 4, counts_known: true },
  { path: 'Corbeille', name: 'Corbeille', special_use: '\\Trash' },
  { path: 'Indesirable', name: 'Indesirable', special_use: '\\Junk' },
  { path: '[Gmail]/Important', name: 'Important', special_use: '\\Important' },
  { path: '[Gmail]/Tous', name: 'Tous', special_use: '\\All' },
  { path: 'Projects', name: 'Projects', unread_count: 2 },
];
let root;
async function mount(overrides = {}) {
  if (root) await React.act(async () => root.unmount());
  useStore.setState({ accounts: [ACCOUNT], accountsReady: true, layout: 'gmail', sidebarCollapsed: false,
    folders: { 'acct-1': FOLDERS }, selectedAccountId: 'acct-1', selectedFolder: 'INBOX',
    searchQuery: '', searchAllFolders: false, showContacts: false, expandedAccounts: { 'acct-1': true },
    collapsedFolders: [], hiddenFolders: {}, favoriteFolders: [], snoozedCount: 0, scheduledCount: 3,
    scheduledAttention: 0, unreadCounts: { total: 7, complete: true, byAccount: { 'acct-1': 7 } }, ...overrides });
  await React.act(async () => {
    root = createRoot(document.getElementById('root'));
    root.render(React.createElement(Sidebar));
  });
}
const row = id => document.querySelector(`[data-gmail-nav="${id}"]`);
const click = async id => { assert.ok(row(id), `${id} exists`); await React.act(async () => row(id).click()); };
const key = async (element, key) => { await React.act(async () => element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }))); };

describe('Gmail sidebar uses live native mailboxes', () => {
  test('inbox and draft counts use server observations, not loaded messages', async () => {
    await mount({ messages: [] });
    assert.equal(row('inbox').getAttribute('aria-current'), 'page');
    assert.equal(row('inbox').querySelector('.gmail-native-nav-count').textContent, '7');
    assert.equal(row('drafts').querySelector('.gmail-native-nav-count').textContent, '4');
    await mount({ folders: { 'acct-1': FOLDERS.map(f => ({ ...f, counts_known: false })) } });
    assert.equal(row('drafts').querySelector('.gmail-native-nav-count'), null);
    assert.equal(row('inbox').querySelector('.gmail-native-nav-count'), null);
  });

  test('explicit mappings win over flagged folders and navigating clears prior searches', async () => {
    await mount({ searchQuery: 'from:someone', searchAllFolders: true });
    await click('sent');
    assert.equal(useStore.getState().selectedFolder, 'Mail/Sent items');
    assert.equal(useStore.getState().selectedAccountId, 'acct-1');
    assert.equal(useStore.getState().searchQuery, '');
    await click('drafts');
    assert.equal(useStore.getState().selectedFolder, 'Local drafts');
    assert.equal(row('drafts').getAttribute('aria-current'), 'page');
  });

  test('Starred searches across folders but only in the selected account', async () => {
    await mount();
    await click('starred');
    assert.equal(useStore.getState().selectedAccountId, 'acct-1');
    assert.equal(useStore.getState().searchQuery, 'is:starred');
    assert.equal(useStore.getState().searchAllFolders, true);
    assert.equal(row('starred').getAttribute('aria-current'), 'page');
    assert.equal(row('inbox').getAttribute('aria-current'), null);
    await click('inbox');
    assert.equal(useStore.getState().searchQuery, '');
  });

  test('More/Less exposes real provider folders and unified Scheduled with an honest scope', async () => {
    await mount();
    assert.equal(row('trash'), null);
    await click('more');
    assert.equal(row('more').getAttribute('aria-expanded'), 'true');
    await click('trash');
    assert.equal(useStore.getState().selectedFolder, 'Corbeille');
    await click('spam');
    assert.equal(useStore.getState().selectedFolder, 'Indesirable');
    await click('important');
    assert.equal(useStore.getState().selectedFolder, '[Gmail]/Important');
    await click('all');
    assert.equal(useStore.getState().selectedFolder, '[Gmail]/Tous');
    assert.match(row('scheduled').title, /All accounts/);
    await click('scheduled');
    assert.equal(useStore.getState().selectedAccountId, null);
    assert.equal(useStore.getState().selectedFolder, '__scheduled__');
    assert.equal(row('scheduled').getAttribute('aria-current'), 'page');
    await click('more');
    assert.equal(row('trash'), null);
  });

  test('unavailable account folders stay disabled and Important is not invented', async () => {
    await mount({ folders: { 'acct-1': [FOLDERS[0]] } });
    assert.equal(row('sent').disabled, true);
    await click('more');
    assert.equal(row('important'), null);
    await click('all');
    assert.equal(useStore.getState().searchQuery, 'in:all');
    assert.equal(useStore.getState().selectedAccountId, 'acct-1');
  });

  test('account selector changes scope and unified role links use backend search', async () => {
    await mount();
    const select = document.querySelector('.gmail-native-scope');
    await React.act(async () => { select.value = ''; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
    await click('sent');
    assert.equal(useStore.getState().selectedAccountId, null);
    assert.equal(useStore.getState().searchQuery, 'in:sent');
    assert.match(row('sent').title, /Unified inbox accounts/);
    await React.act(async () => { select.value = 'acct-1'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
    assert.equal(useStore.getState().selectedAccountId, 'acct-1');
    assert.equal(useStore.getState().searchQuery, '');
  });

  test('hiding mapped Sent and Drafts moves them behind More, and showing restores them', async () => {
    await mount();
    await React.act(async () => useStore.setState({ hiddenFolders: { 'acct-1': ['Mail/Sent items', 'Local drafts'] } }));
    assert.equal(row('sent'), null);
    assert.equal(row('drafts'), null);
    assert.equal(useStore.getState().selectedFolder, 'INBOX');
    await click('more');
    assert.ok(row('more').compareDocumentPosition(row('sent')) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(row('more').compareDocumentPosition(row('drafts')) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
    await click('more');
    assert.equal(row('sent'), null);
    await React.act(async () => useStore.setState({ hiddenFolders: {} }));
    assert.ok(row('sent'));
    assert.ok(row('drafts'));
    assert.ok(row('sent').compareDocumentPosition(row('more')) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(row('drafts').compareDocumentPosition(row('more')) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  });

  test('an active hidden folder remains visible without duplicating its shortcut', async () => {
    await mount({ selectedFolder: 'Local drafts', hiddenFolders: { 'acct-1': ['Local drafts', 'Corbeille'] } });
    assert.equal(row('drafts').getAttribute('aria-current'), 'page');
    await click('more');
    assert.equal(document.querySelectorAll('[data-gmail-nav="drafts"]').length, 1);
    await click('trash');
    await click('more');
    assert.equal(row('trash').getAttribute('aria-current'), 'page');
    assert.equal(row('drafts'), null);
    await click('inbox');
    assert.equal(row('trash'), null);
  });

  test('hidden shortcuts are account-specific and unified search names its actual account scope', async () => {
    await mount({ accounts: [ACCOUNT, { ...ACCOUNT, id: 'acct-2', email_address: 'excluded@example.com', include_in_unified_inbox: false }],
      hiddenFolders: { 'acct-2': ['Mail/Sent items'] } });
    assert.ok(row('sent'));
    const select = document.querySelector('.gmail-native-scope');
    assert.equal(select.querySelector('option[value=""]').textContent, 'Unified inbox accounts');
    assert.ok(select.querySelector('option[value="acct-2"]'));
    await React.act(async () => { select.value = ''; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
    await click('starred');
    assert.match(row('starred').title, /Unified inbox accounts/);
    assert.doesNotMatch(row('starred').title, /All accounts/);
    assert.match(row('snoozed').title, /All accounts/);
    await click('more');
    assert.match(row('scheduled').title, /All accounts/);
  });

  test('categories expose only supported native names and native queries', async () => {
    await mount();
    await key(row('categories'), 'ArrowRight');
    assert.equal(row('categories').getAttribute('aria-expanded'), 'true');
    assert.equal(row('forums'), null);
    assert.equal(row('updates'), null);
    await click('newsletter');
    assert.equal(useStore.getState().searchQuery, 'category:newsletter');
    assert.equal(useStore.getState().selectedAccountId, 'acct-1');
    await key(row('categories'), 'ArrowLeft');
    assert.equal(row('newsletter'), null);
  });

  test('collapsed shortcuts retain icons and scope tooltips; keyboard navigation skips disabled rows', async () => {
    await mount({ sidebarCollapsed: true, folders: { 'acct-1': [FOLDERS[0]] } });
    assert.ok(row('inbox').querySelector('svg'));
    assert.equal(row('inbox').querySelector('span'), null);
    assert.match(row('inbox').title, /a@example.com/);
    row('inbox').focus();
    await key(row('inbox'), 'ArrowDown');
    assert.equal(document.activeElement, row('starred'));
    await key(row('starred'), 'Home');
    assert.equal(document.activeElement, row('inbox'));
    await key(row('inbox'), 'End');
    assert.equal(document.activeElement.getAttribute('data-gmail-account'), 'acct-1');
    row('snoozed').focus();
    await key(row('snoozed'), 'ArrowDown');
    assert.equal(document.activeElement, row('categories'));
  });

  test('native folder clicks and Enter clear shortcut searches and preserve the path', async () => {
    await mount();
    await click('starred');
    const project = [...document.querySelectorAll('[data-mailbox-row]')].find(el => el.textContent === 'Projects2');
    assert.ok(project);
    await key(project, 'Enter');
    assert.equal(useStore.getState().selectedFolder, 'Projects');
    assert.equal(useStore.getState().searchQuery, '');
    await click('starred');
    await React.act(async () => project.click());
    assert.equal(useStore.getState().searchQuery, '');
  });

  test('manage folders expands the native tree without replacing identities or hiding controls', async () => {
    await mount({ expandedAccounts: {} });
    await click('more');
    await click('manage');
    assert.equal(useStore.getState().expandedAccounts['acct-1'], true);
    assert.ok(document.querySelector('[data-gmail-account="acct-1"]'));
    assert.ok([...document.querySelectorAll('span')].some(el => el.textContent === 'Projects'));
  });
});
