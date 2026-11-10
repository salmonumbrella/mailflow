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
const { default: NativeLabelChips } = await import('./NativeLabelChips.jsx');
const { useStore } = await import('../store/index.js');
const { offerNativeLabelUndo, undoNativeLabelMemberships } = await import('../utils/nativeLabelUndo.js');
const host = document.getElementById('root');
const accountId = 'account-one', storageGeneration = 'generation-one';
const row = (id, labels = []) => ({ id, account_id: accountId, entityId: id, storageGeneration, nativeLabelState: 'available', nativeLabels: labels, folder: 'INBOX' });
let root, calls, targets, labels, saved, closed;
const button = text => [...document.querySelectorAll('button')].find(el => el.textContent === text);
const checkbox = name => [...host.querySelectorAll('label')].find(el => el.textContent === name)?.querySelector('input');
const click = el => act(async () => { assert.ok(el, 'click target exists'); el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
const key = name => act(async () => { document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })); });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
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

test('mixed state stages a precise add/remove delta with string versions and no conversation expansion', async () => {
  await mount();
  assert.equal(checkbox('Work').indeterminate, true);
  assert.equal(checkbox('Work').getAttribute('aria-checked'), 'mixed');
  assert.match(host.textContent, /2 selected message\(s\), not entire conversations/);
  await click(checkbox('Work')); await click(checkbox('Work')); await click(checkbox('Work/Child'));
  assert.equal(calls.filter(c => c[0] === 'mutate').length, 0);
  await click(button('Apply'));
  const payload = calls.find(c => c[0] === 'mutate')[1];
  assert.deepEqual(payload.addLabelIds, ['child']); assert.deepEqual(payload.removeLabelIds, ['work']);
  assert.deepEqual(payload.targets, targets.map(t => ({ entityId: t.entityId, expectedMetadataVersion: t.metadataVersion })));
  assert.equal(payload.storageGeneration, storageGeneration); assert.equal(saved.length, 1);
  assert.equal(window.sessionStorage.length, 0);
  assert.ok(calls.filter(c => c[0] === 'query').length >= 2, 'replay body is not used as current metadata');
});

test('cancel and Escape discard local edits without a request, keyboard navigation works', async () => {
  await mount(); assert.equal(document.activeElement.getAttribute('aria-label'), 'Search labels');
  await key('ArrowDown'); assert.equal(document.activeElement, checkbox('Work'));
  await click(checkbox('Work')); await click(button('Cancel')); await key('Escape');
  assert.equal(closed, 2); assert.equal(calls.filter(c => c[0] === 'mutate').length, 0);
});

test('uncertain save survives remount and retries the identical payload; middleware refusal retains recovery', async () => {
  api.mutateNativeLabelMemberships = async payload => { calls.push(['mutate', structuredClone(payload)]); throw new Error('Lost response'); };
  await mount(); await click(checkbox('Work')); await click(button('Apply'));
  assert.match(host.textContent, /save outcome is unknown/); const original = calls.find(c => c[0] === 'mutate')[1];
  await act(async () => root.unmount()); root = null; await mount([row('two')]);
  assert.match(host.textContent, /earlier selection/);
  api.mutateNativeLabelMemberships = async payload => { calls.push(['mutate', structuredClone(payload)]); throw Object.assign(new Error('Locked'), { status: 423 }); };
  await click(button('Verify pending label change')); assert.equal(window.sessionStorage.length, 1);
  api.mutateNativeLabelMemberships = async payload => { calls.push(['mutate', structuredClone(payload)]); return { accountId, storageGeneration, targets: [] }; };
  await click(button('Verify pending label change'));
  for (const call of calls.filter(c => c[0] === 'mutate')) assert.deepEqual(call[1], original);
  assert.equal(window.sessionStorage.length, 0); assert.equal(saved.length, 1);
});

test('repeated apply is locked before network settlement and Close keeps pending recovery', async () => {
  const wait = deferred(); api.mutateNativeLabelMemberships = payload => { calls.push(['mutate', payload]); return wait.promise; };
  await mount(); await click(checkbox('Work')); await click(button('Apply')); await click(button('Saving…'));
  assert.equal(calls.filter(c => c[0] === 'mutate').length, 1); await click(button('Close')); assert.equal(closed, 1);
  await act(async () => root.unmount()); root = null;
  await act(async () => wait.reject(new Error('Lost response')));
  assert.equal(window.sessionStorage.length, 1);
});

