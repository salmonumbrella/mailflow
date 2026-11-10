// Native component integration, not visual/browser coverage. Every API request is served
// by the same isolated fixture as the optional localhost preview; nothing can reach a provider.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';
import { createFixtureState, handleFixtureApi } from '../../../scripts/superhuman-fixture-server.mjs';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    if (url.endsWith('/hooks/useWebSocket.js')) return { format: 'module', shortCircuit: true, source: 'export const useWebSocket = () => ({ current: { readyState: 1 } });' };
    if (url.endsWith('.json')) return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    const env = code => code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
    if (url.endsWith('.jsx')) return { format: 'module', shortCircuit: true, source: env(transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url }).code) };
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: env(code) };
    }
    return nextLoad(url, context);
  },
});
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:4173/', pretendToBeVisual: true });
const observer = class { observe() {} unobserve() {} disconnect() {} };
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  sessionStorage: dom.window.sessionStorage, history: dom.window.history,
  CustomEvent: dom.window.CustomEvent, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent,
  Image: dom.window.Image, Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle, ResizeObserver: observer, IntersectionObserver: observer,
  requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
  IS_REACT_ACT_ENVIRONMENT: true, __VITE_ENV__: { MODE: 'test', DEV: false, PROD: true },
});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
window.innerWidth = 1440;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
window.ResizeObserver = observer;
window.IntersectionObserver = observer;
globalThis.matchMedia = window.matchMedia;
window.Element.prototype.scrollIntoView = () => {};
window.Range.prototype.getClientRects = () => [];
window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0 });
const fixture = createFixtureState();
const unsupported = [];
let labelFixtureEnabled = false;
let labelFolderReads = 0;
const labelCopies = [];
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input), window.location.origin);
  assert.equal(url.origin, window.location.origin, 'integration never requests another origin');
  let result;
  if (labelFixtureEnabled && url.pathname === '/api/accounts/fixture-work/folders') {
    labelFolderReads++;
    result = { status: 200, body: [{ path: 'INBOX', name: 'Inbox', special_use: '\\Inbox' }, { path: 'Review copies', name: 'Review copies' }] };
  } else if (labelFixtureEnabled && url.pathname === '/api/mail/messages/fixture-message-1/copy' && options.method === 'POST') {
    labelCopies.push(JSON.parse(options.body));
    result = { status: 200, body: { ok: true } };
  } else result = url.pathname === '/api/admin/settings' && (!options.method || options.method === 'GET')
    ? { status: 200, body: {} }
    : handleFixtureApi(fixture, options.method || 'GET', url.pathname, url.searchParams, options.body ? JSON.parse(options.body) : undefined);
  if (result.status === 501) unsupported.push(`${options.method || 'GET'} ${url.pathname}`);
  return { ok: result.status < 400, status: result.status, headers: new Headers({ 'content-type': 'application/json' }), json: async () => structuredClone(result.body), text: async () => JSON.stringify(result.body) };
};
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { BrowserRouter } = await import('react-router-dom');
const { i18nReady } = await import('../i18n.js');
await i18nReady;
const { useStore } = await import('../store/index.js');
await import('../plugins/index.js');
const App = (await import('../App.jsx')).default;
const root = createRoot(document.getElementById('root'));
after(async () => { await React.act(async () => { window.dispatchEvent(new window.Event('pagehide')); await new Promise(resolve => setTimeout(resolve, 10)); root.unmount(); useStore.getState().setUser(null); }); dom.window.close(); });
const settle = async () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
const click = async element => { assert.ok(element, 'UI control is present'); await React.act(async () => element.click()); await settle(); };
const button = label => [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label || b.textContent.trim() === label || b.title === label);

test('auxiliary palettes protect hidden mail and return to the requested mail destination', async () => {
  await React.act(async () => root.render(React.createElement(BrowserRouter, { future: { v7_startTransition: true, v7_relativeSplatPath: true } }, React.createElement(App))));
  await settle();
  await React.act(async () => useStore.getState().setLayout('superhuman'));
  await click(document.querySelector('[data-msgid="fixture-message-1"] [role=listitem]'));
  assert.equal(useStore.getState().selectedMessageId, 'fixture-message-1');
  await click(button('Email open activity'));
  const originalStar = fixture.messages.find(message => message.id === 'fixture-message-1').is_starred;
  const originalMutations = fixture.mutations.length;
  await click(button('Commands'));
  for (const action of ['archive', 'reply', 'toggleStar', 'delete', 'toggleThreadMute']) {
    const option = document.querySelector(`[data-command-id="mail:${action}"]`);
    assert.equal(option.getAttribute('aria-disabled'), 'true', `${action} cannot target hidden mail`);
    await click(option);
  }
  assert.equal(fixture.mutations.length, originalMutations);
  assert.equal(fixture.messages.find(message => message.id === 'fixture-message-1').is_starred, originalStar);
  await click(document.querySelector('[data-command-id="inbox"]'));
  assert.equal(Boolean(document.querySelector('[data-auxiliary-view]')), false, 'Inbox command leaves the auxiliary view');
  assert.equal(useStore.getState().selectedAccountId, null);
  assert.equal(useStore.getState().selectedMessageId, null);
  assert.equal(history.state?.mailflowAux, null);

  await click(button('Snippets'));
  await click(button('Commands'));
  await click(document.querySelector(`[data-command-id="account:${fixture.accounts[1].id}"]`));
  assert.equal(Boolean(document.querySelector('[data-auxiliary-view]')), false, 'Account command leaves snippets');
  assert.equal(useStore.getState().selectedAccountId, fixture.accounts[1].id);
  assert.equal(history.state?.mailflowAux, null);

  await click(button('Email open activity'));
  await click(button('Commands'));
  await click(document.querySelector('[data-command-id="mail:focusSearch"]'));
  assert.equal(Boolean(document.querySelector('[data-auxiliary-view]')), false, 'Search command leaves activity');
  assert.equal(document.activeElement, document.querySelector('.sh-list-search input'), 'Search is visible and focused');

  // Returning to mail restores native commands rather than disabling the palette globally.
  await click(button('All Inboxes'));
  await click(document.querySelector('[data-msgid="fixture-message-1"] [role=listitem]'));
  await click(button('Commands'));
  const star = document.querySelector('[data-command-id="mail:toggleStar"]');
  assert.equal(star.getAttribute('aria-disabled'), 'false');
  await click(star);
  assert.equal(fixture.messages.find(message => message.id === 'fixture-message-1').is_starred, !originalStar);
  assert.equal(fixture.sent.length, 0);
  assert.deepEqual(unsupported, []);
});

