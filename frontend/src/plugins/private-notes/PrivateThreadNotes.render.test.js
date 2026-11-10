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
const { useStore } = await import('../../store/index.js');
const { api } = await import('../../utils/api.js');
const { privateNotesApi } = await import('./api.js');
const Notes = (await import('./PrivateThreadNotes.jsx')).default;
const { default: SenderContext, exactSenderConversations } = await import('../../components/SenderContext.jsx');
const originalNotes = { ...privateNotesApi };
const message = { id: 'selected', account_id: 'a', thread_id: 'thread', from_email: 'first@example.com', from_name: 'First' };
const account = { id: 'a', email_address: 'owner@example.com', enabled: true };
const reset = () => useStore.setState({ user: { id: 'owner' }, isLocked: false, enabledPlugins: ['private-notes'], accounts: [account],
  markReadBehavior: 'manual', markReadDelay: 1, selectedMessageId: message.id, selectedAccountId: 'a', selectedFolder: 'INBOX', searchQuery: '', showContacts: false,
  messages: [message], searchResults: [], threadMessages: {}, folders: { a: [] }, messagesRefreshToken: 1,
});
const click = selector => React.act(async () => document.querySelector(selector).click());
const input = text => React.act(async () => {
  const textarea = document.querySelector('textarea');
  Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(textarea, text);
  textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
});
const mount = async (Component, props = {}) => {
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(Component, props)));
  return root;
};
const unmount = root => React.act(async () => root.unmount());
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('notes escape markup, preserve failed input, and reuse submission IDs on retry', async () => {
  reset();
  privateNotesApi.get = async () => ({ notes: [], version: null });
  const calls = [];
  privateNotesApi.add = async (_id, body) => {
    calls.push(body);
    if (calls.length === 1) throw new Error('Offline');
    return { notes: [{ id: body.requestId, text: body.text, createdAt: '2026-01-01T00:00:00Z' }], version: 'v1' };
  };
  const root = await mount(Notes, { message });
  try {
    await input('<img src=x onerror=alert(1)>');
    await click('button[type="submit"]');
    assert.equal(document.querySelector('textarea').value, '<img src=x onerror=alert(1)>');
    assert.match(document.querySelector('[role="alert"]').textContent, /Offline/);
    await click('button[type="submit"]');
    assert.equal(calls[0].requestId, calls[1].requestId);
    assert.equal(document.querySelector('textarea').value, '');
    assert.equal(document.querySelector('img'), null);
    assert.match(document.body.textContent, /<img src=x onerror=alert\(1\)>/);
    assert.match(document.body.textContent, /never sent with email/);
  } finally { await unmount(root); }
});

test('notes reconcile conflicts without losing unsaved text or deleting newer notes', async () => {
  reset();
  const existing = { id: 'existing', text: 'Another window', createdAt: '2026-01-01T00:00:00Z' };
  privateNotesApi.get = async () => ({ notes: [], version: null });
  let sent;
  privateNotesApi.add = async (_id, body) => {
    sent = body;
    if (body.version === null) throw Object.assign(new Error('Review latest notes'), { status: 409, data: { notes: [existing], version: 'v1' } });
    return { notes: [existing, { id: body.requestId, text: body.text, createdAt: existing.createdAt }], version: 'v2' };
  };
  privateNotesApi.remove = async () => { throw new Error('Delete failed'); };
  const root = await mount(Notes, { message });
  try {
    await input('My note'); await click('button[type="submit"]');
    assert.equal(document.querySelector('textarea').value, 'My note');
    assert.match(document.body.textContent, /Another window/);
    await click('button[type="submit"]');
    assert.equal(sent.version, 'v1');
    await click('[aria-label="Delete note"]');
    assert.match(document.body.textContent, /Delete failed/);
    assert.match(document.body.textContent, /My note/);
  } finally { await unmount(root); }
});

