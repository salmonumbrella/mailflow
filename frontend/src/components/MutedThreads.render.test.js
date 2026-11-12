import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) return { format: 'module', shortCircuit: true, source: 'export const useTranslation = () => ({ t: (k, d) => typeof d === "string" ? d : d?.defaultValue || k, i18n: { language: "en" } }); export const initReactI18next = { type: "3rdParty", init() {} };' };
  if (url.endsWith('.json')) return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
  const shim = code => code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
  if (url.endsWith('.jsx')) return { format: 'module', shortCircuit: true, source: shim(transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url }).code) };
  if (url.startsWith('file:') && url.endsWith('.js')) {
    const source = readFileSync(new URL(url), 'utf8');
    if (source.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: shim(source) };
  }
  return nextLoad(url, context);
} });
const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.invalid', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true, __VITE_ENV__: { MODE: 'test' } });
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const Panel = (await import('./MutedThreadsPanel.jsx')).default;
const Action = (await import('./MessageMuteAction.jsx')).default;
const original = { ...api };
const tMessage = { id: 'm1', account_id: 'a', folder: 'Archive', thread_id: 'thread', subject: 'Private subject', from_email: 'person@example.com', is_read: true };
const accounts = [{ id: 'a', enabled: true, name: 'Work' }, { id: 'b', enabled: true, name: 'Home' }];
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const reset = () => useStore.setState({ ...useStore.getInitialState(), user: { id: 'owner' }, accounts, layout: 'superhuman', selectedAccountId: 'a', selectedFolder: 'INBOX', selectedMessageId: null });
const mount = async (Component, props) => { const root = createRoot(document.getElementById('root')); await React.act(async () => root.render(React.createElement(Component, props))); return root; };
const unmount = root => React.act(async () => root.unmount());
const click = async node => { assert.ok(node); await React.act(async () => node.click()); };
const button = text => [...document.querySelectorAll('button')].find(node => node.textContent === text);

test('muted view paginates, unmutes using CAS, and opens a verified native message', async () => {
  reset(); const calls = []; let muted = true; let backs = 0;
  api.get = async path => {
    calls.push(path);
    if (path.endsWith('/mute')) return { muted, revision: 'rev' };
    if (path.includes('offset=100')) return { messages: [{ ...tMessage, id: 'm2', subject: 'Another thread' }], hasMore: false, nextOffset: null };
    return { messages: muted ? [tMessage] : [], hasMore: muted, nextOffset: muted ? 100 : null };
  };
  api.patch = async (path, body) => { assert.equal(path, '/mail/messages/m1/mute'); assert.deepEqual(body, { muted: false, revision: 'rev' }); muted = false; return { muted: false, revision: null }; };
  api.resolveMessage = async id => ({ ...tMessage, id });
  const root = await mount(Panel, { accountId: 'a', onBack: () => backs++ });
  try {
    assert.ok(button('Private subject')); await click(button('Load more'));
    assert.ok(button('Another thread')); assert.ok(calls.includes('/mail/muted?offset=100&account_id=a'));
    await click(button('Unmute conversation'));
    assert.equal(Boolean(button('Private subject')), false); assert.match(document.body.textContent, /No muted conversations/);
    muted = true; await click(button('Refresh')); await click(button('Private subject'));
    assert.equal(backs, 1); assert.equal(useStore.getState().selectedMessageId, 'm1');
    assert.equal(useStore.getState().selectedFolder, 'Archive');
    assert.deepEqual(useStore.getState().threadMessages.__dl_m1, [tMessage]);
  } finally { await unmount(root); Object.assign(api, original); }
});

test('account changes, account removal and lock discard stale list responses', async () => {
  for (const update of [{ selectedAccountId: 'b' }, { isLocked: true }, { user: { id: 'other' } }, { accounts: [accounts[1]] }]) {
    reset(); const delayed = defer(); let loads = 0; api.get = path => path.endsWith('/mute') ? Promise.resolve({ muted: true, revision: 'v' }) : ++loads === 1 ? delayed.promise : Promise.resolve({ messages: [], hasMore: false, nextOffset: null });
    const root = await mount(Panel, { accountId: 'a' });
    try {
      await React.act(async () => useStore.setState(update));
      await React.act(async () => delayed.resolve({ messages: [tMessage], hasMore: false, nextOffset: null }));
      assert.equal(Boolean(button('Private subject')), false);
    } finally { await unmount(root); Object.assign(api, original); }
  }
});

test('repeated opens and Back never apply stale message resolution', async () => {
  reset(); const resolve = defer(); let backs = 0;
  api.get = async path => path.endsWith('/mute') ? { muted: true, revision: 'v' } : { messages: [tMessage], hasMore: false, nextOffset: null };
  api.resolveMessage = () => resolve.promise;
  const root = await mount(Panel, { accountId: 'a', onBack: () => backs++ });
  await click(button('Private subject')); await unmount(root);
  await React.act(async () => resolve.resolve(tMessage));
  assert.equal(backs, 0); assert.equal(useStore.getState().selectedMessageId, null);
  Object.assign(api, original);
});

test('reader control reports conflicts without losing mute status or moving mail', async () => {
  reset(); api.get = async () => ({ muted: true, revision: 'old' });
  api.patch = async () => { throw new Error('Mute state changed. Refresh and try again.'); };
  let archives = 0; api.bulkArchive = async () => archives++;
  const root = await mount(Action, { message: tMessage });
  try {
    await click(button('Unmute conversation'));
    assert.match(document.querySelector('[role=alert]').textContent, /Mute state changed/);
    assert.ok(button('Unmute conversation')); assert.equal(archives, 0);
    await React.act(async () => useStore.setState({ isLocked: true }));
    assert.equal(document.querySelector('[data-mute-message-id]'), null);
  } finally { await unmount(root); Object.assign(api, original); }
});
