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
fixture.messages[0].cc_addresses = [{ email: 'review@northstar.example', address: 'review@northstar.example' }];
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

const focusBody = () => document.activeElement?.blur();
const waitSearch = async () => React.act(async () => new Promise(resolve => setTimeout(resolve, 380)));

test('reference keyboard actions run through the native workspace and isolated provider fixture', async t => {
  await React.act(async () => root.render(React.createElement(BrowserRouter, { future: { v7_startTransition: true, v7_relativeSplatPath: true } }, React.createElement(App))));
  await settle();
  await t.test('arrow navigation opens the drawer, highlights destinations and opens the focused conversation', async () => {
    focusBody(); await key('ArrowLeft');
    assert.ok(document.querySelector('#superhuman-folders'));
    await key('ArrowDown');
    assert.ok(document.activeElement.matches('[data-mailbox-row]'));
    await key('ArrowRight');
    assert.equal(Boolean(document.querySelector('#superhuman-folders')), false);
    await React.act(async () => useStore.getState().setSelectedAccount(null, 'INBOX'));
    await settle();
    await React.act(async () => document.querySelector('[data-msgid="fixture-message-1"] [role=listitem]').focus());
    await key('ArrowRight');
    assert.equal(useStore.getState().selectedMessageId, 'fixture-message-1');
    focusBody(); await key('ArrowRight');
    assert.equal(useStore.getState().composing, false, 'Right never replies from the reader');
    await click(button('Back'));
  });
  await t.test('drawer account headers selected by arrows activate their native Inbox on Enter', async () => {
    await React.act(async () => useStore.getState().setSelectedAccount(null, 'INBOX'));
    await settle(); focusBody(); await key('ArrowLeft');
    await key('ArrowDown'); await key('ArrowDown');
    assert.match(document.activeElement.textContent, /Northstar/);
    await key('Enter');
    assert.equal(useStore.getState().selectedAccountId, 'fixture-work');
    assert.equal(useStore.getState().selectedFolder, 'INBOX');
    assert.equal(Boolean(document.querySelector('#superhuman-folders')), false);
  });
  await t.test('reader Enter replies to everyone, while native controls, IME and modal contexts retain their keys', async () => {
    await React.act(async () => useStore.getState().setSelectedMessage('fixture-message-1'));
    await settle(); focusBody(); await key('Enter');
    assert.equal(useStore.getState().composing, true);
    assert.equal(useStore.getState().composeData.isReplyAll, true, 'Enter must use reply-all, not the user reply default');
    assert.match(JSON.stringify(useStore.getState().composeData.cc), /review@northstar.example/);
    await click(button('Discard'));
    await React.act(async () => button('Back').focus()); await key('Enter');
    assert.equal(useStore.getState().composing, false);
    focusBody(); await key('Enter', { isComposing: true });
    assert.equal(useStore.getState().composing, false);
    await click(button('Back'));
  });
  await t.test('Unread and Starred filter real synced messages and undo the filter on repeat', async () => {
    focusBody(); await key('U', { shiftKey: true });
    assert.ok(fixture.requests.some(r => r.query.unreadOnly === 'true'));
    assert.ok([...document.querySelectorAll('.sh-mail-row')].every(row => row.dataset.unread === 'true'));
    await key('U', { shiftKey: true, repeat: true });
    assert.match(useStore.getState().listFilter, /unread/, 'holding the key does not toggle the filter back off');
    await key('U', { shiftKey: true });
    await key('S', { shiftKey: true }); await waitSearch();
    assert.match(useStore.getState().searchQuery, /is:starred/);
    assert.equal(useStore.getState().searchResults.length, 2);
    await key('S', { shiftKey: true }); await waitSearch();
    assert.equal(useStore.getState().searchQuery, '');
  });
  await t.test('reader archive exposes one visible native Undo and Z cancels its pending provider operation', async () => {
    await React.act(async () => {
      useStore.getState().setSelectedAccount('fixture-work', 'INBOX');
      useStore.setState({ notifications: [], afterRemove: 'next' });
    });
    await settle();
    await React.act(async () => useStore.getState().setSelectedMessage('fixture-message-1'));
    await settle(); focusBody(); await key('e');
    const undoButtons = [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Undo');
    assert.equal(undoButtons.length, 1, 'only one host owns the pending notification');
    for (let node = undoButtons[0]; node; node = node.parentElement) assert.notEqual(node.style.display, 'none', 'Undo is visible outside the hidden list');
    assert.equal(fixture.messages[0].folder, 'INBOX');
    await click(undoButtons[0]);
    assert.ok(useStore.getState().messages.some(m => m.id === 'fixture-message-1'));
    await React.act(async () => useStore.setState({ notifications: [], selectedMessageId: 'fixture-message-1' }));
    await settle(); focusBody(); await key('e');
    await key('z');
    assert.ok(useStore.getState().messages.some(m => m.id === 'fixture-message-1'));
    assert.equal(useStore.getState().notifications.length, 0);
    assert.equal(fixture.mutations.some(m => m.pathname.endsWith('bulk-archive')), false, 'both Undo paths cancel before the provider request');
    await React.act(async () => useStore.getState().setSelectedMessage(null));
    await settle();
  });
  await t.test('scheduled and reader navigation preserve the single global Superhuman undo host', async () => {
    const { SCHEDULED_VIEW } = await import('../utils/scheduledCompose.js');
    await React.act(async () => useStore.getState().addNotification({ title: 'Pending action', onUndo() {} }));
    const undo = button('Undo');
    assert.ok(undo);
    await React.act(async () => useStore.getState().setSelectedAccount(null, SCHEDULED_VIEW));
    await settle();
    assert.equal([...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Undo').length, 1, 'ScheduledList does not add a second timer or action bar');
    assert.equal(button('Undo'), undo, 'the original action bar stays mounted');
    await React.act(async () => { useStore.getState().setSelectedAccount('fixture-work', 'INBOX'); useStore.setState({ notifications: [] }); });
    await settle();
  });
  await t.test('Shift E returns an archived conversation using the native move endpoint and undo window', async () => {
    fixture.messages[0].folder = 'Archive';
    await React.act(async () => useStore.getState().setSelectedAccount('fixture-work', 'Archive'));
    await settle();
    await React.act(async () => document.querySelector('[data-msgid="fixture-message-1"] [role=listitem]').focus());
    await key('E', { shiftKey: true });
    assert.equal(Boolean(document.querySelector('[data-msgid="fixture-message-1"]')), false);
    assert.equal(fixture.messages[0].folder, 'Archive', 'provider move waits for Undo');
    focusBody(); await key('z');
    assert.ok(document.querySelector('[data-msgid="fixture-message-1"]'));
    assert.equal(fixture.messages[0].folder, 'Archive');
    await React.act(async () => document.querySelector('[data-msgid="fixture-message-1"] [role=listitem]').focus());
    await key('E', { shiftKey: true });
    const { flushUndoables } = await import('../utils/undoableAction.js');
    await React.act(async () => { flushUndoables(); await new Promise(resolve => setTimeout(resolve, 30)); });
    assert.equal(fixture.messages[0].folder, 'INBOX');
    assert.ok(fixture.mutations.some(m => m.pathname.endsWith('bulk-move') && m.body.folder === 'INBOX'));
    assert.equal(useStore.getState().notifications.some(n => n.type === 'error'), false, 'confirmed provider moves do not report failure');
  });
  await t.test('N/P traverse the native conversation cards and stop at the edges', async () => {
    fixture.messages[1].thread_id = fixture.messages[0].thread_id;
    fixture.messages[1].thread_key = fixture.messages[0].thread_key;
    fixture.messages[0].message_count = 2;
    fixture.messages[1].message_count = 2;
    await React.act(async () => {
      useStore.getState().setSelectedAccount('fixture-work', 'INBOX');
      useStore.setState({ conversationMode: 'pane', threadedView: false });
    });
    await settle();
    await React.act(async () => document.querySelector('[data-msgid="fixture-message-1"] [role=listitem]').focus());
    await key('ArrowRight');
    assert.ok(document.querySelector('[data-conversation-navigation]'));
    focusBody(); await key('p');
    assert.equal(useStore.getState().selectedMessageId, 'fixture-message-2');
    await key('p');
    assert.equal(useStore.getState().selectedMessageId, 'fixture-message-2', 'previous stops at the oldest card');
    await key('n');
    assert.equal(useStore.getState().selectedMessageId, 'fixture-message-1');
    await key('n');
    assert.equal(useStore.getState().selectedMessageId, 'fixture-message-1', 'next stops at the newest card');
    await click(button('Back'));
  });
  await t.test('new list keys respect editors, modal ownership, custom unbinding and ordinary layouts', async () => {
    const press = async (value, target = document.body, options = {}) => {
      const event = new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options });
      await React.act(async () => target.dispatchEvent(event)); await settle(); return event;
    };
    const search = document.querySelector('.sh-list-search input');
    for (const value of ['U', 'S', 'E']) {
      assert.equal((await press(value, search, { shiftKey: true })).defaultPrevented, false);
      assert.equal((await press(value, document.body, { shiftKey: true, isComposing: true })).defaultPrevented, false);
    }
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); document.body.append(dialog);
    assert.equal((await press('S', document.body, { shiftKey: true })).defaultPrevented, false);
    dialog.remove();
    await React.act(async () => useStore.setState({ shortcuts: { filterStarred: null } }));
    assert.equal((await press('S', document.body, { shiftKey: true })).defaultPrevented, false);
    await React.act(async () => useStore.setState({ shortcuts: {}, layout: 'comfortable' }));
    assert.equal((await press('S', document.body, { shiftKey: true })).defaultPrevented, false);
    assert.equal((await press('ArrowLeft')).defaultPrevented, false);
    await React.act(async () => useStore.setState({ layout: 'superhuman' }));
  });
  assert.deepEqual(fixture.sent, []);
  assert.deepEqual(unsupported, []);
});
