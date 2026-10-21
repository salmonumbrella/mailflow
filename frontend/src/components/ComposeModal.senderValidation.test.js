import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { setImmediate } from 'node:timers';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
    return { format: 'module', shortCircuit: true, source: [
      'export const useTranslation = () => ({ t: (key) => key, i18n: { language: "en", changeLanguage: () => {} } });',
      'export const initReactI18next = { type: "3rdParty", init: () => {} };',
      'export const Trans = ({ children }) => children ?? null;',
      'export const I18nextProvider = ({ children }) => children ?? null;',
      'export default { useTranslation, initReactI18next };',
    ].join('\n') };
  }
  if (url.endsWith('.json')) return { format: 'module', shortCircuit: true,
    source: `export default ${readFileSync(new URL(url), 'utf8')}` };
  if (url.endsWith('.jsx')) {
    const code = transform(readFileSync(new URL(url), 'utf8'), {
      transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url,
    }).code;
    return { format: 'module', shortCircuit: true, source: code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
  }
  if (url.startsWith('file:') && url.endsWith('.js')) {
    const code = readFileSync(new URL(url), 'utf8');
    if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true,
      source: code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
  }
  return nextLoad(url, context);
} });

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, DOMParser: dom.window.DOMParser,
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true, __VITE_ENV__: { MODE: 'test', PROD: true } });
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.matchMedia = dom.window.matchMedia;
globalThis.requestAnimationFrame = cb => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const ComposeModal = (await import('./ComposeModal.jsx')).default;
const NotificationToasts = (await import('./NotificationToasts.jsx')).default;
const { api } = await import('../utils/api.js');


const account = { id: 'acct', enabled: true, email_address: 'owner@synthetic.test', aliases: [
  { id: 'alias', name: 'Alias', email: 'alias@synthetic.test' }], fastmail_verification_supported: true,
  fastmail_api_token_configured: true, fastmail_config_revision: 'rev1' };
const inventory = (status, email = 'alias@synthetic.test', configRevision = 'rev1') => ({ accountId: 'acct', provider: 'fastmail',
  configRevision, sender: { email, status }, identityStatus: 'ready', maskedStatus: 'ready', identities: [], maskedEmails: [] });
