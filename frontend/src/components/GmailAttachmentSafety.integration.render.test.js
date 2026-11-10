import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

const STUBS = {
  '/components/GmailSettings.jsx': 'import React from "react"; export default function GmailSettings({ onClose }) { return React.createElement("div", { role: "dialog" }, React.createElement("button", { onClick: onClose, "data-test-close-settings": "" }, "Close settings")); }',
  '/components/ProfileModal.jsx': 'import React from "react"; export default function ProfileModal({ onClose }) { return React.createElement("div", { role: "dialog" }, React.createElement("button", { onClick: onClose, "data-test-close-profile": "" }, "Close")); }',
  '/utils/pdfDocument.js': 'export const openPdf = (...args) => globalThis.__attachmentPdf.openPdf(...args); export const renderPage = (...args) => globalThis.__attachmentPdf.renderPage(...args); export const renderPagesForPrint = (...args) => globalThis.__attachmentPdf.renderPagesForPrint(...args);',
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
  MutationObserver: dom.window.MutationObserver,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = dom.window.matchMedia;
dom.window.ResizeObserver = globalThis.ResizeObserver;
dom.window.Element.prototype.scrollIntoView = () => {};
dom.window.Element.prototype.getClientRects = function () { return this.isConnected ? [{ width: 200, height: 30 }] : []; };
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}), text: async () => '{}' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { api } = await import('../utils/api.js');
const { useStore } = await import('../store/index.js');
const MailApp = (await import('./MailApp.jsx')).default;
const { forwardIframeKeydown } = await import('../utils/iframeKeys.js');
const AttachmentViewer = (await import('./AttachmentViewer.jsx')).default;
const { createAttachmentActionScope } = await import('../utils/attachmentActions.js');
// This suite keeps MailApp, MessageList, chips, attachment host, viewer, transport,
// store and keyboard routing real. Only unrelated app panels and the PDF engine
// are replaced; these tests do not certify browser pixels or actual PDF decoding.
const originalApi = { ...api, todoist: api.todoist };
const SOURCE = Object.freeze({
  messageId: '11111111-1111-4111-8111-111111111111', accountId: '22222222-2222-4222-8222-222222222222',
  storageGeneration: '33333333-3333-4333-8333-333333333333', entityId: '44444444-4444-4444-8444-444444444444',
  folder: 'INBOX', uidValidity: '9', uid: '3',
});
const ACCOUNT = { id: SOURCE.accountId, storage_generation: SOURCE.storageGeneration,
  email_address: 'owner@example.invalid', enabled: true, include_in_unified_inbox: true };
const PNG = { part: '2', filename: 'Actual image.png', type: 'image/png', size: null };
const PDF = { part: '3', filename: 'Actual report.pdf', type: 'application/pdf', size: null };
const DOC = { part: '4', filename: 'Actual notes.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: null };
const PNG_BYTES = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\n test-only PDF engine stub');
const MESSAGE = {
  id: SOURCE.messageId, account_id: SOURCE.accountId, storage_generation: SOURCE.storageGeneration,
  entity_id: SOURCE.entityId, uid_validity: SOURCE.uidValidity, folder: SOURCE.folder, uid: Number(SOURCE.uid),
  // A native label's canonical entity alias is not the physical attachment owner.
  entityId: '55555555-5555-4555-8555-555555555555', storageGeneration: SOURCE.storageGeneration,
  subject: 'Verified physical message', from_address: 'sender@example.invalid', message_id: '<same-rfc@example.invalid>',
  date: '2026-11-10T12:00:00Z', is_read: false, is_starred: false, has_attachments: true,
  attachmentMetadata: { state: 'partial', scope: 'message', source: SOURCE, items: [PNG, PDF, DOC], omittedCount: 0,
    providerComplete: false, inlineClassification: 'partial', sizeIsExact: false },
};
let root, rows, requests, calls, created, revoked, downloads, authEvents, responseForPart;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const okBytes = (bytes = PNG_BYTES) => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => bytes.slice().buffer });
const errorResponse = (status, json = async () => ({ error: 'Source unavailable', code: 'source_changed' })) => ({ ok: false, status, headers: { get: () => 'application/json' }, json });
const recordAuth = event => authEvents.push(event.type);
window.addEventListener('mailflow:locked', recordAuth);
window.addEventListener('mailflow:session_expired', recordAuth);
URL.createObjectURL = blob => { const url = `blob:attachment-review-${created.length + 1}`; created.push({ url, blob }); return url; };
URL.revokeObjectURL = url => revoked.push(url);
dom.window.HTMLAnchorElement.prototype.click = function () { downloads.push({ filename: this.download, url: this.href }); };

