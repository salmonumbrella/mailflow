// Gmail context-menu keyboard and interrupted-lifecycle regression coverage.
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
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.matchMedia = dom.window.matchMedia;
dom.window.Element.prototype.scrollIntoView = () => {};
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}), text: async () => '{}' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');

const ContextMenu = (await import('./ContextMenu.jsx')).default;


const { api } = await import('../utils/api.js');
const { LAYOUTS, DEFAULT_LAYOUT } = await import('../layouts.js');
const { registerCollector } = await import('../plugins/registry.js');
const { buildGtdContextItems } = await import('../plugins/gtd/GtdContextMenu.jsx');
registerCollector('context-menu-actions', { pluginId: 'gtd-keyboard-test', build: buildGtdContextItems });
registerCollector('context-menu-actions', { pluginId: 'form-keyboard-test', build: ctx => [{
  label: 'Plugin form', keepOpen: true, hasSubmenu: true,
  action: () => ctx.openSubmenu(onBack => React.createElement('div', null,
    React.createElement('input', { 'aria-label': 'Plugin input' }),
    React.createElement('button', { onClick: onBack }, 'Plugin back'))),
}] });
const ACCOUNT = { id: 'acct-1', storage_generation: 'g1', email_address: 'a@example.com', enabled: true };
const MESSAGE = { id: 'm1', account_id: ACCOUNT.id, folder: 'INBOX', storageGeneration: 'g1', uid: 5, from_email: 'a@b.example', subject: 'Subject', is_read: false };
const originalGetFolders = api.getFolders;
const originalResolveMessage = api.resolveMessage;
const originalGetHeaders = api.getMessageHeaders;
let root;
let opener;
const rect = { x: 10, y: 10, left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30 };
async function openMenu({ state = {}, props = {}, keepMounted = false } = {}) {
  useStore.setState({ user: { id: 'u1' }, isLocked: false, layout: 'gmail', accounts: [ACCOUNT], messages: [MESSAGE], searchResults: [], threadMessages: {}, selectedAccountId: ACCOUNT.id, selectedFolder: 'INBOX', selectedMessageId: null, activeLabel: null, nativeLabelFeed: null, searchQuery: '', enabledPlugins: [], categorizationEnabled: true, folders: {}, ...state });
  opener = document.createElement('button');
  opener.textContent = 'Opener';
  opener.getClientRects = () => [rect];
  document.body.prepend(opener);
  opener.focus();
  const result = { actions: [], closes: 0, folderAccounts: [] };
  api.getFolders = async accountId => { result.folderAccounts.push(accountId); return [{ path: 'Archive', name: 'Archive' }, { path: 'Other', name: 'Other' }]; };
  await React.act(async () => {
    root = createRoot(document.getElementById('root'));
    root.render(React.createElement(ContextMenu, {
      x: 10, y: 10, message: MESSAGE,
      onClose: () => { result.closes++; if (!keepMounted) root.render(null); },
      onAction: (...args) => result.actions.push(args), ...props,
    }));
  });
  return result;
}
afterEach(async () => {
  if (root) await React.act(async () => root.unmount());
  root = null;
  opener?.remove();
  api.getFolders = originalGetFolders;
  api.resolveMessage = originalResolveMessage;
  api.getMessageHeaders = originalGetHeaders;
});
const command = label => [...document.querySelectorAll('[data-context-command]')].find(el => el.textContent.trim() === label);
const focusedText = () => document.activeElement?.textContent.trim();
async function key(value, target = document.activeElement, extra = {}) {
  const event = new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra });
  await React.act(async () => target.dispatchEvent(event));
  return event;
}
async function choose(label, value = 'Enter') {
  const el = command(label);
  assert.ok(el, `expected command ${label}`);
  await React.act(async () => el.focus());
  await key(value);
}

