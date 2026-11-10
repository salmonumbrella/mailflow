import { test, beforeEach, afterEach } from 'node:test';
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
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = dom.window.matchMedia;
dom.window.ResizeObserver = globalThis.ResizeObserver;
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0 });
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}), text: async () => '{}' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { api } = await import('../utils/api.js');
const { useStore } = await import('../store/index.js');
const MailApp = (await import('./MailApp.jsx')).default;
const ACCOUNT = { id: 'a', enabled: true, email_address: 'alice@example.invalid', name: 'Alice', signature: '<p>Alice signature</p>' };
const MESSAGE = { id: 'm1', account_id: 'a', folder: 'INBOX', from_name: 'Real sender', subject: 'Session message', is_read: true };
const original = { ...api };
let root;
let records;
let uses;
let saves;
let sends;
const SNIPPET = { id: '11111111-1111-4111-8111-111111111111', title: 'Internal label', subject: 'Authored subject', body: '<img src=x onerror=alert(1)>\nNext line', version: 1, usageCount: 0, lastUsedAt: null, updatedAt: '2026-01-01T10:00:00.000Z' };
beforeEach(async () => {
  records = [{ ...SNIPPET }]; uses = []; saves = []; sends = [];
  api.get = async path => path === '/snippets' ? { snippets: structuredClone(records) } : {};
  api.post = async (path, data) => { uses.push({ path, ...data }); const item = records.find(item => path.includes(item.id)); item.usageCount++; item.lastUsedAt = new Date().toISOString(); return { ...item }; };
  api.saveDraft = async data => { saves.push(data); return { uid: 8, folder: 'Drafts' }; };
  api.send = async data => { sends.push(data); return {}; };
  Object.assign(api, { getAccounts: async () => [ACCOUNT], getUnreadCounts: async () => ({ total: 0, byAccount: {}, snapshots: {}, complete: true }), getFolders: async () => [], todoist: { status: async () => ({ connected: false }) } });
  window.innerWidth = 1440;
  localStorage.clear();
  history.replaceState(null, '', '/');
  useStore.setState({ ...useStore.getInitialState(), user: { id: 'user-a' }, layout: 'superhuman', theme: 'light', sidebarCollapsed: true, messages: [MESSAGE], rightSidebarHidden: false, markReadBehavior: 'manual', plaintextEmail: false, defaultSender: 'account:a' });
  root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(MailApp)));
});
afterEach(async () => { await React.act(async () => root.unmount()); Object.assign(api, original); delete globalThis.__TEST_PLUGIN_SLOTS__; });
const update = async state => React.act(async () => useStore.setState(state));
const click = async selector => React.act(async () => { const node = document.querySelector(selector); assert.ok(node, selector); node.click(); });


const byText = text => [...document.querySelectorAll('button')].find(node => node.textContent.trim() === text);
const clickText = async text => React.act(async () => { const node = byText(text); assert.ok(node, text); node.click(); });
const flush = async () => { await React.act(async () => {}); };

test('standalone snippets navigation preserves mail and browser history; reads never record usage', async () => {
  await click('[aria-label="Snippets"]');
  assert.equal(document.querySelector('[data-auxiliary-view]').dataset.auxiliaryView, 'snippets');
  assert.equal(document.querySelector('[aria-label="Snippets"]').getAttribute('aria-current'), 'page');
  assert.match(document.querySelector('[data-auxiliary-view]').textContent, /Internal label/);
  assert.match(document.querySelector('[data-auxiliary-view]').textContent, /Last usedNever/);
  assert.equal(uses.length, 0);
  assert.ok(document.querySelector('[data-native-list]'));
  await clickText('Back to mail'); assert.equal(document.querySelector('[data-auxiliary-view]'), null);
  await React.act(async () => window.dispatchEvent(new window.PopStateEvent('popstate', { state: { mailflowAux: 'snippets' } })));
  assert.ok(document.querySelector('[data-auxiliary-view="snippets"]')); assert.equal(uses.length, 0);
  await React.act(async () => window.dispatchEvent(new window.PopStateEvent('popstate', { state: {} })));
  assert.equal(document.querySelector('[data-auxiliary-view]'), null);
});

test('compose from snippet mounts native composer with authored subject, safe body, native From and signature', async () => {
  await click('[aria-label="Snippets"]'); await clickText('Compose from snippet'); await flush();
  assert.equal(document.querySelector('[data-auxiliary-view]'), null);
  const state = useStore.getState();
  assert.equal(state.composeData.subject, 'Authored subject'); assert.notEqual(state.composeData.subject, 'Internal label');
  assert.match(state.composeData.body, /&lt;img/); assert.equal(state.composeData.bodyIsHtml, true);
  assert.equal(document.querySelector('.ProseMirror img'), null);
  assert.match(document.querySelector('.ProseMirror').editor.getText(), /<img src=x/);
  assert.ok([...document.querySelectorAll('select')].find(node => node.value === 'account:a'));
  assert.match(document.body.textContent, /Alice signature/);
  assert.equal(uses.length, 1); assert.match(uses[0].path, /\/use$/); assert.match(uses[0].requestId, /^[0-9a-f-]{36}$/);
  assert.equal(sends.length, 0);
});

