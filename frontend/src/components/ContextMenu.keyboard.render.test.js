// Keyboard-only integration for the opt-in Superhuman message-action picker.
//
// The harness mirrors MessageList.render.test.js: node --test cannot parse JSX, so the loader
// hook transforms .jsx with sucrase, and react-i18next is stubbed to return the key.

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
const ACCOUNT = { id: 'a', enabled: true };
const MESSAGE = { id: 'm', account_id: 'a', folder: 'INBOX', from_email: 'sender@example.test', subject: 'Subject', is_read: true };
const originalFolders = api.getFolders;
let root, trigger, calls, closes;
beforeEach(() => {
  useStore.setState({ ...useStore.getInitialState(), accounts: [ACCOUNT], folders: {}, enabledPlugins: [] });
  api.getFolders = async () => [{ path: 'Projects', name: 'Projects' }, { path: 'Work', name: 'Work' }];
  trigger = document.createElement('button');
  document.body.append(trigger);
  trigger.focus();
  calls = []; closes = 0;
  root = createRoot(document.getElementById('root'));
});
afterEach(async () => {
  await React.act(async () => root.unmount());
  trigger.remove();
  api.getFolders = originalFolders;
});
async function mount(props = {}) {
  function Harness() {
    const [open, setOpen] = React.useState(true);
    return open ? React.createElement(ContextMenu, {
      keyboardNavigation: true, x: 10, y: 10, message: MESSAGE,
      onAction: (...args) => calls.push(args), onClose: () => { closes++; setOpen(false); }, ...props,
    }) : null;
  }
  await React.act(async () => root.render(React.createElement(Harness)));
}
async function key(key, options = {}) {
  const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  await React.act(async () => document.activeElement.dispatchEvent(event));
  return event;
}
const choice = text => [...document.querySelectorAll('button')].find(button => button.textContent.includes(text));

test('keyboard snooze uses native buttons, arrows and Enter exactly once', async () => {
  await mount({ defaultSnoozeView: true });
  assert.ok(choice('contextMenu.snooze.threeHours'));
  assert.ok(document.activeElement === choice('contextMenu.snooze.label'), 'expected keyboard focus');
  await key('ArrowDown');
  assert.ok(document.activeElement === choice('contextMenu.snooze.threeHours'), 'expected keyboard focus');
  await key('Enter');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'snooze');
  assert.ok(new Date(calls[0][1]) > new Date());
  assert.equal(closes, 1);
  assert.ok(document.activeElement === trigger, 'expected keyboard focus');
});

test('keyboard move leaves typing intact then arrows and Space choose a real folder', async () => {
  await mount({ defaultMoveView: true });
  const search = document.querySelector('input');
  assert.ok(document.activeElement === search, 'expected keyboard focus');
  assert.equal((await key('Home')).defaultPrevented, false, 'Home remains a text cursor key');
  await key('ArrowDown');
  assert.ok(document.activeElement === choice('Projects'), 'expected keyboard focus');
  await key('ArrowDown');
  assert.ok(document.activeElement === choice('Work'), 'expected keyboard focus');
  await key(' ');
  assert.deepEqual(calls, [['moveTo', 'Work']]);
  assert.equal(closes, 1);
  assert.ok(document.activeElement === trigger, 'expected keyboard focus');
});

test('keyboard picker traps Tab, supports Home/End and restores focus on Escape', async () => {
  await mount({ defaultSnoozeView: true });
  await key('End');
  const last = choice('contextMenu.snooze.custom');
  assert.ok(document.activeElement === last, 'expected keyboard focus');
  await key('Tab');
  assert.ok(document.activeElement === choice('contextMenu.snooze.label'), 'expected keyboard focus');
  await key('Tab', { shiftKey: true });
  assert.ok(document.activeElement === last, 'expected keyboard focus');
  await key('Home');
  assert.ok(document.activeElement === choice('contextMenu.snooze.label'), 'expected keyboard focus');
  await key('Escape');
  assert.equal(closes, 1);
  assert.equal(calls.length, 0);
  assert.ok(document.activeElement === trigger, 'expected keyboard focus');
});

test('IME and held activation keys never execute a picker choice', async () => {
  await mount({ defaultSnoozeView: true });
  await key('ArrowDown');
  await key('Enter', { isComposing: true });
  await key('Enter', { keyCode: 229 });
  await key('Enter', { repeat: true });
  await key(' ', { repeat: true });
  assert.equal(calls.length, 0);
  assert.equal(closes, 0);
});

test('custom snooze keeps native date/time input keys and exposes its submit control', async () => {
  await mount({ defaultSnoozeView: true });
  await key('End');
  await key('Enter');
  const date = document.querySelector('input[type="date"]');
  const time = document.querySelector('input[type="time"]');
  assert.ok(date && time);
  assert.ok(document.activeElement === date, 'expected keyboard focus');
  assert.equal((await key('ArrowUp')).defaultPrevented, false);
  assert.equal((await key('Home')).defaultPrevented, false);
  const submit = [...document.querySelectorAll('#root button')].at(-1);
  await React.act(async () => submit.focus());
  await key('Enter');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'snooze');
  assert.equal(closes, 1);
});

test('without opt-in the pointer menu retains its existing DOM and behavior', async () => {
  await mount({ keyboardNavigation: false, defaultSnoozeView: true });
  assert.equal(choice('contextMenu.snooze.threeHours'), undefined);
  assert.ok(document.activeElement === trigger, 'expected keyboard focus');
  const row = [...document.querySelectorAll('div')].find(el => [...el.childNodes].some(node => node.nodeType === 3 && node.textContent.trim() === 'contextMenu.snooze.threeHours'));
  await React.act(async () => row.click());
  assert.equal(calls[0][0], 'snooze');
});
