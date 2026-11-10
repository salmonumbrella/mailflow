import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { draftSourceFixture, savedDraftFixture, composeDraftFixture, signatureLibraryFixture } from '../test/draftSourceFixture.js';
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
        'const t = (k, o) => (o?.message ? `${k} ${o.message}` : k); export const useTranslation = () => ({ t, i18n: { language: "en", changeLanguage: () => {} } });',
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
api.getSignatureLibrary = async accountId => signatureLibraryFixture(useStore.getState().accounts.find(account => account.id === accountId));
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
  api.saveDraft = async payload => { saved.push(payload); return savedDraftFixture(payload.accountId, 42, saved.length); };
  api.post = async (path, body) => {
    posted.push({ path, body });
    if (path === '/mail/send' && rejectSend) throw new Error('Synthetic send failure');
    return { sentFolder: 'Sent' };
  };
  useStore.setState({
    user: { id: 'synthetic-user' }, accounts: [{ id: '20000000-0000-4000-8000-000000000002', enabled: true, email_address: 'me@example.invalid', name: 'Me' }],
    selectedAccountId: '20000000-0000-4000-8000-000000000002', plaintextEmail: false, composing: false, composeData: null,
    prepareComposeSwitch: null, notifications: [], enabledPlugins: [],
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
  useStore.getState().openCompose({ accountId: '20000000-0000-4000-8000-000000000002', ...data });
  root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(ComposeModal, props)));
  await React.act(async () => {});
}
async function type(input, value) {
  assert.ok(input);
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
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

test('Gmail composer sends typed recipients, subject and rich text through the native endpoint', async () => {
  await mount();
  const toRow = [...document.querySelectorAll('span, button')].find(span => span.textContent === 'compose.to')?.parentElement;
  await type(toRow?.querySelector('input'), 'recipient@example.invalid');
  await React.act(async () => toRow.querySelector('input').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await type(document.querySelector('input[placeholder="compose.subject"]'), 'Synthetic Gmail message');
  const editor = document.querySelector('.ProseMirror').editor;
  await React.act(async () => editor.commands.setContent('<p>Hello <strong>recipient</strong>.</p>'));
  await send();
  const payload = sendPayload();
  assert.ok(payload);
  assert.equal(payload.accountId, '20000000-0000-4000-8000-000000000002');
  assert.match(JSON.stringify(payload.to), /recipient@example.invalid/);
  assert.equal(payload.subject, 'Synthetic Gmail message');
  assert.match(payload.body, /<strong>recipient<\/strong>/);
  assert.equal(useStore.getState().composing, false);
});

test('Gmail reply preserves threading, Cc and Bcc when sending', async () => {
  globalThis.requestAnimationFrame ??= callback => setTimeout(() => callback(Date.now()), 0);
  await mount({
    to: ['recipient@example.invalid'], cc: ['cc@example.invalid'], bcc: ['bcc@example.invalid'],
    subject: 'Re: Synthetic thread', body: '<p>Reply text</p>', bodyIsHtml: true,
    isReply: true, inReplyTo: '<original@example.invalid>', references: '<original@example.invalid>',
  });
  await send();
  const payload = sendPayload();
  assert.ok(payload);
  assert.match(JSON.stringify(payload.cc), /cc@example.invalid/);
  assert.match(JSON.stringify(payload.bcc), /bcc@example.invalid/);
  assert.equal(payload.inReplyTo, '<original@example.invalid>');
  assert.match(payload.body, /Reply text/);
});

test('Gmail send failure keeps the editable draft open and layout switching preserves the editor', async () => {
  rejectSend = true;
  await mount({ to: ['recipient@example.invalid'], subject: 'Keep my draft', body: '<p>Important draft text</p>', bodyIsHtml: true });
  const editor = document.querySelector('.ProseMirror').editor;
  await send();
  assert.equal(useStore.getState().composing, true);
  assert.match(document.body.textContent, /Synthetic send failure/);
  await React.act(async () => useStore.getState().setLayout('comfortable'));
  assert.equal(document.querySelector('.ProseMirror').editor, editor);
  assert.match(editor.getHTML(), /Important draft text/);
  await React.act(async () => useStore.getState().setLayout('gmail'));
  rejectSend = false;
  await send();
  assert.equal(posted.filter(request => request.path === '/mail/send').length, 2);
  assert.equal(useStore.getState().composing, false);
});

test('Gmail composer autosaves an edited draft without sending it', async () => {
  await mount({ to: ['recipient@example.invalid'], subject: 'Save for later', body: '<p>Original</p>', bodyIsHtml: true, ...composeDraftFixture('20000000-0000-4000-8000-000000000002', 7) });
  const editor = document.querySelector('.ProseMirror').editor;
  await React.act(async () => editor.commands.insertContent(' Updated'));
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  await React.act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].existingUid, 7);
  assert.deepEqual(saved[0].existingSource, draftSourceFixture('20000000-0000-4000-8000-000000000002', 7));
  assert.match(saved[0].body, /Updated/);
  assert.equal(sendPayload(), undefined);
});