beforeEach(async () => {
  history.replaceState(null, '', '/');
  rows = [MESSAGE]; requests = []; calls = []; created = []; revoked = []; downloads = []; authEvents = [];
  responseForPart = async () => okBytes();
  globalThis.__attachmentPdf = {
    openPdf: async () => ({ doc: { numPages: 1, getPage: async () => ({ getViewport: () => ({ width: 600, height: 800 }) }) }, destroy() {} }),
    renderPage: () => ({ done: Promise.resolve(), cancel() {} }),
    renderPagesForPrint: async () => [],
  };
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('/attachments/')) {
      requests.push({ url: String(url), options });
      return responseForPart(String(url), options);
    }
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}), text: async () => '{}' };
  };
  Object.assign(api, {
    getAccounts: async () => [ACCOUNT], getMessages: async () => ({ messages: rows, total: rows.length }),
    bulkRead: async (ids, read) => { calls.push({ action: 'read', ids, read }); },
    markRead: async (...args) => { calls.push({ action: 'read', args }); },
    markStarred: async (...args) => { calls.push({ action: 'star', args }); },
    bulkStar: async (...args) => { calls.push({ action: 'star', args }); },
    bulkMove: async (...args) => { calls.push({ action: 'move', args }); },
    bulkDelete: async (...args) => { calls.push({ action: 'delete', args }); },
    markSpam: async (...args) => { calls.push({ action: 'spam', args }); },
    getUnreadCounts: async () => ({ total: 0, byAccount: {}, snapshots: {}, complete: true }),
    getFolders: async () => [{ path: 'INBOX' }, { path: 'Archive', special_use: '\\Archive' }],
    getRules: async () => [], savePreferencesOnExit: () => {},
    todoist: { ...originalApi.todoist, status: async () => ({ connected: false }) },
  });
  useStore.setState({
    user: { id: 'user-one' }, gmailDensity: 'default', gmailDensitySaveState: 'idle', layout: 'gmail',
    selectedMessageId: null, composing: false, showContacts: false, showAdmin: false, isLocked: false,
    attachmentSignOutPending: false, accounts: [ACCOUNT], accountsReady: true, messages: rows,
    threadedView: false, enabledPlugins: [], markReadBehavior: 'manual', expandedThreadId: null,
    threadMessages: {}, shortcuts: {}, searchQuery: '', searchResults: [], selectedAccountId: ACCOUNT.id,
    selectedFolder: 'INBOX', activeLabel: null, nativeLabelFeed: null, notifications: [],
  });
  root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(MailApp)));
});
afterEach(async () => {
  await React.act(async () => root.unmount());
  window.dispatchEvent(new window.Event('pagehide'));
  Object.assign(api, originalApi);
  assert.equal(document.querySelector('[aria-modal="true"]'), null);
});
const chip = (part = '2') => [...document.querySelectorAll('button.mailflow-gmail-attachment-chip')]
  .find(button => button.textContent.includes(MESSAGE.attachmentMetadata.items.find(item => item.part === part)?.filename || part));
const dialog = () => document.querySelector('[role="dialog"][aria-modal="true"]');
const toolbar = name => dialog()?.querySelector(`button[aria-label="message.preview.${name}"]`);
async function activate(part = '2') {
  const button = chip(part); assert.ok(button, `expected actionable chip ${part}`);
  await React.act(async () => { button.focus(); button.click(); });
  return button;
}
async function click(node) { assert.ok(node); await React.act(async () => node.click()); }
async function key(value, options = {}, target = document.activeElement || document.body) {
  const event = new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options });
  await React.act(async () => target.dispatchEvent(event)); return event;
}
async function settle(fn) { await React.act(async () => { fn(); await Promise.resolve(); }); }
async function setRows(next) { rows = next; await React.act(async () => useStore.setState({ messages: rows })); }
function assertNoMailAction() {
  assert.deepEqual(calls, []); assert.equal(useStore.getState().selectedMessageId, null);
  assert.equal(useStore.getState().composing, false);
  assert.equal(document.querySelector('[data-gmail-row-id]')?.dataset.checked, 'false');
  assert.equal(useStore.getState().messages[0]?.is_read, false);
}

