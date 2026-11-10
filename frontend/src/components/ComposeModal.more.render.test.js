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
        // Keys stand in for text. The one string that wraps another (the AI panel's error) shows
        // what it wraps, so a test can tell which error it is.
        'const t = (k, o) => (typeof o === "string" ? o : o?.message ? `${k} ${o.message}` : k); export const useTranslation = () => ({ t, i18n: { language: "en", changeLanguage: () => {} } });',
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
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: callback => setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: id => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });



const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const ComposeModal = (await import('./ComposeModal.jsx')).default;

const originalApi = { post: api.post, saveDraft: api.saveDraft, savePreferencesOnExit: api.savePreferencesOnExit, getContacts: api.getContacts };
let root;
let posted;
let saved;
let rejectSend;
beforeEach(() => {
  posted = [];
  saved = [];
  rejectSend = false;
  api.savePreferencesOnExit = () => {};
  api.saveDraft = async payload => { saved.push(payload); return { uid: 42, folder: 'Drafts' }; };
  api.post = async (path, body) => {
    posted.push({ path, body });
    if (path === '/mail/send' && rejectSend) throw new Error('Synthetic send failure');
    return { sentFolder: 'Sent' };
  };
  useStore.setState({
    user: { id: 'synthetic-user' }, accounts: [{ id: 'account', enabled: true, email_address: 'me@example.invalid', name: 'Me' }],
    selectedAccountId: 'account', plaintextEmail: false, composing: false, composeData: null,
    composeDefaultFullscreen: false, prepareComposeSwitch: null, notifications: [], enabledPlugins: [],
  });
  useStore.getState().setLayout('gmail');
});
afterEach(async () => {
  if (root) await React.act(async () => root.unmount());
  root = null;
  window.dispatchEvent(new window.Event('pagehide'));
  Object.assign(api, originalApi);
});

async function mount(data = {}, props = {}) {
  useStore.getState().openCompose({ accountId: 'account', ...data });
  root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(ComposeModal, props)));
  await React.act(async () => {});
}
async function send() {
  const button = document.querySelector('.mailflow-compose-send button');
  assert.ok(button, 'Gmail send control remains the native send button');
  await React.act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 10));
  });
}
const sendPayload = () => posted.find(request => request.path === '/mail/send')?.body;

async function click(label) {
  const button = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label || b.textContent.trim() === label || b.title === label);
  assert.ok(button, `Missing ${label}`);
  await React.act(async () => button.click());
}
async function more(label) { await click('More compose options'); await click(label); }

test('G134 saved plain draft overrides global rich preference and sends truthful text', async () => {
  await mount({ to: ['recipient@example.invalid'], subject: 'Plain draft', body: 'Literal <b>text</b>\nNext line', bodyIsHtml: false });
  assert.equal(document.querySelector('textarea[placeholder="compose.bodyPh"]')?.value, 'Literal <b>text</b>\nNext line');
  await send();
  assert.equal(sendPayload().bodyIsHtml, false);
  assert.equal(sendPayload().body, 'Literal <b>text</b>\nNext line');
});

test('G134 conversion asks first, cancel preserves formatting, switching back restores rich content and one editor', async () => {
  await mount({ body: '<p>Hello <strong>world</strong></p>', bodyIsHtml: true });
  const editor = document.querySelector('.ProseMirror').editor;
  await more('Plain text mode');
  assert.match(document.body.textContent, /Remove formatting/);
  await click('Cancel');
  assert.match(editor.getHTML(), /<strong>world/);
  await more('Plain text mode');
  await click('Use plain text');
  assert.equal(document.querySelector('textarea[placeholder="compose.bodyPh"]').value, 'Hello world');
  assert.equal(useStore.getState().plaintextEmail, false);
  await more('Plain text mode');
  assert.equal(document.querySelector('.ProseMirror').editor, editor);
  assert.match(editor.getHTML(), /<strong>world/);
});

test('G145 G146 actual editor undo, redo, quote, indent and remove formatting retain text', async () => {
  await mount({ body: '<p>Original</p>', bodyIsHtml: true });
  const editor = document.querySelector('.ProseMirror').editor;
  await React.act(async () => editor.commands.setTextSelection({ from: 1, to: 9 }));
  await click('Quote');
  assert.match(editor.getHTML(), /blockquote/);
  await click('Undo');
  assert.doesNotMatch(editor.getHTML(), /blockquote/);
  await click('Redo');
  assert.match(editor.getHTML(), /blockquote/);
  await click('Increase indent');
  assert.match(editor.getHTML(), /margin-left: 32px/);
  await click('Remove formatting');
  assert.equal(editor.getText().trim(), 'Original');
  assert.doesNotMatch(editor.getHTML(), /blockquote|margin-left/);
});

