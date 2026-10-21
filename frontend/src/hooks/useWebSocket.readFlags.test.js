import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true } : nextLoad(url, context);
} });
const dom = new JSDOM('<div id="root"></div>', { url: 'https://synthetic.test' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
let socket;
class FakeSocket {
  static CLOSED = 3;
  constructor() { socket = this; this.readyState = 1; }
  close() { this.readyState = 3; }
}
globalThis.WebSocket = FakeSocket;
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const { useWebSocket } = await import('./useWebSocket.js');
const { beginReadIntent, completeReadIntent, setReadIntentSession, captureReadRequest, reconcileReadState } = await import('../utils/pendingReads.js');
function App() { useWebSocket(); return null; }
const row = { id: 'owned', account_id: 'a', thread_id: 'thread', message_id: '<shared@synthetic.test>', is_read: true };
const currentRow = () => [...useStore.getState().messages, ...useStore.getState().searchResults,
  ...Object.values(useStore.getState().threadMessages).flat()].find(message => message.id === row.id);
async function mount(t, source = 'messages') {
  useStore.getState().setUser({ id: 'synthetic-reader' });
  useStore.getState().setLocked(false);
  useStore.setState({ selectedAccountId: 'b', messages: [], searchResults: [], threadMessages: {},
    [source]: source === 'threadMessages' ? { thread: [{ ...row }] } : [{ ...row }] });
  setReadIntentSession(useStore.getState().countGeneration);
  t.mock.method(api, 'getUnreadCounts', async () => ({ byAccount: {}, snapshots: {} }));
  const root = createRoot(document.getElementById('root'));
  t.after(async () => {
    await React.act(async () => { useStore.getState().setLocked(true); root.unmount(); });
  });
  await React.act(async () => root.render(React.createElement(App)));
  const capturedSocket = socket;
  return (changes, accountId) => React.act(async () => capturedSocket.onmessage({
    data: JSON.stringify({ type: 'message_flags', changes, ...(accountId == null ? {} : { accountId }) }),
  }));
}

test('pending explicit unread rejects a stale socket read while preserving the star patch', async t => {
  const frame = await mount(t);
  beginReadIntent(row, false);
  await React.act(async () => useStore.getState().updateMessage(row.id, { is_read: false }));
  await frame([{ id: row.id, is_read: true, is_starred: true }]);
  assert.equal(currentRow().is_read, false);
  assert.equal(currentRow().is_starred, true, 'read guarding must leave star behavior unchanged');
});

test('a socket frame cannot retire a completed fence; an issued-after-completion GET converges', async t => {
  const frame = await mount(t);
  const intent = beginReadIntent(row, false);
  completeReadIntent(intent);
  await frame([{ id: row.id, is_read: true }]);
  assert.equal(currentRow().is_read, false);
  const token = captureReadRequest();
  await React.act(async () => useStore.getState().setMessages(reconcileReadState([{ ...row }], token)));
  assert.equal(currentRow().is_read, true);
  await frame([{ id: row.id, is_read: false }]);
  assert.equal(currentRow().is_read, true, 'tokenless frame cannot override the newer authoritative read');
});

for (const boundary of ['session', 'locked']) {
  test(`captured socket generation rejects READ after ${boundary} change`, async t => {
    const frame = await mount(t);
    await React.act(async () => {
      if (boundary === 'session') useStore.getState().setUser({ id: 'next-reader' });
      else useStore.getState().setLocked(true);
      useStore.setState({ messages: [{ ...row, subject: 'next session' }] });
    });
    await frame([{ id: row.id, is_read: false }]);
    assert.equal(currentRow().is_read, true);
  });
}

for (const source of ['messages', 'searchResults', 'threadMessages']) {
  test(`a bulk frame resolves its owned account from ${source}, never selectedAccountId`, async t => {
    const frame = await mount(t, source);
    assert.equal(useStore.getState().selectedAccountId, 'b');
    await frame([{ id: row.id, is_read: false }]);
    assert.equal(currentRow().is_read, false);
  });
}

test('supplied account mismatch and same RFC-ID copies cannot redirect a read patch', async t => {
  const frame = await mount(t);
  await React.act(async () => useStore.setState({ messages: [row, { ...row, id: 'other-copy', account_id: 'b' }] }));
  await frame([{ id: row.id, is_read: false }], 'b');
  assert.equal(currentRow().is_read, true);
  await frame([{ id: row.id, is_read: false }], 'a');
  assert.equal(currentRow().is_read, false);
  assert.equal(useStore.getState().messages.find(message => message.id === 'other-copy').is_read, true);
  await React.act(async () => useStore.setState({ messages: [row, { ...row, account_id: 'b' }] }));
  await frame([{ id: row.id, is_read: false }]);
  assert.ok(useStore.getState().messages.every(message => message.is_read), 'ambiguous duplicate database id is not assigned by selection');
});

after(() => dom.window.close());
