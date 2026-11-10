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
        'export const useTranslation = () => ({ t: (k) => k, i18n: { language: "en", changeLanguage: () => {} } });',
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
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.requestAnimationFrame ??= cb => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame ??= id => clearTimeout(id);
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const THREAD = [
  { id: 'first', account_id: 'account', folder: 'INBOX', message_id: '<first@example.invalid>', subject: 'Synthetic conversation', from_email: 'sender@example.invalid', from_name: 'Sender', date: '2026-01-01T10:00:00Z', is_read: true },
  { id: 'sent', account_id: 'account', folder: 'Sent', message_id: '<sent@example.invalid>', subject: 'Re: Synthetic conversation', from_email: 'me@example.invalid', from_name: 'Me', date: '2026-01-02T10:00:00Z', is_read: true },
  { id: 'latest', account_id: 'account', folder: 'INBOX', message_id: '<latest@example.invalid>', subject: 'Re: Synthetic conversation', from_email: 'sender@example.invalid', from_name: 'Sender', date: '2026-01-03T10:00:00Z', is_read: false },
];
globalThis.fetch = async url => {
  const path = String(url);
  const id = /\/messages\/([^/]+)\/body/.exec(path)?.[1];
  const body = path.includes('/mail/thread?') ? { messages: THREAD }
    : id ? { html: `<p>Synthetic readable body of ${id}</p>`, text: '', attachments: [] } : {};
  return { ok: true, status: 200, json: async () => body };
};
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const ConversationPane = (await import('./ConversationPane.jsx')).default;
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const { bodyCache } = await import('../utils/bodyCache.js');
let root;
const click = async element => React.act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
const settle = () => React.act(async () => new Promise(resolve => setTimeout(resolve, 30)));
const openCards = () => document.querySelectorAll('[data-message-id] > button[aria-expanded="true"]');
beforeEach(async () => {
  bodyCache.clear();
  useStore.setState({
    darkEmailBodies: false, accounts: [{ id: 'account', email_address: 'me@example.invalid' }],
    selectedAccountId: 'account', selectedFolder: 'INBOX', selectedMessageId: 'latest', messages: THREAD,
    composing: false, composeData: null, prepareComposeSwitch: null, enabledPlugins: [],
  });
  api.savePreferencesOnExit = () => {};
  useStore.getState().setLayout('gmail');
  root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(ConversationPane, { threadId: '<first@example.invalid>', folder: 'INBOX' })));
  await settle();
});
afterEach(async () => {
  await React.act(async () => root.unmount());
  window.dispatchEvent(new window.Event('pagehide'));
});

test('Gmail conversation shows received and sent mail and expands or collapses every native body', async () => {
  assert.equal(document.querySelectorAll('[data-message-id]').length, 3);
  assert.equal(openCards().length, 1);
  assert.ok(document.querySelector('iframe'), 'opened mail has a real body renderer');
  await click(document.querySelector('[aria-label="message.expandAll"]'));
  await settle();
  assert.equal(openCards().length, 3);
  assert.equal(document.querySelectorAll('iframe').length, 3);
  await click(document.querySelector('[aria-label="message.collapseAll"]'));
  assert.equal(openCards().length, 0);
  await click(document.querySelector('[aria-label="message.expandAll"]'));
  assert.equal(openCards().length, 3, 'repeated expand still works');
});

for (const [label, flag] of [['message.reply', 'isReply'], ['message.replyAll', 'isReplyAll'], ['message.forward', 'isForward']]) {
  test(`Gmail bottom ${label} opens the native composer for the latest message`, async () => {
    const button = [...document.querySelectorAll('.mailflow-reader-replies button')].find(element => element.textContent === label);
    assert.ok(button, label);
    await click(button);
    await settle();
    assert.equal(useStore.getState().composing, true);
    assert.equal(useStore.getState().composeData[flag], true);
    assert.match(useStore.getState().composeData.subject, /Synthetic conversation/);
  });
}