test('compose saves the existing dirty native draft with signature and quote before switching', async () => {
  await React.act(async () => useStore.getState().openCompose({ accountId: 'a', draftUid: 7, draftFolder: 'Drafts', subject: 'Original subject', body: '<p>Original text</p>', signature: '<p>Edited signature</p>', quotedBody: 'Quoted mail' }));
  await flush();
  await React.act(async () => document.querySelector('.ProseMirror').editor.commands.insertContent('Important edit '));
  await click('[aria-label="Snippets"]'); await clickText('Compose from snippet'); await flush();
  assert.equal(saves.length, 1); assert.equal(saves[0].existingUid, 7); assert.equal(saves[0].subject, 'Original subject');
  assert.match(saves[0].body, /Important edit/); assert.match(saves[0].editedSignature, /Edited signature/); assert.equal(saves[0].quotedBody, 'Quoted mail');
  assert.equal(useStore.getState().composeData.subject, 'Authored subject'); assert.equal(uses.length, 1); assert.equal(sends.length, 0);
});

test('failed draft handoff neither replaces the current draft nor records use', async () => {
  await React.act(async () => useStore.getState().openCompose({ body: '<p>Must keep</p>', subject: 'Keep' })); await flush();
  await update({ prepareComposeSwitch: async () => false });
  await click('[aria-label="Snippets"]'); await clickText('Compose from snippet');
  assert.equal(useStore.getState().composeData.subject, 'Keep'); assert.match(document.querySelector('[role="alert"]').textContent, /existing draft has been kept/);
  assert.equal(uses.length, 0); assert.equal(sends.length, 0);
});

test('account changes during pending handoff refuse late compose and usage, including switch-back', async () => {
  await React.act(async () => useStore.getState().openCompose({ subject: 'Keep', body: '<p>Must keep</p>' })); await flush();
  let resolve; await update({ prepareComposeSwitch: () => new Promise(done => { resolve = done; }) });
  await click('[aria-label="Snippets"]'); await clickText('Compose from snippet');
  await update({ selectedAccountId: 'other' }); await update({ selectedAccountId: null });
  await React.act(async () => resolve(true));
  assert.equal(useStore.getState().composeData.subject, 'Keep'); assert.equal(uses.length, 0);
});

test('leaving snippets while handoff is pending cannot reopen a composer after a later return', async () => {
  await React.act(async () => useStore.getState().openCompose({ subject: 'Keep', body: '<p>Must keep</p>' })); await flush();
  let resolve; await update({ prepareComposeSwitch: () => new Promise(done => { resolve = done; }) });
  await click('[aria-label="Snippets"]'); await clickText('Compose from snippet');
  await click('[aria-label="All inboxes"]'); await click('[aria-label="Snippets"]');
  await React.act(async () => resolve(true));
  assert.equal(useStore.getState().composeData.subject, 'Keep'); assert.equal(uses.length, 0);
});

test('a usage-save failure does not roll back a successfully opened draft or send it', async () => {
  api.post = async () => { throw new Error('Offline'); };
  await click('[aria-label="Snippets"]'); await clickText('Compose from snippet'); await flush();
  assert.equal(useStore.getState().composeData.subject, 'Authored subject');
  assert.match(useStore.getState().notifications.at(-1).body, /usage could not be saved/); assert.equal(sends.length, 0);
});

test('owner changes while a draft handoff is pending do not compose or count usage for the new owner', async () => {
  await React.act(async () => useStore.getState().openCompose({ subject: 'Keep', body: '<p>Must keep</p>' })); await flush();
  let resolve; await update({ prepareComposeSwitch: () => new Promise(done => { resolve = done; }) });
  await click('[aria-label="Snippets"]'); await clickText('Compose from snippet');
  records = [];
  await update({ user: { id: 'user-b' } });
  await React.act(async () => resolve(true));
  assert.equal(useStore.getState().composeData.subject, 'Keep'); assert.equal(uses.length, 0);
  assert.doesNotMatch(document.querySelector('[data-auxiliary-view]').textContent, /Internal label/);
});

test('repeated compose clicks during a pending handoff open one draft and record one use', async () => {
  await React.act(async () => useStore.getState().openCompose({ subject: 'Old', body: '<p>Old draft</p>' })); await flush();
  let resolve; let prepares = 0;
  await update({ prepareComposeSwitch: () => { prepares++; return new Promise(done => { resolve = done; }); } });
  await click('[aria-label="Snippets"]');
  const action = byText('Compose from snippet');
  await React.act(async () => { action.click(); action.click(); });
  assert.equal(prepares, 1); assert.equal(uses.length, 0);
  await React.act(async () => resolve(true)); await flush();
  assert.equal(useStore.getState().composeData.subject, 'Authored subject'); assert.equal(uses.length, 1);
});
