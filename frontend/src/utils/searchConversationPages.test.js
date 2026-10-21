import test from 'node:test';
import assert from 'node:assert/strict';
import { appendSearchPage, extendSearchPages, guardSearchPages } from './searchConversationPages.js';

const row = (id, thread, account = 'account-a') => ({
  id, matched_message_id: id, account_id: account,
  thread_id: JSON.stringify([account, thread]), is_read: false,
});

test('opening a page-one match keeps its first group representative on page two', () => {
  const opened = { ...row('new-match', 'T'), is_read: true };
  const older = row('old-match', 'T');
  const next = row('next-match', 'U');
  const result = appendSearchPage([opened], [older, next], { grouped: true });
  assert.deepEqual(result, [opened, next]);
  assert.equal(result[0], opened);
});

test('a flag-filtered late newer sibling cannot replace the older returned match or duplicate its group', () => {
  const first = row('a', 'A');
  const stillQualifying = row('t-old', 'T');
  const afterLateFlag = appendSearchPage([first], [stillQualifying], { grouped: true });
  const final = appendSearchPage(afterLateFlag, [row('t-new', 'T')], { grouped: true });
  assert.deepEqual(final.map(message => message.id), ['a', 't-old']);
});

test('same thread keys in different accounts remain distinct', () => {
  const first = row('a', 'T');
  const second = row('b', 'T', 'account-b');
  assert.deepEqual(appendSearchPage([first], [second], { grouped: true }), [first, second]);
});

test('physical mode retains different matching messages of the same conversation', () => {
  const first = row('a', 'T');
  const second = row('b', 'T');
  assert.deepEqual(appendSearchPage([first], [second]), [first, second]);
});

test('duplicate-only grouped pages add nothing without mutating input or representative', () => {
  const first = Object.freeze(row('a', 'T'));
  const existing = Object.freeze([first]);
  const incoming = Object.freeze([Object.freeze(row('b', 'T'))]);
  assert.deepEqual(appendSearchPage(existing, incoming, { grouped: true }), [first]);
  assert.equal(existing.length, 1);
});

test('retains first occurrence within the initial page and preserves matched order', () => {
  const a = row('a', 'T'), b = row('b', 'U');
  assert.deepEqual(appendSearchPage([], [a, b, row('c', 'T')], { grouped: true }), [a, b]);
});

test('NULL raw reply thread does not collapse distinct account-qualified fallback groups', () => {
  const a = { ...row('a', 'a'), reply_thread_id: null };
  const b = { ...row('b', 'b'), reply_thread_id: null };
  assert.deepEqual(appendSearchPage([a], [b], { grouped: true }), [a, b]);
});

test('physical fallback dedupes an exact row without hiding another account', () => {
  const a = { id: 'a', account_id: 'one', thread_id: null };
  const b = { ...a, account_id: 'two' };
  assert.deepEqual(appendSearchPage([a], [{ ...a }, b], { grouped: true }), [a, b]);
});

test('duplicate-only grouped pages continue at each server cursor until a new group arrives', async () => {
  const first = row('a', 'A');
  const cursors = [];
  const tokens = [];
  const pages = [
    { messages: [row('a-old', 'A')], hasMore: true, nextCursor: 'c2' },
    { messages: [row('b', 'B')], hasMore: false, nextCursor: null },
  ];
  const result = await extendSearchPages([first], {
    cursor: 'c1', grouped: true, isCurrent: () => true,
    fetchPage: async cursor => {
      cursors.push(cursor);
      const readToken = { request: cursors.length };
      return { data: pages.shift(), readToken };
    },
    guardMessages: (messages, token) => { tokens.push(token); return messages; },
  });
  assert.deepEqual(cursors, ['c1', 'c2']);
  assert.deepEqual(tokens, [{ request: 1 }, { request: 2 }]);
  assert.deepEqual(result.messages.map(message => message.id), ['a', 'b']);
  assert.equal(result.messages[0], first);
  assert.equal(result.hasMore, false);
  assert.deepEqual(result.pages.map(page => page.readToken), [{ request: 1 }, { request: 2 }]);
});

test('publication re-guards raw buffered responses with their original issued tokens', () => {
  const first = { ...row('a', 'A'), is_read: true, representative_is_read: true };
  const raw = row('a', 'A');
  const token = Object.freeze({ issued: 1 });
  const calls = [];
  const pages = [{ data: { messages: [raw] }, readToken: token }];
  const result = guardSearchPages([first], pages, { grouped: true, guardMessages: (messages, actual) => {
    calls.push(actual); return messages.map(message => ({ ...message, is_read: true }));
  } });
  assert.deepEqual(calls, [token]);
  assert.equal(result[0], first);
  assert.equal(result[0].representative_is_read, true);
  assert.equal(raw.is_read, false, 'raw response is retained for the real guard, not overwritten by an earlier projection');
});

