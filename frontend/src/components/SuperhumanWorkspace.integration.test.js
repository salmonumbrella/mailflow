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
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input), window.location.origin);
  assert.equal(url.origin, window.location.origin, 'integration never requests another origin');
  const result = handleFixtureApi(fixture, options.method || 'GET', url.pathname, url.searchParams, options.body ? JSON.parse(options.body) : undefined);
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
const key = async (key, options = {}) => { await React.act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }))); await settle(); };
const input = async (element, value) => {
  assert.ok(element);
  await React.act(async () => {
    const prototype = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await settle();
};

test('native fictional workspace covers opt-in, search, commands, keyboard actions, reader, compose, accounts, and exit', async () => {
  await React.act(async () => root.render(React.createElement(BrowserRouter, { future: { v7_startTransition: true, v7_relativeSplatPath: true } }, React.createElement(App))));
  await settle();
  assert.match(document.body.textContent, /Launch review: final details/);
  assert.equal(document.querySelector('.superhuman-shell'), null);
  await key('k', { ctrlKey: true });
  await click([...document.querySelectorAll('[role=option]')].find(e => e.textContent.includes('Use Superhuman workspace')));
  assert.equal(useStore.getState().theme, 'superhuman');
  assert.equal(useStore.getState().layout, 'superhuman');
  assert.ok(document.querySelector('.superhuman-shell'));
  assert.ok(document.querySelector('.sh-mail-row'));
  await input(document.querySelector('.sh-list-search input'), 'launch');
  await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
  assert.equal(useStore.getState().searchQuery, 'launch');
  assert.equal(document.querySelectorAll('.sh-mail-row').length, 1);
  await input(document.querySelector('.sh-list-search input'), '');
  await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
  assert.ok(useStore.getState().messages.length > 1);
  // Keyboard navigation and mutations travel through native handlers and the real API client.
  await React.act(async () => document.querySelector('[data-msgid="fixture-message-1"] [role=listitem]').focus());
  assert.equal(useStore.getState().listFocusedMessageId, 'fixture-message-1');
  assert.equal(useStore.getState().selectedMessageId, null, 'J focuses without opening a reader');
  await key('j');
  assert.equal(useStore.getState().listFocusedMessageId, 'fixture-message-2');
  await key('k');
  assert.equal(useStore.getState().listFocusedMessageId, 'fixture-message-1');
  await key('x');
  assert.equal(document.querySelector('[data-msgid="fixture-message-1"]').dataset.checked, 'true');
  await key('Escape');
  assert.equal(document.querySelector('[data-msgid="fixture-message-1"]').dataset.checked, 'false');
  await click(button('Commands'));
  await click([...document.querySelectorAll('[role=option]')].find(e => e.textContent.includes('Remove star')));
  assert.equal(fixture.messages[0].is_starred, false, 'palette command reaches the native focused row action');
  await key('u');
  assert.equal(fixture.messages[0].is_read, true);
  await key('u');
  assert.equal(fixture.messages[0].is_read, false);
  await key('e');
  assert.equal(document.querySelector('[data-msgid="fixture-message-1"]'), null);
  assert.equal(fixture.messages[0].folder, 'INBOX', 'archive waits for its undo window');
  await key('z');
  assert.ok(document.querySelector('[data-msgid="fixture-message-1"]'));
  assert.equal(fixture.mutations.some(m => m.pathname.endsWith('bulk-archive')), false);
  await click([...document.querySelectorAll('.sh-list-tab')].find(b => b.textContent.startsWith('Newsletters')));
  assert.equal(document.querySelectorAll('.sh-mail-row').length, 1);
  assert.match(document.querySelector('.sh-mail-row').textContent, /Good ideas, delivered slowly/);
  await click([...document.querySelectorAll('.sh-list-tab')].find(b => b.textContent.startsWith('Primary')));
  await React.act(async () => document.querySelector('[data-msgid="fixture-message-1"] [role=listitem]').focus());
  await key('Enter');
  assert.ok(useStore.getState().selectedMessageId);
  assert.match(document.body.textContent, /Launch review: final details/);
  await click(button('Reply'));
  assert.equal(useStore.getState().composing, true);
  assert.match(useStore.getState().composeData.subject, /Launch review/);
  await click(button('Discard'));
  assert.equal(useStore.getState().composing, false);
  await click(button('Back'));
  assert.equal(useStore.getState().selectedMessageId, null);
  await click(button('Folders and accounts'));
  assert.ok(document.querySelector('#superhuman-folders'));
  await key('Escape');
  assert.equal(document.querySelector('#superhuman-folders'), null);
  await click(button('Folders and accounts'));
  await click([...document.querySelectorAll('[data-mailbox-row]')].find(row => row.textContent.includes('alex@personal.example')));
  assert.equal(useStore.getState().selectedAccountId, 'fixture-personal');
  assert.equal(document.querySelectorAll('.sh-mail-row').length, 1);
  assert.match(document.querySelector('.sh-mail-row').textContent, /Saturday by the coast/);
  await click(button('All Inboxes'));
  assert.equal(useStore.getState().selectedAccountId, null);
  await click(button('Compose'));
  assert.equal(useStore.getState().composing, true);
  await click(button('Open snippets'));
  await click(button('New snippet'));
  await input(document.querySelector('[aria-label="Snippet title"]'), 'Fictional hello');
  await input(document.querySelector('[aria-label="Snippet body"]'), 'Thanks for the thoughtful review.');
  await click(button('Save snippet'));
  assert.equal(fixture.snippets.length, 1);
  await click(button('Close snippets'));
  await click(button('Discard'));
  assert.equal(useStore.getState().composing, false);

  await click(button('Manage splits'));
  await click(button('Add split'));
  await input(document.querySelector('[aria-label="Split 1 name"]'), 'Launch');
  await input(document.querySelector('[aria-label="Split 1 query"]'), 'launch');
  await click(button('Save splits'));
  assert.equal(fixture.preferences.savedSplits.length, 1);
  await click([...document.querySelectorAll('.sh-saved-splits .sh-list-tab')].find(node => node.textContent.startsWith('Launch')));
  await React.act(async () => new Promise(resolve => setTimeout(resolve, 350)));
  assert.equal(document.querySelectorAll('.sh-mail-row').length, 1);
  await click([...document.querySelectorAll('.sh-saved-splits .sh-list-tab')].find(node => node.textContent === 'Inbox'));

  // Activation uses the real store action and authenticated API contract, never a live account.
  await React.act(async () => useStore.getState().setPluginActivated('local-calendar', true));
  await click(button('MailFlow calendar'));
  assert.ok(document.querySelector('.mf-calendar'));
  assert.deepEqual(fixture.calendar.calendars, []);
  await click(button('Add calendar'));
  await input(document.querySelector('[role="dialog"] input[maxlength="100"]'), 'Fictional personal');
  await click(button('Save'));
  assert.equal(fixture.calendar.calendars.length, 1);
  await click(document.querySelector('[data-new-event]'));
  await input(document.querySelector('[role="dialog"] input[maxlength="300"]'), 'Local planning session');
  await click(button('Save event'));
  assert.equal(fixture.events.length, 1);
  assert.match(document.querySelector('.mf-calendar').textContent, /Local planning session/);
  await click(button('← Mail'));
  assert.equal(document.querySelector('.mf-calendar'), null);

  await React.act(async () => useStore.getState().setPluginActivated('private-notes', true));
  await React.act(async () => document.querySelector('[data-msgid="fixture-message-1"] [role=listitem]').focus());
  await key('Enter');
  assert.ok(document.querySelector('[aria-label="Sender context"]'));
  await input(document.querySelector('[aria-label="Add a private note"]'), 'Keep this fictional detail private.');
  await click(button('Save note'));
  assert.match(document.body.textContent, /Keep this fictional detail private/);
  assert.equal(Object.values(fixture.privateNotes)[0].notes.length, 1);
  await click(button('Back'));
  await click(button('Email open activity'));
  assert.match(document.body.textContent, /Image loads are not proof/);
  await click(button('Back to mail'));
  await React.act(async () => useStore.getState().setLayout('comfortable'));
  assert.equal(document.querySelector('.superhuman-shell'), null);
  assert.equal(useStore.getState().theme, 'superhuman', 'layout exit does not silently change the chosen theme');
  assert.deepEqual(fixture.sent, []);
  assert.deepEqual(unsupported, []);
});
