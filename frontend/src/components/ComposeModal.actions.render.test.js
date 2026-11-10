// Real-composer regressions for Instant Intro and confirmed Send + Archive.
//
// The autosave rules are unit-tested in utils/draftAutosave.test.js, but whether a draft counts
// as dirty depends on the live TipTap editor, which rewrites the HTML it loads. That only shows
// up with the real component mounted, so this mounts it the same way the other render tests do.

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
        // Preserve English fallback text, interpolation, and native t function stability.
        'const t = (key, fallback, values = {}) => { const options = typeof fallback === "object" ? fallback : values; const text = typeof fallback === "string" ? fallback : fallback?.defaultValue ?? (options?.message ? `${key} ${options.message}` : key); return text.replace(/\\{\\{(\\w+)\\}\\}/g, (_, name) => String(options?.[name] ?? "")); }; export const useTranslation = () => ({ t, i18n: { language: "en", changeLanguage: () => {} } });',
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

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0 });
let visibility = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const ComposeModal = (await import('./ComposeModal.jsx')).default;

let root;
let records;
let saved;
let sent;
let archived;
const parent = { id: 'original', account_id: 'acct', thread_id: 'thread-original', message_id: '<original@example.invalid>', folder: 'INBOX' };
const snippet = { id: '11111111-1111-4111-8111-111111111111', title: 'Thanks', body: '<b>Thanks</b>\n', version: 1, format: 'text' };
const input = async (node, value) => React.act(async () => {
  const prototype = node.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value);
  node.dispatchEvent(new window.Event('input', { bubbles: true }));
});
const click = async node => { assert.ok(node, 'control exists'); await React.act(async () => node.click()); };
const button = text => [...document.querySelectorAll('button')].find(node => node.textContent.trim() === text);
const field = label => document.querySelector(`[aria-label="${label}"]`);
const key = async (node, value, extra = {}) => {
  const event = new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra });
  await React.act(async () => node.dispatchEvent(event)); return event;
};
const render = async component => { await React.act(async () => root.render(React.createElement(component))); await React.act(async () => {}); };

beforeEach(() => {
  records = []; saved = []; sent = []; archived = [];
  useStore.setState({ layout: 'superhuman', shortcuts: {}, notifications: [], messages: [parent], selectedMessageId: parent.id });
  useStore.setState({ user: { id: 'alice' }, selectedAccountId: 'acct', accounts: [
    { id: 'acct', enabled: true, email_address: 'me@example.invalid', name: 'Me', signature: '<p>My signature</p>' },
    { id: 'other', enabled: true, email_address: 'other@example.invalid', name: 'Other' },
  ], composing: false, composeData: null, prepareComposeSwitch: null, plaintextEmail: false });
  api.get = async path => path === '/snippets' ? { snippets: structuredClone(records) } : {};
  api.post = async (path, data) => { if (path.endsWith('/use')) { const previous = records.find(item => path.includes(item.id)); const item = { ...previous, usageCount: (previous.usageCount || 0) + 1, lastUsedAt: new Date().toISOString() }; records = records.map(old => old.id === item.id ? item : old); return { ...item }; } assert.equal(path, '/snippets'); const item = { ...data, id: snippet.id, version: 1 }; records.push(item); return item; };
  api.put = async (path, data) => { const item = { ...data, id: path.split('/').pop(), version: data.version + 1 }; records = records.map(old => old.id === item.id ? item : old); return item; };
  api.delete = async () => { records = []; return null; };
  api.saveDraft = async data => { saved.push(data); return { uid: 8, folder: 'Drafts' }; };
  api.send = async data => { sent.push(data); return {}; };
  api.post = async (path, data, headers) => { assert.equal(path, '/mail/send'); sent.push({ data, headers }); return { pending: true, pendingId: 'held-id', remainingMs: 10000 }; };
  api.getThread = async () => ({ messages: [parent] });
  api.bulkArchive = async (ids, context) => { archived.push({ ids, context }); return { archived: ids }; };
  api.cancelSend = async () => ({ cancelled: false, status: 'sent', result: { ok: true } });
  api.getSendStatus = async () => ({ status: 'sent', result: { ok: true } });
  root = createRoot(document.getElementById('root'));
});
afterEach(async () => { await React.act(async () => { useStore.setState({ user: null }); root.unmount(); }); });

async function compose(plain = false, extra = {}) {
  useStore.setState({ plaintextEmail: plain });
  useStore.getState().openCompose({ accountId: 'acct', to: ['bob@example.invalid'], subject: 'Contract', body: plain ? 'Hello world' : '<p>Hello world</p>', signature: '<p>My signature</p>', quotedBody: 'Original mail', ...extra });
  await render(ComposeModal);
}

async function autosave() {
  visibility = 'hidden';
  await React.act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
  await React.act(async () => {}); visibility = 'visible';
}

