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
  api.getRules = async () => [saved];
  api.updateRule = async (id, value) => { updates.push({ id, value }); return { ...saved, ...value }; };
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
