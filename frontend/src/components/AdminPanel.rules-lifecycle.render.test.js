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
  useStore.setState({ user: { id: 'user-a' }, accounts: [account, { ...account, id: 'acct-b', email_address: 'b@example.test' }], adminTab: 'rules', folders: { 'acct-a': [], 'acct-b': [] }, nativeLabelSnapshots: {} });
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
const changes = {
  user: () => useStore.setState({ user: { id: 'user-b' } }),
  logout: () => useStore.getState().setUser(null),
  generation: () => useStore.setState({ accounts: [{ ...account, storage_generation: 'replacement' }] }),
  removal: () => useStore.setState({ accounts: [] }),
  disabled: () => useStore.setState({ accounts: [{ ...account, enabled: false }] }),
  'session round trip': () => { useStore.getState().setUser(null); useStore.getState().setUser({ id: 'user-a' }); useStore.setState({ accounts: [account] }); },
  'generation round trip': () => { const accounts = useStore.getState().accounts; useStore.setState({ accounts: [{ ...account, storage_generation: 'replacement' }] }); useStore.setState({ accounts }); },
};
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
async function changeScope(change) {
  api.getRules = async () => [currentRule];
  await React.act(async () => changes[change]());
}
async function showList() { if (button('common.cancel')) await click(button('common.cancel')); }
async function settle(pending, outcome) {
  await React.act(async () => outcome === 'success'
    ? pending.resolve({ ...rule, name: 'Obsolete private rule', enabled: true, rule_revision: 'obsolete' })
    : pending.reject(new Error('Old-user private rule failure')));
}

for (const operation of ['toggle', 'edit', 'create', 'delete', 'run']) {
  for (const change of Object.keys(changes)) {
    for (const outcome of ['success', 'failure']) test(`${operation} ${outcome} cannot leak across ${change}`, async () => {
      await mount();
      const pending = deferred();
      const calls = await start(operation, pending);
      await changeScope(change);
      await showList();
      await settle(pending, outcome);
      assert.match(document.body.textContent, /Current scope rule/);
      assert.doesNotMatch(document.body.textContent, /Obsolete private rule|Old-user private rule failure|admin.rules.running|admin.rules.runStarted/);
      assert.equal(calls(), 1, 'an obsolete write is never replayed');
      if (operation === 'edit' || operation === 'create') {
        await click(button('admin.rules.editButton'));
        assert.equal(button('admin.rules.saveButton')?.disabled, false, 'the old form lock was released');
        assert.doesNotMatch(document.body.textContent, /Old-user private rule failure/);
      }
    });
  }
}

for (const operation of ['toggle', 'edit', 'create', 'delete', 'run']) {
  for (const outcome of ['success', 'failure']) test(`${operation} ${outcome} after unmount cannot affect a new mount or replay writes`, async () => {
    await mount();
    const pending = deferred();
    const calls = await start(operation, pending);
    await React.act(async () => { root.unmount(); root = null; });
    await mount(currentRule);
    await settle(pending, outcome);
    assert.match(document.body.textContent, /Current scope rule/);
    assert.doesNotMatch(document.body.textContent, /Obsolete private rule|Old-user private rule failure/);
    assert.equal(calls(), 1);
  });
}

for (const operation of ['toggle', 'edit', 'delete']) {
  for (const outcome of ['success', 'failure']) test(`obsolete ${operation} ${outcome} cannot unlock a newer mutation`, async () => {
    await mount();
    const obsolete = deferred();
    await start(operation, obsolete);
    await changeScope('user');
    const current = deferred();
    const calls = await start('toggle', current);
    await settle(obsolete, outcome);
    await click(document.querySelector('.no-callout input[type="checkbox"]'));
    assert.equal(calls(), 1, 'the current request still owns the mutation lock');
    await React.act(async () => current.resolve({ ...currentRule, enabled: true, rule_revision: 'updated' }));
    assert.equal(document.querySelector('.no-callout input[type="checkbox"]').checked, true);
    assert.doesNotMatch(document.body.textContent, /Obsolete private rule|Old-user private rule failure/);
  });
}

for (const outcome of ['success', 'failure']) test(`obsolete save ${outcome} cannot clear a newer form or its saving state`, async () => {
  await mount();
  const obsolete = deferred();
  await start('edit', obsolete);
  await changeScope('user');
  const current = deferred();
  const calls = await start('edit', current);
  await settle(obsolete, outcome);
  assert.equal(button('admin.rules.saving')?.disabled, true);
  assert.equal(document.querySelector('[placeholder="admin.rules.namePlaceholder"]').value, currentRule.name);
  assert.doesNotMatch(document.body.textContent, /Old-user private rule failure/);
  assert.equal(calls(), 1);
  await React.act(async () => current.reject(new Error('Current form error')));
  assert.match(document.body.textContent, /Current form error/);
  assert.equal(button('admin.rules.saveButton').disabled, false);
});

for (const outcome of ['success', 'failure']) test(`dismissed save ${outcome} cannot close or report errors in a newer form`, async () => {
  await mount();
  const pending = deferred();
  await start('edit', pending);
  await click(button('common.cancel'));
  await click(button('+ admin.rules.newButton'));
  await enter(document.querySelector('[placeholder="admin.rules.namePlaceholder"]'), 'New draft');
  await settle(pending, outcome);
  assert.equal(document.querySelector('[placeholder="admin.rules.namePlaceholder"]').value, 'New draft');
  assert.doesNotMatch(document.body.textContent, /Old-user private rule failure/);
  assert.equal(button('admin.rules.saveButton').disabled, false);
  await click(button('common.cancel'));
  if (outcome === 'success') assert.match(document.body.textContent, /Obsolete private rule/);
  else assert.match(document.body.textContent, /Native labels/);
});

