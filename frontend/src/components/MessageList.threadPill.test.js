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
        'export const useTranslation = () => ({ t: (...args) => globalThis.__threadPillT(...args), i18n: { language: "en", changeLanguage: () => {} } });',
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

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.synthetic.test', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
// Each mount selects a viewport; useMobile subscribes after reading innerWidth.
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.matchMedia = dom.window.matchMedia;
dom.window.Element.prototype.scrollIntoView = () => {};
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
let rows = [];
globalThis.fetch = async (url) => ({
  ok: true, status: 200, headers: { get: () => 'application/json' },
  json: async () => String(url).includes('/mail/messages?') ? { messages: rows, total: rows.length }
    : String(url).includes('/mail/thread?') ? { messages: rows } : {},
});
const i18next = (await import('i18next')).default.createInstance();
await i18next.init({ lng: 'en', fallbackLng: false, resources: {
  en: { translation: JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) },
} });
globalThis.__threadPillT = i18next.t.bind(i18next);

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const MessageList = (await import('./MessageList.jsx')).default;

const account = { id: 'account', email_address: 'reader@synthetic.test', include_in_unified_inbox: true };
const message = { id: 'message', account_id: 'account', folder: 'INBOX', uid: 1,
  thread_id: 'thread', message_id: '<message@synthetic.test>', subject: 'Conversation',
  from_name: 'Sender', from_email: 'sender@synthetic.test', date: '2026-01-01T12:00:00Z',
  is_read: true, unread_count: 0, message_count: 107 };
let root;
afterEach(async () => { if (root) await React.act(async () => root.unmount()); root = null; });
async function mount({ count = 107, width = 1024, selected = false, layout = 'comfortable' } = {}) {
  window.innerWidth = width;
  rows = [{ ...message, message_count: count }];
  useStore.setState({ accounts: [account], accountsReady: true,
    selectedAccountId: account.id, selectedFolder: 'INBOX',
    messages: rows, messagesTotal: 1, hasMoreMessages: false, loadingMessages: false,
    searchQuery: '', layout, threadedView: true, expandedThreadId: null, threadMessages: {},
    selectedMessageId: selected ? message.id : null, lastViewedMessageId: null,
    folders: { account: [{ path: 'INBOX', name: 'INBOX' }] },
  });
  await React.act(async () => {
    root = createRoot(document.getElementById('root'));
    root.render(React.createElement(MessageList));
  });
}
const pill = () => document.querySelector('[data-msgid="message"] button[aria-expanded]');
const click = async button => React.act(async () => {
  button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
});

for (const [width, layout] of [[375, 'comfortable'], [1024, 'focused'], [1024, 'comfortable']]) for (const selected of [false, true]) {
  test(`count pill names its action, stays focusable, and toggles without selecting: ${width}/${layout}, selected=${selected}`, async () => {
    await mount({ width, selected, layout });
    const button = pill();
    assert.ok(button);
    assert.equal(button.type, 'button');
    assert.equal(button.tabIndex, 0);
    await React.act(async () => button.focus());
    assert.equal(document.activeElement, button);
    const selection = useStore.getState().selectedMessageId;
    for (const [index, expanded] of [false, true, false].entries()) {
      const label = `${expanded ? 'Collapse' : 'Expand'} conversation (107 messages)`;
      assert.equal(button.title, label);
      assert.equal(button.getAttribute('aria-label'), label);
      assert.equal(button.getAttribute('aria-expanded'), String(expanded));
      assert.equal(button.textContent.trim(), '107');
      assert.equal(useStore.getState().selectedMessageId, selection);
      assert.equal(document.activeElement, button);
      if (index < 2) await click(button);
    }
  });
}

test('count is preserved in the accessible name and tooltip for bounded generated counts', async () => {
  await mount();
  const counts = [2, 5, 22, 107, '107', 10000, ...Array.from({ length: 12 }, (_, n) => 2 + (n * 7919) % 99998)];
  for (const count of counts) {
    await React.act(async () => useStore.setState({ messages: [{ ...message, message_count: count }] }));
    assert.equal(pill().title, `Expand conversation (${count} messages)`);
    assert.equal(pill().getAttribute('aria-label'), pill().title);
    assert.equal(pill().textContent.trim(), String(count));
  }
});

test('a single-message conversation has no expand control', async () => {
  await mount({ count: 1 });
  assert.equal(pill(), null);
});