test('notes reject late loads after logout, lock, account removal and message navigation', async () => {
  for (const change of [{ user: null }, { isLocked: true }, { accounts: [] }]) {
    reset(); const load = deferred(); privateNotesApi.get = () => load.promise;
    const root = await mount(Notes, { message });
    try {
      await React.act(async () => useStore.setState(change));
      await React.act(async () => load.resolve({ notes: [{ id: 'secret', text: 'Never leak', createdAt: '2026-01-01' }], version: 'v' }));
      assert.doesNotMatch(document.body.textContent, /Never leak/);
      assert.equal(document.querySelector('textarea'), null);
    } finally { await unmount(root); }
  }
  reset(); const old = deferred();
  privateNotesApi.get = id => id === 'selected' ? old.promise : Promise.resolve({ notes: [], version: null });
  const root = await mount(Notes, { message });
  try {
    await React.act(async () => root.render(React.createElement(Notes, { message: { ...message, id: 'new' } })));
    await React.act(async () => old.resolve({ notes: [{ id: 'old', text: 'Stale thread', createdAt: '2026-01-01' }], version: 'v' }));
    assert.doesNotMatch(document.body.textContent, /Stale thread/);
  } finally { await unmount(root); }
});

test('notes transport protects CSRF and forwards lock/session expiry events', async () => {
  const originalFetch = globalThis.fetch;
  const events = [];
  const onLock = () => events.push('locked'); const onExpired = () => events.push('expired');
  window.addEventListener('mailflow:locked', onLock); window.addEventListener('mailflow:session_expired', onExpired);
  try {
    for (const status of [423, 401]) {
      globalThis.fetch = async (_url, options) => {
        assert.equal(options.headers['X-Requested-With'], 'MailFlow'); assert.equal(options.credentials, 'include');
        return { ok: false, status, json: async () => ({ error: 'Blocked' }) };
      };
      await assert.rejects(originalNotes.get('id'), /Blocked/);
    }
    assert.deepEqual(events, ['locked', 'expired']);
  } finally {
    globalThis.fetch = originalFetch;
    window.removeEventListener('mailflow:locked', onLock); window.removeEventListener('mailflow:session_expired', onExpired);
  }
});

test('sender context uses the exact selected sender, saved contacts and account-bound mail', async () => {
  reset();
  useStore.setState({ messages: [{ ...message, reply_from_email: 'actual@example.com', reply_from_name: '<img src=x>' }] });
  const calls = [];
  api.getContacts = async options => { calls.push(options); return { contacts: [
    { display_name: 'Wrong person', primary_email: 'notactual@example.com' },
    { display_name: 'Actual Person', primary_email: 'actual@example.com', organization: 'Saved organization' },
  ] }; };
  api.search = async (query, id, options) => { calls.push([query, id, options]); return { messages: [
    { id: 'r', account_id: 'a', thread_id: 'recent', from_email: 'actual@example.com', subject: '<script>real</script>' },
    { id: 'copy', account_id: 'a', thread_id: 'recent', from_email: 'actual@example.com', subject: 'Duplicate' },
    { id: 'wrong-account', account_id: 'b', from_email: 'actual@example.com', subject: 'Other account secret' },
    { id: 'wrong-email', account_id: 'a', from_email: 'notactual@example.com', subject: 'Other sender' },
  ] }; };
  const compose = useStore.getState().openCompose; let draft;
  useStore.setState({ openCompose: data => { draft = data; } });
  const root = await mount(SenderContext);
  try {
    assert.deepEqual(calls, [{ q: 'actual@example.com', limit: 30 }, ['from:"actual@example.com"', 'a', { limit: 30 }]]);
    assert.match(document.body.textContent, /Actual Person/); assert.match(document.body.textContent, /Saved organization/);
    assert.doesNotMatch(document.body.textContent, /Wrong person|Other account secret|Other sender|Duplicate/);
    assert.equal(document.querySelector('script'), null);
    await React.act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Write email').click());
    assert.deepEqual(draft, { accountId: 'a', to: ['actual@example.com'] });
  } finally { await unmount(root); useStore.setState({ openCompose: compose }); }
});