// These fail against the wave8 implementation before adding keyboard behavior.
test('Gmail menu focuses enabled commands, wraps arrows, and handles Home/End without dispatch', async () => {
  const result = await openMenu({ props: { variant: 'messagePane' } });
  assert.ok(document.querySelector('[role="menu"]'));
  assert.equal(command('common.copy')?.getAttribute('aria-disabled'), 'true');
  assert.equal(focusedText(), 'messageList.selectAll');
  await key('ArrowUp');
  assert.equal(focusedText(), 'contextMenu.delete');
  await key('ArrowDown');
  assert.equal(focusedText(), 'messageList.selectAll');
  await key('End');
  assert.equal(focusedText(), 'contextMenu.delete');
  await key('Home');
  assert.equal(focusedText(), 'messageList.selectAll');
  assert.deepEqual(result.actions, []);
});
for (const activation of ['Enter', ' ']) test(`${JSON.stringify(activation)} dispatches the native command once and restores its opener`, async () => {
  const result = await openMenu();
  await choose('contextMenu.delete', activation);
  assert.deepEqual(result.actions, [['delete']]);
  assert.equal(result.closes, 1);
  assert.equal(document.activeElement === opener, true);
});
test('Escape and Left leave only the active category level, then restore the prior command', async () => {
  const result = await openMenu();
  await choose('contextMenu.categorize', 'ArrowRight');
  assert.equal(focusedText(), 'contextMenu.categorize');
  assert.equal(command('messageList.categories.primary').getAttribute('aria-disabled'), 'true');
  await choose('contextMenu.categoryAlwaysDomain');
  await key('Escape');
  assert.equal(result.closes, 0);
  assert.equal(focusedText(), 'contextMenu.categoryAlwaysDomain');
  await key('ArrowLeft');
  assert.equal(focusedText(), 'contextMenu.categorize');
  await key('Escape');
  assert.equal(result.closes, 1);
});
test('custom snooze is a labelled form dialog; editing keys stay native and Escape returns one layer', async () => {
  const result = await openMenu();
  await choose('contextMenu.snooze.label');
  await choose('contextMenu.snooze.custom');
  assert.ok(document.querySelector('[role="dialog"]'));
  const input = document.querySelector('input[type="date"]');
  assert.ok(input.getAttribute('aria-label'));
  input.focus();
  assert.equal((await key('ArrowLeft')).defaultPrevented, false);
  assert.equal((await key('Home')).defaultPrevented, false);
  await key('Escape');
  assert.equal(document.querySelector('input[type="date"]'), null);
  assert.equal(result.closes, 0);
  assert.equal(focusedText(), 'contextMenu.snooze.custom');
});
test('move search is outside its menu; down enters folders and dispatches the same moveTo target', async () => {
  const result = await openMenu();
  await choose('contextMenu.moveToFolder');
  const input = document.querySelector('input');
  assert.equal(document.activeElement === input, true);
  assert.equal(input.closest('[role="menu"]'), null);
  assert.equal((await key('Home')).defaultPrevented, false);
  await key('ArrowDown');
  assert.equal(focusedText(), 'Archive');
  await key('ArrowDown');
  assert.equal(focusedText(), 'Other');
  await key('Enter');
  assert.deepEqual(result.actions, [['moveTo', 'Other']]);
});
test('an open menu suppresses unhandled background shortcuts and Escape even from body', async () => {
  const result = await openMenu();
  const seen = [];
  const listener = event => seen.push(event.key);
  document.addEventListener('keydown', listener);
  try { await key('e'); await key('Escape', document.body); }
  finally { document.removeEventListener('keydown', listener); }
  assert.deepEqual(seen, []);
  assert.deepEqual(result.actions, []);
  assert.equal(result.closes, 1);
});
test('GTD opt-in submenu has enabled command navigation without changing its action policy', async () => {
  const result = await openMenu({ state: { enabledPlugins: ['gtd-keyboard-test'], accounts: [{ ...ACCOUNT, gtd_enabled: true }] }, props: { variant: 'gtdSidebar' } });
  assert.equal(command('contextMenu.archive'), undefined);
  await choose('gtd.title');
  assert.ok(document.querySelector('[role="menu"]'));
  await key('ArrowDown');
  assert.ok(focusedText().startsWith('gtd.state.'));
  await key('Escape');
  assert.equal(focusedText(), 'gtd.title');
  assert.equal(result.closes, 0);
});
test('arbitrary plugin forms are not mislabelled menus or robbed of editing keys', async () => {
  const result = await openMenu({ state: { enabledPlugins: ['form-keyboard-test'] } });
  await choose('Plugin form');
  assert.ok(document.querySelector('[role="dialog"]'));
  assert.equal(document.querySelector('[role="menu"]'), null);
  assert.equal(document.activeElement.tagName, 'INPUT');
  assert.equal((await key('ArrowDown')).defaultPrevented, false);
  await key('Escape');
  assert.equal(focusedText(), 'Plugin form');
  assert.equal(result.closes, 0);
});
test('scrolling inside stays open, scrolling outside dismisses; resize repositions', async () => {
  const result = await openMenu();
  const menu = document.querySelector('[role="menu"]');
  menu.getBoundingClientRect = () => ({ ...rect, width: 400, height: 400 });
  await React.act(async () => menu.dispatchEvent(new dom.window.Event('scroll', { bubbles: false })));
  assert.equal(result.closes, 0);
  const width = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 200 });
  await React.act(async () => window.dispatchEvent(new dom.window.Event('resize')));
  assert.equal(menu.style.left, '0px');
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  await React.act(async () => document.body.dispatchEvent(new dom.window.Event('scroll', { bubbles: false })));
  assert.equal(result.closes, 1);
});
for (const hidden of ['removed', 'hidden', 'recycled']) test(`dismissal does not focus an opener that was ${hidden}`, async () => {
  await openMenu();
  if (hidden === 'removed') opener.remove();
  if (hidden === 'hidden') opener.style.display = 'none';
  if (hidden === 'recycled') opener.dataset.gmailRowId = 'other';
  await key('Escape');
  assert.equal(document.activeElement === opener, false);
});
for (const [name, change] of Object.entries({
  navigation: { selectedFolder: 'Other' }, user: { user: { id: 'u2' } },
  generation: { accounts: [{ ...ACCOUNT, storage_generation: 'g2' }] },
  removedAccount: { accounts: [] }, lock: { isLocked: true },
  source: { messages: [{ ...MESSAGE, uid: 6 }] }, removedSource: { messages: [] },
})) test(`pending folder responses cannot survive ${name} or reauthorize a stale command`, async () => {
  const result = await openMenu({ keepMounted: true });
  let resolve;
  api.getFolders = () => new Promise(done => { resolve = done; });
  await choose('contextMenu.moveToFolder');
  await React.act(async () => useStore.setState(change));
  await React.act(async () => resolve([{ path: 'Stale', name: 'Stale' }]));
  assert.equal(command('Stale'), undefined);
  assert.equal(result.closes, 1);
  assert.equal(document.activeElement === opener, false);
  await key('Escape', document.body);
  assert.equal(result.closes, 1);
  assert.deepEqual(result.actions, []);
});
test('folder response after closure is ignored even when the caller defers unmounting', async () => {
  const result = await openMenu({ keepMounted: true });
  let resolve;
  api.getFolders = () => new Promise(done => { resolve = done; });
  await choose('contextMenu.moveToFolder');
  await key('Escape'); // back to main
  await key('Escape'); // close
  await React.act(async () => resolve([{ path: 'Stale', name: 'Stale' }]));
  await choose('contextMenu.moveToFolder');
  assert.equal(command('Stale'), undefined);
  assert.equal(result.closes, 1);
  assert.deepEqual(result.actions, []);
});
test('default layout preserves its previous pointer menu and Escape behavior', async () => {
  const result = await openMenu({ state: { layout: DEFAULT_LAYOUT } });
  assert.equal(document.querySelector('[role="menu"]'), null);
  assert.equal(document.activeElement === opener, true);
  await key('Escape');
  assert.equal(result.closes, 1);
});

