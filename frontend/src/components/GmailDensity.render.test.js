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
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
// useMobile reads the per-scenario window.innerWidth before subscribing.
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.matchMedia = dom.window.matchMedia;
dom.window.Element.prototype.scrollIntoView = () => {};
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
// MessageList refetches on mount, so its fixture must also be served by fetch.
let SERVED = [];
const CALLS = [];
globalThis.fetch = async (url, opts = {}) => {
  const path = String(url);
  let sent = null;
  try { sent = typeof opts.body === 'string' ? JSON.parse(opts.body) : null; } catch { /* not JSON */ }
  CALLS.push({ path, method: opts.method || 'GET', body: sent });
  const body = path.includes('/mail/messages?') ? { messages: SERVED, total: SERVED.length } : {};
  return { ok: true, status: 200, headers: { get: name => /content-type/i.test(name) ? 'application/json' : null }, json: async () => body, text: async () => JSON.stringify(body) };
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const MessageList = (await import('./MessageList.jsx')).default;

const ACCOUNT = { id: 'acct-density', email_address: 'density@example.invalid', name: 'Density', color: '#6366f1', include_in_unified_inbox: true };
const MESSAGE = {
  id: 'message-density', account_id: ACCOUNT.id, folder: 'INBOX', uid: 1,
  subject: 'Keep this subject', snippet: 'Keep this preview', message_id: '<density@example.invalid>',
  from_name: 'Density Sender', from_email: 'sender@example.invalid', date: '2026-11-10T12:00:00Z',
  is_read: false, is_starred: false, is_deleted: false, has_attachments: true,
};
const THREAD = { ...MESSAGE, thread_id: 'density-thread', message_count: 2, unread_count: 1 };
const SUBMESSAGE = { ...MESSAGE, id: 'density-child', uid: 2, subject: 'Expanded child', snippet: 'Expanded preview', is_read: true };
let root;

api.savePreferencesOnExit = () => {};
api.getGmailDensity = async () => ({ gmailDensity: 'default', gmailDensityRevision: 0 });
api.saveGmailDensity = async ({ gmailDensity, expectedRevision }) => ({ ok: true, gmailDensity, gmailDensityRevision: expectedRevision + 1 });
afterEach(async () => {
  if (root) await React.act(async () => root.unmount());
  root = null;
  window.dispatchEvent(new window.Event('pagehide'));
});

async function mount({ width, threadedView, previews = true }) {
  window.innerWidth = width;
  SERVED = [threadedView ? THREAD : MESSAGE];
  useStore.setState({
    user: { id: 'density-user' }, isLocked: false,
    accounts: [ACCOUNT], accountsReady: true, selectedAccountId: ACCOUNT.id, selectedFolder: 'INBOX',
    messages: SERVED, messagesTotal: 1, hasMoreMessages: false, loadingMessages: false,
    searchQuery: '', threadedView, selectedMessageId: null, activeGtdTab: null, gtdSections: null,
    threadMessages: { 'density-thread': [MESSAGE, SUBMESSAGE] }, loadingThread: null,
    showMessagePreviews: previews, enabledPlugins: [], showMobileAvatars: false,
    folders: { [ACCOUNT.id]: [{ path: 'INBOX', name: 'INBOX' }] },
  });
  useStore.getState().setLayout('gmail');
  await React.act(async () => {
    root = createRoot(document.getElementById('root'));
    root.render(React.createElement(MessageList));
  });
}

// jsdom proves hooks and retained content, not rendered pixel measurements.
for (const width of [390, 700, 701, 768, 1024]) {
  for (const threadedView of [false, true]) {
    test(`Gmail density keeps ${threadedView ? 'thread' : 'flat'} row content and native controls at ${width}px`, async () => {
      await mount({ width, threadedView });
      const row = document.querySelector('.mailflow-message-row');
      const wrapper = document.querySelector(`[data-msgid="${MESSAGE.id}"]`);
      const content = row.querySelector('.mailflow-row-content');
      const checkbox = row.querySelector('.mailflow-gmail-row-controls > input');
      assert.ok(row && content && wrapper);
      assert.equal(Boolean(row.querySelector('.mailflow-row-main')), !threadedView, 'flat rows have the extra flex wrapper');
      assert.equal(Boolean(checkbox), width >= 768, 'native mobile control policy is unchanged');
      assert.ok(wrapper.matches(threadedView
        ? '.mailflow-message-list [data-msgid]:has(> div > .mailflow-message-row)'
        : '.mailflow-message-list [data-msgid]:has(> .mailflow-message-row)'), 'separator selector matches the real outer wrapper');
      assert.ok(row.querySelector('.mailflow-row-sender > div:last-child'), 'date and attachment indicator remain');
      const preview = content.querySelector('.mailflow-row-preview');
      const subject = content.querySelector('.mailflow-row-subject');
      if (checkbox) await React.act(async () => checkbox.click());
      const checked = row.dataset.checked;
      const requestsBefore = CALLS.filter(call => call.method !== 'GET').length;
      for (const density of ['compact', 'comfortable', 'default', 'compact']) {
        await React.act(async () => useStore.getState().setGmailDensity(density));
        assert.equal(document.documentElement.dataset.gmailDensity, density);
        assert.equal(useStore.getState().layout, 'gmail');
        assert.equal(document.querySelector('.mailflow-message-row'), row, 'density does not remount the row');
        assert.equal(row.querySelector('.mailflow-row-content'), content);
        assert.equal(content.querySelector('.mailflow-row-preview'), preview);
        assert.match(preview.textContent, /Keep this preview/);
        assert.match(subject.textContent, /Keep this subject/);
        assert.equal(row.dataset.checked, checked, 'density preserves checked selection');
        assert.equal(row.querySelector('.mailflow-gmail-row-controls > input'), checkbox);
      }
      assert.equal(CALLS.filter(call => call.method !== 'GET').length, requestsBefore, 'density never mutates provider mail');
    });
  }
}

for (const previews of [true, false]) {
  test(`expanded thread children consume density with previews ${previews ? 'on' : 'off'}`, async () => {
    await mount({ width: 1024, threadedView: true, previews });
    const toggle = document.querySelector('.mailflow-row-sender button[aria-expanded]');
    assert.ok(toggle);
    await React.act(async () => toggle.click());
    const children = [...document.querySelectorAll('.mailflow-thread-message-row')];
    assert.equal(children.length, 2);
    const child = children[1];
    assert.ok(child.querySelector('.mailflow-thread-message-content > .mailflow-thread-message-sender'));
    assert.equal(Boolean(child.querySelector('.mailflow-thread-message-preview')), previews);
    for (const density of ['default', 'compact', 'comfortable']) {
      await React.act(async () => useStore.getState().setGmailDensity(density));
      assert.equal(document.querySelectorAll('.mailflow-thread-message-row')[1], child);
      assert.equal(toggle.getAttribute('aria-expanded'), 'true');
      assert.equal(useStore.getState().threadMessages['density-thread'][1], SUBMESSAGE);
    }
    await React.act(async () => child.click());
    assert.equal(useStore.getState().selectedMessageId, SUBMESSAGE.id, 'expanded child remains selectable');
    await React.act(async () => useStore.getState().setLayout('comfortable'));
    assert.equal(document.documentElement.dataset.mailflowLayout, 'comfortable');
    assert.equal(document.querySelectorAll('.mailflow-thread-message-row')[1], child, 'layout exit preserves expanded content');
  });
}
