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
fixture.preferences = { ...fixture.preferences, layout: 'superhuman', theme: 'superhuman', markReadBehavior: 'manual', categorizationEnabled: false,
  enabledPlugins: ['private-notes'], hideEmptySplits: true,
  savedSplits: [{ id: 'starred', label: 'Starred', query: 'is:starred' }, { id: 'absent', label: 'Absent', query: 'from:nobody@nowhere.invalid' }],
};
fixture.messages[1].thread_id = fixture.messages[0].thread_id;
fixture.messages[1].thread_key = fixture.messages[0].thread_key;
fixture.messages[0].message_count = 2;
fixture.messages[1].message_count = 2;

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
const button = label => [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label || b.textContent.trim() === label || b.title === label);
const key = async (key, options = {}) => { await React.act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }))); await settle(); };
const background = async () => React.act(async () => document.activeElement?.blur?.());
const changeState = async state => React.act(async () => useStore.setState(state));
const press = async (value, target = document.body, options = {}) => {
  const event = new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options });
  await React.act(async () => target.dispatchEvent(event)); await settle(); return event;
};

test('reference keys operate native mail and respect focus, modal, identity and layout guards', async () => {
  await React.act(async () => root.render(React.createElement(BrowserRouter, { future: { v7_startTransition: true, v7_relativeSplatPath: true } }, React.createElement(App))));
  await settle();
  assert.ok(document.querySelector('.superhuman-shell'));
  await background();
  await press('Tab');
  assert.equal(useStore.getState().activeSavedSplitId, 'starred');
  await press('Tab', document.body, { shiftKey: true });
  assert.equal(useStore.getState().activeSavedSplitId, null);
  // Hidden zero-count splits are not keyboard destinations, and the cycle wraps.
  await press('Tab', document.body, { shiftKey: true });
  assert.equal(useStore.getState().activeSavedSplitId, 'starred');
  await press('Tab');
  assert.equal(useStore.getState().activeSavedSplitId, null);
  for (const target of [button('Compose'), document.querySelector('.sh-list-search input'), document.querySelector('.sh-list-options summary')]) {
    assert.equal((await press('Tab', target)).defaultPrevented, false);
    assert.equal(useStore.getState().activeSavedSplitId, null);
  }
  await changeState({ searchQuery: 'launch' });
  assert.equal((await press('Tab')).defaultPrevented, false, 'ordinary search retains Tab');
  await changeState({ searchQuery: '' }); await settle();
  await changeState({ listFocusedMessageId: 'fixture-message-1' });
  await press('u'); assert.equal(fixture.messages[0].is_read, true);
  await press('u'); assert.equal(fixture.messages[0].is_read, false);
  await press('m'); assert.equal(fixture.messages[0].is_read, false, 'M never marks list rows read');
  await press('l');
  assert.ok(document.querySelector('[role="dialog"]'), 'L opens the native copy/label picker');
  assert.match(document.querySelector('[role="dialog"] input').placeholder, /label|folder/i);
  await key('Escape'); await background();
  await press('v');
  assert.ok(document.querySelector('[role="menu"], [role="dialog"]'), 'V opens native move destinations: ' + document.body.textContent.slice(-1000));
  assert.match(document.querySelector('[role="menu"], [role="dialog"]').textContent, /Archive/);
  await key('Escape'); await background();
  assert.equal(fixture.mutations.some(item => /move|copy/.test(item.pathname)), false, 'opening pickers never mutates mail');
  const ignoredTargets = document.createElement('div');
  ignoredTargets.innerHTML = '<textarea></textarea><div contenteditable="true"><span>Editor</span></div><button>Action</button><a href="#">Link</a><div role="textbox"><span>Textbox</span></div>';
  document.body.append(ignoredTargets);
  const initialRead = fixture.messages[0].is_read;
  for (const target of [ignoredTargets.querySelector('textarea'), ignoredTargets.querySelector('[contenteditable] span'), ignoredTargets.querySelector('button'), ignoredTargets.querySelector('a'), ignoredTargets.querySelector('[role="textbox"] span')]) {
    for (const value of ['u', 'v', 'l', 'm', 'n', 'p', 'Tab']) assert.equal((await press(value, target)).defaultPrevented, false);
  }
  ignoredTargets.remove();
  for (const value of ['u', 'v', 'l', 'm', 'n', 'p', 'Tab']) {
    assert.equal((await press(value, document.body, { isComposing: true })).defaultPrevented, false);
    assert.equal((await press(value, document.body, { keyCode: 229 })).defaultPrevented, false);
  }
  assert.equal(fixture.messages[0].is_read, initialRead);
  const modal = document.createElement('div'); modal.setAttribute('role', 'dialog'); document.body.append(modal);
  for (const value of ['u', 'v', 'l', 'm', 'n', 'p', 'Tab']) assert.equal((await press(value)).defaultPrevented, false);
  modal.remove();
  await changeState({ shortcuts: { gtdReference: 'v', toggleRead: 'm', openLabelPicker: null } });
  await press('m'); assert.equal(fixture.messages[0].is_read, true, 'explicit M read binding remains authoritative');
  assert.equal((await press('l')).defaultPrevented, false);
  assert.equal((await press('v')).defaultPrevented, false, 'disabled GTD action does not silently become Move');
  await changeState({ shortcuts: {}, conversationMode: 'pane' });
  await press('Enter'); await settle();
  assert.ok(document.querySelector('[data-conversation-navigation]'));
  assert.equal((await press('Tab')).defaultPrevented, false, 'reader keeps natural link navigation');
  await press('p');
  assert.equal(useStore.getState().selectedMessageId, 'fixture-message-2');
  assert.equal(document.querySelector('[data-message-id="fixture-message-2"] > button').getAttribute('aria-expanded'), 'true');
  await press('p'); assert.equal(useStore.getState().selectedMessageId, 'fixture-message-2', 'traversal stops at the first card');
  await press('n'); assert.equal(useStore.getState().selectedMessageId, 'fixture-message-1');
  await press('n'); assert.equal(useStore.getState().selectedMessageId, 'fixture-message-1', 'traversal stops at the last card');
  await press('m');
  assert.equal(document.activeElement.getAttribute('aria-label'), 'Add a private note');
  assert.equal(document.activeElement.dataset.privateNoteMessageId, 'fixture-message-1');
  await background();
  await changeState({ enabledPlugins: [] });
  assert.equal((await press('m')).defaultPrevented, false, 'disabled notes never captures M');
  await changeState({ messageWindows: [{ id: 'guard-window', messageId: 'fixture-message-3', z: 999, minimized: false }] });
  const selected = useStore.getState().selectedMessageId;
  await press('p'); assert.equal(useStore.getState().selectedMessageId, selected, 'a foreground window owns reader navigation');
  await changeState({ messageWindows: [], selectedMessageId: null, layout: 'comfortable' });
  assert.equal((await press('Tab')).defaultPrevented, false);
  assert.equal((await press('n')).defaultPrevented, false);
  assert.equal((await press('p')).defaultPrevented, false);
  await changeState({ layout: 'superhuman', listFocusedMessageId: 'fixture-message-3' });
  await press('M', document.body, { shiftKey: true, isComposing: true });
  assert.equal(fixture.messages[2].folder, 'INBOX', 'IME never mutes');
  await press('M', document.body, { shiftKey: true }); await settle();
  assert.equal(fixture.messages[2].folder, 'Archive', 'Shift+M persists mute and archives the captured Inbox message');
  const savedMute = Object.values(fixture.mutedThreads).find(item => item.muted);
  assert.ok(savedMute?.revision);
  const muteArchive = fixture.mutations.find(item => item.pathname.endsWith('bulk-archive') && item.body.muteGuard);
  assert.equal(muteArchive.body.muteGuard.messageId, 'fixture-message-3');
  await React.act(async () => button('Muted conversations').click()); await settle();
  assert.ok(document.querySelector('[data-auxiliary-view]'));
  const mutedSubject = [...document.querySelectorAll('[data-auxiliary-view] button')].find(node => node.textContent === fixture.messages[2].subject);
  assert.ok(mutedSubject);
  await React.act(async () => mutedSubject.click()); await settle();
  assert.equal(useStore.getState().selectedMessageId, 'fixture-message-3');
  assert.equal(useStore.getState().selectedFolder, 'Archive');
  assert.ok(button('Unmute conversation'));
  await React.act(async () => button('Unmute conversation').click()); await settle();
  assert.equal(fixture.messages[2].folder, 'Archive', 'unmute never moves mail back to Inbox');
  assert.equal(Object.values(fixture.mutedThreads).some(item => item.muted), false);
  assert.deepEqual(unsupported, []);
});
