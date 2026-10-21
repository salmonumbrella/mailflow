import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldKeepEmptyInbox } from './knownEmptyInbox.js';

const empty = () => ({ known: true, stale: false, pending: false, totalCount: 0, unreadCount: 0 });
const eligible = (overrides = {}) => ({
  loadingMessages: true, messagesOffset: 0, currentPage: 1, selectedFolder: 'INBOX',
  searchQuery: '', showGtdTab: false, accountSnapshots: [empty()], ...overrides,
});

test('preserves empty presentation only for a pending ordinary Inbox page zero', () => {
  assert.equal(shouldKeepEmptyInbox(eligible()), true);
  for (const override of [{ loadingMessages: false }, { messagesOffset: 1 }, { currentPage: 2 },
    { selectedFolder: 'Archive' }, { selectedFolder: '__snoozed__' }, { searchQuery: 'term' }, { showGtdTab: true }]) {
    assert.equal(shouldKeepEmptyInbox(eligible(override)), false, JSON.stringify(override));
  }
  assert.equal(shouldKeepEmptyInbox(eligible({ searchQuery: '  ' })), true);
});

test('unknown, stale, pending and absent provider evidence cannot certify an empty Inbox', () => {
  for (const sample of [undefined, null, {}, { ...empty(), known: false }, { ...empty(), stale: true },
    { ...empty(), pending: true }, { ...empty(), known: undefined }, { ...empty(), stale: undefined },
    { ...empty(), pending: undefined }]) {
    assert.equal(shouldKeepEmptyInbox(eligible({ accountSnapshots: [sample] })), false, JSON.stringify(sample));
  }
  assert.equal(shouldKeepEmptyInbox(eligible({ accountSnapshots: [] })), false);
});

test('zero unread or optimistic zero does not replace authoritative total', () => {
  for (const totalCount of [1, 50, 100000, null, undefined, '0', -1, NaN, Infinity]) {
    assert.equal(shouldKeepEmptyInbox(eligible({ accountSnapshots: [{ ...empty(), totalCount, unreadCount: 0 }] })), false);
  }
});

test('every scoped account must support empty presentation', () => {
  assert.equal(shouldKeepEmptyInbox(eligible({ accountSnapshots: [empty(), empty()] })), true);
  for (const sample of [{ ...empty(), totalCount: 1 }, { ...empty(), known: false },
    { ...empty(), stale: true }, { ...empty(), pending: true }]) {
    assert.equal(shouldKeepEmptyInbox(eligible({ accountSnapshots: [empty(), sample] })), false);
    assert.equal(shouldKeepEmptyInbox(eligible({ accountSnapshots: [sample, empty()] })), false);
  }
});

test('generated fresh zero-total account sets retain empty presentation', () => {
  let seed = 0x52a8;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let run = 0; run < 256; run++) {
    const count = 1 + next() % 64;
    const samples = Array.from({ length: count }, () => ({ ...empty(), generation: next(), unreadCount: next() }));
    assert.equal(shouldKeepEmptyInbox(eligible({ accountSnapshots: samples })), true, `run=${run}`);
  }
});

test('generated nonempty totals prevent the override at every position in account sets', () => {
  let seed = 0xdeadbeef;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let run = 0; run < 256; run++) {
    const samples = Array.from({ length: 1 + next() % 64 }, empty);
    samples[next() % samples.length].totalCount = 1 + next();
    assert.equal(shouldKeepEmptyInbox(eligible({ accountSnapshots: samples })), false, `run=${run}`);
  }
});

test('missing account evidence in sparse scopes cannot certify empty', () => {
  for (const accountSnapshots of [new Array(1), Object.assign(new Array(3), { 0: empty(), 2: empty() }), Object.assign(new Array(2), { 1: empty() })]) {
    assert.equal(shouldKeepEmptyInbox(eligible({ accountSnapshots })), false);
  }
});

test('strict scope boundaries and trimmed search preserve only ordinary page zero', () => {
  for (const messagesOffset of [-1, 1, '0', null]) assert.equal(shouldKeepEmptyInbox(eligible({ messagesOffset })), false);
  for (const currentPage of [0, 2, '1', null]) assert.equal(shouldKeepEmptyInbox(eligible({ currentPage })), false);
  for (const searchQuery of ['\t\n\u00a0', '\u2003']) assert.equal(shouldKeepEmptyInbox(eligible({ searchQuery })), true);
  for (const searchQuery of [' term ', '\u2003term\u2003']) assert.equal(shouldKeepEmptyInbox(eligible({ searchQuery })), false);
  assert.equal(shouldKeepEmptyInbox(eligible({ selectedFolder: 'inbox' })), false);
});

test('strict canonical snapshot fields cannot be replaced by coerced values', () => {
  for (const totalCount of [false, new Number(0), 0n, -Infinity]) {
    assert.equal(shouldKeepEmptyInbox(eligible({ accountSnapshots: [{ ...empty(), totalCount }] })), false);
  }
  assert.equal(shouldKeepEmptyInbox(eligible({ accountSnapshots: [{ ...empty(), totalCount: -0 }] })), true);
  for (const patch of [{ known: 1 }, { known: 'true' }, { stale: 0 }, { stale: null }, { pending: 0 }, { pending: null }]) {
    assert.equal(shouldKeepEmptyInbox(eligible({ accountSnapshots: [{ ...empty(), ...patch }] })), false);
  }
});

test('frozen evidence is pure and independent of unread or optimistic display fields', () => {
  for (const totalCount of [0, 17]) {
    for (const unreadCount of [0, 23, null, '0']) {
      const accountSnapshots = Object.freeze([Object.freeze({ ...empty(), totalCount, unreadCount, displayedTotal: 0, optimisticTotal: 0 })]);
      const input = Object.freeze(eligible({ accountSnapshots }));
      assert.equal(shouldKeepEmptyInbox(input), totalCount === 0);
      assert.equal(shouldKeepEmptyInbox(input), totalCount === 0);
    }
  }
});
