// The quotation editor unmounts when the composer is minimized. Exercise the real native
// TipTap composer and editable quotation; only the network boundary is mocked.

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
        'export const useTranslation = () => ({ t: (k, o) => (o?.message ? `${k} ${o.message}` : k), i18n: { language: "en", changeLanguage: () => {} } });',
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
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0 });
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const ComposeModal = (await import('./ComposeModal.jsx')).default;


let root;
let saved;
let sent;
const originalQuote = '<blockquote><p>Jordan: Please review the proposal.</p></blockquote>';
const button = label => [...document.querySelectorAll('button')].find(node => node.textContent.trim() === label);
const click = async node => { assert.ok(node, 'control exists'); await React.act(async () => node.click()); };

beforeEach(() => {
  saved = []; sent = [];
  useStore.setState({ user: { id: 'quote-owner' }, selectedAccountId: 'acct', accounts: [
    { id: 'acct', enabled: true, email_address: 'me@example.invalid', name: 'Me', signature: '<p>My signature</p>' },
  ], composing: false, composeData: null, prepareComposeSwitch: null, plaintextEmail: false, notifications: [] });
  api.saveDraft = async payload => { saved.push(payload); return { uid: 8, folder: 'Drafts' }; };
  api.post = async (path, payload) => { assert.equal(path, '/mail/send'); sent.push(payload); return { ok: true }; };
  root = createRoot(document.getElementById('root'));
});
afterEach(async () => { await React.act(async () => { root.unmount(); useStore.setState({ composing: false, composeData: null, prepareComposeSwitch: null }); }); });

for (const variant of ['original', 'edited']) {
  test(`${variant} reply quotation survives repeated minimize/restore, draft save and send capture`, async () => {
    useStore.getState().openCompose({ accountId: 'acct', isReply: true,
      inReplyTo: '<original@example.invalid>', to: ['Jordan <jordan@example.invalid>'],
      subject: 'Re: Proposal', body: '<p>Thank you for the proposal.</p>', bodyIsHtml: true,
      quotedBody: 'Jordan: Please review the proposal.', quotedBodyHtml: originalQuote });
    await React.act(async () => root.render(React.createElement(ComposeModal)));
    await React.act(async () => {});
    const editor = document.querySelector('.ProseMirror')?.editor;
    assert.ok(editor, 'the real rich-text editor mounted');
    await React.act(async () => editor.commands.insertContent(' I will review it.'));
    const quote = [...document.querySelectorAll('[contenteditable]')].find(node => node.innerHTML === originalQuote);
    assert.ok(quote, 'the original quotation is mounted');
    const expected = variant === 'edited' ? '<blockquote><p>Jordan: Edited quotation.</p></blockquote>'
      : originalQuote;
    if (variant !== 'original') await React.act(async () => {
      quote.innerHTML = expected;
      quote.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    for (let cycle = 0; cycle < 2; cycle++) {
      await click(document.querySelector('button[title="compose.toolbar.minimize"]'));
      assert.equal(document.querySelector('.ProseMirror'), null, 'the editable subtree is unmounted');
      if (cycle === 0) {
        await React.act(async () => assert.equal(await useStore.getState().prepareComposeSwitch(), true));
        assert.equal(saved[0].quotedBodyHtml, expected, 'a save while minimized retains the current quotation');
      }
      await click([...document.querySelectorAll('div')].find(node => node.textContent === 'Re: Proposal' && node.style.position === 'fixed'));
      const restored = [...document.querySelectorAll('[contenteditable]')].find(node => node !== document.querySelector('.ProseMirror') && !node.textContent.includes('My signature'));
      assert.ok(restored, 'the quotation editor remounted');
      assert.equal(restored.innerHTML, expected, 'remount retains the current quote, without reverting edits');
      assert.match(document.querySelector('.ProseMirror').textContent, /Thank you for the proposal/);
      assert.match(document.body.textContent, /My signature/);
    }
    await click(button('compose.saveDraft'));
    assert.equal(saved.length, 2);
    assert.equal(saved[1].quotedBodyHtml, expected, 'Save captures the exact current quotation');
    await click(button('compose.send'));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].quotedBodyHtml, expected, 'Send captures the exact current quotation');
    assert.match(sent[0].body, /Thank you for the proposal/);
    assert.match(sent[0].body, /I will review it/);
    assert.match(sent[0].editedSignature, /My signature/);
  });
}