test('independent integration: native canonical alias difference retains the exact physical proof and reuses downloaded bytes', async () => {
  assert.equal(requests.length, 0);
  await activate();
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.url, `/api/mail/messages/${SOURCE.messageId}/attachments/2`);
  assert.equal(request.options.headers['X-Mailflow-Message-Source'], encodeURIComponent(JSON.stringify(SOURCE)));
  assert.equal(request.options.credentials, 'include');
  assert.equal(dialog()?.querySelector('img')?.getAttribute('alt'), PNG.filename);
  assertNoMailAction();
  await click(toolbar('download'));
  assert.equal(requests.length, 1, 'download uses the byte resource that is actually on screen');
  assert.equal(downloads[0]?.filename, PNG.filename);
  assert.deepEqual(new Uint8Array(await created.find(item => item.url === downloads[0].url).blob.arrayBuffer()), PNG_BYTES);
  await click(toolbar('close'));
  assert.ok(created.every(item => revoked.includes(item.url)), 'preview and download URLs belong to the closed interaction');
});

test('independent integration: mount, metadata refresh, focus and hover never fetch an attachment', async () => {
  const button = chip(); assert.ok(button);
  await React.act(async () => {
    button.focus();
    for (const type of ['mouseover', 'mouseenter', 'pointerover', 'mousemove']) button.dispatchEvent(new window.MouseEvent(type, { bubbles: true }));
  });
  await setRows([{ ...MESSAGE, is_starred: true }]);
  assert.equal(requests.length, 0); assert.equal(dialog(), null);
});

test('independent integration: auxiliary, modified, double and context chip events never activate the mail row', async () => {
  const button = chip(); assert.ok(button);
  for (const [type, options] of [['auxclick', { button: 1 }], ['click', { ctrlKey: true }], ['click', { metaKey: true }],
    ['click', { shiftKey: true }], ['click', { altKey: true }], ['dblclick', { detail: 2 }], ['contextmenu', { button: 2 }]]) {
    await React.act(async () => button.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, ...options })));
  }
  assertNoMailAction(); assert.equal(requests.length, 0);
  assert.equal(useStore.getState().messageWindows.length, 0);
  assert.equal(document.querySelector('[data-mailflow-context-menu]'), null);
});

test('independent integration: Enter and Space on chips do not dispatch customized global or row commands', async () => {
  await React.act(async () => useStore.setState({ shortcuts: { compose: 'Enter', toggleStar: ' ' } }));
  const button = chip(); await React.act(async () => button.focus());
  await key('Enter'); await key(' ');
  assertNoMailAction();
  // jsdom does not synthesize the browser's keyboard button click. Dispatch the
  // default activation explicitly only when the handler has not already done it.
  if (!requests.length) await click(button);
  assert.equal(requests.length, 1);
  assertNoMailAction();
});

test('independent integration: a real preview fences global keys, toolbar clicks and pending prefix commands', async () => {
  await key('g', {}, document.body);
  await activate();
  for (const value of ['j', 'k', 'x', 's', 'e', 'c', 'i', '#', '!']) await key(value, { shiftKey: ['#', '!'].includes(value) }, document.body);
  assertNoMailAction(); assert.ok(dialog());
  await React.act(async () => {
    for (const value of ['c', 'e', 's', 'x']) forwardIframeKeydown({ key: value, target: { tagName: 'DIV' }, preventDefault() {} }, document);
  });
  assertNoMailAction();
  await click(toolbar('download')); assertNoMailAction();
  await key('Escape'); assert.equal(dialog(), null); assertNoMailAction();
  assert.equal(useStore.getState().selectedFolder, 'INBOX');
});

const ABA = {
  'lock then unlock': () => { useStore.getState().setLocked(true); useStore.getState().setLocked(false); },
  'logout then same user': () => { const state = useStore.getState(); useStore.getState().setUser(null); useStore.getState().setUser(state.user); useStore.setState({ accounts: state.accounts, accountsReady: true, messages: rows, selectedAccountId: ACCOUNT.id, selectedFolder: 'INBOX' }); },
  'account disable then restore': () => { useStore.setState({ accounts: [{ ...ACCOUNT, enabled: false }] }); useStore.setState({ accounts: [ACCOUNT] }); },
  'account remove then restore': () => { useStore.setState({ accounts: [] }); useStore.setState({ accounts: [ACCOUNT] }); },
  'physical entity change then restore': () => { useStore.setState({ messages: [{ ...MESSAGE, entity_id: MESSAGE.entityId }] }); useStore.setState({ messages: rows }); },
  'mailbox epoch change then restore': () => { useStore.setState({ messages: [{ ...MESSAGE, uid_validity: '10' }] }); useStore.setState({ messages: rows }); },
  'folder navigation then return': () => { useStore.setState({ selectedFolder: 'Archive' }); useStore.setState({ selectedFolder: 'INBOX' }); },
  'page hide': () => window.dispatchEvent(new window.Event('pagehide')),
};
for (const phase of ['response', 'bytes']) for (const [name, invalidate] of Object.entries(ABA)) {
  test(`independent integration: ${name} permanently cancels deferred ${phase} before React effects`, async () => {
    const pending = deferred();
    responseForPart = phase === 'response' ? () => pending.promise
      : async () => ({ ...okBytes(), arrayBuffer: () => pending.promise });
    await activate(); assert.equal(requests.length, 1);
    await settle(invalidate);
    assert.equal(requests[0].options.signal.aborted, true);
    await settle(() => pending.resolve(phase === 'response' ? okBytes() : PNG_BYTES.slice().buffer));
    assert.equal(dialog(), null); assert.equal(created.length, 0); assert.equal(downloads.length, 0);
    assert.deepEqual(authEvents, []);
  });
}

