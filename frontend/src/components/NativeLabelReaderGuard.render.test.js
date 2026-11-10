// Render test for MessagePane.
//
// Every other frontend test covers a .js util. This one mounts the actual component, because
// the AI-run changes (#428) live in its effects and its refs, and a unit test of the registry
// cannot tell you the component still mounts, still re-renders when you change message, and
// still leaves in-flight runs alone. Those are exactly the ways that change could regress.
//
// node --test cannot parse JSX, so the loader hook below transforms .jsx with sucrase, which is
// already present via the build toolchain. react-i18next is stubbed because the component only
// needs t() to return something; wiring a real i18n instance would test i18next, not this.

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
        // A {{label}} value is shown in brackets, so a test can see which text a string wraps.
        'export const useTranslation = () => ({ t: (k, o) => (o && o.label !== undefined ? k + "[" + o.label + "]" : k), i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export const Trans = ({ children }) => children ?? null;',
        'export const I18nextProvider = ({ children }) => children ?? null;',
        'export default { useTranslation, initReactI18next };',
      ].join("\n") };
    }
    // pdf.js needs a real browser; the viewer tests drive this stand-in through globalThis.__pdfStub.
    if (url.endsWith('/src/utils/pdfDocument.js')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const openPdf = (bytes, options) => globalThis.__pdfStub.openPdf(bytes, options);',
        'export const renderPage = () => ({ done: Promise.resolve(), cancel() {} });',
        'export const renderPagesForPrint = async () => [];',
      ].join("\n") };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    // import.meta.env is Vite's; Node has no equivalent, so point it at a stub object.
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
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  MutationObserver: dom.window.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
});
// jsdom implements neither of these, and the component asks the window for both.
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { aiRuns } = await import('../utils/aiRunRegistry.js');
const { api } = await import('../utils/api.js');
const { shortcutBus } = await import('../utils/shortcutBus.js');
const MessagePane = (await import('./MessagePane.jsx')).default;

const { default: ConversationMessageCard } = await import('./ConversationMessageCard.jsx');
const { applyMarkRead, scheduleMarkRead, scheduleMarkReadTimer } = await import('../utils/markRead.js');
const { labelViewKey } = await import('../utils/nativeLabelNavigation.js');
const { bodyCache } = await import('../utils/bodyCache.js');
const view = { accountId: 'acct', storageGeneration: 'gen', labelId: 'work' };
const row = { id: 'retained', account_id: 'acct', folder: 'INBOX', uid: 1, subject: 'Retained readable message', from_email: 'x@y.z', date: new Date().toISOString(), is_read: true, to_addresses: [], cc_addresses: [], entityId: 'entity', storageGeneration: 'gen', nativeLabelState: 'available', nativeLabels: [] };
let root, writes;
const host = document.getElementById('root');
const click = selector => React.act(async () => { const element = host.querySelector(selector); assert.ok(element, selector); element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })); });
const setStatus = status => React.act(async () => useStore.setState({ nativeLabelFeed: { key: labelViewKey(view), status } }));
beforeEach(() => {
  writes = []; bodyCache.clear();
  useStore.setState({ user: { id: 'u1' }, layout: 'gmail', accounts: [{ id: 'acct', enabled: true, storage_generation: 'gen', email_address: 'me@example.com' }], folders: {},
    messages: [row], searchResults: [], searchQuery: '', threadMessages: {}, selectedMessageId: row.id,
    activeLabel: view, nativeLabelFeed: { key: labelViewKey(view), status: 'ready' }, notifications: [], markReadBehavior: 'manual', composing: false, composeData: null });
  api.getMessageBody = async () => ({ text: 'Already loaded body', attachments: [] });
  api.markStarred = async (...args) => { writes.push(['star', ...args]); return {}; };
  api.bulkRead = async (...args) => { writes.push(['read', ...args]); return {}; };
  api.bulkArchive = async (...args) => { writes.push(['archive', ...args]); return {}; };
  api.deleteMessage = async (...args) => { writes.push(['delete', ...args]); return {}; };
  api.queryNativeLabelMemberships = async () => { writes.push(['query']); return {}; };
  root = createRoot(host);
});
afterEach(async () => { await React.act(async () => root.unmount()); aiRuns.abortAll(); });

for (const status of ['loading', 'error']) test(`retained reader stays open but pointer, keyboard and labels cannot mutate during ${status}`, async () => {
  await React.act(async () => root.render(React.createElement(MessagePane)));
  await setStatus(status);
  assert.match(host.textContent, /Retained readable message/); assert.match(host.textContent, /gmail.memberships.readerPaused/);
  await click('[aria-label="message.star"]'); await click('[aria-label="message.archive"]'); await click('[aria-label="message.delete"]');
  await React.act(async () => { shortcutBus.emit('toggleStar'); shortcutBus.emit('reply'); shortcutBus.emit('replyAll'); });
  assert.equal(useStore.getState().selectedMessageId, row.id); assert.equal(useStore.getState().composing, false); assert.deepEqual(writes, []);
  const labels = host.querySelector('.mf-native-label-edit'); assert.ok(labels.disabled);
  await setStatus('ready'); await click('[aria-label="message.star"]'); assert.equal(writes.length, 1); assert.equal(writes[0][0], 'star');
});

