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

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const ComposeModal = (await import('./ComposeModal.jsx')).default;
const { api } = await import('../utils/api.js');


// Real shared protocol/session subscription; only transport and timer scheduling are held.
await import('../utils/markRead.js');
const { beginReadIntent, settleReadIntent } = await import('../utils/pendingReads.js');
const { setPendingDelete, clearDeleteGuard } = await import('../utils/pendingDeletes.js');
const account = { id: 'acct', enabled: true, email_address: 'owner@synthetic.test', aliases: [] };
const row = { id: 'parent', account_id: 'acct', folder: 'INBOX', thread_id: 'thread', is_read: true };
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = () => React.act(async () => { await new Promise(resolve => setImmediate(resolve)); });

async function setup() {
  const original = { post: api.post, getThread: api.getThread, timeout: globalThis.setTimeout,
    setter: useStore.getState().setThreadMessages };
  const timers = [], issued = [], publications = [];
  let bodyReads = 0;
  const observedRow = new Proxy(row, { get(target, key) {
    if (['id', 'account_id', 'is_read'].includes(key)) bodyReads++;
    return target[key];
  } });
  api.post = async (path) => { assert.equal(path, '/mail/send'); return { ok: true }; };
  api.getThread = async threadId => {
    assert.equal(threadId, 'thread');
    const request = defer(); issued.push(request); return request.promise;
  };
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === 3000 || delay === 10000) { const timer = { callback, delay, args }; timers.push(timer); return timer; }
    return original.timeout(callback, delay, ...args);
  };
  useStore.getState().setUser(null);
  useStore.getState().setUser({ id: 'owner' });
  useStore.getState().setLocked(false);
  useStore.setState({ accounts: [account], plaintextEmail: true, composing: true, notifications: [],
    prepareComposeSwitch: null, threadMessages: {},
    composeData: { accountId: 'acct', isReply: true, threadId: 'thread',
      to: ['recipient@synthetic.test'], subject: 'Re: Synthetic', body: 'Synthetic reply' },
    setThreadMessages: (id, rows) => { publications.push({ id, rows }); original.setter(id, rows); } });
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(ComposeModal)));
  await flush();
  const send = [...document.querySelectorAll('button')].find(button => button.textContent.includes('compose.send'));
  assert.ok(send);
  await React.act(async () => send.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  await flush();
  assert.deepEqual(timers.map(timer => timer.delay), [3000, 10000], 'existing post-send timelines retained');
  return { issued, publications, observedRow, reads: () => bodyReads,
    fire: index => timers[index].callback(...timers[index].args),
    async start(index) {
      const before = issued.length;
      // Invoke the actual timer callback produced by the mounted component. The GET stays held.
      const pending = timers[index].callback(...timers[index].args);
      assert.equal(issued.length, before + 1);
      return { request: issued.at(-1), pending };
    },
    async release(handle, rows = [observedRow]) {
      await React.act(async () => { handle.request.resolve({ messages: rows }); await handle.pending; });
    },
    async cleanup() {
      clearDeleteGuard(row.id);
      await React.act(async () => root.unmount());
      useStore.setState({ setThreadMessages: original.setter });
      useStore.getState().setUser(null);
      api.post = original.post; api.getThread = original.getThread; globalThis.setTimeout = original.timeout;
    },
  };
}

test('held old GET preserves later unread; each later timer captures a fresh request token', async () => {
  const h = await setup();
  try {
    const old = await h.start(0);
    const unread = beginReadIntent(row, false); settleReadIntent(unread);
    await h.release(old);
    assert.equal(h.publications.length, 1);
    assert.equal(h.publications[0].rows[0].is_read, false, 'old response cannot undo unread');
    const fresh = await h.start(1);
    await h.release(fresh);
    assert.equal(h.publications.length, 2);
    assert.equal(h.publications[1].rows[0].is_read, true, 'later authoritative GET can converge');
  } finally { await h.cleanup(); }
});

for (const transition of ['other-owner', 'same-user-relogin', 'lock-unlock']) {
  test(`held GET cannot reconcile or publish after ${transition}`, async () => {
    const h = await setup();
    try {
      const held = await h.start(0);
      await React.act(async () => {
        if (transition === 'other-owner') useStore.getState().setUser({ id: 'other' });
        if (transition === 'same-user-relogin') { useStore.getState().setUser(null); useStore.getState().setUser({ id: 'owner' }); }
        if (transition === 'lock-unlock') { useStore.getState().setLocked(true); useStore.getState().setLocked(false); }
      });
      const before = h.reads();
      await h.release(held);
      assert.equal(h.reads(), before, 'stale rows must not reach reconciliation');
      assert.deepEqual(h.publications, [], 'stale response must not enter thread cache');
    } finally { await h.cleanup(); }
  });
}

test('locked invocation issues no GET and an empty response keeps existing publication behavior', async () => {
  const h = await setup();
  try {
    await React.act(async () => useStore.getState().setLocked(true));
    const before = h.issued.length;
    await h.fire(0);
    assert.equal(h.issued.length, before, 'locked invocation never issues a GET');
    await React.act(async () => useStore.getState().setLocked(false));
    const fresh = await h.start(1);
    await h.release(fresh, []);
    assert.equal(h.issued.length, before + 1);
    assert.deepEqual(h.publications, []);
  } finally { await h.cleanup(); }
});

test('delete guard filters before reconciliation and prevents a deleted row advancing read fences', async () => {
  const h = await setup();
  try {
    const unread = beginReadIntent(row, false); settleReadIntent(unread);
    setPendingDelete(row.id);
    const hidden = await h.start(0);
    await h.release(hidden);
    assert.equal(h.publications.length, 1);
    assert.deepEqual(h.publications[0].rows, []);
    assert.equal(unread.read, false, 'a hidden authoritative row cannot overwrite the read fence');
  } finally { await h.cleanup(); }
});


test('rechecks session and lock immediately before publication after synchronous reconciliation', async () => {
  const h = await setup();
  try {
    const held = await h.start(0);
    let reset = false;
    const changingRow = new Proxy(row, { get(target, key) {
      if (key === 'account_id' && !reset) {
        reset = true;
        useStore.getState().setLocked(true);
      }
      return target[key];
    } });
    await h.release(held, [changingRow]);
    assert.equal(reset, true, 'actual read reconciliation examined the row');
    assert.deepEqual(h.publications, [], 'a reset during reconciliation cannot publish');
  } finally { await h.cleanup(); }
});