test('fresh guarded unread on the same physical row converges without replacing match fields', () => {
  const first = { ...row('a', 'A'), is_read: true, representative_is_read: true, snippet: 'first match' };
  const fresh = { ...first };
  delete fresh.representative_is_read;
  const result = appendSearchPage([first], [{ ...fresh, is_read: false, snippet: 'incoming context' }], { grouped: true });
  assert.equal(result[0].id, first.id);
  assert.equal(result[0].is_read, false);
  assert.equal(result[0].snippet, 'first match');
  assert.equal(Object.hasOwn(result[0], 'representative_is_read'), false);
  assert.equal(first.is_read, true, 'the input is unchanged');
});

test('a guard retaining the existing local read state retains its representative flag too', () => {
  const first = { ...row('a', 'A'), is_read: true, representative_is_read: true };
  const guarded = { ...row('a', 'A'), is_read: true };
  const result = appendSearchPage([first], [guarded], { grouped: true, rawMessages: [row('a', 'A')] });
  assert.equal(result[0], first);
  assert.equal(result[0].representative_is_read, true);
});

test('equal aggregate flags still remove an obsolete representative override when the guard accepts the raw row', () => {
  const first = { ...row('a', 'A'), representative_is_read: true };
  const fresh = row('a', 'A');
  const result = appendSearchPage([first], [fresh], { grouped: true, rawMessages: [fresh] });
  assert.equal(result[0].is_read, false);
  assert.equal(Object.hasOwn(result[0], 'representative_is_read'), false);
});

test('an intent override keeps both existing fields even when its own flag differs from aggregate is_read', () => {
  const first = { ...row('a', 'A'), representative_is_read: true };
  const raw = row('a', 'A');
  const guarded = { ...raw, is_read: true };
  const result = appendSearchPage([first], [guarded], { grouped: true, rawMessages: [raw] });
  assert.equal(result[0], first);
  assert.equal(result[0].is_read, false);
  assert.equal(result[0].representative_is_read, true);
});

test('three duplicate-only requests retain hasMore and the last server cursor', async () => {
  let requests = 0;
  const result = await extendSearchPages([row('a', 'A')], {
    cursor: 'c0', grouped: true, isCurrent: () => true, guardMessages: messages => messages,
    fetchPage: async () => ({ data: {
      messages: [row('older', 'A')], hasMore: true, nextCursor: `c${++requests}`,
    } }),
  });
  assert.equal(requests, 3);
  assert.equal(result.hasMore, true);
  assert.equal(result.cursor, 'c3');
  assert.deepEqual(result.messages.map(message => message.id), ['a']);
});

test('a stale scope response is discarded before applying its read guard or starting another request', async () => {
  let requests = 0;
  const result = await extendSearchPages([], {
    grouped: true, isCurrent: () => false,
    guardMessages: () => assert.fail('stale response must not be projected'),
    fetchPage: async () => { requests++; return { data: {
      messages: [row('late', 'A')], hasMore: true, nextCursor: 'next',
    } }; },
  });
  assert.equal(result, null);
  assert.equal(requests, 1);
});

test('a nonadvancing cursor fails explicitly instead of looping or declaring exhaustion', async () => {
  await assert.rejects(extendSearchPages([], {
    cursor: 'same', grouped: true, isCurrent: () => true, guardMessages: messages => messages,
    fetchPage: async () => ({ data: { messages: [], hasMore: true, nextCursor: 'same' } }),
  }), { message: 'Search pagination needs a refresh' });
});


test('flat v1 follows nextCursor without a hasMore field and retains physical matches', async () => {
  const issued = Object.freeze({ request: 'flat-first' });
  const firstEnvelope = { messages: [row('one', 'T')], nextCursor: 'v1-next' };
  assert.equal(Object.hasOwn(firstEnvelope, 'hasMore'), false);
  const first = await extendSearchPages([], {
    grouped: false, isCurrent: () => true, guardMessages: messages => messages,
    fetchPage: async () => ({ data: firstEnvelope, readToken: issued }),
  });
  assert.equal(first.hasMore, true);
  assert.equal(first.cursor, 'v1-next');
  assert.equal(first.pages[0].readToken, issued);
  const next = await extendSearchPages(first.messages, {
    cursor: first.cursor, grouped: false, isCurrent: () => true, guardMessages: messages => messages,
    fetchPage: async cursor => {
      assert.equal(cursor, 'v1-next');
      return { data: { messages: [row('two', 'T')], nextCursor: null }, readToken: { request: 'flat-next' } };
    },
  });
  assert.deepEqual(next.messages.map(message => message.id), ['one', 'two']);
  assert.equal(next.hasMore, false);
  assert.equal(next.cursor, null);
});

test('flat v1 still rejects a nonadvancing cursor without a hasMore field', async () => {
  await assert.rejects(extendSearchPages([], {
    cursor: 'same', grouped: false, isCurrent: () => true, guardMessages: messages => messages,
    fetchPage: async () => ({ data: { messages: [], nextCursor: 'same' } }),
  }), { message: 'Search pagination needs a refresh' });
});

test('grouped v2 keeps server hasMore authoritative even when a cursor is present', async () => {
  const result = await extendSearchPages([], {
    grouped: true, isCurrent: () => true, guardMessages: messages => messages,
    fetchPage: async () => ({ data: { messages: [row('one', 'T')], hasMore: false, nextCursor: 'opaque' } }),
  });
  assert.equal(result.hasMore, false);
});