test('metadata conflict refreshes, discards staged edits, and requires another explicit Apply', async () => {
  api.mutateNativeLabelMemberships = async payload => { calls.push(['mutate', payload]); targets = targets.map(t => ({ ...t, metadataVersion: '9007199254740999', labelIds: [] })); throw Object.assign(new Error('Stale'), { status: 409, code: 'stale_metadata_version' }); };
  await mount(); await click(checkbox('Work')); await click(button('Apply'));
  assert.match(host.textContent, /Review the refreshed selection/); assert.equal(button('Apply').disabled, true);
  assert.equal(checkbox('Work').checked, false); assert.equal(window.sessionStorage.length, 0);
  api.mutateNativeLabelMemberships = async payload => { calls.push(['mutate', payload]); return {}; };
  await click(checkbox('Work/Child')); await click(button('Apply'));
  assert.equal(calls.filter(c => c[0] === 'mutate').at(-1)[1].targets[0].expectedMetadataVersion, '9007199254740999');
});

test('unverified, cross-account and draft selection never queries or mutates membership', async () => {
  for (const rows of [[{ ...row('one'), nativeLabelState: 'unavailable' }], [row('one'), { ...row('two'), account_id: 'other' }], [{ ...row('one'), is_draft: true }]]) {
    await mount(rows); assert.ok(host.querySelector('[role=alert]')); assert.equal(button('Apply').disabled, true);
    await act(async () => root.unmount()); root = null;
  }
  assert.equal(calls.length, 0);
});

test('late query after account switch cannot populate the newer picker', async () => {
  const wait = deferred(); const original = api.queryNativeLabelMemberships;
  api.queryNativeLabelMemberships = scope => scope.targets[0].entityId === 'one' ? wait.promise : original(scope);
  await mount([row('one')]);
  await act(async () => root.render(React.createElement(NativeLabelPicker, props([row('two')]))));
  await act(async () => wait.resolve({ accountId, storageGeneration, targets: [targets[0]] }));
  assert.equal(checkbox('Work').checked, false); assert.equal(checkbox('Work').indeterminate, false);
});

test('account generation replacement while request is pending cannot patch or save new scope', async () => {
  const wait = deferred(); api.mutateNativeLabelMemberships = payload => { calls.push(['mutate', payload]); return wait.promise; };
  await mount(); await click(checkbox('Work')); await click(button('Apply'));
  await act(async () => useStore.setState({ accounts: [{ id: accountId, storage_generation: 'new-generation' }] }));
  await act(async () => wait.resolve({ accountId, storageGeneration, targets: [] }));
  assert.equal(saved.length, 0); assert.match(host.textContent, /account changed/); assert.equal(button('Apply').disabled, true);
});

test('chips honor visibility/color/path and navigate exact account and generation', async () => {
  const routes = []; useStore.setState({ setActiveLabel: target => routes.push(target) });
  root = createRoot(host);
  await act(async () => root.render(React.createElement(NativeLabelChips, { message: row('one', [{ ...labels[1], color: '#123456', textColor: '#ffffff' }, { ...labels[0], messageVisible: false }]) })));
  assert.equal(host.querySelectorAll('.mf-native-message-label').length, 1);
  assert.equal(host.querySelector('.mf-native-message-label').style.backgroundColor, 'rgb(18, 52, 86)');
  await click(button('Work/Child')); assert.deepEqual(routes, [{ accountId, storageGeneration, labelId: 'child' }]);
});

test('reader chip removal submits one version-checked message after verifying current membership', async () => {
  root = createRoot(host);
  await act(async () => root.render(React.createElement(NativeLabelChips, { message: row('one', [labels[0]]), editable: true })));
  await click(host.querySelector('[aria-label="Remove Work from this message"]'));
  assert.equal(calls.find(c => c[0] === 'mutate')[1].targets.length, 1);
  assert.equal(document.querySelector('dialog'), null);
  assert.deepEqual(calls.find(c => c[0] === 'mutate')[1].removeLabelIds, ['work']);
});

