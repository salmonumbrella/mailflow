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

test('review: rich insertion preserves structured draft text and surrounding nodes', async () => {
  records = [{ ...snippet, body: 'Inserted <img src=x onerror=alert(1)>\nline' }];
  await compose(false, { body: '<p>Before</p><ul><li><p>Bullet</p></li></ul><blockquote><p>Quoted paragraph</p></blockquote><p>After</p>' });
  const editor = document.querySelector('.ProseMirror').editor;
  const original = editor.getJSON();
  await React.act(async () => editor.commands.setTextSelection({ from: 2, to: editor.state.doc.content.size - 1 }));
  await click(field('Open snippets')); await click(button('Insert snippet'));
  const text = editor.getText();
  for (const word of ['Bullet', 'Quoted paragraph', 'After']) assert.ok(text.includes(word));
  assert.ok(text.includes('Inserted <img src=x onerror=alert(1)>'));
  assert.equal(document.querySelector('.ProseMirror img'), null);
  assert.equal(document.querySelectorAll('.ProseMirror ul').length, 1);
  assert.equal(document.querySelectorAll('.ProseMirror blockquote').length, 1);
  await autosave(); assert.equal(sent.length, 0); assert.equal(saved[0].quotedBody, 'Original mail');
  await React.act(async () => editor.commands.undo()); assert.deepEqual(editor.getJSON(), original);
});

test('review: empty rich drafts accept multiline snippets without losing the independent signature', async () => {
  records = [{ ...snippet, body: '\nFirst\n\nLast\n' }]; await compose(false, { body: '' });
  const editor = document.querySelector('.ProseMirror').editor;
  await click(field('Open snippets')); await click(button('Insert snippet'));
  assert.equal(editor.getText({ blockSeparator: '\n' }), '\nFirst\n\nLast\n');
  await autosave(); assert.match(saved[0].editedSignature, /My signature/); assert.equal(sent.length, 0);
});

test('review: failed deletion retains the saved record and supports retry', async () => {
  records = [snippet]; await render(SnippetsPanel); await click(button('Delete'));
  api.delete = async () => { throw new Error('Connection failed'); };
  await click(button('Delete snippet'));
  assert.equal(records.length, 1); assert.match(document.querySelector('[role="alert"]').textContent, /Connection failed/);
  assert.ok(button('Delete snippet'));
  api.delete = async () => { records = []; };
  await click(button('Delete snippet')); assert.equal(records.length, 0); assert.match(document.body.textContent, /No snippets yet/);
});

test('review: conflicts preserve the editor until explicit reload and use the new version afterward', async () => {
  records = [snippet]; await render(SnippetsPanel); await click(button('Edit snippet'));
  await input(field('Snippet body'), 'Local unsaved text');
  api.put = async () => { throw Object.assign(new Error('Changed elsewhere'), { status: 409 }); };
  await click(button('Save snippet')); assert.equal(field('Snippet body').value, 'Local unsaved text');
  records = [{ ...snippet, body: 'Remote version', version: 4 }];
  await click(button('Reload snippets')); assert.match(document.body.textContent, /Remote version/);
  await click(button('Edit snippet')); await input(field('Snippet body'), 'Resolved text');
  let payload; api.put = async (path, data) => { payload = data; return { ...snippet, ...data, version: 5 }; };
  await click(button('Save snippet')); assert.equal(payload.version, 4); assert.equal(payload.body, 'Resolved text');
});

test('review: owner A to B to A discards a pending old save through both remounts', async () => {
  records = [snippet]; await render(SnippetsPanel); await click(button('Edit snippet'));
  await input(field('Snippet body'), 'Old pending edit');
  let resolve; api.put = () => new Promise(done => { resolve = done; });
  await click(button('Save snippet'));
  records = [];
  await React.act(async () => useStore.setState({ user: { id: 'bob' } }));
  await React.act(async () => useStore.setState({ user: { id: 'alice' } }));
  await React.act(async () => resolve({ ...snippet, body: 'Old pending edit', version: 2 }));
  assert.doesNotMatch(document.body.textContent, /Old pending edit/); assert.match(document.body.textContent, /No snippets yet/);
});

test('review: snippet editing consumes Send shortcuts and IME Escape without touching the mail draft', async () => {
  records = [snippet]; await compose(true); await click(field('Open snippets')); await click(button('Edit snippet'));
  const body = field('Snippet body'); await input(body, 'Unsaved text');
  await key(body, 'Escape', { isComposing: true, keyCode: 229 }); assert.equal(field('Snippet body'), body);
  for (const modifier of ['ctrlKey', 'metaKey']) {
    const event = await key(body, 'Enter', { [modifier]: true }); assert.equal(event.defaultPrevented, true);
  }
  assert.equal(records[0].version, 1); assert.equal(sent.length, 0);
  await click(button('Cancel')); await key(field('Search snippets'), 'Escape');
  assert.equal(document.querySelector('textarea[placeholder="compose.bodyPh"]').value, 'Hello world');
});
