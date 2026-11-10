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
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver,
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
let ATTACH_REQUESTS = [];
let attachmentResponse;
let downloads = [];
let urls = [];
URL.createObjectURL = blob => { urls.push(blob); return `blob:test-${urls.length}`; };
URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = function () { downloads.push({ name: this.download, href: this.href }); };
globalThis.fetch = async (url, opts = {}) => {
  const path = String(url);
  if (/\/attachments\//.test(path)) { ATTACH_REQUESTS.push({ path, opts }); return attachmentResponse(path, opts); }
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
    attachmentSignOutPending: false, showContacts: false, showAdmin: false, composing: false, messageWindows: [],
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
  ATTACH_REQUESTS = []; downloads = []; urls = [];
  attachmentResponse = undefined;
  CALLS = [];
  for (const key of Object.keys(ROUTES)) delete ROUTES[key];
});


const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const pngFile = { ...file, filename: 'Actual.png', type: 'image/png' };
const response = (bytes = png, status = 200) => ({ ok: status < 400, status,
  headers: { get: () => null }, arrayBuffer: async () => bytes.buffer, json: async () => ({ error: 'changed' }) });
const chip = (id, part = '2') => mainRow(id)?.querySelector(`[data-attachment-part="${part}"]`);
async function click(node, options = {}) {
  assert.ok(node, 'action button exists');
  await React.act(async () => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, ...options })));
}
async function key(node, key, options = {}) {
  await React.act(async () => node.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })));
}
async function close() { await key(document.body, 'Escape'); }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('explicit real raster preview is outside the row, sends only its frozen proof and never opens mail', async () => {
  const row = message(1, [pngFile, { ...pngFile, part: '3', filename: 'Adjacent.png' }]);
  attachmentResponse = async () => response();
  await mount([row]);
  const opener = chip(row.id);
  assert.equal(opener.tagName, 'BUTTON');
  assert.equal(opener.getAttribute('aria-label'), 'Preview Actual.png');
  await React.act(async () => opener.focus());
  for (const event of ['mouseover', 'mouseenter', 'focus']) {
    await React.act(async () => opener.dispatchEvent(new window.MouseEvent(event, { bubbles: true })));
  }
  assert.equal(ATTACH_REQUESTS.length, 0);
  await click(opener);
  assert.equal(ATTACH_REQUESTS.length, 1);
  assert.equal(ATTACH_REQUESTS[0].path, `/api/mail/messages/${row.id}/attachments/2`);
  assert.deepEqual(JSON.parse(decodeURIComponent(ATTACH_REQUESTS[0].opts.headers['X-Mailflow-Message-Source'])), row.attachmentMetadata.source);
  assert.equal(useStore.getState().selectedMessageId, null);
  assert.equal(useStore.getState().messages[0].is_read, false);
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.equal(mainRow(row.id).contains(dialog), false);
  assert.ok(dialog.querySelector('img[src^="blob:"]'));
  assert.equal(ATTACH_REQUESTS.length, 1, 'adjacent part is not prefetched');
  await close();
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, opener);
});

test('unsupported file downloads actual bytes with the displayed immutable filename', async () => {
  const row = message(1, [{ ...file, filename: 'Actual.docx', type: 'application/octet-stream' }]);
  attachmentResponse = async () => response(new Uint8Array([80, 75, 3, 4]));
  await mount([row]);
  assert.equal(chip(row.id).getAttribute('aria-label'), 'Download Actual.docx');
  await click(chip(row.id));
  assert.equal(ATTACH_REQUESTS.length, 1);
  assert.deepEqual(downloads.map(item => item.name), ['Actual.docx']);
  assert.equal(urls[0].size, 4);
  assert.equal(useStore.getState().selectedMessageId, null);
  assert.equal(document.querySelector('a[href*="/attachments"]'), null);
});

