import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k, d) => (typeof d === "string" ? d : (d?.defaultValue ?? k).replace(/{{(\\w+)}}/g, (_, name) => d[name])), i18n: { language: "en", changeLanguage: () => {} } });',
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
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent, Event: dom.window.Event,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
// useMobile() reads window.innerWidth first, then subscribes to matchMedia. jsdom defaults
// innerWidth to 1024, which is the desktop case the bug report is about.
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.matchMedia = dom.window.matchMedia;
dom.window.Element.prototype.scrollIntoView = () => {};
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
// MessageList loads its own messages on mount and overwrites anything seeded in the store,
// so the fetch stub has to serve the row rather than the store. Only the messages endpoint
// needs a real shape; everything else can be an empty object, unless a test serves a path
// through ROUTES as [status, body].
let SERVED = [];
const ROUTES = {};
// Every request, with its JSON body, for tests that assert what reached the server.
let CALLS = [];
globalThis.fetch = async (url, opts = {}) => {
  const path = String(url);
  let sent = null;
  try { sent = typeof opts.body === 'string' ? JSON.parse(opts.body) : null; } catch { /* not JSON */ }
  CALLS.push({ path, method: opts.method || 'GET', body: sent });
  // A route may carry response headers as a third element.
  const [status, body, headers = {}] = Object.entries(ROUTES).find(([p]) => path.endsWith(p))?.[1]
    ?? [200, path.includes('/mail/messages?') ? { messages: SERVED, total: SERVED.length } : {}];
  return { ok: status < 400, status, headers: { get: name => headers[name] ?? (/content-type/i.test(name) ? 'application/json' : null) }, json: async () => body, text: async () => JSON.stringify(body) };
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const MessageList = (await import('./MessageList.jsx')).default;

const { api } = await import('../utils/api.js');
api.savePreferencesOnExit = () => {};

const ACCOUNT = { id: '22222222-2222-4222-8222-222222222222', email_address: 'me@example.test', aliases: [],
  folder_mappings: { drafts: 'Drafts' }, signature: '', enabled: true };
const draft = (n = 1) => ({ id: `${String(n).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, account_id: ACCOUNT.id,
  storage_generation: '33333333-3333-4333-8333-333333333333', entity_id: `${String(n).padStart(8, '0')}-eeee-4eee-8eee-eeeeeeeeeeee`,
  folder: 'Drafts', uid: 5, uid_validity: '42', message_id: '<same-rfc@example.test>', subject: `Draft ${n}`,
  from_email: ACCOUNT.email_address, to_addresses: [{ address: 'to@example.test' }], is_read: true, is_draft: true,
  is_deleted: false, has_attachments: false, date: '2026-11-10T12:00:00Z' });
const expected = row => ({ messageId: row.id, accountId: row.account_id, storageGeneration: row.storage_generation,
  entityId: row.entity_id, folder: row.folder, uidValidity: String(row.uid_validity), uid: String(row.uid) });
let root;
const original = { getMessageBody: api.getMessageBody, getMessageBcc: api.getMessageBcc };
async function mount(rows) {
  SERVED = rows;
  api.getMessageBody = async () => ({ text: 'Editable draft text', attachments: [] });
  api.getMessageBcc = async () => ({ bcc: ['private@example.test'] });
  useStore.setState({ user: { id: 'draft-user' }, isLocked: false, accounts: [ACCOUNT], accountsReady: true,
    selectedAccountId: ACCOUNT.id, selectedFolder: 'Drafts', selectedMessageId: null,
    layout: 'gmail', gmailDensity: 'default', messages: rows, messagesTotal: rows.length, hasMoreMessages: false,
    loadingMessages: false, searchQuery: '', searchResults: [], threadedView: false, conversationMode: 'off',
    expandedThreadId: null, threadMessages: {}, loadingThread: false, composing: false, composeData: null, prepareComposeSwitch: null,
    activeGtdTab: null, gtdSections: null, enabledPlugins: [], categorizationEnabled: false, activeLabel: null, nativeLabelFeed: null,
    folders: { [ACCOUNT.id]: [{ path: 'Drafts', name: 'Drafts', special_use: '\\Drafts' }, { path: 'INBOX', name: 'INBOX' }] } });
  await React.act(async () => { root = createRoot(document.getElementById('root')); root.render(React.createElement(MessageList)); });
}
const clickRow = row => React.act(async () => {
  const node = document.querySelector(`[data-msgid="${row.id}"] .mailflow-message-row`);
  assert.ok(node); node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
});
afterEach(async () => {
  if (root) await React.act(async () => root.unmount());
  root = null; Object.assign(api, original);
  window.dispatchEvent(new window.Event('pagehide'));
});

test('Drafts list opening preserves clicked immutable row authority and all editable data', async () => {
  const row = draft(); await mount([row]); await clickRow(row);
  const data = useStore.getState().composeData;
  assert.deepEqual(data.draftSource, expected(row));
  assert.equal(Object.isFrozen(data.draftSource), true);
  assert.equal(data.body, 'Editable draft text');
  assert.deepEqual(data.bcc, ['private@example.test']);
  assert.equal(data.draftAccountId, ACCOUNT.id);
});

test('a delayed list open cannot reread a newer row at the same account/folder/UID', async () => {
  const row = draft(); await mount([row]);
  let finish;
  api.getMessageBody = () => new Promise(resolve => { finish = resolve; });
  await clickRow(row);
  const newer = { ...draft(2), uid_validity: '43' };
  await React.act(async () => { useStore.setState({ messages: [newer] }); finish({ text: 'Original saved text', attachments: [] }); });
  assert.deepEqual(useStore.getState().composeData.draftSource, expected(row));
  assert.notDeepEqual(useStore.getState().composeData.draftSource, expected(newer));
});

for (const change of ['rapid click', 'account ABA', 'compose reopen', 'lock ABA']) test(`delayed list draft opening is cancelled after ${change}`, async () => {
  const first = draft(), second = { ...draft(2), uid: 6, message_id: '<second@example.test>' }; await mount([first, second]);
  let finish;
  api.getMessageBody = id => id === first.id ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ text: 'Second body', attachments: [] });
  await clickRow(first);
  if (change === 'rapid click') await clickRow(second);
  else await React.act(async () => {
    if (change === 'account ABA') { useStore.setState({ selectedAccountId: null }); useStore.setState({ selectedAccountId: ACCOUNT.id }); }
    else if (change === 'compose reopen') { useStore.getState().openCompose({ subject: 'New editor' }); useStore.getState().closeCompose(); }
    else { useStore.setState({ isLocked: true }); useStore.setState({ isLocked: false }); }
  });
  const before = useStore.getState().composeData;
  await React.act(async () => { finish({ text: 'Old body', attachments: [] }); });
  assert.deepEqual(useStore.getState().composeData, before);
  if (change === 'rapid click') assert.deepEqual(before.draftSource, expected(second));
});
