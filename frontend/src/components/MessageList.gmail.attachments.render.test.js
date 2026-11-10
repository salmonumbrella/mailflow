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
const ACCOUNT = { id: '22222222-2222-4222-8222-222222222222', storage_generation: '33333333-3333-4333-8333-333333333333',
  email_address: 'a@example.test', name: 'A', color: '#6366f1', include_in_unified_inbox: true,
  oauth_provider: 'google', imap_host: 'imap.gmail.com', enabled: true };
const file = { part: '2', filename: 'Actual report.pdf', type: 'application/pdf', size: 2048 };
function message(index = 1, files = [file], fields = {}) {
  const row = { id: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`, account_id: ACCOUNT.id,
    storage_generation: ACCOUNT.storage_generation, entity_id: `${String(index).padStart(8, '0')}-4444-4444-8444-444444444444`,
    folder: 'INBOX', uid: index, uid_validity: '9', subject: `Subject ${index}`, snippet: 'Preview text',
    from_name: 'Sender', from_email: 'sender@example.test', date: '2026-11-10T12:00:00Z', is_read: false,
    is_starred: false, is_deleted: false, has_attachments: true, message_id: '<shared@example.test>', ...fields };
  row.attachmentMetadata = { state: files.length ? 'partial' : 'unknown', scope: 'message',
    source: { messageId: row.id, accountId: row.account_id, storageGeneration: row.storage_generation,
      entityId: row.entity_id, folder: row.folder, uidValidity: row.uid_validity, uid: String(row.uid) },
    items: files, omittedCount: 0, providerComplete: false, inlineClassification: 'partial', sizeIsExact: false };
  return row;
}
let root;
const container = document.getElementById('root');
const names = within => [...within.querySelectorAll('.mailflow-gmail-attachment-name')].map(node => node.textContent);
const mainRow = id => container.querySelector(`[data-msgid="${id}"] .mailflow-message-row`);
async function mount(rows, { threadedView = false, folder = 'INBOX', accountId = ACCOUNT.id,
  accounts = [ACCOUNT], layout = 'gmail', width = 1024, activeLabel = null, searchQuery = '' } = {}) {
  if (root) await React.act(async () => root.unmount());
  SERVED = rows;
  window.innerWidth = width;
  window.matchMedia = () => ({ matches: width <= 700, addEventListener() {}, removeEventListener() {} });
  document.documentElement.dataset.mailflowLayout = layout;
  document.documentElement.dataset.gmailDensity = 'default';
  useStore.setState({
    user: { id: 'chip-test-user' }, isLocked: false, accounts, accountsReady: true, layout, gmailDensity: 'default',
    selectedAccountId: accountId, selectedFolder: folder, messages: rows, messagesTotal: rows.length,
    hasMoreMessages: false, loadingMessages: false, searchQuery, searchResults: searchQuery ? rows : [],
    threadedView, selectedMessageId: null, expandedThreadId: null, threadMessages: {}, loadingThread: false,
    activeGtdTab: null, gtdSections: null, enabledPlugins: [], categorizationEnabled: false,
    activeLabel, nativeLabelFeed: null, showMessagePreviews: true,
    folders: Object.fromEntries(accounts.map(account => [account.id, [
      { path: 'INBOX', name: 'INBOX' }, { path: 'Archive', name: 'Archive' },
    ]])),
  });
  await React.act(async () => { root = createRoot(container); root.render(React.createElement(MessageList)); });
}

afterEach(async () => {
  if (root) await React.act(async () => root.unmount());
  root = null;
  window.dispatchEvent(new window.Event('pagehide'));
  assert.deepEqual(CALLS.filter(call => /\/attachments(?:\/|\.zip)|\/mail\/messages\/[^/?]+(?:\?|$)/.test(call.path)), [],
    'chip render, refresh and density updates never request bodies or attachment content');
  CALLS = [];
  for (const key of Object.keys(ROUTES)) delete ROUTES[key];
});

for (const threadedView of [false, true]) {
  test(`Gmail ${threadedView ? 'thread representative' : 'flat row'} displays only its cached physical-source files`, async () => {
    const row = message(1, [file], threadedView ? { thread_id: 'thread-one', message_count: 3, unread_count: 1 } : {});
    await mount([row], { threadedView });
    const element = mainRow(row.id);
    assert.deepEqual(names(element), [file.filename]);
    assert.equal(element.querySelector('.mailflow-gmail-attachment-chips').getAttribute('aria-label'),
      'Cached attachments for this message only; details may be incomplete.');
    assert.equal(element.querySelector('.mailflow-gmail-attachment-chips').querySelectorAll('button,a,[tabindex]').length, 0);
    assert.equal(element.getAttribute('draggable'), 'true');
    for (const density of ['comfortable', 'compact', 'default']) {
      await React.act(async () => useStore.setState({ gmailDensity: density }));
      assert.deepEqual(names(element), density === 'default' ? [file.filename] : []);
    }
  });
}

test('expanded child chips retain their own physical message source rather than representative metadata', async () => {
  const head = message(1, [file], { thread_id: 'thread-one', message_count: 3, unread_count: 2 });
  const child = message(2, [{ ...file, filename: 'Child image.png', type: 'image/png' }], { thread_id: 'thread-one' });
  const unknown = message(3, [], { thread_id: 'thread-one' });
  await mount([head], { threadedView: true });
  await React.act(async () => useStore.setState({ expandedThreadId: 'thread-one', threadMessages: { 'thread-one': [child, unknown] } }));
  assert.deepEqual(names(mainRow(head.id)), [file.filename]);
  const children = [...container.querySelectorAll('.mailflow-thread-message-row')];
  assert.equal(children.length, 2);
  assert.deepEqual(names(children[0]), ['Child image.png']);
  assert.deepEqual(names(children[1]), []);
  await React.act(async () => useStore.setState({ threadMessages: { 'thread-one': [{ ...child, uid: 77 }, unknown] } }));
  assert.deepEqual(names(children[0]), [], 'a moved/rebound child cannot retain stale part labels');
  assert.deepEqual(names(mainRow(head.id)), [file.filename]);
});

test('unified rows with the same RFC Message-ID never share attachment filenames or source accounts', async () => {
  const secondAccount = { ...ACCOUNT, id: '55555555-5555-4555-8555-555555555555' };
  const a = message(1);
  const b = message(2, [{ ...file, filename: 'Other account.docx' }], { account_id: secondAccount.id });
  await mount([a, b], { accountId: null, accounts: [ACCOUNT, secondAccount] });
  assert.deepEqual(names(mainRow(a.id)), [file.filename]);
  assert.deepEqual(names(mainRow(b.id)), ['Other account.docx']);
  await React.act(async () => useStore.setState({ messages: [a, { ...b, attachmentMetadata: a.attachmentMetadata }] }));
  assert.deepEqual(names(mainRow(b.id)), [], 'a copied wrapper from another account is not usable');
});

test('Snoozed, search and native-label results use the same bounded message-only metadata', async () => {
  const snoozed = message(1, [file], { folder: 'Snoozed', snooze_until: '2026-11-11T12:00:00Z' });
  await mount([snoozed], { folder: 'Snoozed', threadedView: true });
  assert.deepEqual(names(mainRow(snoozed.id)), [file.filename]);
  const search = message(2, [{ ...file, filename: 'Search.pdf' }]);
  await mount([search], { searchQuery: 'has:attachment' });
  assert.deepEqual(names(mainRow(search.id)), ['Search.pdf']);
  const native = message(3, [{ ...file, filename: 'Native label.pdf' }], {
    entityId: '66666666-6666-4666-8666-666666666666', storageGeneration: ACCOUNT.storage_generation,
    nativeLabelState: 'available', nativeLabels: [],
  });
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/labels/test-label/messages?')) return { ok: true, status: 200,
      headers: { get: () => 'application/json' }, json: async () => ({ accountId: ACCOUNT.id,
        storageGeneration: ACCOUNT.storage_generation, labelId: 'test-label', messages: [native], total: 1, nextCursor: null }), text: async () => '' };
    return original(url, options);
  };
  try {
    await mount([], { folder: null, activeLabel: { accountId: ACCOUNT.id,
      storageGeneration: ACCOUNT.storage_generation, labelId: 'test-label' } });
    assert.deepEqual(names(mainRow(native.id)), ['Native label.pdf'], 'canonical label alias does not replace physical entity');
  } finally { globalThis.fetch = original; }
});

test('missing metadata preserves existing paperclip; layout switches and mobile render do not invent chips', async () => {
  const known = message(1);
  const unknown = message(2, [], { message_id: '<unknown@example.test>' }); delete unknown.attachmentMetadata;
  await mount([known, unknown], { width: 390 });
  assert.deepEqual(names(mainRow(known.id)), [file.filename]);
  assert.deepEqual(names(mainRow(unknown.id)), []);
  assert.ok(mainRow(unknown.id).querySelector('path[d^="M21.44"]'), 'existing attachment flag remains visible');
  for (const layout of ['comfortable', 'list', 'gmail']) {
    await React.act(async () => useStore.setState({ layout }));
    assert.deepEqual(names(mainRow(known.id)), layout === 'gmail' ? [file.filename] : []);
  }
});

test('metadata/density refresh leaves Gmail keyboard row focus and bulk selection intact', async () => {
  const row = message(1);
  await mount([row]);
  const element = mainRow(row.id);
  assert.equal(element.getAttribute('role'), 'group');
  assert.equal(element.getAttribute('tabindex'), '0');
  await React.act(async () => element.focus());
  const checkbox = element.querySelector('input[type="checkbox"]');
  await React.act(async () => checkbox.click());
  assert.equal(checkbox.checked, true);
  await React.act(async () => element.focus());
  for (const density of ['compact', 'comfortable', 'default']) {
    await React.act(async () => useStore.setState({ gmailDensity: density,
      messages: [{ ...row, attachmentMetadata: { ...row.attachmentMetadata, items: [{ ...file, filename: 'Refined name.pdf' }] } }] }));
    assert.equal(document.activeElement, element);
    assert.equal(checkbox.checked, true);
    assert.equal(useStore.getState().selectedMessageId, null);
    assert.deepEqual(names(element), density === 'default' ? ['Refined name.pdf'] : []);
  }
  await React.act(async () => container.querySelector('.mailflow-message-list')?.dispatchEvent(new window.Event('scroll', { bubbles: true })));
});