test('canonical aliases are submitted only once with exact metadata version', async () => {
  targets[1] = { ...targets[0], requestedEntityId: 'two' };
  await mount(); await click(checkbox('Work/Child')); await click(button('Apply'));
  assert.deepEqual(calls.find(c => c[0] === 'mutate')[1].targets, [{ entityId: 'one', expectedMetadataVersion: '9007199254740993' }]);
});

test('definition scope mismatch refuses edits even when membership query is valid', async () => {
  api.getNativeLabels = async () => ({ accountId: 'other-account', storageGeneration, labels });
  await mount(); assert.match(host.textContent, /could not be verified/); assert.equal(button('Apply').disabled, true);
});

test('reader refresh marks stale labels unavailable and rejects responses from a former message', async () => {
  root = createRoot(host);
  const first = row('one', [labels[0]]), second = row('two', [labels[1]]), wait = deferred();
  api.getMessage = () => wait.promise;
  await act(async () => root.render(React.createElement(NativeLabelChips, { message: first, editable: true })));
  await act(async () => window.dispatchEvent(new CustomEvent('mailflow:native-labels-changed', { detail: { accountId, storageGeneration } })));
  assert.match(host.textContent, /Labels unavailable/);
  await act(async () => root.render(React.createElement(NativeLabelChips, { message: second, editable: true })));
  await act(async () => wait.resolve({ ...first, nativeLabels: [{ ...labels[0], name: 'Stale', path: 'Stale' }] }));
  assert.match(host.textContent, /Work\/Child/); assert.doesNotMatch(host.textContent, /Stale/);
  api.getMessage = async () => ({ ...second, nativeLabels: [{ ...labels[1], name: 'Renamed', path: 'Work/Renamed' }] });
  await act(async () => window.dispatchEvent(new CustomEvent('mailflow:native-labels-changed', { detail: { accountId, storageGeneration } })));
  assert.match(host.textContent, /Work\/Renamed/);
});

test('session-storage failure refuses mutation rather than losing the recovery token', async () => {
  const original = dom.window.Storage.prototype.setItem;
  await mount(); await click(checkbox('Work'));
  try {
    dom.window.Storage.prototype.setItem = () => { throw new Error('Quota exceeded'); };
    await click(button('Apply')); assert.match(host.textContent, /request was not sent/);
    assert.equal(calls.filter(c => c[0] === 'mutate').length, 0);
  } finally { dom.window.Storage.prototype.setItem = original; }
});

test('pending request remains recoverable even when the new selection has unverified identity', async () => {
  api.mutateNativeLabelMemberships = async payload => { calls.push(['mutate', structuredClone(payload)]); throw new Error('Lost response'); };
  await mount(); await click(checkbox('Work')); await click(button('Apply'));
  const original = calls.find(c => c[0] === 'mutate')[1];
  await act(async () => root.unmount()); root = null;
  await mount([{ ...row('one'), nativeLabelState: 'unavailable', entityId: null }]);
  assert.match(host.textContent, /verified identity/);
  api.mutateNativeLabelMemberships = async payload => { calls.push(['mutate', structuredClone(payload)]); return {}; };
  await click(button('Verify pending label change'));
  assert.deepEqual(calls.filter(c => c[0] === 'mutate').at(-1)[1], original);
});

