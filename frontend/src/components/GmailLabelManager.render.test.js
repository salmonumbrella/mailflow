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
const { default: GmailLabelManager } = await import('./GmailLabelManager.jsx');
const host = document.getElementById('root');
let root; let calls; let labels; let locks;
const accountId = 'account-one';
const base = { id: 'work', accountId, name: 'Work', path: 'Work', parentId: null, color: '#123456', textColor: '#ffffff', visibility: 'show', messageVisible: true, revision: '9007199254740993', counts: null };
const button = text => [...host.querySelectorAll('button')].find(el => el.textContent === text);
const field = text => [...host.querySelectorAll('label')].find(el => el.firstChild?.textContent === text || el.textContent === text)?.querySelector('input,select');
const click = el => act(async () => { assert.ok(el, 'click target exists'); el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
const change = (el, value) => act(async () => {
  assert.ok(el, 'change target exists');
  const prototype = el.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, value);
  el.dispatchEvent(new dom.window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
});
const submit = () => act(async () => { host.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
const key = name => act(async () => { document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })); });
async function mount(id = accountId, initialCreate = false) {
  root = createRoot(host);
  await act(async () => { root.render(React.createElement(GmailLabelManager, { key: id, accountId: id, initialCreate, onLockChange: value => locks.push(value) })); });
}
beforeEach(() => {
  calls = []; locks = []; labels = [{ ...base }, { ...base, id: 'child', name: 'Child', path: 'Work/Child', parentId: 'work' }, { ...base, id: 'other', name: 'Other', path: 'Other' }];
  window.sessionStorage.clear();
  api.getNativeLabels = async id => { calls.push(['get', id]); return { labels: labels.map(l => ({ ...l })), treeRevision: '9007199254740995', assignmentSupported: false, coverage: 'not_indexed' }; };
  api.createNativeLabel = async data => { calls.push(['create', structuredClone(data)]); labels.push({ ...data, id: 'created', path: data.name, revision: '1' }); return { label: labels.at(-1) }; };
  api.updateNativeLabel = async (id, data) => { calls.push(['update', id, structuredClone(data)]); labels = labels.map(l => l.id === id ? { ...l, ...data, path: data.name, revision: '9007199254740994' } : l); return {}; };
  api.previewNativeLabelDelete = async (id, account) => { calls.push(['preview', id, account]); return { label: labels.find(l => l.id === id), descendants: labels.filter(l => l.parentId === id), treeRevision: '9007199254740995', removesMessages: false }; };
  api.deleteNativeLabel = async (id, data) => { calls.push(['delete', id, structuredClone(data)]); labels = labels.filter(l => l.id !== id && l.parentId !== id); return {}; };
  for (const method of ['createFolder', 'renameFolder', 'deleteFolder']) api[method] = () => { throw new Error('Native labels must never mutate folders'); };
});
afterEach(async () => { if (root) await act(async () => root.unmount()); root = null; });

test('real definitions render hierarchy and honest synchronized-cache scope, without manufactured counts', async () => {
  await mount();
  assert.match(host.textContent, /counts cover synchronized mail only/);
  assert.match(host.textContent, /do not sync to Google/);
  assert.equal(host.querySelectorAll('.mf-native-labels-tree > li').length, 3);
  assert.equal(host.querySelectorAll('.mf-native-labels-tree > li')[2].style.getPropertyValue('--label-depth'), '1');
  assert.doesNotMatch(host.textContent, /0 messages/);
});

test('create submits real account-scoped metadata and returns focus after authoritative reload', async () => {
  await mount(); const opener = button('Create MailFlow label'); await click(opener);
  assert.ok(document.activeElement === field('Label name'));
  await change(field('Label name'), '  Travel  '); await change(field('Nest under'), 'work');
  await change(field('Background color'), '#aabbcc'); await change(field('Text color'), '#112233');
  await change(field('Sidebar visibility'), 'unread'); await click(field('Show in the message list'));
  await submit();
  const payload = calls.find(c => c[0] === 'create')[1];
  assert.equal(payload.accountId, accountId); assert.equal(payload.name, 'Travel'); assert.equal(payload.parentId, 'work');
  assert.equal(payload.color, '#aabbcc'); assert.equal(payload.textColor, '#112233'); assert.equal(payload.visibility, 'unread'); assert.equal(payload.messageVisible, false);
  assert.match(payload.mutationId, /^[0-9a-f-]{36}$/); assert.equal(host.querySelector('form'), null);
  assert.ok(document.activeElement === opener, "focus returns to opener"); assert.equal(window.sessionStorage.length, 0);
});

test('rename/reparent excludes descendants and reset persists null colors with exact string revision', async () => {
  await mount(); await click(host.querySelector('[aria-label="Edit MailFlow label Work"]'));
  assert.deepEqual([...field('Nest under').options].map(o => o.value), ['', 'other']);
  await change(field('Label name'), 'Jobs'); await change(field('Nest under'), 'other'); await click(button('Reset both colors')); await submit();
  const payload = calls.find(c => c[0] === 'update')[2];
  assert.equal(payload.expectedRevision, '9007199254740993'); assert.equal(payload.parentId, 'other');
  assert.equal(payload.color, null); assert.equal(payload.textColor, null);
});

test('subtree deletion previews exact names, defaults focus to keep and requires revision-bound confirmation', async () => {
  await mount(); const opener = host.querySelector('[aria-label="Remove MailFlow label Work"]'); await click(opener);
  assert.equal(calls.filter(c => c[0] === 'delete').length, 0);
  assert.ok(document.activeElement === button('Keep labels')); assert.match(host.textContent, /No messages or IMAP folders will be deleted/);
  assert.deepEqual([...host.querySelector('[data-label-editor] ul').children].map(l => l.textContent), ['Work', 'Work/Child']);
  await key('Escape'); assert.equal(button('Remove listed labels'), undefined); assert.ok(document.activeElement === opener, "focus returns to opener");
  await click(opener); await click(button('Remove listed labels'));
  const payload = calls.find(c => c[0] === 'delete')[2];
  assert.equal(payload.expectedTreeRevision, '9007199254740995'); assert.equal(payload.confirmSubtree, true);
  assert.equal(labels.length, 1);
});

test('stale preview never repeats deletion and requires a fresh preview including new descendants', async () => {
  await mount(); await click(host.querySelector('[aria-label="Remove MailFlow label Work"]'));
  api.deleteNativeLabel = async (id, data) => { calls.push(['delete', id, data]); labels.push({ ...base, id: 'new-child', path: 'Work/New', parentId: 'work' }); throw Object.assign(new Error('Stale'), { status: 409 }); };
  await click(button('Remove listed labels'));
  assert.equal(calls.filter(c => c[0] === 'delete').length, 1); assert.equal(button('Remove listed labels'), undefined);
  assert.match(host.querySelector('[role=alert]').textContent, /Review the refreshed labels/);
  await click(host.querySelector('[aria-label="Remove MailFlow label Work"]'));
  assert.match(host.querySelector('[data-label-editor]').textContent, /Work\/New/);
});

test('lost response locks edits and persists same mutation for safe replay across remount', async () => {
  await mount(); await click(button('Create MailFlow label')); await change(field('Label name'), 'Pending');
  api.createNativeLabel = async data => { calls.push(['create', structuredClone(data)]); throw new TypeError('Network lost'); };
  await submit();
  const original = calls.find(c => c[0] === 'create')[1];
  assert.match(host.querySelector('[role=alert]').textContent, /save outcome is unknown/);
  assert.equal(button('Create MailFlow label').disabled, true); assert.equal(locks.at(-1), true);
  await submit(); assert.equal(calls.filter(c => c[0] === 'create').length, 1);
  await act(async () => root.unmount()); root = null; await mount();
  assert.ok(button('Retry pending label request')); assert.equal(button('Create MailFlow label').disabled, true);
  api.createNativeLabel = async data => { calls.push(['create', structuredClone(data)]); return {}; };
  await click(button('Retry pending label request'));
  assert.deepEqual(calls.filter(c => c[0] === 'create')[1][1], original);
  assert.equal(button('Retry pending label request'), undefined); assert.equal(locks.at(-1), false); assert.equal(window.sessionStorage.length, 0);
});

test('failed refresh after acknowledged save cannot resubmit the mutation', async () => {
  await mount(); await click(button('Create MailFlow label')); await change(field('Label name'), 'Saved');
  api.getNativeLabels = async () => { throw new Error('Read unavailable'); }; await submit();
  assert.equal(host.querySelector('form'), null); assert.equal(button('Retry pending label request'), undefined);
  assert.equal(calls.filter(c => c[0] === 'create').length, 1); assert.match(host.textContent, /Label changes saved/);
  assert.match(host.querySelector('[role=alert]').textContent, /Read unavailable/);
});

test('loading refusal exposes retry rather than empty success and unsafe controls', async () => {
  api.getNativeLabels = async () => { throw new Error('Access denied'); }; await mount();
  assert.equal(button('Create MailFlow label').disabled, true); assert.doesNotMatch(host.textContent, /No MailFlow labels yet/);
  assert.match(host.querySelector('[role=alert]').textContent, /Access denied/);
  api.getNativeLabels = async () => ({ labels: [], treeRevision: '0' }); await click(button('Refresh labels'));
  assert.equal(host.querySelector('[role=alert]'), null); assert.match(host.textContent, /No MailFlow labels yet/);
});

test('invalid names do not hit API and definitive validation refusal retains editable draft', async () => {
  await mount(); await click(button('Create MailFlow label')); await change(field('Label name'), 'Bad/name'); await submit();
  assert.equal(calls.some(c => c[0] === 'create'), false);
  await change(field('Label name'), 'Duplicate'); api.createNativeLabel = async () => { throw Object.assign(new Error('Invalid name'), { status: 400 }); }; await submit();
  assert.equal(field('Label name').value, 'Duplicate'); assert.equal(button('Retry pending label request'), undefined);
  assert.equal(window.sessionStorage.length, 0); assert.equal(button('Save MailFlow label').disabled, false);
});

test('a delayed old read cannot replace the authoritative list after mutation', async () => {
  await mount(); let release;
  api.getNativeLabels = () => new Promise(resolve => { release = resolve; });
  await click(button('Refresh labels'));
  // Existing definitions remain editable while the background snapshot is in flight.
  await click(host.querySelector('[aria-label="Edit MailFlow label Work"]'));
  await change(field('Label name'), 'Updated');
  api.getNativeLabels = async () => ({ labels: labels.map(l => ({ ...l })), treeRevision: '9007199254740996' });
  await submit();
  await act(async () => release({ labels: [{ ...base, name: 'Stale', path: 'Stale' }], treeRevision: '1' }));
  assert.match(host.textContent, /Updated/); assert.doesNotMatch(host.textContent, /Stale/);
});

test('double submission during mutation is serialized and dialog stays locked', async () => {
  await mount(); await click(button('Create MailFlow label')); await change(field('Label name'), 'Once');
  let release;
  api.createNativeLabel = data => { calls.push(['create', data]); return new Promise(resolve => { release = resolve; }); };
  await submit(); await submit();
  assert.equal(calls.filter(c => c[0] === 'create').length, 1); assert.equal(locks.at(-1), true);
  await key('Escape'); assert.ok(host.querySelector('form'));
  await act(async () => release({})); assert.equal(host.querySelector('form'), null); assert.equal(locks.at(-1), false);
});

test('pending operations remain account scoped when mounting another account', async () => {
  window.sessionStorage.setItem('mailflow:pending-native-label:account-one', JSON.stringify({ kind: 'create', payload: { accountId, mutationId: 'existing-request', name: 'Pending' } }));
  await mount('account-two'); assert.equal(button('Retry pending label request'), undefined);
  assert.deepEqual(calls[0], ['get', 'account-two']); assert.equal(calls.some(c => c[0] === 'create'), false);
});

test('mutation is not dispatched when recovery token cannot be saved to session storage', async () => {
  await mount(); await click(button('Create MailFlow label')); await change(field('Label name'), 'Unsafe retry');
  const prototype = Object.getPrototypeOf(window.sessionStorage); const original = prototype.setItem;
  prototype.setItem = () => { throw new Error('Storage unavailable'); };
  try {
    await submit(); assert.equal(calls.some(c => c[0] === 'create'), false);
    assert.match(host.querySelector('[role=alert]').textContent, /request was not sent/);
    assert.equal(button('Retry pending label request'), undefined);
  } finally { prototype.setItem = original; }
});

test('auth, screen-lock and rate-limit refusals during recovery keep the original mutation journal', async () => {
  await mount(); await click(button('Create MailFlow label')); await change(field('Label name'), 'Original');
  api.createNativeLabel = async data => { calls.push(['create', structuredClone(data)]); throw new TypeError('Response lost after possible commit'); };
  await submit(); const original = calls.find(c => c[0] === 'create')[1];
  for (const status of [400, 401, 403, 404, 409, 413, 423, 429]) {
    api.createNativeLabel = async () => { throw Object.assign(new Error('Gate refused'), { status }); };
    await click(button('Retry pending label request'));
    assert.equal(window.sessionStorage.length, 1); assert.equal(button('Create MailFlow label').disabled, true);
    assert.match(host.querySelector('[role=alert]').textContent, /earlier save outcome is still unknown/);
  }
  await act(async () => root.unmount()); root = null; await mount();
  api.createNativeLabel = async data => { calls.push(['create', structuredClone(data)]); return {}; };
  await click(button('Retry pending label request'));
  assert.deepEqual(calls.filter(c => c[0] === 'create')[1][1], original); assert.equal(window.sessionStorage.length, 0);
});

test('deletion preview discloses current and retained-generation associations without implying mail deletion', async () => {
  api.previewNativeLabelDelete = async () => ({ label: labels[0], descendants: [labels[1]], treeRevision: '42', associations: [
    { storageGeneration: 'current', currentGeneration: true, memberships: 4, entities: 3 },
    { storageGeneration: 'old', currentGeneration: false, memberships: 2, entities: 2 },
  ] });
  await mount(); await click(host.querySelector('[aria-label="Remove MailFlow label Work"]'));
  const associations = host.querySelector('[aria-label="Message associations to remove"]');
  assert.match(associations.textContent, /Current mailbox: Associations: 4; message entities: 3/);
  assert.match(associations.textContent, /Retained earlier mailbox: Associations: 2; message entities: 2/);
  assert.match(host.textContent, /No messages or IMAP folders will be deleted/);
  assert.equal(calls.some(call => call[0] === 'delete'), false);
});

test('Create shortcut opens the real definition editor but cannot bypass pending recovery', async () => {
  await mount(accountId, true);
  assert.ok(host.querySelector('form'));
  assert.equal(document.activeElement, field('Label name'));
  assert.equal(calls.some(call => call[0] === 'create'), false);
  await act(async () => root.unmount()); root = null;
  window.sessionStorage.setItem(`mailflow:pending-native-label:${accountId}`, JSON.stringify({ kind: 'create', payload: { accountId, mutationId: 'pending', name: 'Earlier' } }));
  await mount(accountId, true);
  assert.equal(host.querySelector('form'), null);
  assert.ok(button('Retry pending label request'));
  assert.equal(calls.some(call => call[0] === 'create'), false);
});