test('G150 spellcheck toggles browser editor checking and More restores trigger focus', async () => {
  await mount();
  const editor = document.querySelector('.ProseMirror').editor;
  await more('Browser spellcheck');
  assert.equal(editor.view.dom.spellcheck, false);
  assert.equal(document.activeElement.getAttribute('aria-label'), 'More compose options');
  await more('Browser spellcheck');
  assert.equal(editor.view.dom.spellcheck, true);
});

test('G116 default fullscreen persists independently and applies to the next new composer', async () => {
  await mount({ subject: 'First' });
  await more('Default to full screen');
  assert.equal(useStore.getState().composeDefaultFullscreen, true);
  assert.equal(localStorage.getItem('mailflow_compose_default_fullscreen'), 'true');
  assert.equal(document.querySelector('.compose-window').getAttribute('data-docked'), 'true');
  await React.act(async () => root.unmount()); root = null;
  await mount({ subject: 'Next' });
  assert.equal(document.querySelector('.compose-window').getAttribute('data-docked'), 'false');
  assert.equal(useStore.getState().layout, 'gmail');
});

test('G134 converted draft saves plain mode and lock restore carries mode, recipients, attachments', async () => {
  await mount({ to: ['recipient@example.invalid'], subject: 'Save mode', body: '<p>Body</p>', bodyIsHtml: true });
  await more('Plain text mode'); await click('Use plain text');
  await click('compose.saveDraft');
  assert.equal(saved.at(-1).body, 'Body');
  assert.equal(saved.at(-1).bodyIsHtml, false);
  assert.equal(saved.at(-1).plaintextEmail, true);
  await React.act(async () => window.dispatchEvent(new window.Event('mailflow:will-lock')));
  const restored = useStore.getState().composeData;
  assert.equal(restored.bodyIsHtml, false);
  assert.equal(restored.plaintextEmail, true);
  assert.deepEqual(restored.to, ['recipient@example.invalid']);
});

test('G134 legacy scheduled rich input with plain output converts markup and entities safely', async () => {
  await mount({ body: '<p>Hello &amp; goodbye</p><p>Second</p>', bodyIsHtml: true, plaintextEmail: true, signature: '<b>Me</b>' });
  assert.equal(document.querySelector('textarea[placeholder="compose.bodyPh"]').value, 'Hello & goodbye\nSecond');
});

test('G149 print draft uses isolated sanitized print document without sending or saving', async () => {
  let html = ''; let prints = 0;
  const originalOpen = window.open;
  const win = { closed: false, opener: window, document: { open() {}, close() {}, write(value) { html = value; } }, focus() {}, print() { prints++; } };
  window.open = () => win;
  try {
    await mount({ to: ['recipient@example.invalid'], subject: 'Print only', body: '<p>Draft body</p>', bodyIsHtml: true });
    await more('Print draft');
    assert.equal(prints, 1); assert.equal(win.opener, null);
    assert.match(html, /Draft body/); assert.match(html, /Print only/);
    assert.match(html, /script-src 'none'/);
    assert.equal(posted.length, 0); assert.equal(saved.length, 0);
  } finally { window.open = originalOpen; }
});

test('G146 paragraph indentation bounds and native list nesting preserve editor text', async () => {
  await mount({ body: '<p>First</p><p>Second</p>', bodyIsHtml: true });
  const editor = document.querySelector('.ProseMirror').editor;
  await React.act(async () => {
    editor.commands.setTextSelection(2);
    for (let i = 0; i < 12; i++) editor.commands.increaseParagraphIndent();
  });
  assert.equal(editor.getAttributes('paragraph').indent, 8);
  await React.act(async () => { for (let i = 0; i < 12; i++) editor.commands.decreaseParagraphIndent(); });
  assert.equal(editor.getAttributes('paragraph').indent, 0);
  await React.act(async () => { editor.commands.selectAll(); editor.commands.toggleBulletList(); editor.commands.setTextSelection(12); });
  await click('Increase indent');
  assert.equal((editor.getHTML().match(/<ul>/g) || []).length, 2);
  await click('Decrease indent');
  assert.equal((editor.getHTML().match(/<ul>/g) || []).length, 1);
  assert.match(editor.getText(), /First/); assert.match(editor.getText(), /Second/);
});

