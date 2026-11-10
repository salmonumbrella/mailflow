// Render test for the Categorize submenu's "Always for this sender / domain" (#490).
//
// The harness mirrors MessageList.render.test.js: node --test cannot parse JSX, so the loader
// hook transforms .jsx with sucrase, and react-i18next is stubbed to return the key.

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
        'export const useTranslation = () => ({ t: (k, d) => (typeof d === "string" ? d : d?.defaultValue ?? k), i18n: { language: "en", changeLanguage: () => {} } });',
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
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.matchMedia = dom.window.matchMedia;
dom.window.Element.prototype.scrollIntoView = () => {};
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}), text: async () => '{}' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');

const ContextMenu = (await import('./ContextMenu.jsx')).default;


const { api } = await import('../utils/api.js');
const { registerCollector } = await import('../plugins/registry.js');
registerCollector('context-menu-actions', { pluginId: 'independent-form', build: ctx => [{
  label: 'Independent form', keepOpen: true, hasSubmenu: true,
  action: () => ctx.openSubmenu(() => React.createElement('div', null,
    React.createElement('input', { 'aria-label': 'Nested editor' }),
    React.createElement('button', { onClick: () => ctx.onAction('formSubmit') }, 'Apply'))),
}] });
const ACCOUNT = { id: 'review-account', email_address: 'review@example.invalid', storage_generation: 'g1', enabled: true };
const MESSAGE = { id: 'review-message', account_id: ACCOUNT.id, storageGeneration: 'g1', uid: 12, folder: 'INBOX', subject: 'Review source', from_email: 'sender@example.invalid' };
let root, opener, openerContainer;
const originalApi = { ...api };
async function mount({ state = {}, props = {} } = {}) {
  useStore.setState({ user: { id: 'review-user' }, isLocked: false, layout: 'gmail', accounts: [ACCOUNT], selectedAccountId: ACCOUNT.id, selectedFolder: 'INBOX', selectedMessageId: null, searchQuery: '', activeLabel: null, nativeLabelFeed: null, messages: [MESSAGE], searchResults: [], expandedThreadId: null, threadMessages: {}, enabledPlugins: [], folders: {}, categorizationEnabled: false, ...state });
  openerContainer = document.createElement('div');
  opener = document.createElement('button');
  opener.textContent = 'Review opener'; opener.getClientRects = () => [{ width: 20, height: 20 }];
  openerContainer.append(opener); document.body.prepend(openerContainer); opener.focus();
  const result = { actions: [], closes: 0 };
  await React.act(async () => {
    root = createRoot(document.getElementById('root'));
    root.render(React.createElement(ContextMenu, { x: 10, y: 10, message: MESSAGE, onClose: () => { result.closes++; }, onAction: (...args) => result.actions.push(args), ...props }));
  });
  return result;
}
afterEach(async () => { if (root) await React.act(async () => root.unmount()); root = null; openerContainer?.remove(); Object.assign(api, originalApi); });
const command = label => [...document.querySelectorAll('[data-context-command]')].find(el => el.textContent.trim() === label);
async function key(value, options = {}, target = document.activeElement) {
  const event = new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options });
  await React.act(async () => target.dispatchEvent(event)); return event;
}
async function choose(label) {
  assert.ok(command(label), label);
  await React.act(async () => command(label).focus());
  await key('Enter');
}
for (const composing of [{ isComposing: true }, { keyCode: 229 }]) {
  test(`independent menu: IME ${JSON.stringify(composing)} cannot activate or dismiss a destructive menu command`, async () => {
    const result = await mount();
    await React.act(async () => command('contextMenu.delete').focus());
    await key('Enter', composing); await key('Escape', composing);
    assert.deepEqual(result.actions, []); assert.equal(result.closes, 0);
  });
}
test('independent menu: repeated Enter cannot execute a newly focused delete command', async () => {
  const result = await mount();
  await React.act(async () => command('contextMenu.delete').focus());
  await key('Enter', { repeat: true });
  assert.deepEqual(result.actions, []); assert.equal(result.closes, 0);
});
test('independent menu: CSS-hidden ancestor is not a valid focus restoration target', async () => {
  const result = await mount();
  openerContainer.style.display = 'none';
  await key('Escape');
  assert.equal(result.closes, 1); assert.equal(document.activeElement === opener, false);
});
test('independent menu: removing a previously visible source invalidates its still-mounted menu', async () => {
  const result = await mount();
  const retained = command('contextMenu.delete');
  await React.act(async () => useStore.setState({ messages: [] }));
  await React.act(async () => retained.click());
  assert.equal(result.closes, 1, 'a vanished source closes the menu exactly once');
  assert.deepEqual(result.actions, [], 'retained visible DOM cannot act on a vanished source');
});
test('independent menu: collapsing an expanded child invalidates its still-mounted menu', async () => {
  const parent = { ...MESSAGE, id: 'parent', thread_id: 'thread', message_count: 2 };
  const child = { ...MESSAGE, thread_id: 'thread' };
  const result = await mount({ state: { messages: [parent], expandedThreadId: 'thread', threadMessages: { thread: [child] } }, props: { message: child } });
  const retained = command('contextMenu.delete');
  await React.act(async () => useStore.setState({ expandedThreadId: null }));
  await React.act(async () => retained.click());
  assert.equal(result.closes, 1);
  assert.deepEqual(result.actions, []);
});
test('independent menu: arbitrary plugin form preserves native editing and only its own button action', async () => {
  const result = await mount({ state: { enabledPlugins: ['independent-form'] } });
  await choose('Independent form');
  const input = document.querySelector('input[aria-label="Nested editor"]');
  assert.equal(input.closest('[role="menu"]'), null);
  await React.act(async () => input.focus());
  for (const value of [' ', 'Enter', 'Home', 'End', 'ArrowLeft', 'ArrowRight']) assert.equal((await key(value)).defaultPrevented, false, value);
  assert.deepEqual(result.actions, []);
  const button = [...document.querySelectorAll('button')].find(el => el.textContent === 'Apply');
  await React.act(async () => button.click());
  assert.deepEqual(result.actions, [['formSubmit']]);
});
test('independent menu: header viewer Escape returns to its exact command before closing the menu', async () => {
  api.getMessageHeaders = async () => ({ headers: 'Subject: Review source' });
  const result = await mount();
  await choose('contextMenu.viewHeaders');
  assert.ok(document.querySelector('[role="dialog"]'));
  await key('Escape');
  assert.equal(result.closes, 0); assert.equal(document.activeElement.textContent.trim(), 'contextMenu.viewHeaders');
  await key('Escape'); assert.equal(result.closes, 1);
});
