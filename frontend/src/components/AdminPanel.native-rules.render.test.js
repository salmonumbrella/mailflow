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
  actions: [{ type: 'apply_native_label', value: 'label-a' }], nativeLabelReferences: [{ id: 'label-a', path: 'Parent/Child', missing: false }] };
let root, updates = [];
const button = key => [...document.querySelectorAll('button')].find(node => node.textContent.trim() === key);
const click = node => React.act(async () => { assert.ok(node); node.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
const choose = (node, value) => React.act(async () => { node.value = value; node.dispatchEvent(new window.Event('change', { bubbles: true })); });
async function mount(saved = rule) {
  updates = [];
  api.admin.getSettings = async () => ({ settings: {} });
  api.getUnreadCounts = async () => ({});
  api.getRules = async () => Array.isArray(saved) ? saved : [saved];
  api.updateRule = async (id, value) => { updates.push({ id, value }); return { ...(Array.isArray(saved) ? saved.find(item => item.id === id) : saved), ...value }; };
  api.getNativeLabels = async accountId => ({ accountId, storageGeneration: 'gen-a', labels: [{ id: 'label-a', path: 'Parent/Child', name: 'Child' }] });
  api.getNativeLabelCounts = async accountId => ({ accountId, storageGeneration: 'gen-a', counts: [] });
  useStore.setState({ user: { id: 'user-a' }, accounts: [account, { ...account, id: 'acct-b', email_address: 'b@example.test' }], adminTab: 'rules', folders: { 'acct-a': [], 'acct-b': [] }, nativeLabelSnapshots: {} });
  await React.act(async () => { root = createRoot(document.getElementById('root')); root.render(React.createElement(AdminPanel)); });
}
afterEach(async () => { if (root) await React.act(async () => root.unmount()); localStorage.clear(); });

test('editing native actions sends stable IDs and the saved generation, with account and path in selectors', async () => {
  await mount(); await click(button('admin.rules.editButton'));
  const select = document.querySelector('[aria-label="nativeLabelRules.apply"]');
  assert.equal(select.value, 'label-a');
  assert.match(select.textContent, /a@example.test · Parent\/Child/);
  await click(button('admin.rules.saveButton'));
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].value.actions, rule.actions);
  assert.equal(updates[0].value.expectedStorageGeneration, 'gen-a');
});

test('changing a rule account removes incompatible native action selections', async () => {
  await mount(); await click(button('admin.rules.editButton'));
  await choose(document.querySelector('select'), 'acct-b');
  assert.equal(document.querySelector('[aria-label="nativeLabelRules.apply"]'), null);
  const label = [...document.querySelectorAll('label')].find(node => node.textContent === 'nativeLabelRules.apply');
  assert.equal(label.querySelector('input').checked, false);
});

test('disabled broken rules show missing references and re-enable errors instead of swallowing them', async () => {
  await mount({ ...rule, nativeLabelReferences: [{ id: 'label-a', path: null, missing: true }] });
  assert.match(document.body.textContent, /nativeLabelRules.missing/);
  api.updateRule = async () => { throw new Error('Label no longer exists'); };
  await click(document.querySelector('input[type="checkbox"]'));
  assert.match(document.querySelector('[role="alert"]').textContent, /Label no longer exists/);
  assert.equal(document.querySelector('input[type="checkbox"]').checked, false);
});

test('native edits cannot adopt a replacement account generation at save time', async () => {
  await mount(); await click(button('admin.rules.editButton'));
  api.getNativeLabels = async accountId => ({ accountId, storageGeneration: 'gen-b', labels: [{ id: 'label-a', path: 'Parent/Child' }] });
  api.getNativeLabelCounts = async accountId => ({ accountId, storageGeneration: 'gen-b', counts: [] });
  await React.act(async () => useStore.setState({ accounts: [{ ...account, storage_generation: 'gen-b' }] }));
  await click(button('admin.rules.saveButton'));
  assert.equal(updates.length, 0);
  assert.match(document.body.textContent, /nativeLabelRules.accountChanged/);
});

test('a raw update response without reference DTO still displays the verified label instead of a false missing warning', async () => {
  await mount(); await click(button('admin.rules.editButton'));
  api.updateRule = async () => { const raw = { ...rule }; delete raw.nativeLabelReferences; return raw; };
  await click(button('admin.rules.saveButton'));
  assert.match(document.body.textContent, /Parent\/Child/);
  assert.doesNotMatch(document.body.textContent, /nativeLabelRules.missing/);
});

test('negative condition-only rules display account paths and retain UUIDs, operators and revision on edit', async () => {
  const saved = { ...rule, rule_revision: 'revision-1', conditions: [{ field: 'native_label', operator: 'not_has', value: 'label-a' }], actions: [{ type: 'star' }] };
  await mount(saved); await click(button('admin.rules.editButton'));
  const select = document.querySelector('[aria-label="nativeLabelRules.condition"]');
  assert.equal(select.value, 'label-a');
  assert.match(select.textContent, /a@example.test · Parent\/Child/);
  assert.equal(document.querySelector('[aria-label="nativeLabelRules.membership"]').value, 'not_has');
  await click(button('admin.rules.saveButton'));
  assert.deepEqual(updates[0].value.conditions, saved.conditions);
  assert.equal(updates[0].value.expectedRuleRevision, 'revision-1');
});