test('dismissed delete failure cannot close a reopened confirmation', async () => {
  await mount();
  const pending = deferred();
  await start('delete', pending);
  await click(button('common.cancel'));
  await click(button('admin.rules.deleteButton'));
  await settle(pending, 'failure');
  assert.ok(button('common.cancel'));
  assert.match(document.body.textContent, /admin.rules.deleteConfirm/);
});

for (const operation of ['toggle', 'edit', 'delete', 'run']) test(`${operation} rejects repeated clicks in the same event turn`, async () => {
  await mount();
  if (operation === 'edit') await click(button('admin.rules.editButton'));
  if (operation === 'delete') await click(button('admin.rules.deleteButton'));
  const pending = deferred();
  let calls = 0;
  const handler = () => { calls++; return pending.promise; };
  api.updateRule = handler; api.deleteRule = handler; api.runRules = handler;
  const target = operation === 'toggle' ? document.querySelector('.no-callout input[type="checkbox"]')
    : button(operation === 'edit' ? 'admin.rules.saveButton' : operation === 'delete' ? 'admin.rules.deleteButton' : 'admin.rules.runButton');
  await React.act(async () => {
    target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(calls, 1);
  await settle(pending, 'failure');
});

test('scope changes immediately fence clicks before the new rules finish loading', async () => {
  await mount();
  const pending = deferred();
  let calls = 0;
  api.getRules = () => pending.promise;
  api.updateRule = async () => { calls++; return rule; };
  const toggle = document.querySelector('.no-callout input[type="checkbox"]');
  await React.act(async () => {
    changes['generation round trip']();
    toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(calls, 0);
  await React.act(async () => pending.resolve([currentRule]));
  await click(document.querySelector('.no-callout input[type="checkbox"]'));
  assert.equal(calls, 1);
});

for (const outcome of ['success', 'failure']) test(`obsolete Run ${outcome} cannot clear a current Run`, async () => {
  await mount();
  const obsolete = deferred();
  await start('run', obsolete);
  await changeScope('user');
  const current = deferred();
  const calls = await start('run', current);
  await settle(obsolete, outcome);
  assert.equal(button('admin.rules.running').disabled, true);
  await click(button('admin.rules.running'));
  assert.equal(calls(), 1);
  await React.act(async () => current.reject(new Error('Current run error')));
  assert.match(document.body.textContent, /Current run error/);
  assert.equal(button('admin.rules.runButton').disabled, false);
});

test('Run completion wins over a delayed HTTP rejection and enables a deliberate new run', async () => {
  await mount();
  const pending = deferred();
  await start('run', pending);
  await React.act(async () => window.dispatchEvent(new CustomEvent('mailflow:rules-run-complete', { detail: { ok: true, processed: 4, matched: 2 } })));
  await settle(pending, 'failure');
  assert.match(document.body.textContent, /admin.rules.runResult/);
  assert.doesNotMatch(document.body.textContent, /Old-user private rule failure/);
  assert.equal(button('admin.rules.runButton').disabled, false);
  let runs = 0;
  api.runRules = async () => { runs++; return { ok: true }; };
  await click(button('admin.rules.runButton'));
  assert.equal(runs, 1);
});

for (const change of ['user', 'generation', 'generation round trip']) test(`folder response cannot repopulate the store after ${change}`, async () => {
  await mount();
  const pending = deferred();
  api.getFolders = () => pending.promise;
  await React.act(async () => useStore.setState({ folders: {} }));
  await click(button('admin.rules.editButton'));
  await changeScope(change);
  await click(button('common.cancel') || button('+ admin.rules.newButton'));
  await React.act(async () => pending.resolve([{ id: 'private-folder', path: 'Private old folder' }]));
  assert.deepEqual(useStore.getState().folders, {});
});

test('ordinary account metadata changes preserve current callbacks and exact rule revisions', async () => {
  await mount({ ...rule, rule_revision: 'before' });
  const pending = deferred();
  await start('toggle', pending);
  await React.act(async () => useStore.setState({ accounts: [...useStore.getState().accounts].reverse().map(item => ({ ...item, name: 'Renamed' })) }));
  await React.act(async () => pending.resolve({ ...rule, rule_revision: 'after', enabled: true }));
  await click(button('admin.rules.editButton'));
  api.updateRule = async (id, value) => { updates.push({ id, value }); return { ...rule, ...value }; };
  await click(button('admin.rules.saveButton'));
  assert.equal(updates.at(-1).value.expectedRuleRevision, 'after');
});

test('an open form exposes refresh loading/failure and can retry without replaying a save', async () => {
  await mount();
  await click(button('admin.rules.editButton'));
  const pending = deferred();
  let saves = 0;
  api.updateRule = async () => { saves++; return currentRule; };
  api.getRules = () => pending.promise;
  await React.act(async () => changes.generation());
  assert.equal(button('admin.rules.saveButton').disabled, true);
  assert.match(document.querySelector('[role="status"]').textContent, /common.loading/);
  await click(button('admin.rules.saveButton'));
  assert.equal(saves, 0);
  await React.act(async () => pending.reject(new Error('Current rule refresh failed')));
  assert.equal(button('admin.rules.saveButton').disabled, true);
  assert.match(document.querySelector('[role="alert"]').textContent, /Current rule refresh failed/);
  api.getRules = async () => [currentRule];
  await click(button('common.retry'));
  assert.equal(saves, 0);
  assert.equal(button('admin.rules.saveButton').disabled, false);
  await click(button('admin.rules.saveButton'));
  assert.equal(saves, 1);
});