test('header modal receives native button activation and Escape returns to the menu first', async () => {
  const result = await openMenu();
  api.getMessageHeaders = async () => ({ headers: 'Subject: Test' });
  await choose('contextMenu.viewHeaders');
  assert.ok(document.querySelector('[role="dialog"]'));
  assert.equal(document.activeElement.tagName, 'BUTTON');
  assert.equal((await key('Enter')).defaultPrevented, false);
  await key('Escape');
  assert.equal(result.closes, 0);
  assert.equal(focusedText(), 'contextMenu.viewHeaders');
  await key('Escape');
  assert.equal(result.closes, 1);
});
test('late header resolution after closure cannot open a modal', async () => {
  const result = await openMenu({ props: { variant: 'gtdSidebar' }, keepMounted: true });
  let resolve;
  api.resolveMessage = () => new Promise(done => { resolve = done; });
  await choose('contextMenu.viewHeaders');
  await key('Escape');
  await React.act(async () => resolve(MESSAGE));
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(result.closes, 1);
});
test('repeat and IME keys cannot activate or dismiss a command', async () => {
  const result = await openMenu();
  await key('Enter', document.activeElement, { repeat: true });
  await key('Escape', document.activeElement, { repeat: true });
  for (const extra of [{ isComposing: true }, { keyCode: 229 }]) {
    await key('Enter', document.activeElement, extra);
    await key('Escape', document.activeElement, extra);
  }
  assert.equal(result.closes, 0);
  assert.deepEqual(result.actions, []);
});
test('disabled commands cannot be keyboard activated or clicked', async () => {
  const result = await openMenu({ props: { variant: 'messagePane' } });
  const disabled = command('common.copy');
  disabled.focus();
  await key('Enter');
  await React.act(async () => disabled.click());
  assert.deepEqual(result.actions, []);
  assert.equal(result.closes, 0);
});
test('context invalidation is permanent through lock/unlock and restored navigation', async () => {
  const result = await openMenu({ keepMounted: true });
  const original = useStore.getState();
  const action = command('contextMenu.delete');
  await React.act(async () => useStore.setState({ isLocked: true }));
  await React.act(async () => useStore.setState(original));
  await React.act(async () => action.click());
  assert.deepEqual(result.actions, []);
  assert.equal(result.closes, 1);
});
test('outside scrim dismisses once and restores a current opener', async () => {
  const result = await openMenu();
  const scrim = document.querySelector('[aria-hidden="true"]');
  await React.act(async () => scrim.click());
  assert.equal(result.closes, 1);
  assert.equal(document.activeElement === opener, true);
});
test('direct move picker Escape closes instead of exposing a menu that was never opened', async () => {
  const result = await openMenu({ props: { defaultMoveView: true } });
  assert.equal(document.activeElement.tagName, 'INPUT');
  await key('Escape');
  assert.equal(result.closes, 1);
});
test('Tab exits commands without trapping forms or leaking a mail shortcut', async () => {
  const result = await openMenu();
  assert.equal((await key('Tab')).defaultPrevented, false);
  assert.equal(result.closes, 1);
  assert.equal(document.activeElement === opener, true);
});