for (const status of [401, 423]) for (const phase of ['response', 'error JSON']) {
  test(`independent integration: stale ${status} at ${phase} cannot affect a restored session`, async () => {
    const pending = deferred();
    responseForPart = phase === 'response' ? () => pending.promise
      : async () => errorResponse(status, () => pending.promise);
    await activate();
    await settle(ABA['lock then unlock']);
    await settle(() => pending.resolve(phase === 'response' ? errorResponse(status) : { error: 'Old session' }));
    assert.deepEqual(authEvents, []); assert.equal(useStore.getState().isLocked, false);
    assert.equal(useStore.getState().user?.id, 'user-one'); assert.equal(created.length, 0); assert.equal(downloads.length, 0);
  });
}

test('independent integration: sign-out start cancels bytes while the logout network request is still pending', async () => {
  const pending = deferred(), logout = deferred();
  api.logout = () => logout.promise;
  responseForPart = async () => ({ ...okBytes(), arrayBuffer: () => pending.promise });
  await activate();
  await settle(() => { void useStore.getState().signOut(); });
  assert.equal(useStore.getState().user?.id, 'user-one', 'logout has not completed');
  assert.equal(requests[0].options.signal.aborted, true);
  await settle(() => pending.resolve(PNG_BYTES.slice().buffer));
  assert.equal(created.length, 0); assert.equal(downloads.length, 0); assert.equal(dialog(), null);
});

for (const status of [400, 404, 409, 413]) {
  test(`independent integration: current ${status} cannot silently download, retry or discard source proof`, async () => {
    responseForPart = async () => errorResponse(status);
    await activate();
    assert.equal(requests.length, 1); assert.equal(downloads.length, 0); assert.equal(created.length, 0);
    assert.ok(dialog()); assertNoMailAction();
    await settle(() => useStore.setState({ messages: [...rows] }));
    assert.equal(requests.length, 1, 'a render does not authorize another request');
  });
}

test('independent integration: rapid next-file navigation cannot show old bytes or download under the new title', async () => {
  const pending = deferred();
  responseForPart = async url => url.endsWith('/2') ? okBytes() : pending.promise;
  await activate(); const firstUrl = dialog().querySelector('img').src;
  await key('ArrowRight');
  assert.equal(requests.length, 2); assert.equal(dialog()?.querySelector('img'), null);
  assert.equal(downloads.length, 0);
  assert.ok(revoked.includes(firstUrl));
  await settle(() => pending.resolve(okBytes(PDF_BYTES)));
  await click(toolbar('download'));
  assert.equal(downloads[0]?.filename, PDF.filename);
  assert.deepEqual(new Uint8Array(await created.find(item => item.url === downloads[0].url).blob.arrayBuffer()), PDF_BYTES);
});

test('independent integration: late PDF open destroys the handle instead of publishing after close', async () => {
  const pending = deferred(); let opens = 0, destroyed = 0;
  responseForPart = async () => okBytes(PDF_BYTES);
  globalThis.__attachmentPdf.openPdf = () => { opens++; return pending.promise; };
  await activate('3'); assert.equal(opens, 1);
  await click(toolbar('close'));
  await settle(() => pending.resolve({ doc: { numPages: 1 }, destroy() { destroyed++; } }));
  assert.equal(destroyed, 1); assert.equal(dialog(), null); assert.equal(downloads.length, 0);
});


