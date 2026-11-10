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

const OpenActivityPanel = (await import('./OpenActivityPanel.jsx')).default;
const MessageOpenActivity = (await import('./MessageOpenActivity.jsx')).default;
const ComposeOpenActivity = (await import('./ComposeOpenActivity.jsx')).default;
let root;
let sent, drafts;
const account = { id: 'a', email_address: 'me@mail.example', enabled: true, name: 'Me' };
const activity = { id: 'event', status: 'sent', subject: 'Owner subject', loadCount: 1, sentAt: '2026-11-10T07:00:00.000Z', expiresAt: '2026-12-10T07:00:00.000Z' };
const render = async (component, props = {}) => { await React.act(async () => root.render(React.createElement(component, props))); };
const click = async node => { assert.ok(node); await React.act(async () => node.click()); };
const checkbox = () => document.querySelector('input[type="checkbox"][aria-describedby]');
const button = text => [...document.querySelectorAll('button')].find(node => node.textContent.trim() === text);
beforeEach(() => {
  sent = []; drafts = [];
  useStore.setState({ user: { id: 'owner' }, accounts: [account], selectedAccountId: 'a', composing: false, composeData: null, prepareComposeSwitch: null, plaintextEmail: false });
  api.get = async path => path === '/open-activity/capabilities' ? { available: true } : { activity: [activity] };
  api.post = async (path, data) => { assert.equal(path, '/mail/send'); sent.push(data); return {}; };
  api.saveDraft = async data => { drafts.push(data); return { uid: 1, folder: 'Drafts' }; };
  root = createRoot(document.getElementById('root'));
});
afterEach(async () => { await React.act(async () => root.unmount()); });

test('private activity ignores late owner/account results and navigation unmounts', async () => {
  const pending = [];
  api.get = path => new Promise(resolve => pending.push({ path, resolve }));
  let back = 0;
  await render(OpenActivityPanel, { accountId: 'a', onBack: () => { back++; } });
  await render(OpenActivityPanel, { accountId: 'b', onBack: () => { back++; } });
  await React.act(async () => pending[0].resolve({ activity: [activity] }));
  assert.doesNotMatch(document.body.textContent, /Owner subject/);
  assert.equal(pending[1].path, '/open-activity?accountId=b');
  await React.act(async () => useStore.setState({ user: { id: 'other' } }));
  await React.act(async () => pending[1].resolve({ activity: [activity] }));
  assert.doesNotMatch(document.body.textContent, /Owner subject/);
  await React.act(async () => pending[2].resolve({ activity: [{ ...activity, subject: 'Other subject' }] }));
  assert.match(document.body.textContent, /Other subject/);
  await click(button('Back to mail')); assert.equal(back, 1);
  const input = document.createElement('input'); document.body.appendChild(input);
  await React.act(async () => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(back, 1); input.remove();
  await React.act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(back, 2);
});
test('activity shows honest empty/error/retry and bounded load wording', async () => {
  api.get = async () => { throw new Error('Synthetic unavailable'); };
  await render(OpenActivityPanel); assert.match(document.body.textContent, /Synthetic unavailable/);
  api.get = async () => ({ activity: [] }); await click(button('Refresh')); assert.match(document.body.textContent, /No tracked messages/);
  api.get = async () => ({ activity: [activity] }); await click(button('Refresh'));
  assert.match(document.body.textContent, /1 image load recorded/); assert.match(document.body.textContent, /not proof/);
});
test('reader ignores stale message completion and does not query incoming messages', async () => {
  const pending = [];
  api.get = path => new Promise(resolve => pending.push({ path, resolve }));
  const message = { id: 'm1', account_id: 'a', from_address: account.email_address, folder: 'Sent' };
  await render(MessageOpenActivity, { message });
  await render(MessageOpenActivity, { message: { ...message, id: 'm2' } });
  await React.act(async () => pending[0].resolve({ activity })); assert.equal(document.body.textContent, '');
  await React.act(async () => pending[1].resolve({ activity: { ...activity, loadCount: 3 } })); assert.match(document.body.textContent, /3 image loads/);
  await render(MessageOpenActivity, { message: { ...message, id: 'm3', from_address: 'incoming@mail.example', folder: 'INBOX' } });
  assert.equal(pending.length, 2); assert.equal(document.body.textContent, '');
});
test('toggle requires availability and stays disabled for plain-text; errors do not turn it on', async () => {
  let changed = 0;
  api.get = async () => ({ available: false });
  await render(ComposeOpenActivity, { checked: false, onChange: () => { changed++; }, owner: 'owner' });
  assert.equal(checkbox().disabled, true); assert.match(document.body.textContent, /public HTTPS/);
  await click(checkbox()); assert.equal(changed, 0);
  await render(ComposeOpenActivity, { checked: true, plaintextEmail: true, onChange: () => { changed++; }, owner: 'owner' });
  assert.equal(checkbox().checked, false); assert.equal(checkbox().disabled, true);
});
test('real composer sends only explicit opt-in and never saves a pixel or setting into IMAP drafts', async () => {
  useStore.getState().openCompose({ accountId: 'a', to: ['recipient@mail.example'], subject: 'Synthetic', body: '<p>Hello</p>', trackOpens: true, draftUid: 3, draftFolder: 'Drafts' });
  await render(ComposeModal);
  assert.equal(checkbox().checked, false); assert.equal(checkbox().disabled, false);
  await click(checkbox()); assert.equal(checkbox().checked, true);
  await React.act(async () => document.querySelector('.ProseMirror').editor.commands.insertContent(' updated'));
  visibility = 'hidden';
  await React.act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
  visibility = 'visible';
  assert.ok(drafts.length > 0);
  assert.ok(drafts.every(draft => !Object.hasOwn(draft, 'trackOpens') && !JSON.stringify(draft).includes('/pixel/')));
  await click(button('compose.send'));
  assert.equal(sent.length, 1); assert.equal(sent[0].trackOpens, true); assert.doesNotMatch(sent[0].body, /\/pixel\//);
});
test('new and plain-text composers always send tracking false', async () => {
  useStore.setState({ plaintextEmail: true });
  useStore.getState().openCompose({ accountId: 'a', to: ['recipient@mail.example'], subject: 'Synthetic', body: 'Hello', trackOpens: true, restored: true });
  await render(ComposeModal); assert.equal(checkbox().checked, false); assert.equal(checkbox().disabled, true);
  await click(button('compose.send')); assert.equal(sent[0].trackOpens, false);
});

test('opening tracked mail resolves native message safely and ignores navigation-away completion', async () => {
  let resolve;
  api.get = async () => ({ activity: [{ ...activity, accountId: 'a', messageId: 'm1' }] });
  api.resolveMessage = () => new Promise(done => { resolve = done; });
  let back = 0;
  await render(OpenActivityPanel, { accountId: 'a', onBack: () => { back++; } });
  await click(button('Owner subject'));
  await React.act(async () => useStore.setState({ selectedMessageId: 'newer-selection' }));
  await React.act(async () => resolve({ id: 'm1', account_id: 'a', folder: 'Sent' }));
  assert.equal(useStore.getState().selectedMessageId, 'newer-selection'); assert.equal(back, 0);
  await click(button('Owner subject'));
  await React.act(async () => resolve({ id: 'm1', account_id: 'a', folder: 'Sent' }));
  assert.equal(useStore.getState().selectedMessageId, 'm1'); assert.equal(useStore.getState().selectedFolder, 'Sent'); assert.equal(back, 1);
});