test('Gmail composer preserves docked dimensions on first drag and supports minimize, restore, maximize', async () => {
  await mount({ subject: 'Window controls', to: ['recipient@example.invalid'] });
  const element = document.querySelector('.compose-window');
  const title = document.querySelector('.mailflow-compose-title');
  assert.equal(element.dataset.docked, 'true');
  Object.defineProperties(element, { offsetWidth: { configurable: true, value: 600 }, offsetHeight: { configurable: true, value: 616 } });
  element.getBoundingClientRect = () => ({ x: 100, y: 100, width: 600, height: 616 });
  element.getAnimations = () => [];
  title.setPointerCapture = () => {};
  title.hasPointerCapture = () => false;
  await React.act(async () => title.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 110, clientY: 110 })));
  assert.equal(element.dataset.docked, 'false');
  assert.equal(element.style.width, '600px');
  assert.equal(element.style.height, '616px');
  await React.act(async () => {
    title.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true, clientX: 130, clientY: 130 }));
    title.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true }));
  });
  assert.equal(document.body.style.cursor, '');
  const click = async selector => React.act(async () => document.querySelector(selector).dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  await click('[title="compose.toolbar.maximize"]');
  assert.equal(element.style.left, '28px');
  await click('[title="compose.toolbar.restore"]');
  assert.equal(element.style.width, '600px');
  assert.equal(element.style.height, '616px');
  await click('[title="compose.toolbar.minimize"]');
  assert.equal(document.querySelector('.compose-window'), null);
  await React.act(async () => document.getElementById('root').firstElementChild.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  const restored = document.querySelector('.compose-window');
  assert.ok(restored);
  assert.equal(restored.style.width, '600px');
  assert.equal(restored.style.height, '616px');
  assert.equal(document.querySelector('input[placeholder="compose.subject"]').value, 'Window controls');
});

test('Gmail contact selection inserts without duplicating existing recipients and Cancel leaves chips untouched', async () => {
  api.getContacts = async () => ({ contacts: [
    { id: 'duplicate', display_name: 'Existing', primary_email: 'RECIPIENT@example.invalid' },
    { id: 'new', display_name: 'New Person', primary_email: 'new@example.invalid' },
  ], total: 2 });
  await mount({ to: ['recipient@example.invalid'], subject: 'Contact picker integration' });
  const pickerLabel = () => [...document.querySelectorAll('.mailflow-recipient-picker-label')].find(button => button.textContent === 'compose.to');
  const click = async element => {
    await React.act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    await React.act(async () => new Promise(resolve => setTimeout(resolve, 10)));
  };
  await click(pickerLabel());
  assert.ok(document.querySelector('[role="dialog"]'));
  await click(document.querySelector('.mailflow-contact-picker-select input'));
  await click(document.querySelector('.mailflow-contact-picker-insert'));
  assert.equal(Boolean(document.querySelector('.mailflow-contact-picker')), false);
  const recipientRow = pickerLabel().parentElement;
  const chips = () => [...recipientRow.querySelectorAll('span[title]')].map(element => (element.title.match(/<([^>]+)>/)?.[1] || element.title).toLowerCase());
  assert.deepEqual(chips().sort(), ['new@example.invalid', 'recipient@example.invalid']);
  await click(pickerLabel());
  await click(document.querySelector('.mailflow-contact-picker-select input'));
  await click([...document.querySelectorAll('.mailflow-contact-picker button')].find(button => button.textContent === 'common.cancel'));
  assert.deepEqual(chips().sort(), ['new@example.invalid', 'recipient@example.invalid']);
  assert.equal(sendPayload(), undefined, 'contact insertion never sends mail');
});

test('Gmail formatting toggle hides only the toolbar and retains rich text and attachment control', async () => {
  await mount({ to: ['recipient@example.invalid'], body: '<p><strong>Keep formatted text</strong></p>', bodyIsHtml: true });
  const editor = document.querySelector('.ProseMirror').editor;
  const toggle = document.querySelector('.mailflow-formatting-toggle');
  assert.ok(toggle);
  await React.act(async () => toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(document.querySelector('.mailflow-compose-formatting'), null);
  assert.equal(document.querySelector('.ProseMirror').editor, editor);
  assert.match(editor.getHTML(), /<strong>Keep formatted text<\/strong>/);
  assert.ok(document.querySelector('input[type="file"][multiple]'));
  await React.act(async () => toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.ok(document.querySelector('.mailflow-compose-formatting'));
});

test('Gmail inline reply preserves one editable draft across navigation, maximize, restore and pop-out', async () => {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const matching = { element: target, messageId: 'source', accountId: '20000000-0000-4000-8000-000000000002' };
  try {
    await mount({ to: ['recipient@example.invalid'], subject: 'Inline reply', body: '<p>Draft reply</p>', bodyIsHtml: true, isReply: true, sourceMessageId: 'source' }, { gmailReplyTarget: matching });
    assert.equal(target.querySelector('.compose-window').dataset.inline, 'true');
    const editor = document.querySelector('.ProseMirror').editor;
    await React.act(async () => editor.commands.insertContent(' Edited'));
    const assertDraft = () => {
      assert.equal(document.querySelectorAll('.ProseMirror').length, 1);
      assert.match(document.querySelector('.ProseMirror').editor.getHTML(), /Edited/);
      assert.equal(sendPayload(), undefined);
    };
    await React.act(async () => root.render(React.createElement(ComposeModal, { gmailReplyTarget: { ...matching, messageId: 'another-message' } })));
    assert.equal(Boolean(target.querySelector('.compose-window')), false);
    assert.equal(document.querySelector('.compose-window').dataset.inline, 'false');
    assertDraft();
    await React.act(async () => root.render(React.createElement(ComposeModal, { gmailReplyTarget: matching })));
    assert.equal(target.querySelector('.compose-window').dataset.inline, 'true');
    const click = async selector => React.act(async () => document.querySelector(selector).dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    await click('[title="compose.toolbar.maximize"]');
    assert.equal(document.querySelector('.compose-window').dataset.inline, 'false');
    assertDraft();
    await click('[title="compose.toolbar.restore"]');
    assert.equal(target.querySelector('.compose-window').dataset.inline, 'true');
    assertDraft();
    await click('[title="compose.openPopup"]');
    assert.equal(document.querySelector('.compose-window').dataset.inline, 'false');
    assertDraft();
  } finally {
    if (root) await React.act(async () => root.unmount());
    root = null;
    target.remove();
  }
});
