// Render test for ComposeModal's draft autosave (#413).
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

const { SnippetsPanel } = await import('./SnippetsPanel.jsx');
let root;
let records;
let saved;
let sent;
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
  records = []; saved = []; sent = [];
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
  root = createRoot(document.getElementById('root'));
});
afterEach(async () => { await React.act(async () => root.unmount()); });

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

test('snippet management creates, edits, cancels, confirms deletion and shows empty state', async () => {
  await render(SnippetsPanel);
  assert.match(document.body.textContent, /No snippets yet/);
  await click(button('New snippet'));
  await input(field('Snippet title'), 'Follow up'); await input(field('Subject (optional)'), 'Actual subject'); await input(field('Snippet body'), 'Thanks for your time.');
  await click(button('Save snippet')); assert.equal(records.length, 1); assert.equal(records[0].subject, 'Actual subject');
  assert.match(document.body.textContent, /Thanks for your time/);
  await click(button('Edit snippet')); await input(field('Snippet body'), 'Unsaved'); await click(button('Cancel'));
  assert.equal(records[0].body, 'Thanks for your time.');
  await click(button('Edit snippet')); await input(field('Snippet body'), 'Updated text'); await click(button('Save snippet'));
  assert.equal(records[0].body, 'Updated text'); assert.equal(records[0].version, 2);
  await click(button('Delete')); await click(button('Cancel')); assert.equal(records.length, 1);
  await click(button('Delete')); await click(button('Delete snippet')); assert.equal(records.length, 0);
  assert.match(document.body.textContent, /No snippets yet/);
});

test('failed load has retry; failed save preserves editing text and allows retry', async () => {
  api.get = async () => { throw new Error('Offline'); }; await render(SnippetsPanel);
  assert.match(document.querySelector('[role="alert"]').textContent, /Offline/);
  api.get = async () => ({ snippets: [] }); await click(button('Reload snippets')); await click(button('New snippet'));
  await input(field('Snippet title'), 'Hello'); await input(field('Snippet body'), 'Keep this draft');
  const post = api.post; api.post = async () => { throw new Error('Save failed'); };
  await click(button('Save snippet')); assert.equal(field('Snippet body').value, 'Keep this draft');
  api.post = post; await click(button('Save snippet')); assert.equal(records[0].body, 'Keep this draft');
});

test('late responses from a previous owner are ignored; same-user account switches retain snippets', async () => {
  let resolveOld; api.get = () => new Promise(resolve => { resolveOld = resolve; });
  await render(SnippetsPanel);
  api.get = async () => ({ snippets: [{ ...snippet, title: 'Bob only' }] });
  await React.act(async () => useStore.setState({ user: { id: 'bob' } }));
  await React.act(async () => resolveOld({ snippets: [{ ...snippet, title: 'Alice private' }] }));
  assert.match(document.body.textContent, /Bob only/); assert.doesNotMatch(document.body.textContent, /Alice private/);
  await React.act(async () => useStore.setState({ selectedAccountId: 'other' }));
  assert.match(document.body.textContent, /Bob only/);
});

test('rich snippet insertion preserves selected text, signatures, quotes and From, and is undoable', async () => {
  records = [snippet]; await compose();
  const editor = document.querySelector('.ProseMirror').editor;
  await React.act(async () => editor.commands.setTextSelection({ from: 7, to: 12 }));
  await click(field('Open snippets')); await click(button('Insert snippet'));
  assert.equal(document.querySelector('[role="alert"]')?.textContent, undefined);
  assert.equal(editor.getText({ blockSeparator: '\n' }), 'Hello <b>Thanks</b>\nworld');
  assert.equal(document.querySelector('.ProseMirror img'), null);
  await autosave();
  assert.equal(saved.length, 1); assert.equal(saved[0].accountId, 'acct');
  assert.match(saved[0].body, /&lt;b&gt;Thanks&lt;\/b&gt;/); assert.match(saved[0].editedSignature, /My signature/); assert.equal(saved[0].quotedBody, 'Original mail');
  assert.equal(sent.length, 0);
  await React.act(async () => editor.commands.undo()); assert.equal(editor.getText(), 'Hello world');
});

test('plain-text insertion at the saved cursor never replaces selected text', async () => {
  records = [snippet]; await compose(true);
  const body = document.querySelector('textarea[placeholder="compose.bodyPh"]');
  body.setSelectionRange(6, 11);
  await click(field('Open snippets')); await click(button('Insert snippet'));
  assert.equal(body.value, 'Hello <b>Thanks</b>\nworld'); assert.equal(body.selectionStart, 20);
  assert.equal(sent.length, 0);
});

test('picker supports search/arrows, ignores IME and repeats, traps focus, and never sends', async () => {
  records = [snippet, { ...snippet, id: 'two', title: 'Second', body: 'Second text' }]; await compose();
  const editorNode = document.querySelector('.ProseMirror');
  await key(editorNode, ';', { ctrlKey: true, isComposing: true }); assert.equal(field('Search snippets'), null);
  await key(editorNode, ';', { ctrlKey: true });
  const search = field('Search snippets'); assert.ok(search);
  await key(search, 'ArrowDown'); assert.equal(document.querySelector('[role="option"][aria-selected="true"]').textContent, 'Second');
  await key(search, 'Enter', { isComposing: true }); assert.ok(field('Search snippets'));
  await key(search, 'Enter', { repeat: true }); assert.ok(field('Search snippets'));
  const sendKey = await key(search, 'Enter', { ctrlKey: true }); assert.equal(sendKey.defaultPrevented, true); assert.equal(sent.length, 0);
  const close = field('Close snippets'); close.focus(); await key(close, 'Tab', { shiftKey: true }); assert.equal(document.activeElement, button('Delete'));
  await key(search, 'Enter'); assert.equal(field('Search snippets'), null); assert.match(editorNode.editor.getText(), /Second text/);
});