const reply = { isReply: true, threadId: parent.thread_id, inReplyTo: parent.message_id };
const finish = async () => {
  const pending = useStore.getState().notifications.find(note => note.heldSendId);
  assert.ok(pending, 'native Undo send remains available');
  await React.act(async () => { await pending.onUndo(); });
};

test('Intro moves committed and uncommitted To into visible Bcc, preserves Cc/body/identity, and never sends', async () => {
  await compose(true, { to: ['Bob <bob@example.invalid>', 'ANN@example.invalid'], bcc: ['ann@example.invalid'], cc: ['copied@example.invalid'] });
  const to = document.querySelector('input[placeholder=""]');
  await input(to, '"Smith, Jo" <jo@example.invalid>');
  await click(button('Instant intro'));
  assert.match(document.querySelector('[role="status"]').textContent, /To recipients moved to Bcc/);
  assert.equal(document.querySelector('input[placeholder="compose.toPh"]').value, '');
  assert.match(document.body.textContent, /compose.bcc/);
  await autosave();
  assert.deepEqual(saved[0].to, []);
  assert.deepEqual(saved[0].bcc, ['ann@example.invalid', 'Bob <bob@example.invalid>', '"Smith, Jo" <jo@example.invalid>']);
  assert.deepEqual(saved[0].cc, ['copied@example.invalid']);
  assert.equal(saved[0].body, 'Hello world'); assert.equal(saved[0].accountId, 'acct');
  assert.equal(sent.length, 0);
});

test('Intro shortcut respects custom keys, IME, nested dialogs, repeats and opt-in layout', async () => {
  await compose(true);
  const body = document.querySelector('textarea[placeholder="compose.bodyPh"]');
  await key(body, 'I', { ctrlKey: true, shiftKey: true, isComposing: true });
  await key(body, 'I', { ctrlKey: true, shiftKey: true, repeat: true });
  await React.act(async () => useStore.setState({ shortcuts: { compose: 'ctrl+shift+i' } }));
  assert.equal((await key(body, 'I', { ctrlKey: true, shiftKey: true })).defaultPrevented, false);
  await React.act(async () => useStore.setState({ shortcuts: {} }));
  await click(field('Share availability'));
  await key(field('Available date'), 'I', { ctrlKey: true, shiftKey: true });
  assert.equal(document.querySelector('[role="status"]'), null);
  await click(button('Cancel'));
  await React.act(async () => useStore.setState({ layout: 'vertical' }));
  assert.equal(button('Instant intro'), undefined);
  assert.equal((await key(body, 'I', { ctrlKey: true, shiftKey: true })).defaultPrevented, false);
  await React.act(async () => useStore.setState({ layout: 'superhuman' }));
  await key(body, 'I', { metaKey: true, shiftKey: true });
  assert.match(document.querySelector('[role="status"]').textContent, /To recipients moved/);
  assert.equal(sent.length, 0);
});

test('Send + Archive preserves native payload/undo; only original ids archive after durable success despite navigation', async () => {
  await compose(true, reply);
  await click(button('Send + Archive'));
  assert.equal(sent.length, 1); assert.equal(sent[0].data.undoSeconds, 10);
  assert.equal(sent[0].data.inReplyTo, parent.message_id); assert.equal(sent[0].data.accountId, 'acct');
  assert.equal(archived.length, 0);
  await React.act(async () => useStore.setState({ selectedMessageId: 'other-selected', messages: [parent, { ...parent, id: 'other-selected', thread_id: 'other-thread' }] }));
  await finish();
  assert.deepEqual(archived, [{ ids: ['original'], context: { accountId: 'acct', threadId: parent.thread_id, inReplyTo: parent.message_id, pendingId: 'held-id' } }]);
  assert.equal(useStore.getState().selectedMessageId, 'other-selected');
  assert.deepEqual(useStore.getState().messages.map(row => row.id), ['other-selected']);
});

test('undo never archives and restores the original reply context', async () => {
  await compose(true, reply);
  api.cancelSend = async () => ({ cancelled: true });
  await click(button('Send + Archive')); await finish();
  assert.equal(archived.length, 0);
  assert.deepEqual(useStore.getState().composeData.replyArchiveContext, { accountId: 'acct', threadId: parent.thread_id, inReplyTo: parent.message_id });
});

test('partially rejected sends never archive or claim archive success', async () => {
  await compose(true, reply);
  api.cancelSend = async () => ({ cancelled: false, status: 'sent', result: { ok: true, rejected: ['bad@example.invalid'] } });
  await click(button('Send + Archive')); await finish();
  assert.equal(archived.length, 0);
  assert.ok(useStore.getState().notifications.some(note => note.title === 'Reply sent. Archiving was not confirmed.'));
});