test('stale reader opening and already-scheduled automatic reads cannot mutate optimistic or server flags', async () => {
  useStore.setState({ markReadBehavior: 'immediate', messages: [{ ...row, is_read: false }], nativeLabelFeed: { key: labelViewKey(view), status: 'error' } });
  await React.act(async () => root.render(React.createElement(MessagePane)));
  applyMarkRead({ ...row, is_read: false }); assert.equal(scheduleMarkRead({ ...row, is_read: false }), null);
  let fired = false; scheduleMarkReadTimer(row.id, () => { fired = true; applyMarkRead({ ...row, is_read: false }); }, 0);
  await React.act(async () => new Promise(resolve => setTimeout(resolve, 10)));
  assert.equal(fired, false); assert.deepEqual(writes, []); assert.equal(useStore.getState().messages[0].is_read, false);
  assert.equal(useStore.getState().selectedMessageId, row.id);
});

test('Back remains available from the retained reader without a mail mutation', async () => {
  await setStatus('error'); await React.act(async () => root.render(React.createElement(MessagePane)));
  await click('[data-native-label-safe]'); assert.equal(useStore.getState().selectedMessageId, null); assert.deepEqual(writes, []);
});

test('conversation-card flags and tools are blocked without collapsing its loaded body', async () => {
  let updates = 0;
  await React.act(async () => root.render(React.createElement(ConversationMessageCard, { message: row, expanded: true, selected: true, onToggle() {}, onUpdate() { updates++; }, onDelete() { writes.push(['delete']); } })));
  await setStatus('error');
  const buttons = [...host.querySelectorAll('button')];
  for (const button of buttons.filter(button => ['message.star', 'message.delete'].includes(button.getAttribute('aria-label')))) await React.act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })));
  await React.act(async () => { shortcutBus.emit('unsubscribe'); shortcutBus.emit('loadRemoteImages'); });
  assert.equal(host.querySelector('.mailflow-conversation-card').dataset.expanded, 'true'); assert.equal(updates, 0); assert.deepEqual(writes, []);
});

test('ordinary readers ignore an unrelated native-feed error after leaving the label view', async () => {
  useStore.setState({ activeLabel: null, nativeLabelFeed: { key: labelViewKey(view), status: 'error' } });
  await React.act(async () => root.render(React.createElement(MessagePane))); await click('[aria-label="message.star"]');
  assert.equal(writes[0][0], 'star'); assert.doesNotMatch(host.textContent, /gmail.memberships.readerPaused/);
});

test('a confirmation already open when verification fails is dismissed without deleting or closing the reader', async () => {
  useStore.setState({ messages: [{ ...row, folder: 'Trash' }], folders: { acct: [{ path: 'Trash', special_use: '\\Trash' }] } });
  await React.act(async () => root.render(React.createElement(MessagePane)));
  await click('[aria-label="gmailReader.deletePermanently"]'); assert.ok(document.querySelector('[role=alertdialog]'));
  await setStatus('error'); assert.equal(document.querySelector('[role=alertdialog]'), null);
  assert.equal(useStore.getState().selectedMessageId, row.id); assert.deepEqual(writes, []);
});

test('ready verification resumes a retained reader read from the current matching entity only', async () => {
  const unread = { ...row, is_read: false };
  useStore.setState({ messages: [unread], markReadBehavior: 'immediate', nativeLabelFeed: { key: labelViewKey(view), status: 'error' } });
  await React.act(async () => root.render(React.createElement(MessagePane))); assert.deepEqual(writes, []);
  await React.act(async () => useStore.setState({ messages: [{ ...unread, folder: 'Archive', uid: 99 }], nativeLabelFeed: { key: labelViewKey(view), status: 'ready' } }));
  assert.deepEqual(writes, [['read', [row.id], true]]); assert.equal(useStore.getState().messages[0].is_read, true);
});

test('ready verification never resumes a retained reader on a replacement entity with the same cache ID', async () => {
  useStore.setState({ messages: [{ ...row, is_read: false }], markReadBehavior: 'immediate', nativeLabelFeed: { key: labelViewKey(view), status: 'error' } });
  await React.act(async () => root.render(React.createElement(MessagePane)));
  await React.act(async () => useStore.setState({ messages: [{ ...row, is_read: false, entityId: 'replacement' }], nativeLabelFeed: { key: labelViewKey(view), status: 'ready' } }));
  assert.deepEqual(writes, []); assert.equal(useStore.getState().messages[0].is_read, false);
});

test('a conversation card opened while blocked can automatically read its fresh verified message after ready', async () => {
  const unread = { ...row, is_read: false }; const updates = [];
  useStore.setState({ messages: [unread], markReadBehavior: 'immediate', nativeLabelFeed: { key: labelViewKey(view), status: 'error' } });
  await React.act(async () => root.render(React.createElement(ConversationMessageCard, { message: unread, expanded: true, selected: true, onToggle() {}, onUpdate: (...args) => updates.push(args) })));
  assert.deepEqual(writes, []); await setStatus('ready'); assert.deepEqual(writes, [['read', [row.id], true]]); assert.equal(updates[0][1].is_read, true);
});
