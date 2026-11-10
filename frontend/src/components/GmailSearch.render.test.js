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
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent, Event: dom.window.Event,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
// useMobile() reads window.innerWidth first, then subscribes to matchMedia. jsdom defaults
// innerWidth to 1024, which is the desktop case the bug report is about.
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.matchMedia = dom.window.matchMedia;
dom.window.Element.prototype.scrollIntoView = () => {};
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const GmailSearch = (await import('./GmailSearch.jsx')).default;
let root, query = '', payloads = [], rejectSave = false;
const container = () => document.getElementById('root');
const button = label => [...container().querySelectorAll('button')].find(b => b.textContent.trim() === label || b.getAttribute('aria-label') === label);
const click = async node => { assert.ok(node); await React.act(async () => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))); };
const input = async (node, value) => { assert.ok(node); await React.act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new dom.window.Event('input', { bubbles: true })); }); };
async function mount(initial = '') {
  query = initial; payloads = []; rejectSave = false;
  useStore.setState({ user: { id: 'user-a' }, accounts: [{ id: 'acct-a', email_address: 'a@example.test', enabled: true }], selectedAccountId: 'acct-a', folders: { 'acct-a': [{ path: 'INBOX' }, { path: 'Archive' }] }, notifications: [] });
  api.createRule = async value => { payloads.push(value); if (rejectSave) throw new Error('Offline, try again'); return { id: 'saved-rule' }; };
  function Harness() { const [value, setValue] = React.useState(initial); return React.createElement(GmailSearch, { query: value, onChange: next => { query = next; setValue(next); } }); }
  await React.act(async () => { root = createRoot(container()); root.render(React.createElement(Harness)); });
}
afterEach(async () => { if (root) await React.act(async () => root.unmount()); localStorage.clear(); });

test('advanced form submits native query, preserves extra operators, and restores focus', async () => {
  await mount('from:alice is:starred');
  await click(button('Advanced search options'));
  const dialog = container().querySelector('[role="dialog"]');
  const from = dialog.querySelector('input');
  assert.equal(document.activeElement, from);
  await input(from, 'Bob Smith');
  await click(button('Search'));
  assert.equal(query, 'from:"Bob Smith" is:starred');
  assert.equal(container().querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement.getAttribute('role'), 'combobox');
});