test('risk confirmation is deliberate, frozen and never bypassed by auxiliary or modified events', async () => {
  const row = message(1, [{ ...file, filename: 'Invoice.pdf.exe', type: 'application/octet-stream' }]);
  attachmentResponse = async () => response();
  await mount([row]);
  const opener = chip(row.id);
  for (const type of ['auxclick', 'contextmenu', 'dblclick', 'dragstart']) {
    await React.act(async () => opener.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 1 })));
  }
  await click(opener, { ctrlKey: true });
  await click(opener, { shiftKey: true });
  await key(opener, 'Enter', { ctrlKey: true });
  assert.equal(ATTACH_REQUESTS.length, 0);
  assert.equal(useStore.getState().selectedMessageId, null);
  await click(opener);
  assert.equal(ATTACH_REQUESTS.length, 0);
  assert.ok(document.querySelector('[role="dialog"]'));
  await click(opener, { detail: 2 });
  assert.equal(ATTACH_REQUESTS.length, 0, 'double-click does not confirm risk');
  const current = { ...row, attachmentMetadata: { ...row.attachmentMetadata,
    items: [{ ...file, filename: 'Replacement.docx', type: 'application/octet-stream' }] } };
  await React.act(async () => useStore.setState({ messages: [current] }));
  await click(document.querySelector('[data-attachment-confirm]'));
  assert.deepEqual(downloads.map(item => item.name), ['Invoice.pdf.exe']);
});

for (const field of ['uid', 'uid_validity', 'entity_id', 'storage_generation']) {
  test(`late bytes cannot survive physical ${field} replacement and restoration in a batch`, async () => {
    const row = message(1, [pngFile]);
    const wait = deferred(); attachmentResponse = () => wait.promise;
    await mount([row]); await click(chip(row.id));
    await React.act(async () => {
      useStore.setState({ messages: [{ ...row, [field]: field === 'uid' ? 99 : 'changed' }] });
      useStore.setState({ messages: [row] });
      wait.resolve(response());
    });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(urls.length, 0);
    assert.equal(downloads.length, 0);
  });
}

test('same physical source read/star refresh remains live and native aliases do not retarget bytes', async () => {
  const row = message(1, [pngFile], { entityId: 'logical-other-entity', storageGeneration: 'logical-other-generation' });
  const wait = deferred(); attachmentResponse = () => wait.promise;
  await mount([row]); await click(chip(row.id));
  await React.act(async () => {
    useStore.setState({ messages: [{ ...row, is_read: true, is_starred: true }] });
    wait.resolve(response());
  });
  assert.ok(document.querySelector('[role="dialog"] img'));
  assert.equal(ATTACH_REQUESTS.length, 1);
  assert.equal(JSON.parse(decodeURIComponent(ATTACH_REQUESTS[0].opts.headers['X-Mailflow-Message-Source'])).entityId, row.entity_id);
});

test('current 409 is unavailable without fallback or retry; transient download failure retries only explicitly', async () => {
  const row = message(1, [{ ...file, filename: 'Document.docx' }]);
  attachmentResponse = async () => response(png, 409);
  await mount([row]); await click(chip(row.id));
  assert.match(document.querySelector('[role="dialog"]').textContent, /changed or is no longer available/);
  assert.equal(document.querySelector('[data-attachment-retry]'), null);
  assert.equal(ATTACH_REQUESTS.length, 1);
  await close();
  attachmentResponse = async () => { throw new Error('network'); };
  await click(chip(row.id));
  assert.equal(ATTACH_REQUESTS.length, 2);
  attachmentResponse = async () => response();
  await click(document.querySelector('[data-attachment-retry]'));
  assert.equal(ATTACH_REQUESTS.length, 3);
  assert.equal(downloads.length, 1);
});


for (const [field, value] of [['gmailDensity', 'compact'], ['layout', 'comfortable'], ['showContacts', true],
  ['showAdmin', true], ['composing', true], ['selectedFolder', 'Archive'], ['searchQuery', 'other'],
  ['selectedMessageId', 'reader-row'], ['activeGtdTab', 'today']]) {
  test(`initiating list ${field} transition and restoration cannot revive delayed preview`, async () => {
    const row = message(1, [pngFile]);
    const wait = deferred(); attachmentResponse = () => wait.promise;
    await mount([row]); await click(chip(row.id));
    const initial = useStore.getState()[field];
    await React.act(async () => {
      useStore.setState({ [field]: value });
      useStore.setState({ [field]: initial });
      wait.resolve(response());
    });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(urls.length, 0);
  });
}