test('missing negative predicates never become match-all and changing accounts leaves a repairable condition', async () => {
  await mount({ ...rule, conditions: [{ field: 'native_label', operator: 'not_has', value: 'missing' }], actions: [{ type: 'star' }] });
  await click(button('admin.rules.editButton'));
  assert.match(document.body.textContent, /nativeLabelRules.missing/);
  await click(button('admin.rules.saveButton'));
  assert.equal(updates.length, 0);
  await choose(document.querySelector('select'), 'acct-b');
  assert.equal(document.querySelector('[aria-label="nativeLabelRules.condition"]').value, '');
  assert.equal(document.querySelector('[aria-label="nativeLabelRules.membership"]').value, 'not_has');
  await click(button('admin.rules.saveButton'));
  assert.equal(updates.length, 0);
});

test('server-issued converted conditions stay readonly and survive action edits unchanged', async () => {
  const conditions = [{ field: 'subject', operator: 'not_contains', value: '100%_é', semantics: 'search_v1' }, { field: 'is_read', operator: 'is_not', value: 'true', semantics: 'search_v1' }, { field: 'has_attachment', operator: 'is_not', value: 'true', semantics: 'search_v1' }];
  await mount({ ...rule, rule_revision: 'revision-2', conditions });
  await click(button('admin.rules.editButton'));
  assert.equal([...document.querySelectorAll('input')].find(input => input.value === '100%_é').disabled, true);
  assert.equal([...document.querySelectorAll('select')].find(select => select.value === 'is_read').disabled, true);
  assert.match(document.body.textContent, /nativeLabelRules.convertedIsNot/);
  await click(button('admin.rules.saveButton'));
  assert.deepEqual(updates[0].value.conditions, conditions);
  assert.equal(updates[0].value.expectedRuleRevision, 'revision-2');
});

test('rule revision conflicts remain visible and do not replace the saved rule', async () => {
  await mount({ ...rule, rule_revision: 'old' }); await click(button('admin.rules.editButton'));
  api.updateRule = async () => { throw Object.assign(new Error('Rule revision changed. Reload before saving.'), { status: 409 }); };
  await click(button('admin.rules.saveButton'));
  assert.match(document.body.textContent, /Rule revision changed/);
  assert.ok(button('admin.rules.saveButton'));
});

const reorderRows = async () => {
  await React.act(async () => document.querySelector('[draggable="true"]').dispatchEvent(new window.Event('dragstart', { bubbles: true })));
  await React.act(async () => document.querySelectorAll('.no-callout')[1].dispatchEvent(new window.Event('drop', { bubbles: true })));
};
const reorderFixtures = () => [rule, { ...rule, id: 'rule-b', name: 'Second rule' }].map(item => ({ ...item, rule_revision: 'revision-before' }));

for (const operation of ['toggle', 'edit']) test(`reordering refreshes exact revisions before a subsequent ${operation}`, async () => {
  let saved = reorderFixtures();
  await mount(saved);
  api.reorderRules = async ids => { saved = ids.map(id => ({ ...saved.find(item => item.id === id), rule_revision: 'revision-after' })); return { ok: true }; };
  api.getRules = async () => saved;
  api.updateRule = async (id, value) => {
    updates.push({ id, value });
    if (value.expectedRuleRevision !== saved.find(item => item.id === id).rule_revision) throw Object.assign(new Error('The rule changed. Refresh before saving.'), { status: 409 });
    return { ...saved.find(item => item.id === id), enabled: value.enabled };
  };
  await reorderRows();
  if (operation === 'toggle') await click(document.querySelector('input[type="checkbox"]'));
  else { await click(button('admin.rules.editButton')); await click(button('admin.rules.saveButton')); }
  assert.equal(updates.length, 1);
  assert.equal(updates[0].value.expectedRuleRevision, 'revision-after');
  assert.doesNotMatch(document.body.textContent, /The rule changed/);
});

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('reorder blocks another reorder, toggle and edit through the revision refresh', async () => {
  const saved = reorderFixtures();
  await mount(saved);
  const pending = deferred(), refresh = deferred();
  let reorders = 0;
  api.reorderRules = async () => { reorders++; return pending.promise; };
  api.getRules = () => refresh.promise;
  await reorderRows();
  assert.equal(document.querySelector('[draggable="true"]'), null);
  assert.equal(document.querySelector('input[type="checkbox"]').disabled, true);
  await click(button('admin.rules.editButton'));
  await click(document.querySelector('input[type="checkbox"]'));
  assert.equal(updates.length, 0);
  assert.equal(button('admin.rules.saveButton'), undefined);
  assert.equal(button('admin.rules.runButton').disabled, true);
  await React.act(async () => pending.resolve({ ok: true }));
  assert.equal(document.querySelector('input[type="checkbox"]').disabled, true);
  await React.act(async () => refresh.resolve(saved.map(item => ({ ...item, rule_revision: 'revision-after' }))));
  assert.equal(document.querySelector('input[type="checkbox"]').disabled, false);
  assert.equal(reorders, 1);
});