test('G150 menu keyboard navigation returns focus and preserves current editor selection', async () => {
  await mount({ body: '<p>Select me</p>', bodyIsHtml: true });
  const editor = document.querySelector('.ProseMirror').editor;
  await React.act(async () => editor.commands.setTextSelection({ from: 1, to: 7 }));
  await click('More compose options');
  assert.equal(document.activeElement.textContent, 'Default to full screen');
  await React.act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true })));
  assert.equal(document.activeElement.textContent, 'Print draft');
  await React.act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(document.activeElement.getAttribute('aria-label'), 'More compose options');
  assert.equal(editor.state.selection.from, 1); assert.equal(editor.state.selection.to, 7);
});

test('G134 plain failed send preserves literal text, mode and attached files', async () => {
  rejectSend = true;
  await mount({ to: ['recipient@example.invalid'], subject: 'Keep plain', body: 'A < B & C', bodyIsHtml: false,
    attachments: [{ name: 'note.txt', data: 'aGVsbG8=', type: 'text/plain' }] });
  await send();
  assert.equal(useStore.getState().composing, true);
  assert.equal(sendPayload().plaintextEmail, true);
  assert.equal(sendPayload().body, 'A < B & C');
  assert.equal(sendPayload().attachments[0].filename, 'note.txt');
  assert.equal(document.querySelector('textarea[placeholder="compose.bodyPh"]').value, 'A < B & C');
});

test('G134 quote edits survive rich to plain to rich without resetting original quote', async () => {
  await mount({ body: '<p>Reply</p>', bodyIsHtml: true, isReply: true, quotedBody: 'Old quote', quotedBodyHtml: '<p>Old quote</p>' });
  const quote = [...document.querySelectorAll('[contenteditable="true"]')].find(node => !node.classList.contains('ProseMirror') && node.textContent.includes('Old quote'));
  assert.ok(quote); quote.innerHTML = '<p>Edited &amp; preserved quote</p>';
  await more('Plain text mode'); await click('Use plain text');
  assert.match(document.body.textContent, /Edited & preserved quote/);
  await more('Plain text mode');
  assert.match(document.body.textContent, /Edited & preserved quote/);
});

test('G146 remove formatting retains inline images and file attachments', async () => {
  await mount({ body: '<p><strong>Text</strong><img src="data:image/png;base64,aGVsbG8="></p>', bodyIsHtml: true,
    attachments: [{ name: 'note.txt', data: 'aGVsbG8=', type: 'text/plain' }] });
  const editor = document.querySelector('.ProseMirror').editor;
  await React.act(async () => editor.commands.selectAll());
  await click('Remove formatting');
  assert.match(editor.getHTML(), /<img/); assert.doesNotMatch(editor.getHTML(), /strong/);
  assert.match(document.body.textContent, /note.txt/);
});

test('G134 clearing the entire rich quote stays empty through both modes, saves and sends', async () => {
  rejectSend = true;
  await mount({ to: ['recipient@example.invalid'], subject: 'No removed quote', body: '<p>Reply</p>', bodyIsHtml: true,
    isReply: true, quotedBody: 'Sensitive old quote', quotedBodyHtml: '<p>Sensitive old quote</p>' });
  const quote = [...document.querySelectorAll('[contenteditable="true"]')].find(node => !node.classList.contains('ProseMirror') && node.textContent.includes('Sensitive old quote'));
  assert.ok(quote); quote.innerHTML = '';
  await click('compose.saveDraft');
  assert.doesNotMatch(JSON.stringify(saved.at(-1)), /Sensitive old quote/);
  await send();
  assert.doesNotMatch(JSON.stringify(posted.at(-1).body), /Sensitive old quote/);
  await more('Plain text mode'); await click('Use plain text');
  assert.doesNotMatch(document.body.textContent, /Sensitive old quote/);
  await click('compose.saveDraft');
  assert.doesNotMatch(JSON.stringify(saved.at(-1)), /Sensitive old quote/);
  await send();
  assert.equal(posted.at(-1).body.plaintextEmail, true);
  assert.doesNotMatch(JSON.stringify(posted.at(-1).body), /Sensitive old quote/);
  await more('Plain text mode');
  assert.doesNotMatch(document.body.textContent, /Sensitive old quote/);
  await send();
  assert.equal(posted.at(-1).body.plaintextEmail, false);
  assert.doesNotMatch(JSON.stringify(posted.at(-1).body), /Sensitive old quote/);
});
