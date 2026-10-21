import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from './api.js';

async function capture(t, request) {
  let called;
  t.mock.method(globalThis, 'fetch', async url => {
    called = new URL(String(url), 'https://synthetic.test');
    return { ok: true, json: async () => ({ messages: [], hasMore: false, nextCursor: null }) };
  });
  await request();
  return called.searchParams;
}
test('grouped search forwards cursor/mode without an offset', async t => {
  const params = await capture(t, () => api.search('Nana', 'account', {
    threaded: true, mode: 'pane', cursor: 'opaque', offset: 10, folder: 'Archive', limit: 50,
  }));
  assert.equal(params.get('threaded'), 'true');
  assert.equal(params.get('cursor'), 'opaque');
  assert.equal(params.get('mode'), 'pane');
  assert.equal(params.has('offset'), false);
});
test('legacy physical offset callers retain their parameter', async t => {
  const params = await capture(t, () => api.search('Nana', 'account', { offset: 10 }));
  assert.equal(params.get('offset'), '10');
  assert.equal(params.has('threaded'), false);
});
test('scoped thread forwards explicit scope and can request all context folders', async t => {
  const params = await capture(t, () => api.getThread('["account","T"]', 'INBOX', false,
    { query: 'Nana', accountId: 'account', folder: undefined, mode: 'pane', matchedMessageId: 'physical-match' }));
  assert.equal(params.get('id'), '["account","T"]');
  assert.equal(params.get('q'), 'Nana');
  assert.equal(params.get('accountId'), 'account');
  assert.equal(params.get('mode'), 'pane');
  assert.equal(params.get('matchedMessageId'), 'physical-match');
  assert.equal(params.has('folder'), false);
});
test('ordinary thread forwarding retains folder and unified flags', async t => {
  const params = await capture(t, () => api.getThread('T', 'INBOX', true));
  assert.equal(params.get('folder'), 'INBOX');
  assert.equal(params.get('unified'), 'true');
  assert.equal(params.has('q'), false);
  assert.equal(params.has('accountId'), false);
  assert.equal(params.has('matchedMessageId'), false);
});