for (const change of ['user', 'generation', 'account removal']) test(`late reorder refresh does not adopt old rows after ${change} changes`, async () => {
  await mount(reorderFixtures());
  const refresh = deferred();
  api.reorderRules = async () => ({ ok: true });
  api.getRules = () => refresh.promise;
  await reorderRows();
  api.getRules = async () => [{ ...rule, id: 'new-rule', name: 'Current scope rule', rule_revision: 'current' }];
  await React.act(async () => useStore.setState(change === 'user' ? { user: { id: 'new-user' } }
    : { accounts: change === 'account removal' ? [] : [{ ...account, storage_generation: 'replacement' }] }));
  assert.match(document.body.textContent, /Current scope rule/);
  await React.act(async () => refresh.resolve([{ ...rule, name: 'Obsolete private rule', rule_revision: 'old' }]));
  assert.match(document.body.textContent, /Current scope rule/);
  assert.doesNotMatch(document.body.textContent, /Obsolete private rule/);
});

test('uncertain reorder response refetches committed revisions rather than restoring stale objects', async () => {
  await mount(reorderFixtures());
  api.reorderRules = async () => { throw new Error('Lost reorder acknowledgement'); };
  api.getRules = async () => reorderFixtures().map(item => ({ ...item, rule_revision: 'committed' }));
  await reorderRows();
  assert.match(document.querySelector('[role="alert"]').textContent, /Lost reorder acknowledgement/);
  await click(document.querySelector('input[type="checkbox"]'));
  assert.equal(updates[0].value.expectedRuleRevision, 'committed');
});

test('failed revision refresh does not leave stale rules editable', async () => {
  await mount(reorderFixtures());
  api.reorderRules = async () => ({ ok: true });
  api.getRules = async () => { throw new Error('Revision refresh unavailable'); };
  await reorderRows();
  assert.match(document.querySelector('[role="alert"]').textContent, /Revision refresh unavailable/);
  assert.equal(button('admin.rules.runButton').disabled, true);
  assert.equal(button('admin.rules.editButton'), undefined);
  assert.equal(document.querySelector('.no-callout input[type="checkbox"]'), null);
  api.getRules = async () => reorderFixtures().map(item => ({ ...item, rule_revision: 'recovered' }));
  await click(button('common.retry'));
  await click(document.querySelector('input[type="checkbox"]'));
  assert.equal(updates[0].value.expectedRuleRevision, 'recovered');
});

test('unmount during reorder prevents a follow-on refresh', async () => {
  await mount(reorderFixtures());
  const pending = deferred();
  let reads = 0;
  api.reorderRules = () => pending.promise;
  api.getRules = async () => { reads++; return reorderFixtures(); };
  await reorderRows();
  await React.act(async () => { root.unmount(); root = null; });
  await React.act(async () => pending.resolve({ ok: true }));
  assert.equal(reads, 0);
});

const enter = (node, value) => React.act(async () => {
  assert.ok(node);
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(node, value);
  node.dispatchEvent(new window.Event('input', { bubbles: true }));
});
for (const operation of ['create', 'toggle']) test(`ordinary ${operation} response revision survives a native action edit without reloading`, async () => {
  const ordinary = { ...rule, name: 'Ordinary rule', rule_revision: '2026-11-10 12:00:00.123456+00', actions: [{ type: 'star' }] };
  const revision = '2026-11-10 12:00:01.654321+00';
  await mount(operation === 'create' ? [] : ordinary);
  api.createRule = async () => ({ ...ordinary, rule_revision: revision });
  api.updateRule = async (id, value) => {
    updates.push({ id, value });
    return { ...ordinary, enabled: value.enabled, actions: value.actions, rule_revision: revision };
  };
  if (operation === 'create') {
    await click(button('+ admin.rules.newButton'));
    await enter(document.querySelector('[placeholder="admin.rules.namePlaceholder"]'), 'Ordinary rule');
    await choose(document.querySelector('select'), account.id);
    await enter(document.querySelector('[placeholder="value"]'), 'alice');
    await click([...document.querySelectorAll('label')].find(node => node.textContent === 'admin.rules.actionStar').querySelector('input'));
    await click(button('admin.rules.saveButton'));
  } else await click(document.querySelector('input[type="checkbox"]'));
  await click(button('admin.rules.editButton'));
  await click([...document.querySelectorAll('label')].find(node => node.textContent === 'nativeLabelRules.apply').querySelector('input'));
  await choose(document.querySelector('[aria-label="nativeLabelRules.apply"]'), 'label-a');
  await click(button('admin.rules.saveButton'));
  assert.equal(updates.at(-1).value.expectedRuleRevision, revision);
  assert.ok(updates.at(-1).value.actions.some(action => action.type === 'apply_native_label' && action.value === 'label-a'));
  assert.equal(button('admin.rules.saveButton'), undefined);
});