test('native L and palette label commands load uncached ordinary folders without opening the drawer', async () => {
  labelFixtureEnabled = true;
  await click(button('All Inboxes'));
  await React.act(async () => useStore.setState({ folders: {} }));
  await click(document.querySelector('[data-msgid="fixture-message-1"] [role=listitem]'));
  assert.equal(Boolean(document.querySelector('#superhuman-folders')), false);
  await React.act(async () => document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'l', bubbles: true, cancelable: true })));
  await settle();
  assert.equal(labelFolderReads, 1);
  const option = document.querySelector('[data-command-id="label:Review copies"]');
  assert.ok(option, 'L discovers the ordinary folder without relying on the sidebar cache');
  await click(option);
  assert.deepEqual(labelCopies, [{ folder: 'Review copies' }]);
  assert.equal(Boolean(document.querySelector('[role="dialog"]')), false);
  assert.equal(fixture.messages.find(message => message.id === 'fixture-message-1').folder, 'INBOX');

  await React.act(async () => useStore.setState({ folders: {} }));
  await click(button('Commands'));
  const command = document.querySelector('[data-command-id="mail:openLabelPicker"]');
  assert.equal(command.getAttribute('aria-disabled'), 'false', 'Unknown folders are loadable, not known-empty');
  await click(command);
  assert.equal(labelFolderReads, 2);
  assert.ok(document.querySelector('[data-command-id="label:Review copies"]'));
  await React.act(async () => document.querySelector('[role="combobox"]').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  assert.equal(labelCopies.length, 1, 'Dismissing the picker does not copy mail');
  assert.equal(fixture.sent.length, 0);
  assert.deepEqual(unsupported, []);
});

test('foreground compose, settings, help and message windows keep auxiliary keyboard handlers inactive', async () => {
  fixture.preferences.enabledPlugins = ['local-calendar'];
  await React.act(async () => useStore.setState({ enabledPlugins: ['local-calendar'] }));
  await click(button('All Inboxes'));
  const press = async (target, key, options = {}) => {
    await React.act(async () => target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })));
    await settle();
  };
  for (const title of ['Email open activity', 'Muted conversations', 'MailFlow calendar']) {
    await click(button(title));
    assert.ok(document.querySelector('[data-auxiliary-view]'));
    await click(button('Compose'));
    const composeButton = document.querySelector('.compose-window button');
    assert.ok(composeButton);
    const session = useStore.getState().composeSession;
    await press(composeButton, 'Escape');
    assert.equal(Boolean(document.querySelector('[data-auxiliary-view]')), true, `${title} must not dismiss behind compose`);
    await press(composeButton, 'A', { ctrlKey: true, shiftKey: true });
    assert.equal(useStore.getState().composeSession, session, `${title} must not replace the foreground draft`);
    await click(button('Discard'));

    await click(document.querySelector('.superhuman-rail [aria-label="Settings"]'));
    assert.equal(useStore.getState().showAdmin, true);
    await press(document.body, 'Escape');
    assert.equal(Boolean(document.querySelector('[data-auxiliary-view]')), true, `${title} stays behind settings`);
    await React.act(async () => useStore.getState().setShowAdmin(false));

    await click(document.querySelector('.superhuman-rail [aria-label="Keyboard shortcuts"]'));
    assert.ok(document.querySelector('[role="dialog"]'));
    await press(document.body, 'Escape');
    assert.equal(Boolean(document.querySelector('[role="dialog"]')), false, 'Escape closes the foreground help');
    assert.equal(Boolean(document.querySelector('[data-auxiliary-view]')), true, `${title} stays behind help`);

    await React.act(async () => useStore.getState().openMessageWindow('fixture-message-1'));
    await settle();
    await press(document.body, 'Escape');
    assert.equal(Boolean(document.querySelector('[data-auxiliary-view]')), true, `${title} stays behind a message window`);
    await React.act(async () => useStore.getState().closeAllMessageWindows());

    // Contacts can remain selected behind an auxiliary screen without being foreground.
    await React.act(async () => useStore.getState().setShowContacts(true));
    if (title === 'MailFlow calendar') {
      await press(document.querySelector('.mf-calendar'), 'b');
      const dialog = document.querySelector('.mf-calendar-dialog');
      assert.ok(dialog, 'Foreground calendar retains New event shortcut');
      await press(dialog.querySelector('input'), 'Escape');
      assert.equal(Boolean(document.querySelector('.mf-calendar-dialog')), false);
      assert.ok(document.querySelector('.mf-calendar'), 'Calendar editor owns its dismissal');
    }
    await press(document.body, 'Escape');
    assert.equal(Boolean(document.querySelector('[data-auxiliary-view]')), false, `${title} still handles foreground Escape`);
    await React.act(async () => useStore.getState().setShowContacts(false));
  }
  assert.equal(fixture.sent.length, 0);
  assert.deepEqual(unsupported, []);
});