test('search matches complete nested paths and hidden-message labels remain assignable', async () => {
  labels[1].messageVisible = false; await mount();
  const input = host.querySelector('[aria-label="Search labels"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, 'Work/Child');
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  assert.equal(host.querySelectorAll('input[type=checkbox]').length, 1);
  await click(checkbox('Work/Child')); await click(button('Apply'));
  assert.deepEqual(calls.find(c => c[0] === 'mutate')[1].addLabelIds, ['child']);
});

test('mapped drafts are refused even when is_draft is absent', async () => {
  useStore.setState({ accounts: [{ id: accountId, storage_generation: storageGeneration, folder_mappings: { drafts: 'My Drafts' } }] });
  await mount([{ ...row('one'), folder: 'My Drafts' }]);
  assert.match(host.textContent, /Draft labels cannot be carried over/); assert.equal(calls.length, 0);
});

test('Create and Manage shortcuts dismiss staged edits and route the exact account without mutation', async () => {
  const events = []; const listener = event => events.push(event.detail);
  window.addEventListener('mailflow:manage-native-labels', listener);
  try {
    await mount(); await click(checkbox('Work')); await click(button('Create new')); await click(button('Manage labels'));
    assert.deepEqual(events, [{ accountId, create: true }, { accountId }]); assert.equal(closed, 2);
    assert.equal(calls.filter(c => c[0] === 'mutate').length, 0);
  } finally { window.removeEventListener('mailflow:manage-native-labels', listener); }
});

test('Undo is offered only for a verified forward response and sends only a server-preimage reference', async () => {
  const original = { accountId, storageGeneration, mutationId: 'forward-one' };
  offerNativeLabelUndo({}, original); assert.equal(useStore.getState().notifications.length, 0);
  offerNativeLabelUndo({ ...original, undoSupported: true }, original);
  api.undoNativeLabelMemberships = async payload => { calls.push(['undo', structuredClone(payload)]); return { undoSupported: false }; };
  await act(async () => useStore.getState().notifications[0].onUndo());
  const payload = calls.find(c => c[0] === 'undo')[1];
  assert.deepEqual(Object.keys(payload).sort(), ['accountId', 'mutationId', 'originalMutationId', 'storageGeneration']);
  assert.equal(payload.originalMutationId, 'forward-one'); assert.notEqual(payload.mutationId, 'forward-one');
  assert.equal(window.sessionStorage.length, 0); assert.equal(useStore.getState().notifications[0].title, 'Label change undone');
});

test('uncertain Undo persists and can be exactly verified after picker remount', async () => {
  const payload = { accountId, storageGeneration, originalMutationId: 'forward-one', mutationId: 'undo-one' };
  api.undoNativeLabelMemberships = async data => { calls.push(['undo', structuredClone(data)]); throw new Error('Lost response'); };
  await undoNativeLabelMemberships(payload); assert.equal(window.sessionStorage.length, 1);
  assert.equal(useStore.getState().notifications[0].title, 'Label Undo needs verification');
  await mount(); assert.equal(button('Apply').disabled, true);
  api.undoNativeLabelMemberships = async data => { calls.push(['undo', structuredClone(data)]); return { undoSupported: false }; };
  await click(button('Verify pending label change'));
  assert.deepEqual(calls.filter(c => c[0] === 'undo').map(c => c[1]), [payload, payload]);
  assert.equal(window.sessionStorage.length, 0); assert.equal(calls.filter(c => c[0] === 'mutate').length, 0);
});

test('Undo conflict refreshes without a replacement inverse; recovery middleware errors retain exact payload', async () => {
  const payload = { accountId, storageGeneration, originalMutationId: 'forward-one', mutationId: 'undo-one' };
  api.undoNativeLabelMemberships = async data => { calls.push(['undo', structuredClone(data)]); throw Object.assign(new Error('Changed'), { status: 409, code: 'stale_metadata_version' }); };
  await undoNativeLabelMemberships(payload);
  assert.equal(window.sessionStorage.length, 0); assert.match(useStore.getState().notifications[0].body, /Later changes were not overwritten/);
  api.undoNativeLabelMemberships = async () => { throw new Error('Lost response'); }; await undoNativeLabelMemberships(payload);
  api.undoNativeLabelMemberships = async () => { throw Object.assign(new Error('Locked'), { status: 423 }); };
  await undoNativeLabelMemberships(payload); assert.equal(window.sessionStorage.length, 1);
});

test('Undo blocks a replacement account and cannot run while a forward outcome remains uncertain', async () => {
  const payload = { accountId, storageGeneration, originalMutationId: 'forward-one', mutationId: 'undo-one' };
  api.undoNativeLabelMemberships = async () => { throw new Error('Must not send'); };
  useStore.setState({ accounts: [{ id: accountId, storage_generation: 'replacement' }] });
  await undoNativeLabelMemberships(payload); assert.match(useStore.getState().notifications[0].body, /account changed/);
  useStore.setState({ accounts: [{ id: accountId, storage_generation: storageGeneration }] });
  api.mutateNativeLabelMemberships = async () => { throw new Error('Lost response'); };
  await mount(); await click(checkbox('Work')); await click(button('Apply'));
  await act(async () => undoNativeLabelMemberships(payload)); assert.equal(useStore.getState().notifications[0].title, 'Verify the pending label change first');
});

test('direct removal conflict never automatically repeats the remove against refreshed versions', async () => {
  api.mutateNativeLabelMemberships = async payload => { calls.push(['mutate', structuredClone(payload)]); throw Object.assign(new Error('Changed'), { status: 409, code: 'stale_metadata_version' }); };
  root = createRoot(host);
  await act(async () => root.render(React.createElement(NativeLabelPicker, { ...props([row('one')]), initialRemove: 'work', autoApply: true })));
  assert.equal(calls.filter(c => c[0] === 'mutate').length, 1);
  assert.match(host.textContent, /Review the refreshed selection/); assert.equal(button('Apply').disabled, true); assert.equal(closed, 0);
});

test('an Undo finishing after logout cannot notify the next session', async () => {
  const wait = deferred(); useStore.setState({ user: { id: 'first-user' } });
  api.undoNativeLabelMemberships = () => wait.promise;
  const promise = undoNativeLabelMemberships({ accountId, storageGeneration, originalMutationId: 'forward-one', mutationId: 'undo-one' });
  useStore.setState({ user: { id: 'next-user' }, notifications: [], accounts: [] });
  wait.resolve({}); await promise;
  assert.equal(useStore.getState().notifications.length, 0); assert.equal(window.sessionStorage.length, 0);
  useStore.setState({ user: null });
});

test('chip removal uncertainty keeps the chip, withholds Undo, and verifies the exact request before offering Undo', async () => {
  const source = row('one', [labels[0]]);
  api.mutateNativeLabelMemberships = async payload => { calls.push(['mutate', structuredClone(payload)]); throw new Error('Lost response'); };
  root = createRoot(host);
  await act(async () => root.render(React.createElement(NativeLabelChips, { message: source, editable: true })));
  await click(host.querySelector('[aria-label="Remove Work from this message"]'));
  assert.equal(host.querySelector('.mf-native-message-label').textContent, 'Work×');
  assert.ok(document.querySelector('dialog')); assert.ok(button('Verify pending label change'));
  assert.equal(useStore.getState().notifications.some(notice => notice.onUndo), false);
  const original = calls.find(c => c[0] === 'mutate')[1];
  api.getMessage = async () => ({ ...source, nativeLabels: [], metadataVersion: '9007199254740994' });
  api.mutateNativeLabelMemberships = async payload => { calls.push(['mutate', structuredClone(payload)]); return { ...payload, undoSupported: true }; };
  await click(button('Verify pending label change'));
  assert.deepEqual(calls.filter(c => c[0] === 'mutate').map(c => c[1]), [original, original]);
  assert.equal(document.querySelector('dialog'), null); assert.equal(host.querySelector('.mf-native-message-label'), null);
  assert.equal(useStore.getState().notifications.some(notice => notice.onUndo), true);
});

test('chip removal refusal retains the original label and does not expose Undo', async () => {
  api.mutateNativeLabelMemberships = async payload => { calls.push(['mutate', payload]); throw Object.assign(new Error('Label missing'), { status: 404, code: 'label_not_found' }); };
  root = createRoot(host);
  await act(async () => root.render(React.createElement(NativeLabelChips, { message: row('one', [labels[0]]), editable: true })));
  await click(host.querySelector('[aria-label="Remove Work from this message"]'));
  assert.equal(calls.filter(c => c[0] === 'mutate').length, 1); assert.match(document.querySelector('dialog').textContent, /Label missing/);
  assert.equal(host.querySelector('.mf-native-message-label').textContent, 'Work×');
  assert.equal(useStore.getState().notifications.some(notice => notice.onUndo), false);
  assert.equal(window.sessionStorage.length, 0);
});

test('a live label-definition change refreshes open picker names and explicitly discards stale staging', async () => {
  await mount(); await click(checkbox('Work/Child'));
  labels = labels.map(label => label.id === 'child' ? { ...label, path: 'Work/Renamed' } : label);
  await act(async () => window.dispatchEvent(new CustomEvent('mailflow:native-labels-changed', { detail: { accountId, storageGeneration } })));
  assert.ok(checkbox('Work/Renamed')); assert.equal(checkbox('Work/Renamed').checked, false);
  assert.match(host.textContent, /Labels changed. Review/); assert.equal(button('Apply').disabled, true);
  assert.equal(calls.filter(c => c[0] === 'mutate').length, 0);
});