const flush = () => React.act(async () => { await new Promise(resolve => setImmediate(resolve)); });
const click = el => React.act(async () => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
let requests;
async function mount(reply, lookup, accountPatch = {}, composePatch = {}) {
  requests = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/mail/send')) { requests.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ pending: true, pendingId: 'held', remainingMs: 0 }) }; }
    return { ok: true, json: async () => ({}) };
  };
  api.getSenderIdentities = lookup;
  useStore.setState({ user: { id: 'u1' }, countGeneration: 100, isLocked: false, accounts: [{ ...account, ...accountPatch }], plaintextEmail: true, composing: true,
    notifications: [], prepareComposeSwitch: null, composeData: { accountId: 'acct', aliasId: 'alias', isReply: reply,
      to: ['recipient@synthetic.test'], subject: 'Hi', body: 'Body', ...composePatch } });
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(React.Fragment, null, React.createElement(ComposeModal), React.createElement(NotificationToasts))));
  await flush(); return root;
}
const unmount = root => React.act(async () => root.unmount());
for (const reply of [true, false]) test(`${reply ? 'reply' : 'compose'} shows actual unavailable toast without changing From`, async () => {
  const root = await mount(reply, async () => inventory('unavailable'));
  try {
    assert.ok(document.body.textContent.includes('compose.senderValidation.unavailable'));
    const selected = [...document.querySelectorAll('select')].find(el => el.value === 'alias:alias:acct');
    assert.ok(selected, 'chosen From remains alias');
    assert.equal(useStore.getState().composeData.aliasId, 'alias');
  } finally { await unmount(root); }
});
test('unknown is truthful and credential replacement clears old warning and refreshes', async () => {
  let calls = 0;
  const root = await mount(false, async () => { calls++; return inventory(calls === 1 ? 'unknown' : 'allowed', undefined, calls === 1 ? 'rev1' : 'rev2'); });
  try {
    assert.ok(document.body.textContent.includes('compose.senderValidation.unknown'));
    await React.act(async () => useStore.setState({ accounts: [{ ...account, fastmail_config_revision: 'rev2' }] }));
    await flush(); assert.equal(calls, 2);
    assert.ok(!document.body.textContent.includes('compose.senderValidation.unknown'));
  } finally { await unmount(root); }
});
test('late alias result cannot warn after switching to primary or signing out', async () => {
  let resolveAlias;
  const root = await mount(false, (_id, aliasId) => aliasId ? new Promise(resolve => { resolveAlias = resolve; })
    : Promise.resolve(inventory('allowed', account.email_address)));
  try {
    const select = [...document.querySelectorAll('select')].find(el => el.value === 'alias:alias:acct');
    await React.act(async () => { select.value = 'account:acct'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
    await React.act(async () => resolveAlias(inventory('unavailable')));
    assert.ok(!document.body.textContent.includes('compose.senderValidation.unavailable'));
    await React.act(async () => useStore.setState({ user: null }));
    assert.equal(useStore.getState().notifications.filter(n => n.senderValidation).length, 0);
  } finally { await unmount(root); }
});
test('mismatched revision and failed lookup warn unknown, and unmount removes only owned warning', async () => {
  const root = await mount(false, async () => inventory('unavailable', undefined, 'old'));
  await React.act(async () => useStore.getState().addNotification({ title: 'Unrelated' }));
  assert.ok(!document.body.textContent.includes('compose.senderValidation.unavailable'));
  assert.ok(document.body.textContent.includes('compose.senderValidation.unknown'));
  await unmount(root);
  assert.equal(useStore.getState().notifications.length, 1); assert.equal(useStore.getState().notifications[0].title, 'Unrelated');
});
test('an alias removed from account state still validates the selected alias id, never the primary', async () => {
  const selections = [];
  const root = await mount(false, async (_id, aliasId) => {
    selections.push(aliasId);
    if (selections.length > 1) throw Object.assign(new Error('Account not found'), { status: 404 });
    return inventory('allowed');
  });
  try {
    await React.act(async () => useStore.setState({ accounts: [{ ...account, aliases: [] }] }));
    await flush(); assert.deepEqual(selections, ['alias', 'alias']);
    assert.ok(document.body.textContent.includes('compose.senderValidation.missing'));
    assert.ok(!document.body.textContent.includes('compose.senderValidation.unavailable'));
  } finally { await unmount(root); }
});
test('held sender failure visibly restores the exact unsent draft', async () => {
  const previousStatus = api.getSendStatus;
  api.getSendStatus = async () => ({ status: 'failed', error: 'The selected sender is no longer available.' });
  const root = await mount(true, async () => inventory('allowed'));
  try {
    await click([...document.querySelectorAll('button')].find(b => b.textContent.includes('compose.send')));
    // The held-send controller first polls one second after the undo window.
    // Wait for its observable restoration, not an arbitrary pre-poll delay.
    const deadline = Date.now() + 3000;
    while (!useStore.getState().composeData?.sendError && Date.now() < deadline) {
      await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
    }
    assert.equal(requests[0].aliasId, 'alias');
    assert.equal(useStore.getState().composeData.aliasId, 'alias');
    assert.equal(useStore.getState().composeData.sendError, 'The selected sender is no longer available.');
    assert.ok(document.body.textContent.includes('compose.undoSend.notSent'));
  } finally { api.getSendStatus = previousStatus; await unmount(root); }
});

for (const transition of ['lock', 'same-user relogin']) test(`held inventory cannot publish after ${transition}`, async () => {
  let resolveLookup;
  const root = await mount(false, () => new Promise(resolve => { resolveLookup = resolve; }));
  const oldResolve = resolveLookup;
  try {
    await React.act(async () => {
      if (transition === 'lock') useStore.getState().setLocked(true);
      else {
        useStore.getState().setUser(null);
        useStore.getState().setUser({ id: 'u1' });
      }
    });
    await React.act(async () => oldResolve(inventory('unavailable')));
    assert.equal(useStore.getState().notifications.filter(n => n.senderValidation).length, 0);
  } finally { await unmount(root); }
});

test('a disabled or unsupported transport issues no inventory request or warning', async () => {
  let calls = 0;
  const root = await mount(false, async () => { calls++; return inventory('allowed'); });
  try {
    assert.equal(calls, 1);
    for (const patch of [{ enabled: false }, { fastmail_verification_supported: false, oauth_provider: 'google' }]) {
      await React.act(async () => useStore.setState({ accounts: [{ ...account, ...patch }] }));
      await flush();
      assert.equal(calls, 1);
      assert.equal(useStore.getState().notifications.filter(n => n.senderValidation).length, 0);
    }
  } finally { await unmount(root); }
});

for (const reply of [false, true]) test(`tokenless ${reply ? 'reply' : 'compose'} primary stays quiet without a GET`, async () => {
  let calls = 0;
  const root = await mount(false, async () => { calls++; return inventory('unknown'); },
    { fastmail_api_token_configured: false }, { aliasId: null, isReply: reply });
  try {
    assert.equal(calls, 0);
    assert.ok([...document.querySelectorAll('select')].some(el => el.value === 'account:acct'));
    assert.equal(useStore.getState().notifications.filter(n => n.senderValidation).length, 0);
  } finally { await unmount(root); }
});

test('tokenless secondary warns unknown without a GET and primary switching removes only that warning', async () => {
  let calls = 0;
  const root = await mount(false, async () => { calls++; return inventory('unknown'); },
    { fastmail_api_token_configured: false });
  try {
    assert.equal(calls, 0);
    assert.ok(document.body.textContent.includes('compose.senderValidation.unknown'));
    assert.ok(!document.body.textContent.includes('compose.senderValidation.unavailable'));
    assert.equal(useStore.getState().composeData.aliasId, 'alias');
    await React.act(async () => useStore.getState().addNotification({ title: 'Unrelated' }));
    const select = [...document.querySelectorAll('select')].find(el => el.value === 'alias:alias:acct');
    await React.act(async () => { select.value = 'account:acct'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
    await flush();
    assert.equal(calls, 0);
    assert.equal(useStore.getState().notifications.filter(n => n.senderValidation).length, 0);
    assert.ok(useStore.getState().notifications.some(n => n.title === 'Unrelated'));
    await React.act(async () => { select.value = 'alias:alias:acct'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
    await flush();
    assert.equal(calls, 0);
    assert.ok(document.body.textContent.includes('compose.senderValidation.unknown'));
  } finally { await unmount(root); }
});

test('quiet primary is the selected account address, not any account primary or the alias label', async () => {
  let calls = 0;
  const root = await mount(false, async () => { calls++; return inventory('unknown'); },
    { fastmail_api_token_configured: false });
  try {
    const accountA = { ...account, fastmail_api_token_configured: false };
    const accountB = { ...accountA, id: 'other', name: 'Other', email_address: 'alias@synthetic.test', aliases: [] };
    await React.act(async () => useStore.setState({ accounts: [accountA, accountB] }));
    await flush();
    assert.ok(document.body.textContent.includes('compose.senderValidation.unknown'), 'Another account primary cannot quiet this secondary');
    const select = [...document.querySelectorAll('select')].find(el => el.value === 'alias:alias:acct');
    await React.act(async () => { select.value = 'account:other'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
    await flush();
    assert.equal(useStore.getState().notifications.filter(n => n.senderValidation).length, 0);
    assert.equal(calls, 0);
    // The same selected address becomes quiet only when it is A's actual primary.
    await React.act(async () => useStore.setState({ accounts: [{ ...accountA, aliases: [
      { id: 'alias', name: 'Not primary by label', email: 'OWNER@synthetic.test' }], }, accountB] }));
    await React.act(async () => { select.value = 'alias:alias:acct'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
    await flush();
    assert.equal(useStore.getState().notifications.filter(n => n.senderValidation).length, 0);
    assert.equal(calls, 0);
  } finally { await unmount(root); }
});

test('configuring a token refreshes a warned secondary and clearing restores unknown without another GET', async () => {
  let calls = 0;
  const root = await mount(false, async () => { calls++; return inventory('allowed'); },
    { fastmail_api_token_configured: false });
  try {
    assert.ok(document.body.textContent.includes('compose.senderValidation.unknown'));
    await React.act(async () => useStore.setState({ accounts: [account] }));
    await flush();
    assert.equal(calls, 1);
    assert.equal(useStore.getState().notifications.filter(n => n.senderValidation).length, 0);
    await React.act(async () => useStore.setState({ accounts: [{ ...account, fastmail_api_token_configured: false }] }));
    await flush();
    assert.equal(calls, 1);
    assert.ok(document.body.textContent.includes('compose.senderValidation.unknown'));
    assert.equal(useStore.getState().composeData.aliasId, 'alias');
  } finally { await unmount(root); }
});
