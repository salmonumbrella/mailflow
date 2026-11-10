import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) return { format: 'module', shortCircuit: true, source: `
      export const useTranslation = () => ({ t: (key, fallback, values = {}) => (typeof fallback === 'string' ? fallback : key).replace(/{{(\\w+)}}/g, (_, name) => values[name] ?? ''), i18n: { language: 'en', changeLanguage() {} } });
      export const initReactI18next = { type: '3rdParty', init() {} };
      export const Trans = ({ children }) => children ?? null;
      export const I18nextProvider = ({ children }) => children ?? null;
    ` };
    if (url.endsWith('.json')) return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    if (url.endsWith('.jsx')) return { format: 'module', shortCircuit: true, source: transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic' }).code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const source = readFileSync(new URL(url), 'utf8');
      if (source.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: source.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
    }
    return nextLoad(url, context);
  },
});
const dom = new JSDOM('<button id="opener">Open settings</button><div id="root"></div>', { url: 'https://mail.example.invalid/', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Event: dom.window.Event, Node: dom.window.Node,
  Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true, __VITE_ENV__: { MODE: 'test', DEV: false, PROD: true },
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = dom.window.matchMedia;
globalThis.fetch = async () => new Response('{}', { status: 200 });
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { api } = await import('../utils/api.js');
const { default: NativeLabelPicker } = await import('./NativeLabelPicker.jsx');
const { useStore } = await import('../store/index.js');
const { undoNativeLabelMemberships } = await import('../utils/nativeLabelUndo.js');
const { readPendingMembership } = await import('../utils/nativeLabelMemberships.js');
const host = document.getElementById('root');
const accountId = 'account-one', storageGeneration = 'generation-one';
const row = (id, labels = []) => ({ id, account_id: accountId, entityId: id, storageGeneration, nativeLabelState: 'available', nativeLabels: labels, folder: 'INBOX' });
let root, calls, targets, labels, saved, closed;
const button = text => [...document.querySelectorAll('button')].find(el => el.textContent === text);
const checkbox = name => [...host.querySelectorAll('label')].find(el => el.textContent === name)?.querySelector('input');
const click = el => act(async () => { assert.ok(el, 'click target exists'); el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
const props = (messages = [row('one'), row('two')]) => ({ messages, onClose: () => closed++, onSaved: payload => saved.push(payload) });
async function mount(messages) {
  root = createRoot(host);
  await act(async () => root.render(React.createElement(NativeLabelPicker, props(messages))));
}
beforeEach(() => {
  calls = []; saved = []; closed = 0; window.sessionStorage.clear();
  useStore.setState({ accounts: [{ id: accountId, storage_generation: storageGeneration }], folders: {}, notifications: [] });
  labels = [{ id: 'work', name: 'Work', path: 'Work', messageVisible: true }, { id: 'child', name: 'Child', path: 'Work/Child', parentId: 'work', messageVisible: true }];
  targets = [{ requestedEntityId: 'one', entityId: 'one', metadataVersion: '9007199254740993', available: true, labelIds: ['work'] },
    { requestedEntityId: 'two', entityId: 'two', metadataVersion: '9007199254740994', available: true, labelIds: [] }];
  api.getNativeLabels = async () => ({ accountId, storageGeneration, labels });
  api.queryNativeLabelMemberships = async scope => { calls.push(['query', structuredClone(scope)]); return { accountId: scope.accountId, storageGeneration: scope.storageGeneration, targets: targets.filter(t => scope.targets.some(s => s.entityId === t.requestedEntityId)) }; };
  api.mutateNativeLabelMemberships = async payload => { calls.push(['mutate', structuredClone(payload)]); return { ...payload, targets: [] }; };
  for (const method of ['copyMessage', 'moveMessage', 'createFolder', 'gtdClassify']) api[method] = () => { throw new Error('No provider or GTD side effects allowed'); };
});
afterEach(async () => { if (root) await act(async () => root.unmount()); root = null; });


test('changing a verified selection to a draft cannot apply the old selection snapshot', async () => {
  await mount([row('one')]);
  assert.ok(checkbox('Work'), 'verified source loaded');
  await act(async () => root.render(React.createElement(NativeLabelPicker, props([{ ...row('draft'), is_draft: true }]))));
  assert.match(host.textContent, /Labels on drafts are not supported/);
  const staleOption = checkbox('Work/Child');
  if (staleOption && !staleOption.disabled) await click(staleOption);
  const apply = button('Apply');
  if (apply && !apply.disabled) await click(apply);
  assert.equal(calls.filter(call => call[0] === 'mutate').length, 0, 'an unavailable new selection must never mutate the previous message');
  assert.ok(!staleOption || staleOption.disabled, 'old selection options must be cleared or disabled');
});

test('uncertain Undo retains exact request, then clears only on a confirmed terminal conflict', async () => {
  const payload = { accountId, storageGeneration, originalMutationId: 'forward-token', mutationId: 'undo-token' };
  const requests = [];
  api.undoNativeLabelMemberships = async request => { requests.push(structuredClone(request)); throw new Error('Lost response'); };
  await undoNativeLabelMemberships(payload);
  assert.deepEqual(readPendingMembership(accountId), payload);
  api.undoNativeLabelMemberships = async request => { requests.push(structuredClone(request)); throw Object.assign(new Error('Touched label was deleted'), { status: 409, code: 'undo_unavailable' }); };
  await undoNativeLabelMemberships(payload, true);
  assert.deepEqual(requests, [payload, payload]);
  assert.equal(readPendingMembership(accountId), null);
  assert.match(useStore.getState().notifications.find(item => item.title === 'Labels could not be undone').body, /Later changes were not overwritten/);
});

test('late Undo response never posts its notification into a different user session', async () => {
  useStore.setState({ user: { id: 'first-user' } });
  let finish;
  api.undoNativeLabelMemberships = () => new Promise(resolve => { finish = resolve; });
  const pending = undoNativeLabelMemberships({ accountId, storageGeneration, originalMutationId: 'forward-token', mutationId: 'undo-token' });
  useStore.setState({ user: { id: 'second-user' }, notifications: [] });
  finish({ undoSupported: false }); await pending;
  assert.deepEqual(useStore.getState().notifications, []);
});
