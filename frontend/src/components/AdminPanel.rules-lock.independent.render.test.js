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
        'export const useTranslation = () => ({ t: (k) => k, i18n: { language: "en", changeLanguage: () => {} } });',
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
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const AdminPanel = (await import('./AdminPanel.jsx')).default;

const account = { id: 'acct-a', name: 'Work', email_address: 'a@example.test', enabled: true, storage_generation: 'gen-a' };
const rule = { id: 'rule-a', name: 'Native labels', account_id: account.id, storage_generation: 'gen-a', enabled: false,
  condition_logic: 'AND', conditions: [{ field: 'from', operator: 'contains', value: 'alice' }],
  actions: [{ type: 'star' }], nativeLabelReferences: [{ id: 'label-a', path: 'Parent/Child', missing: false }] };
let root, updates = [];
const button = key => [...document.querySelectorAll('button')].find(node => node.textContent.trim() === key);
const click = node => React.act(async () => { assert.ok(node); node.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
async function mount(saved = rule) {
  updates = [];
  api.admin.getSettings = async () => ({ settings: {} });
  api.getUnreadCounts = async () => ({});
  api.getRules = async () => Array.isArray(saved) ? saved : [saved];
  api.updateRule = async (id, value) => { updates.push({ id, value }); return { ...(Array.isArray(saved) ? saved.find(item => item.id === id) : saved), ...value }; };
  api.createRule = async value => ({ ...rule, ...value });
  api.deleteRule = async () => ({ ok: true });
  api.runRules = async () => ({ ok: true });
  api.getFolders = async () => [];
  api.getNativeLabels = async accountId => ({ accountId, storageGeneration: 'gen-a', labels: [{ id: 'label-a', path: 'Parent/Child', name: 'Child' }] });
  api.getNativeLabelCounts = async accountId => ({ accountId, storageGeneration: 'gen-a', counts: [] });
  useStore.setState({ user: { id: 'user-a' }, isLocked: false, accounts: [account, { ...account, id: 'acct-b', email_address: 'b@example.test' }], adminTab: 'rules', folders: { 'acct-a': [], 'acct-b': [] }, nativeLabelSnapshots: {} });
  await React.act(async () => { root = createRoot(document.getElementById('root')); root.render(React.createElement(AdminPanel)); });
}
afterEach(async () => { if (root) await React.act(async () => root.unmount()); localStorage.clear(); });


const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const enter = (node, value) => React.act(async () => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(node, value);
  node.dispatchEvent(new window.Event('input', { bubbles: true }));
});
const currentRule = { ...rule, name: 'Current scope rule', rule_revision: 'current' };
async function start(operation, pending) {
  let calls = 0;
  const handler = () => { calls++; return pending.promise; };
  if (operation === 'toggle') { api.updateRule = handler; await click(document.querySelector('.no-callout input[type="checkbox"]')); }
  if (operation === 'edit') { api.updateRule = handler; await click(button('admin.rules.editButton')); await click(button('admin.rules.saveButton')); }
  if (operation === 'create') {
    api.createRule = handler;
    await click(button('+ admin.rules.newButton'));
    await enter(document.querySelector('[placeholder="admin.rules.namePlaceholder"]'), 'Private creation');
    await enter(document.querySelector('[placeholder="value"]'), 'alice');
    await click([...document.querySelectorAll('label')].find(node => node.textContent === 'admin.rules.actionStar').querySelector('input'));
    await click(button('admin.rules.saveButton'));
  }
  if (operation === 'delete') { api.deleteRule = handler; await click(button('admin.rules.deleteButton')); await click(button('admin.rules.deleteButton')); }
  if (operation === 'run') { api.runRules = handler; await click(button('admin.rules.runButton')); }
  assert.equal(calls, 1);
  return () => calls;
}

// App ordinarily unmounts mail while locked. Observe the lock epoch as well so
// a lock/unlock round trip batched into one render cannot revive old callbacks.
for (const operation of ['toggle', 'edit', 'create', 'delete', 'run']) {
  for (const outcome of ['success', 'failure']) test(`independent: ${operation} ${outcome} is fenced by a same-tick lock round trip`, async () => {
    await mount();
    const pending = deferred();
    const calls = await start(operation, pending);
    let reads = 0;
    api.getRules = async () => { reads++; return [currentRule]; };
    await React.act(async () => {
      useStore.setState({ isLocked: true });
      useStore.setState({ isLocked: false });
    });
    await React.act(async () => outcome === 'success'
      ? pending.resolve({ ...rule, name: 'Obsolete pre-lock rule', enabled: true })
      : pending.reject(new Error('Obsolete pre-lock error')));
    if (button('common.cancel')) await click(button('common.cancel'));
    assert.match(document.body.textContent, /Current scope rule/);
    assert.doesNotMatch(document.body.textContent, /Obsolete pre-lock|admin.rules.running|admin.rules.runStarted/);
    assert.equal(reads, 1, 'unlock must require a fresh rule list');
    assert.equal(calls(), 1, 'the obsolete operation must not replay');
  });
}

for (const operation of ['toggle', 'edit', 'delete', 'run']) {
  for (const immediate of [true, false]) test(`independent: ${operation} cannot dispatch while locked ${immediate ? 'before render' : 'after fresh read'}`, async () => {
    await mount();
    if (operation === 'edit') await click(button('admin.rules.editButton'));
    if (operation === 'delete') await click(button('admin.rules.deleteButton'));
    const target = () => operation === 'toggle' ? document.querySelector('.no-callout input[type="checkbox"]')
      : button(operation === 'edit' ? 'admin.rules.saveButton' : operation === 'delete' ? 'admin.rules.deleteButton' : 'admin.rules.runButton');
    let calls = 0;
    const handler = async () => { calls++; return rule; };
    api.updateRule = handler; api.deleteRule = handler; api.runRules = handler;
    if (immediate) {
      const staleTarget = target();
      await React.act(async () => {
        useStore.setState({ isLocked: true });
        staleTarget.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      });
    } else {
      await React.act(async () => useStore.setState({ isLocked: true }));
      // Scope refresh deliberately clears the old deletion prompt.
      if (operation === 'delete') await click(button('admin.rules.deleteButton'));
      await click(target());
    }
    assert.equal(calls, 0, 'no rule mutation may start in the locked session');
  });
}

for (const outcome of ['success', 'failure']) test(`independent: reorder ${outcome} cannot reconcile the old lock epoch`, async () => {
  await mount([rule, { ...rule, id: 'rule-b', name: 'Second rule' }]);
  const pending = deferred();
  let writes = 0, reads = 0;
  api.reorderRules = () => { writes++; return pending.promise; };
  await React.act(async () => document.querySelector('[draggable="true"]').dispatchEvent(new window.Event('dragstart', { bubbles: true })));
  await React.act(async () => document.querySelectorAll('.no-callout')[1].dispatchEvent(new window.Event('drop', { bubbles: true, cancelable: true })));
  assert.equal(writes, 1);
  api.getRules = async () => { reads++; return [currentRule]; };
  await React.act(async () => { useStore.setState({ isLocked: true }); useStore.setState({ isLocked: false }); });
  assert.equal(reads, 1, 'unlock must reload independently of the obsolete reorder');
  await React.act(async () => outcome === 'success' ? pending.resolve({}) : pending.reject(new Error('Obsolete reorder')));
  assert.equal(reads, 1, 'only the current scope reload should read; old reorder must not reconcile');
  assert.match(document.body.textContent, /Current scope rule/);
  assert.doesNotMatch(document.body.textContent, /Obsolete reorder/);
  assert.equal(writes, 1);
  assert.equal(button('admin.rules.editButton').disabled, false);
});