for (const view of ['flat', 'thread', 'expanded', 'unified', 'snoozed', 'search', 'mobile']) {
  test(`${view} activation downloads only the physical clicked row without expanding or reading its siblings`, async () => {
    const files = [{ ...file, filename: `${view}.docx` }];
    const head = message(1, files, view === 'thread' || view === 'expanded'
      ? { thread_id: 'one-thread', message_count: 2, unread_count: 2 } : {});
    const child = message(2, [{ ...files[0], filename: 'Child.docx' }], { thread_id: 'one-thread' });
    const opts = { threadedView: ['thread', 'expanded'].includes(view), accountId: view === 'unified' ? null : ACCOUNT.id,
      folder: view === 'snoozed' ? 'Snoozed' : 'INBOX', searchQuery: view === 'search' ? 'has:attachment' : '',
      width: view === 'mobile' ? 390 : 1024 };
    attachmentResponse = async () => response();
    await mount([head], opts);
    let target = chip(head.id);
    if (view === 'expanded') {
      await React.act(async () => useStore.setState({ expandedThreadId: 'one-thread', threadMessages: { 'one-thread': [head, child] } }));
      target = [...container.querySelectorAll('.mailflow-thread-message-row button[data-attachment-part]')].at(-1);
    }
    await click(target);
    const expected = view === 'expanded' ? child : head;
    assert.equal(ATTACH_REQUESTS.length, 1);
    assert.equal(ATTACH_REQUESTS[0].path, `/api/mail/messages/${expected.id}/attachments/2`);
    assert.equal(useStore.getState().selectedMessageId, null);
    assert.equal(useStore.getState().expandedThreadId, view === 'expanded' ? 'one-thread' : null);
    assert.deepEqual(downloads.map(item => item.name), [expected.attachmentMetadata.items[0].filename]);
  });
}

test('expanded-child collapse roundtrip invalidates independently of the same-ID thread representative', async () => {
  const head = message(1, [pngFile], { thread_id: 'one-thread', message_count: 2, unread_count: 2 });
  const wait = deferred(); attachmentResponse = () => wait.promise;
  await mount([head], { threadedView: true });
  await React.act(async () => useStore.setState({ expandedThreadId: 'one-thread', threadMessages: { 'one-thread': [head] } }));
  await click(container.querySelector('.mailflow-thread-message-row button[data-attachment-part]'));
  await React.act(async () => {
    useStore.setState({ expandedThreadId: null });
    useStore.setState({ expandedThreadId: 'one-thread' });
    wait.resolve(response());
  });
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(urls.length, 0);
});

test('native-label activation retains physical proof and feed readiness roundtrip invalidates', async () => {
  const native = message(1, [pngFile], { entityId: '66666666-6666-4666-8666-666666666666',
    storageGeneration: ACCOUNT.storage_generation, nativeLabelState: 'available', nativeLabels: [] });
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/labels/test-label/messages?')) return { ok: true, status: 200,
      headers: { get: () => 'application/json' }, json: async () => ({ accountId: ACCOUNT.id,
        storageGeneration: ACCOUNT.storage_generation, labelId: 'test-label', messages: [native], total: 1, nextCursor: null }), text: async () => '' };
    return original(url, options);
  };
  try {
    const wait = deferred(); attachmentResponse = () => wait.promise;
    await mount([], { folder: null, activeLabel: { accountId: ACCOUNT.id,
      storageGeneration: ACCOUNT.storage_generation, labelId: 'test-label' } });
    await click(chip(native.id));
    assert.equal(ATTACH_REQUESTS.length, 1);
    const feed = useStore.getState().nativeLabelFeed;
    await React.act(async () => {
      useStore.setState({ nativeLabelFeed: { ...feed, status: 'loading' } });
      useStore.setState({ nativeLabelFeed: feed });
      wait.resolve(response());
    });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(urls.length, 0);
    attachmentResponse = async () => response();
    await click(chip(native.id));
    assert.ok(document.querySelector('[role="dialog"] img'));
    assert.equal(JSON.parse(decodeURIComponent(ATTACH_REQUESTS.at(-1).opts.headers['X-Mailflow-Message-Source'])).entityId, native.entity_id);
  } finally { globalThis.fetch = original; }
});