test('HTML source disables snippets rather than injecting into HTML syntax', async () => {
  await compose(); await React.act(async () => document.querySelector('[title="Edit HTML source"]').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true })));
  assert.equal(field('Open snippets').disabled, true); assert.match(field('Open snippets').title, /Switch to rich text/);
});

test('manual availability validates timezone and date, cancels safely, and inserts without sending', async () => {
  await compose(true);
  const body = document.querySelector('textarea[placeholder="compose.bodyPh"]'); body.setSelectionRange(6, 11);
  await click(field('Share availability'));
  assert.match(document.querySelector('[role="dialog"]').textContent, /calendar has not been checked/);
  assert.equal(button('Insert availability').disabled, true);
  await input(field('Available date'), '2099-11-20'); await input(field('Available time'), '14:30');
  await input(field('Availability time zone'), 'not-a-zone'); assert.equal(button('Insert availability').disabled, true);
  await input(field('Availability time zone'), 'America/New_York'); assert.equal(button('Insert availability').disabled, false);
  await key(field('Available time'), 'Enter', { ctrlKey: true }); assert.equal(sent.length, 0); assert.ok(field('Available date'));
  await click(button('Cancel')); assert.equal(body.value, 'Hello world');
  await click(field('Share availability')); await input(field('Available date'), '2099-11-20'); await input(field('Available time'), '14:30');
  await input(field('Availability time zone'), 'America/New_York'); await click(button('Insert availability'));
  assert.match(body.value, /^Hello I’m available .*2099.*America\/New_York.*world$/); assert.equal(sent.length, 0);
});

test('quick replies appear only for replies and insert without replacing text or sending', async () => {
  await compose(true, { isReply: true });
  const body = document.querySelector('textarea[placeholder="compose.bodyPh"]'); body.setSelectionRange(6, 11);
  assert.ok(document.querySelector('[aria-label="Quick replies"]')); await click(button('Thank you'));
  assert.equal(body.value, 'Hello Thank you for the update.world'); assert.equal(sent.length, 0);
  await autosave(); assert.equal(saved[0].quotedBody, 'Original mail'); assert.match(saved[0].editedSignature, /My signature/);
});

test('new messages do not expose canned reply actions', async () => {
  await compose(); assert.equal(document.querySelector('[aria-label="Quick replies"]'), null);
});

test('saving twice while pending makes one mutation and ignores completion after user switch', async () => {
  await render(SnippetsPanel); await click(button('New snippet'));
  await input(field('Snippet title'), 'Private'); await input(field('Snippet body'), 'Alice text');
  let complete; let calls = 0;
  api.post = () => { calls++; return new Promise(resolve => { complete = resolve; }); };
  const form = field('Snippet title').closest('form');
  await React.act(async () => {
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.equal(calls, 1); assert.equal(button('Cancel').disabled, true);
  api.get = async () => ({ snippets: [] });
  await React.act(async () => useStore.setState({ user: { id: 'bob' } }));
  await React.act(async () => complete({ ...snippet, title: 'Alice private', body: 'Alice text' }));
  assert.doesNotMatch(document.body.textContent, /Alice/); assert.match(document.body.textContent, /No snippets yet/);
});

test('snippet Escape cancels edits first and leaves the original composer intact', async () => {
  records = [snippet]; await compose(); await click(field('Open snippets')); await click(button('Edit snippet'));
  await input(field('Snippet body'), 'Unsaved'); await key(field('Snippet body'), 'Escape');
  assert.ok(field('Search snippets')); assert.equal(records[0].body, snippet.body);
  await key(field('Search snippets'), 'Escape'); assert.equal(field('Search snippets'), null);
  assert.equal(document.querySelector('.ProseMirror').editor.getText(), 'Hello world'); assert.equal(sent.length, 0);
});

test('mobile composer exposes snippets and manual availability with the same safe insertion', async () => {
  const originalWidth = window.innerWidth;
  window.innerWidth = 390;
  try {
    records = [snippet]; await compose(true);
    const body = document.querySelector('textarea[placeholder="compose.bodyPh"]'); body.setSelectionRange(6, 6);
    await click(field('Open snippets')); await click(button('Insert snippet'));
    assert.equal(body.value, 'Hello <b>Thanks</b>\nworld');
    await click(field('Share availability')); assert.ok(field('Available date')); await click(button('Cancel'));
    assert.equal(sent.length, 0);
  } finally { window.innerWidth = originalWidth; }
});

test('explicit inline insertion records one use but reading and cancelling the picker do not', async () => {
  records = [{ ...snippet, subject: 'Must not replace draft subject' }]; await compose(true);
  await click(field('Open snippets')); assert.equal(records[0].usageCount || 0, 0);
  await key(field('Search snippets'), 'Escape'); assert.equal(records[0].usageCount || 0, 0);
  await click(field('Open snippets')); await click(button('Insert snippet'));
  assert.equal(records[0].usageCount, 1); assert.ok(records[0].lastUsedAt); assert.equal(sent.length, 0);
  await autosave(); assert.equal(saved[0].subject, 'Contract');
});