test('failed original-thread verification leaves draft open and does not send', async () => {
  await compose(true, reply);
  api.getThread = async () => ({ messages: [{ ...parent, account_id: 'other-account' }] });
  await click(button('Send + Archive'));
  assert.equal(sent.length, 0); assert.equal(useStore.getState().composing, true);
  assert.match(document.body.textContent, /Nothing was sent/);
});

test('archive unavailable for new mail; normal Send and Send later stay native', async () => {
  await compose(true);
  assert.equal(button('Send + Archive').disabled, true);
  const body = document.querySelector('textarea[placeholder="compose.bodyPh"]');
  await key(body, 'Enter', { ctrlKey: true, shiftKey: true });
  assert.ok(document.querySelector('[role="menu"]')); assert.equal(sent.length, 0);
});

test('calendar availability seed opens the manual dialog and does not send or change recipients on cancel', async () => {
  await compose(true, { availability: { date: '2099-11-20', time: '09:00', timeZone: 'Europe/Paris' } });
  assert.equal(field('Available date').value, '2099-11-20');
  assert.equal(field('Available time').value, '09:00');
  assert.equal(field('Availability time zone').value, 'Europe/Paris');
  assert.match(document.querySelector('[role="dialog"]').textContent, /calendar has not been checked/);
  await click(button('Cancel')); assert.equal(sent.length, 0);
  assert.equal(document.querySelector('textarea[placeholder="compose.bodyPh"]').value, 'Hello world');
});

test('failed held delivery preserves inbox mail without archiving', async () => {
  await compose(true, reply);
  api.cancelSend = async () => ({ cancelled: false, status: 'failed', error: 'SMTP refused' });
  await click(button('Send + Archive')); await finish();
  assert.equal(archived.length, 0); assert.equal(useStore.getState().composeData.sendError, 'SMTP refused');
});

test('uncertain archive failure is shown once with no retry and no optimistic removal', async () => {
  await compose(true, reply);
  let calls = 0; api.bulkArchive = async () => { calls++; throw new Error('Network interrupted'); };
  await click(button('Send + Archive')); await finish();
  assert.equal(calls, 1); assert.deepEqual(useStore.getState().messages, [parent]);
  assert.ok(useStore.getState().notifications.some(note => note.title === 'Reply sent. Archiving was not confirmed.' && note.persistent));
});

test('legacy immediate success sends normally but explicitly does not archive', async () => {
  await compose(true, reply);
  api.post = async (_path, data) => { sent.push(data); return { ok: true }; };
  await click(button('Send + Archive'));
  assert.equal(sent.length, 1); assert.equal(archived.length, 0);
  assert.ok(useStore.getState().notifications.some(note => note.title === 'Reply sent. Archiving was not confirmed.'));
});

test('repeated Send + Archive during original-thread lookup starts only one send', async () => {
  await compose(true, reply);
  let resolveThread;
  api.getThread = () => new Promise(resolve => { resolveThread = resolve; });
  const send = button('Send + Archive');
  await React.act(async () => { send.click(); send.click(); });
  assert.equal(sent.length, 0);
  await React.act(async () => { resolveThread({ messages: [parent] }); });
  assert.equal(sent.length, 1); await finish(); assert.equal(archived.length, 1);
});

test('retry after a lost send response keeps its pinned archive ids and idempotency key', async () => {
  await compose(true, reply);
  let attempts = 0; const keys = [];
  api.post = async (_path, _data, headers) => { keys.push(headers['X-Idempotency-Key']); if (++attempts === 1) throw new Error('Lost response'); return { pending: true, pendingId: 'held-id', remainingMs: 10000 }; };
  await click(button('Send + Archive'));
  api.getThread = async () => ({ messages: [parent, { ...parent, id: 'new-incoming' }] });
  await click(button('Send + Archive')); await finish();
  assert.equal(keys[0], keys[1]); assert.deepEqual(archived[0].ids, ['original']);
});

test('owner changes during preflight prevent sending or archiving another user’s draft', async () => {
  await compose(true, reply);
  let resolveThread;
  api.getThread = () => new Promise(resolve => { resolveThread = resolve; });
  await click(button('Send + Archive'));
  await React.act(async () => { useStore.setState({ user: { id: 'other-owner' } }); resolveThread({ messages: [parent] }); });
  assert.equal(sent.length, 0); assert.equal(archived.length, 0);
});

test('rich editor keeps native Ctrl+Enter sending and supports Instant Intro without editor text changes', async () => {
  await compose(false, reply);
  const editorNode = document.querySelector('.ProseMirror');
  await key(editorNode, 'I', { ctrlKey: true, shiftKey: true });
  assert.match(document.querySelector('[role="status"]').textContent, /To recipients moved/);
  assert.equal(editorNode.editor.getText(), 'Hello world');
  await input(document.querySelector('input[placeholder="compose.toPh"]'), 'introduced@example.invalid');
  await key(editorNode, 'Enter', { ctrlKey: true });
  assert.equal(sent.length, 1); assert.equal(archived.length, 0);
  await finish();
});