test('an expanded-child menu loses its source when the parent collapses', async () => {
  const result = await openMenu({ keepMounted: true, state: {
    messages: [{ ...MESSAGE, id: 'parent', thread_id: 'thread' }],
    expandedThreadId: 'thread', threadMessages: { thread: [MESSAGE] },
  } });
  await React.act(async () => useStore.setState({ expandedThreadId: null }));
  await choose('contextMenu.delete');
  assert.equal(result.closes, 1);
  assert.deepEqual(result.actions, []);
});

for (const layout of Object.keys(LAYOUTS)) {
  for (const accountsReady of [false, true]) test(`${layout} conversation picker refuses a missing account (ready=${accountsReady}) without replay when accounts arrive`, async () => {
    const result = await openMenu({ state: { layout, accounts: [], accountsReady }, props: { variant: 'conversation', defaultMoveView: true }, keepMounted: true });
    assert.equal(result.closes, 1);
    assert.deepEqual(result.folderAccounts, []);
    await React.act(async () => useStore.setState({ accounts: [ACCOUNT], accountsReady: true }));
    assert.deepEqual(result.folderAccounts, [], 'account discovery cannot reauthorize an old picker');
    assert.deepEqual(result.actions, []);
  });
  test(`${layout} conversation picker refuses disabled or removed accounts instead of using the selected account`, async () => {
    const result = await openMenu({ state: { layout, accounts: [{ ...ACCOUNT, enabled: false }, { id: 'other', enabled: true }], selectedAccountId: 'other', accountsReady: true }, props: { variant: 'conversation', defaultMoveView: true } });
    assert.equal(result.closes, 1);
    assert.deepEqual(result.folderAccounts, []);
    assert.deepEqual(result.actions, []);
  });
}
test('a current conversation copy outside list/expanded sources keeps its own account for the picker', async () => {
  const result = await openMenu({ state: { messages: [], threadMessages: {}, selectedAccountId: 'other', accounts: [ACCOUNT, { id: 'other', enabled: true }] }, props: { variant: 'conversation', defaultMoveView: true } });
  assert.deepEqual(result.folderAccounts, [ACCOUNT.id]);
  await key('ArrowDown');
  await key('Enter');
  assert.deepEqual(result.actions, [['moveTo', 'Archive']]);
});
