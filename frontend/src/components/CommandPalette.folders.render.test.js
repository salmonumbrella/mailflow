import test, { after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
    return { format: 'module', shortCircuit: true, source: [
      'const t = (k, o) => k === "commandPalette.labelPicker.copyTo" ? `Translated to ${o.folder}` : k === "commandPalette.labelPicker.placeholder" ? "Translated picker" : k === "commandPalette.labelPicker.error" ? "Translated error" : o?.defaultValue ?? k; export const useTranslation = () => ({ t, i18n: { language: "en", changeLanguage() {} } });',
      'export const initReactI18next = { type: "3rdParty", init() {} };',
      'export const Trans = ({ children }) => children ?? null;',
      'export const I18nextProvider = ({ children }) => children ?? null;',
      'export default { useTranslation, initReactI18next };',
    ].join('\n') };
  }
  if (url.endsWith('.json')) {
    return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
  }
  if (url.endsWith('.jsx')) {
    const code = readFileSync(new URL(url), 'utf8');
    return { format: 'module', source: transform(code, { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url }).code, shortCircuit: true };
  }
  return nextLoad(url, context);
} });

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
dom.window.Element.prototype.scrollIntoView = () => {};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const CommandPalette = (await import('./CommandPalette.jsx')).default;
after(() => dom.window.close());


const MESSAGE = { id: 'm', account_id: 'a', folder: 'INBOX' };
const ACCOUNTS = [{ id: 'a', enabled: true }, { id: 'b', enabled: true }];
const originals = { ...api };
let root, calls, closes;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => {
  useStore.setState({ ...useStore.getInitialState(), user: { id: 'owner' }, layout: 'superhuman', accounts: ACCOUNTS,
    folders: {}, messages: [MESSAGE], selectedMessageId: MESSAGE.id });
  calls = []; closes = 0;
  root = createRoot(document.getElementById('root'));
});
afterEach(async () => { await React.act(async () => root.unmount()); Object.assign(api, originals); });
const render = (props = {}) => React.act(async () => root.render(React.createElement(CommandPalette, {
  open: true, labelPickerMessage: MESSAGE, onClose: () => { closes++; }, ...props,
})));
const key = (target, name, options = {}) => React.act(async () => target.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...options })));

test('unknown folders load on demand and permit only real ordinary-folder copy targets', async () => {
  const pending = deferred();
  api.getFolders = id => { calls.push(id); return pending.promise; };
  const copies = []; api.copyMessage = async (...args) => { copies.push(args); return { ok: true }; };
  await render();
  assert.deepEqual(calls, ['a']);
  assert.ok(document.querySelector('[role="status"]'));
  assert.equal(document.querySelectorAll('[role="option"]').length, 0);
  await render(); assert.deepEqual(calls, ['a'], 'Ordinary rerenders do not duplicate the request');
  await React.act(async () => pending.resolve([{ path: 'INBOX', name: 'Inbox' }, { path: 'Trash', special_use: '\\Trash' }, { path: 'Parent', no_select: true }, { path: 'Review copies' }]));
  const options = document.querySelectorAll('[role="option"]');
  assert.equal(options.length, 1);
  assert.match(options[0].textContent, /Review copies/);
  await React.act(async () => options[0].click());
  assert.deepEqual(copies, [['m', 'Review copies']]);
  assert.equal(closes, 1);
});

test('folder failure has a keyboard-accessible retry and retains picker focus', async () => {
  api.getFolders = async id => { calls.push(id); throw new Error('Folder lookup failed'); };
  await render();
  assert.match(document.querySelector('[role="alert"]').textContent, /Folder lookup failed/);
  const search = document.querySelector('input');
  const retry = document.querySelector('[role="alert"] button');
  await key(search, 'Tab'); assert.equal(document.activeElement, retry);
  await key(retry, 'Tab'); assert.equal(document.activeElement, search);
  await key(search, 'Tab', { shiftKey: true }); assert.equal(document.activeElement, retry);
  const pending = deferred(); api.getFolders = id => { calls.push(id); return pending.promise; };
  await key(retry, 'Enter'); assert.equal(closes, 0);
  await React.act(async () => retry.click());
  assert.deepEqual(calls, ['a', 'a']); assert.equal(document.activeElement, search);
  assert.ok(document.querySelector('[role="status"]'));
  await React.act(async () => pending.resolve([{ path: 'Review copies' }]));
  assert.equal(document.querySelector('[role="alert"]'), null);
  assert.equal(document.querySelectorAll('[role="option"]').length, 1);
});

test('dismissed, locked, disabled-account and previous-owner folder responses cannot populate the cache', async () => {
  for (const change of ['dismiss', 'lock', 'disable', 'owner', 'owner-roundtrip', 'newer-cache']) {
    await render({ open: false });
    await React.act(async () => useStore.setState({ user: { id: 'owner' }, isLocked: false, accounts: ACCOUNTS, folders: {} }));
    const pending = deferred(); api.getFolders = () => pending.promise;
    await render();
    if (change === 'dismiss') await render({ open: false });
    else await React.act(async () => {
      if (change === 'lock') useStore.setState({ isLocked: true });
      if (change === 'disable') useStore.setState({ accounts: [{ id: 'a', enabled: false }] });
      if (change.startsWith('owner')) useStore.setState({ user: { id: 'other' }, accounts: [] });
      if (change === 'owner-roundtrip') useStore.setState({ user: { id: 'owner' }, accounts: ACCOUNTS });
      if (change === 'newer-cache') useStore.getState().setFolders('a', [{ path: 'Newer folder' }]);
    });
    await React.act(async () => pending.resolve([{ path: 'Stale folder' }]));
    assert.equal(useStore.getState().folders.a?.some(folder => folder.path === 'Stale folder') || false, false, change);
  }
});

test('known empty folders do not repeatedly load or invent a copy destination', async () => {
  useStore.setState({ folders: { a: [] } });
  api.getFolders = async () => { assert.fail('Known empty folder cache must not reload on every open'); };
  await render();
  assert.equal(document.querySelectorAll('[role="option"]').length, 0);
  assert.equal(document.querySelector('[role="alert"]'), null);
});
