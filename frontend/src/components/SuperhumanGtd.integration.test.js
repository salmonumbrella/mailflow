// Native component integration, not visual/browser coverage. Every API request is served
// by the same isolated fixture as the optional localhost preview; nothing can reach a provider.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';
import { createFixtureState, handleFixtureApi } from '../../../scripts/superhuman-layout-fixture.mjs';

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
fixture.preferences.layout = 'superhuman';
fixture.preferences.markReadBehavior = 'manual';
fixture.preferences.replyDefault = 'reply';
fixture.preferences.enabledPlugins = ['gtd'];
fixture.accounts[0].gtd_enabled = true;
// Label copies are deliberately absent from the Inbox response.
const todoRows = fixture.messages.slice(4, 6).map(message => ({ ...message, folder: 'Todo' }));
for (const row of todoRows) fixture.messages.find(message => message.id === row.id).folder = row.folder;
const waitingRow = { ...fixture.messages[6], folder: 'Watch', gist: 'Waiting on a fictional reply' };
fixture.messages[6].folder = 'Watch';
const sections = {
  todo: { threads: todoRows, total: 2, unread: 2 },
  watch: { threads: [waitingRow], total: 1, unread: 0 },
  delegated: { threads: [{ ...waitingRow, folder: 'Delegated' }], total: 1, unread: 0 },
  reference: { threads: [], total: 0, unread: 0 }, someday: { threads: [], total: 0, unread: 0 },
};
const gtdMutations = [];
let failSnooze = false;
fixture.messages[0].cc_addresses = [{ email: 'review@northstar.example', address: 'review@northstar.example' }];
const unsupported = [];
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input), window.location.origin);
  assert.equal(url.origin, window.location.origin, 'integration never requests another origin');
  if (url.pathname === '/api/gtd/sections') return { ok: true, status: 200, json: async () => ({ sections: structuredClone(sections) }) };
  if (url.pathname === '/api/plugins') return { ok: true, status: 200, json: async () => [{ id: 'gtd', activated: true }] };
  if (url.pathname === '/api/gtd/metadata') return { ok: true, status: 200, json: async () => ({}) };
  if (url.pathname.endsWith('/snooze') && failSnooze) return { ok: false, status: 500, json: async () => ({ error: 'Fictional snooze failed' }) };
  if (url.pathname === '/api/gtd/done') {
    gtdMutations.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
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
const key = async (key, options = {}) => { await React.act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }))); await settle(); };

const focusBody = () => document.activeElement?.blur();