test('Enter saves history and keyboard suggestions reuse it', async () => {
  await mount('from:alice');
  const search = container().querySelector('[role="combobox"]');
  await React.act(async () => search.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  assert.deepEqual(JSON.parse(localStorage.getItem('mailflow:gmail-search-history:user-a')), ['from:alice']);
  await input(search, '');
  await React.act(async () => search.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
  assert.ok(search.getAttribute('aria-activedescendant'));
  await React.act(async () => search.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  assert.equal(query, 'from:alice');
});

test('creates an actual native rule with selected actions and no invented state', async () => {
  await mount('from:alice');
  await click(button('Advanced search options')); await click(button('Create filter'));
  const dialog = container().querySelector('[aria-label="Create filter"]');
  await click([...dialog.querySelectorAll('label')].find(l => l.textContent === 'Star it').querySelector('input'));
  await click(button('Create filter'));
  assert.equal(payloads.length, 1);
  assert.deepEqual(payloads[0].conditions, [{ field: 'from', operator: 'contains', value: 'alice' }]);
  assert.deepEqual(payloads[0].actions, [{ type: 'star' }]);
  assert.equal(payloads[0].accountId, 'acct-a');
  assert.equal(container().querySelector('[role="dialog"]'), null);
  assert.equal(useStore.getState().notifications.at(-1).title, 'Filter saved');
});

test('unsupported filter criteria cannot silently become broader rules', async () => {
  await mount('from:alice after:2026-01-01');
  await click(button('Advanced search options')); await click(button('Create filter'));
  assert.match(container().querySelector('[role="alert"]').textContent, /cannot yet save/);
  assert.equal(payloads.length, 0);
  assert.ok(container().querySelector('[aria-label="Advanced search"]'));
});

test('failed saves remain open and do not claim success', async () => {
  await mount('subject:invoice'); rejectSave = true;
  await click(button('Advanced search options')); await click(button('Create filter'));
  await click([...container().querySelectorAll('label')].find(l => l.textContent === 'Mark as read').querySelector('input'));
  await click(button('Create filter'));
  assert.match(container().querySelector('[role="alert"]').textContent, /Offline/);
  assert.equal(useStore.getState().notifications.length, 0);
  assert.ok(container().querySelector('[aria-label="Create filter"]'));
});

test('Escape dismisses advanced form without applying edits', async () => {
  await mount('from:alice'); await click(button('Advanced search options'));
  const from = container().querySelector('[role="dialog"] input');
  await input(from, 'bob');
  await React.act(async () => from.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(query, 'from:alice');
  assert.equal(container().querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement.getAttribute('role'), 'combobox');
});

test('historical filter run is targeted and a failed start retries without duplicate creation', async () => {
  await mount('from:alice');
  let runIds = [], failRun = true;
  api.runRule = async id => { runIds.push(id); if (failRun) throw Object.assign(new Error('Another run is active'), { status: 409 }); return { started: true, status: 'running', ruleId: 'saved-rule', runId: 'run-test' }; };
  await click(button('Advanced search options')); await click(button('Create filter'));
  await click([...container().querySelectorAll('label')].find(l => l.textContent === 'Star it').querySelector('input'));
  await click([...container().querySelectorAll('label')].find(l => l.textContent.includes('Also apply only this filter')).querySelector('input'));
  await click(button('Create filter'));
  assert.equal(payloads.length, 1);
  assert.deepEqual(runIds, ['saved-rule']);
  assert.match(container().querySelector('[role="alert"]').textContent, /Filter saved.*could not start/);
  assert.equal(container().querySelector('fieldset').disabled, true);
  assert.equal(useStore.getState().notifications.length, 0);
  failRun = false;
  await click(button('Retry applying filter'));
  assert.equal(payloads.length, 1);
  assert.deepEqual(runIds, ['saved-rule', 'saved-rule']);
  assert.equal(container().querySelector('[role="dialog"]'), null);
  assert.match(useStore.getState().notifications.at(-1).body, /run has started/);
});

test('advanced address suggestions ignore a stale autocomplete response', async () => {
  await mount('');
  let firstResolve;
  api.suggestContacts = value => value === 'ali' ? new Promise(resolve => { firstResolve = resolve; }) : Promise.resolve({ contacts: [{ email: 'bob@example.test', name: 'Bob' }] });
  await click(button('Advanced search options'));
  const from = container().querySelector('[aria-label="Advanced search"] input');
  await input(from, 'ali');
  await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
  await input(from, 'bob');
  await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
  await React.act(async () => firstResolve({ contacts: [{ email: 'alice@example.test', name: 'Alice' }] }));
  const values = [...document.getElementById(from.getAttribute('list')).querySelectorAll('option')].map(option => option.value);
  assert.deepEqual(values, ['bob@example.test']);
});

test('unified search offers only displayed accounts and requires an explicit per-account filter', async () => {
  await mount('from:alice');
  await React.act(async () => useStore.setState({ selectedAccountId: null, accounts: [
    { id: 'acct-a', email_address: 'a@example.test', enabled: true },
    { id: 'acct-b', email_address: 'b@example.test', enabled: true },
    { id: 'hidden', email_address: 'hidden@example.test', enabled: true, include_in_unified_inbox: false },
  ] }));
  await click(button('Advanced search options')); await click(button('Create filter'));
  const selector = container().querySelector('[aria-label="Filter account"]');
  assert.deepEqual([...selector.options].map(option => option.value), ['', 'acct-a', 'acct-b']);
  await click([...container().querySelectorAll('label')].find(l => l.textContent === 'Star it').querySelector('input'));
  await click(button('Create filter'));
  assert.equal(payloads.length, 0);
  assert.match(container().querySelector('[role="alert"]').textContent, /Choose an account/);
  await React.act(async () => { selector.value = 'acct-b'; selector.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
  await click(button('Create filter'));
  assert.equal(payloads[0].accountId, 'acct-b');
  assert.deepEqual(payloads[0].searchScope, { accountIds: ['acct-b'], scopeAccountId: null });
});

test('an uncertain historical start is checked, never automatically resubmitted, and can be stopped', async () => {
  await mount('from:alice');
  let starts = 0, statusCalls = [], stops = [];
  api.runRule = async (_id, scope) => { starts++; assert.deepEqual(scope.accountIds, ['acct-a']); assert.equal(scope.scopeAccountId, 'acct-a'); throw new Error('Connection lost'); };
  api.getRuleRun = async (ruleId, runId) => { statusCalls.push({ ruleId, runId }); throw Object.assign(new Error('Unavailable'), { status: 404 }); };
  api.cancelRuleRun = async (ruleId, runId) => { stops.push({ ruleId, runId }); return { ruleId, runId, status: 'cancelled' }; };
  await click(button('Advanced search options')); await click(button('Create filter'));
  await click([...container().querySelectorAll('label')].find(l => l.textContent === 'Star it').querySelector('input'));
  await click([...container().querySelectorAll('label')].find(l => l.textContent.includes('Also apply only this filter')).querySelector('input'));
  await click(button('Create filter'));
  assert.equal(starts, 1);
  assert.equal(statusCalls.length, 1);
  assert.equal(button('Retry applying filter').disabled, true);
  await click(button('Cancel'));
  assert.ok(button('Stop run'));
  await click(button('Stop run'));
  assert.deepEqual(stops, statusCalls);
  assert.match(container().querySelector('[role="status"]').textContent, /Completed actions were not undone/);
  assert.equal(starts, 1);
});

// The reader's sender action must carry the clicked copy's account, never the toolbar scope.
const senderMessage = { id: 'copy-b', account_id: 'acct-b', from_email: 'sender@example.test', from_name: 'Sender' };
async function senderFilter(message = senderMessage) {
  const { openGmailSenderFilter } = await import('../utils/gmailSenderFilter.js');
  let accepted;
  await React.act(async () => { accepted = openGmailSenderFilter(message); });
  return accepted;
}
async function senderSetup() {
  await mount('subject:existing-search');
  await React.act(async () => useStore.setState({ layout: 'gmail', accounts: [
    { id: 'acct-a', enabled: true },
    { id: 'acct-b', enabled: true, include_in_unified_inbox: false },
    { id: 'disabled', enabled: false },
  ] }));
}

test('sender filter opens editable criteria for the clicked account without changing the current search or saving', async () => {
  await senderSetup();
  assert.equal(await senderFilter(), true);
  const dialog = container().querySelector('[aria-label="Advanced search"]');
  assert.ok(dialog);
  assert.equal(dialog.querySelector('input').value, 'sender@example.test');
  assert.equal(query, 'subject:existing-search');
  assert.equal(useStore.getState().selectedAccountId, 'acct-a');
  assert.equal(payloads.length, 0);
  await input(dialog.querySelector('input'), 'edited@example.test');
  await click(button('Create filter'));
  const selector = container().querySelector('[aria-label="Filter account"]');
  assert.equal(selector.value, 'acct-b');
  assert.deepEqual([...selector.options].map(option => option.value), ['', 'acct-b']);
  await click([...container().querySelectorAll('label')].find(l => l.textContent === 'Star it').querySelector('input'));
  await click(button('Create filter'));
  assert.deepEqual(payloads[0].searchScope, { accountIds: ['acct-b'], scopeAccountId: 'acct-b' });
  assert.deepEqual(payloads[0].conditions, [{ field: 'from', operator: 'contains', value: 'edited@example.test' }]);
});

test('sender filter cannot fall back to unified for absent, disabled, unowned accounts or missing sender', async () => {
  await senderSetup();
  for (const message of [
    { ...senderMessage, account_id: undefined }, { ...senderMessage, account_id: 'disabled' },
    { ...senderMessage, account_id: 'not-owned' }, { ...senderMessage, from_email: '' },
  ]) {
    assert.equal(await senderFilter(message), false);
    assert.equal(container().querySelector('[role="dialog"]'), null);
  }
  assert.equal(payloads.length, 0);
});

test('sender filter cancellation discards its scope before ordinary search filter creation', async () => {
  await senderSetup(); await senderFilter();
  await click(button('Create filter')); await click(button('Cancel'));
  assert.equal(payloads.length, 0);
  assert.equal(query, 'subject:existing-search');
  await click(button('Advanced search options')); await click(button('Create filter'));
  assert.equal(container().querySelector('[aria-label="Filter account"]').value, 'acct-a');
});

test('sender filter rejects an account disabled or removed after opening and cannot widen its scope', async () => {
  for (const stale of ['disabled', 'removed']) {
    await senderSetup(); await senderFilter(); await click(button('Create filter'));
    await click([...container().querySelectorAll('label')].find(l => l.textContent === 'Star it').querySelector('input'));
    await React.act(async () => useStore.setState({ accounts: stale === 'removed' ? [{ id: 'acct-a', enabled: true }] : [{ id: 'acct-a', enabled: true }, { id: 'acct-b', enabled: false }] }));
    await click(button('Create filter'));
    assert.equal(payloads.length, 0);
    assert.match(container().querySelector('[role="alert"]').textContent, /account.*(available|scope)/i);
    await React.act(async () => root.unmount()); root = null;
  }
});

test('sender filter preserves its exact account for historical runs and does nothing in other layouts', async () => {
  await senderSetup();
  for (const layout of ['comfortable', 'compact', 'outlook']) {
    await React.act(async () => useStore.setState({ layout }));
    assert.equal(await senderFilter(), false);
    assert.equal(container().querySelector('[role="dialog"]'), null);
  }
  await React.act(async () => useStore.setState({ layout: 'gmail', selectedAccountId: null }));
  await senderFilter(); await click(button('Create filter'));
  const starts = [];
  api.runRule = async (id, scope) => { starts.push({ id, scope }); return { ruleId: id, runId: scope.runId, status: 'completed' }; };
  await click([...container().querySelectorAll('label')].find(l => l.textContent === 'Star it').querySelector('input'));
  await click([...container().querySelectorAll('label')].find(l => l.textContent.includes('Also apply only this filter')).querySelector('input'));
  await click(button('Create filter'));
  assert.equal(starts.length, 1);
  assert.equal(starts[0].scope.scopeAccountId, 'acct-b');
  assert.deepEqual(starts[0].scope.accountIds, ['acct-b']);
});

test('sender criteria retain the clicked account across Back and reject staleness before creating a filter', async () => {
  await senderSetup(); await senderFilter(); await click(button('Create filter'));
  await click(button('‹ Back to search options'));
  await input(container().querySelector('[aria-label="Advanced search"] input'), 'new@example.test');
  await click(button('Create filter'));
  assert.equal(container().querySelector('[aria-label="Filter account"]').value, 'acct-b');
  await click(button('‹ Back to search options'));
  await React.act(async () => useStore.setState({ accounts: [{ id: 'acct-a', enabled: true }] }));
  await click(button('Create filter'));
  assert.ok(container().querySelector('[aria-label="Advanced search"]'));
  assert.match(container().querySelector('[role="alert"]').textContent, /account.*available/i);
  assert.equal(payloads.length, 0);
});

test('an identity change cannot save a sender filter for the previous user', async () => {
  await senderSetup(); await senderFilter(); await click(button('Create filter'));
  await click([...container().querySelectorAll('label')].find(l => l.textContent === 'Star it').querySelector('input'));
  await React.act(async () => useStore.setState({ user: { id: 'user-b' } }));
  await click(button('Create filter'));
  assert.equal(payloads.length, 0);
  assert.match(container().querySelector('[role="alert"]').textContent, /account.*scope/i);
});

test('a sender action cannot replace an in-flight save, and reopening starts with empty actions', async () => {
  await senderSetup(); await senderFilter(); await click(button('Create filter'));
  await click([...container().querySelectorAll('label')].find(l => l.textContent === 'Star it').querySelector('input'));
  let finish;
  api.createRule = value => { payloads.push(value); return new Promise(resolve => { finish = resolve; }); };
  await click(button('Create filter'));
  assert.equal(await senderFilter({ ...senderMessage, account_id: 'acct-a' }), false);
  assert.equal(container().querySelector('[aria-label="Filter account"]').value, 'acct-b');
  await React.act(async () => finish({ id: 'saved-rule' }));
  await senderFilter(); await click(button('Create filter'));
  assert.equal([...container().querySelectorAll('label')].find(l => l.textContent === 'Star it').querySelector('input').checked, false);
  await click(button('Cancel'));
  assert.equal(payloads.length, 1);
});