test('sender context reports independent source errors and suppresses late results after lock', async () => {
  reset();
  api.getContacts = async () => { throw new Error('Contact offline'); };
  api.search = async () => { throw new Error('Search offline'); };
  const root = await mount(SenderContext);
  try {
    assert.match(document.body.textContent, /Contacts could not be loaded/);
    assert.match(document.body.textContent, /Recent mail could not be loaded/);
    assert.match(document.body.textContent, /first@example.com/);
    const old = deferred(); api.getContacts = () => old.promise; api.search = async () => ({ messages: [] });
    await React.act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Retry').click());
    await React.act(async () => useStore.setState({ isLocked: true }));
    await React.act(async () => old.resolve({ contacts: [{ display_name: 'Stale private name', primary_email: 'first@example.com' }] }));
    assert.doesNotMatch(document.body.textContent, /Stale private name/); assert.equal(document.querySelector('aside'), null);
  } finally { await unmount(root); }
});

test('sender context opens resolved mail outside loaded list and ignores stale navigation', async () => {
  const row = { id: 'outside', account_id: 'a', from_email: 'first@example.com', subject: 'Older message', folder: 'Archive' };
  for (const stale of [false, true]) {
    reset(); api.getContacts = async () => ({ contacts: [] }); api.search = async () => ({ messages: [row] });
    const resolved = deferred(); api.resolveMessage = () => resolved.promise;
    const root = await mount(SenderContext);
    try {
      await React.act(async () => [...document.querySelectorAll('button')].find(button => button.textContent.includes('Older message')).click());
      if (stale) await React.act(async () => useStore.setState({ selectedMessageId: 'new-navigation' }));
      await React.act(async () => resolved.resolve({ ...row, id: 'moved' }));
      assert.equal(useStore.getState().selectedMessageId, stale ? 'new-navigation' : 'moved');
      if (!stale) {
        assert.equal(useStore.getState().selectedFolder, 'Archive');
        assert.equal(useStore.getState().threadMessages.__dl_moved[0].id, 'moved');
      }
    } finally { await unmount(root); }
  }
});

test('sender result bounds and same-address filtering do not imply recipient receipts', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ id: String(i), account_id: 'a', from_email: 'SENDER@EXAMPLE.COM' }));
  assert.equal(exactSenderConversations(rows, 'sender@example.com', 'a').length, 8);
  assert.equal(exactSenderConversations(rows, 'sender@example.com', 'b').length, 0);
});


test('sender opening honors native read preferences and cancels delayed reads on navigation', async () => {
  const row = { id: 'outside-read', account_id: 'a', from_email: 'first@example.com', subject: 'Read target', folder: 'Archive', is_read: false };
  const reads = [];
  api.bulkRead = async ids => { reads.push(ids); };
  for (const behavior of ['manual', 'immediate', 'delay']) {
    reset();
    const id = `${row.id}-${behavior}`;
    useStore.setState({ markReadBehavior: behavior, markReadDelay: 0.04 });
    api.getContacts = async () => ({ contacts: [] });
    api.search = async () => ({ messages: [{ ...row, id }] });
    api.resolveMessage = async () => ({ ...row, id });
    const root = await mount(SenderContext);
    try {
      await React.act(async () => [...document.querySelectorAll('button')].find(button => button.textContent.includes('Read target')).click());
      if (behavior === 'delay') {
        await React.act(async () => useStore.setState({ selectedMessageId: 'new-navigation' }));
        await React.act(async () => new Promise(resolve => setTimeout(resolve, 60)));
      }
    } finally { await unmount(root); }
  }
  assert.deepEqual(reads, [['outside-read-immediate']]);
});

test('sender source responses are discarded on a user or selected-account change', async () => {
  for (const change of [{ user: { id: 'other-user' } }, { accounts: [{ id: 'b' }], selectedAccountId: 'b' }]) {
    reset();
    const pending = deferred(); let calls = 0;
    api.getContacts = () => ++calls === 1 ? pending.promise : Promise.resolve({ contacts: [] });
    api.search = async () => ({ messages: [] });
    const root = await mount(SenderContext);
    try {
      await React.act(async () => useStore.setState(change));
      await React.act(async () => pending.resolve({ contacts: [{ primary_email: 'first@example.com', display_name: 'Previous owner secret' }] }));
      assert.doesNotMatch(document.body.textContent, /Previous owner secret/);
    } finally { await unmount(root); }
  }
});