test('Superhuman GTD header, dense triage and keyboard parity use native primitives', async t => {
  await React.act(async () => root.render(React.createElement(BrowserRouter, { future: { v7_startTransition: true, v7_relativeSplatPath: true } }, React.createElement(App))));
  await settle();
  const tabs = () => [...document.querySelectorAll('.sh-list-tab')];
  const tab = name => tabs().find(button => button.textContent.startsWith(name));
  await t.test('GTD tabs precede category splits with unread badges and no legacy second bar', async () => {
    assert.deepEqual(tabs().map(button => button.firstChild.textContent), ['Inbox', 'Todo', 'Waiting', 'Reference', 'Someday', 'Primary', 'Newsletters', 'Promotions', 'Automated', 'Social']);
    assert.equal(tab('Inbox').getAttribute('aria-pressed'), 'true');
    assert.equal(tab('Todo').querySelector('[aria-label="2 Unread"]').textContent, '2');
    assert.equal([...document.querySelectorAll('.sh-mail-list button')].filter(button => button.textContent.startsWith('Todo')).length, 1);
    await click(tab('Todo'));
  });
  await t.test('j/k highlight visible GTD rows; Enter opens through GTD and Escape returns to that list', async () => {
    assert.equal(useStore.getState().activeGtdTab, 'todo');
    assert.deepEqual([...document.querySelectorAll('.sh-mail-scroll .sh-mail-row')].map(row => row.dataset.msgid), todoRows.map(row => row.id));
    assert.equal(useStore.getState().listFocusedMessageId, todoRows[0].id);
    focusBody(); await key('j');
    assert.equal(useStore.getState().listFocusedMessageId, todoRows[1].id);
    assert.equal(useStore.getState().selectedMessageId, null);
    await key('k');
    assert.equal(useStore.getState().listFocusedMessageId, todoRows[0].id);
    await key('j'); await key('Enter');
    assert.equal(useStore.getState().selectedMessageId, todoRows[1].id);
    assert.ok(document.querySelector('.superhuman-reader'));
    focusBody(); await key('k');
    assert.equal(useStore.getState().selectedMessageId, todoRows[0].id, 'reader navigation stays in this GTD list');
    await key('j');
    assert.equal(useStore.getState().selectedMessageId, todoRows[1].id);
    focusBody(); await key('Escape');
    assert.equal(useStore.getState().selectedMessageId, null);
    assert.equal(useStore.getState().activeGtdTab, 'todo');
    assert.equal(useStore.getState().listFocusedMessageId, todoRows[1].id);
  });
  await t.test('Command K targets the highlighted GTD row and its native star action', async () => {
    focusBody(); await key('k', { metaKey: true });
    const input = document.querySelector('[role="combobox"]');
    assert.ok(input, 'native command palette opens');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'star message');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    const star = [...document.querySelectorAll('[role="option"]')].find(option => option.textContent.includes('Star message'));
    assert.ok(star);
    assert.notEqual(star.getAttribute('aria-disabled'), 'true');
    await click(star);
    assert.equal(fixture.messages.find(row => row.id === todoRows[1].id).is_starred, true);
    assert.equal(useStore.getState().gtdSections.todo.threads[1].is_starred, true);
    assert.equal(useStore.getState().selectedMessageId, null);
  });
  await t.test('GTD snooze removes the section row and failure restores it without changing inbox counts', async () => {
    await React.act(async () => useStore.setState({ listFocusedMessageId: todoRows[0].id }));
    const before = structuredClone(useStore.getState().unreadCounts);
    failSnooze = true;
    focusBody(); await key('h');
    const tomorrow = [...document.querySelectorAll('[data-keyboard-menu-item]')].find(button => button.textContent.includes('Tomorrow morning'));
    assert.ok(tomorrow);
    await click(tomorrow);
    failSnooze = false;
    assert.deepEqual(useStore.getState().unreadCounts, before);
    assert.ok(useStore.getState().gtdSections.todo.threads.some(row => row.id === todoRows[0].id));
    await React.act(async () => useStore.setState({ listFocusedMessageId: todoRows[0].id }));
    focusBody(); await key('h');
    await click([...document.querySelectorAll('[data-keyboard-menu-item]')].find(button => button.textContent.includes('Tomorrow morning')));
    assert.equal(useStore.getState().gtdSections.todo.threads.some(row => row.id === todoRows[0].id), false);
    assert.equal(fixture.messages.find(row => row.id === todoRows[0].id).folder, 'Snoozed');
    sections.todo = { threads: [todoRows[1]], total: 1, unread: 1 };
    await React.act(async () => useStore.setState({ listFocusedMessageId: todoRows[1].id }));
  });
  await t.test('GTD tabs reject invisible bulk selection and keep archive section-scoped', async () => {
    const { shortcutBus } = await import('../utils/shortcutBus.js');
    focusBody(); await key('x');
    assert.equal(document.querySelector('.sh-list-bulk'), null);
    await React.act(async () => shortcutBus.emit('archive'));
    assert.deepEqual(gtdMutations.at(-1), { id: todoRows[1].id, states: ['todo'] });
    assert.equal(fixture.mutations.some(mutation => mutation.pathname.includes('bulk-archive')), false);
  });
  await t.test('Waiting keeps merged section actions in hover and keyboard context menus', async () => {
    await click(tab('Waiting'));
    const row = document.querySelector('.sh-mail-scroll .sh-mail-row-content');
    assert.ok(row);
    assert.match(row.textContent, /Waiting on a fictional reply/);
    await React.act(async () => row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 70, clientY: 80 })));
    assert.ok(document.querySelector('[data-keyboard-menu-item]'));
    await key('Escape');
    assert.equal(document.querySelector('[data-keyboard-menu-item]'), null);
    const done = row.querySelector('[title="Mark done"]');
    assert.ok(done, 'existing GTD hover action is retained');
    await click(done);
    assert.deepEqual(gtdMutations.at(-1), { id: waitingRow.id, states: ['watch', 'delegated'] });
  });
  await t.test('scroll edge buttons reach later splits and Inbox restores all categories', async () => {
    const strip = document.querySelector('.sh-list-tabs');
    Object.defineProperties(strip, { clientWidth: { configurable: true, value: 200 }, scrollWidth: { configurable: true, value: 800 } });
    const scrolls = [];
    strip.scrollBy = options => scrolls.push(options);
    await React.act(async () => strip.dispatchEvent(new window.Event('scroll', { bubbles: true })));
    await click(document.querySelector('[aria-label="Scroll tabs right"]'));
    assert.deepEqual(scrolls.at(-1), { left: 120, behavior: 'smooth' });
    strip.scrollLeft = 600;
    await React.act(async () => strip.dispatchEvent(new window.Event('scroll', { bubbles: true })));
    assert.equal(document.querySelector('[aria-label="Scroll tabs right"]'), null);
    await click(document.querySelector('[aria-label="Scroll tabs left"]'));
    assert.deepEqual(scrolls.at(-1), { left: -120, behavior: 'smooth' });
    await click(tab('Social'));
    assert.equal(tabs().filter(button => button.getAttribute('aria-pressed') === 'true').length, 1);
    assert.equal(useStore.getState().activeGtdTab, null);
    assert.ok(fixture.requests.some(request => request.query.category === 'social'));
    await click(tab('Inbox'));
    assert.ok(fixture.requests.some(request => request.pathname === '/api/mail/messages' && !request.query.category));
    await React.act(async () => useStore.setState({ enabledPlugins: [] }));
    assert.deepEqual(tabs().map(button => button.firstChild.textContent), ['Primary', 'Newsletters', 'Promotions', 'Automated', 'Social']);
  });
  assert.deepEqual(unsupported, []);
});


test('Superhuman header measures scroll edges when its tab strip mounts', async () => {
  const Header = (await import('./SuperhumanListHeader.jsx')).default;
  const ref = React.createRef();
  let measures = 0;
  await React.act(async () => root.render(React.createElement(Header, {
    label: 'Inbox', count: 0, categories: [{ key: 'primary', label: 'Primary' }], activeCategory: 'primary',
    searchQuery: '', layout: 'superhuman', pageSize: 50, tabScrollRef: ref, onTabScroll: () => { measures++; },
  })));
  assert.ok(ref.current);
  assert.ok(measures > 0, 'measure the actual mounted strip, including late account/plugin initialization');
});