test('independent integration: malformed proof never becomes an actionable chip or a byte request', async () => {
  for (const field of Object.keys(SOURCE)) {
    const source = { ...SOURCE }; delete source[field];
    await setRows([{ ...MESSAGE, attachmentMetadata: { ...MESSAGE.attachmentMetadata, source } }]);
    assert.equal(chip(), undefined, `missing ${field} stays nonactionable`);
  }
  for (const source of [{ ...SOURCE, extra: true }, { ...SOURCE, uid: 3 }, { ...SOURCE, folder: 'INBOX\n' }, { ...SOURCE, uidValidity: '09' }]) {
    await setRows([{ ...MESSAGE, attachmentMetadata: { ...MESSAGE.attachmentMetadata, source } }]);
    assert.equal(chip(), undefined);
  }
  assert.equal(requests.length, 0); assert.equal(created.length, 0);
  await setRows([MESSAGE]); await activate(); assert.equal(requests.length, 1);
});


for (const source of [false, 0, '', {}, { ...SOURCE, extra: true }]) {
  test(`independent integration: provided malformed source ${JSON.stringify(source)} cannot choose headerless legacy transport`, async () => {
    await React.act(async () => root.render(React.createElement(AttachmentViewer, {
      messageId: SOURCE.messageId, attachments: [PNG], source, onClose() {},
    })));
    assert.equal(requests.length, 0); assert.equal(created.length, 0);
  });
}

test('independent integration: a verified scope without its proof cannot choose headerless legacy transport', async () => {
  const scope = createAttachmentActionScope({ store: useStore, source: SOURCE, sourceCurrent: () => true });
  try {
    await React.act(async () => root.render(React.createElement(AttachmentViewer, {
      messageId: SOURCE.messageId, attachments: [PNG], scope, onClose() {},
    })));
    assert.equal(requests.length, 0); assert.equal(created.length, 0);
  } finally { await React.act(async () => scope.dispose()); }
});

test('independent integration: omitted source preserves only the explicitly legacy reader path', async () => {
  await React.act(async () => root.render(React.createElement(AttachmentViewer, {
    messageId: SOURCE.messageId, attachments: [PNG], onClose() {},
  })));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers['X-Mailflow-Message-Source'], undefined);
  assert.ok(dialog()?.querySelector('img'));
});

test('independent integration: same-source flag refresh keeps the exact loaded bytes and immutable displayed filename', async () => {
  await activate();
  const previewUrl = dialog().querySelector('img').src;
  await setRows([{ ...MESSAGE, is_starred: true, is_read: true }]);
  assert.equal(requests.length, 1); assert.equal(dialog().querySelector('img').src, previewUrl);
  await setRows([{ ...MESSAGE, attachmentMetadata: { ...MESSAGE.attachmentMetadata,
    items: [{ ...PNG, filename: 'New label.png', type: 'application/octet-stream' }, PDF, DOC] } }]);
  assert.equal(requests.length, 1, 'same-source metadata refresh does not fetch or retarget an active snapshot');
  assert.equal(dialog().querySelector('img').alt, PNG.filename);
  await click(toolbar('download')); assert.equal(downloads[0]?.filename, PNG.filename);
});

test('independent integration: commit-time filename replacement cannot expose old bytes before passive cleanup', async () => {
  const pending = deferred();
  responseForPart = async () => requests.length === 1 ? okBytes() : pending.promise;
  const scope = createAttachmentActionScope({ store: useStore, source: SOURCE, sourceCurrent: () => true });
  const observed = [];
  function CommitProbe({ renamed }) {
    React.useLayoutEffect(() => {
      if (!renamed) return;
      observed.push(dialog()?.querySelector('img')?.alt ?? null);
      toolbar('download')?.click();
    }, [renamed]);
    return React.createElement(AttachmentViewer, {
      messageId: SOURCE.messageId, source: SOURCE, scope, attachments: [{ ...PNG, filename: renamed ? 'Replacement.png' : PNG.filename }], onClose() {},
    });
  }
  try {
    await React.act(async () => root.render(React.createElement(CommitProbe, { renamed: false })));
    assert.equal(dialog().querySelector('img').alt, PNG.filename);
    await React.act(async () => root.render(React.createElement(CommitProbe, { renamed: true })));
    assert.deepEqual(observed, [null], 'no A bytes can render in the B commit before effects reset state');
    assert.equal(downloads.length, 0, 'even a commit-time toolbar activation cannot save A bytes under B title');
    await settle(() => pending.resolve(okBytes()));
    await click(toolbar('download'));
    assert.equal(downloads[0]?.filename, 'Replacement.png');
  } finally { await React.act(async () => scope.dispose()); }
});
