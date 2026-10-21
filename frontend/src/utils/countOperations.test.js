import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateCountOperations, settleCountOperations, projectCountOperations } from './countOperations.js';
const fence = { seq: '20', epoch: 'server.test', version: 3 };
const sample = (a = 120, seq = '1') => ({ unread: { byAccount: { a, b: 10 }, snapshots: {
  a: { totalCount: a + 3, revision: seq, known: true, stale: false, epoch: 'server.test', quiescentAtStart: seq === '21', refreshSeqAtStart: seq },
  b: { totalCount: 10, revision: seq, known: true, stale: false, epoch: 'server.test', quiescentAtStart: seq === '21', refreshSeqAtStart: seq },
} }, folders: { a: [{ path: 'Sent', unread_count: 4, total_count: 5, counts_known: true }] },
  categories: { a: { counts: { primary: a, newsletter: 0 }, totals: { primary: a + 3 }, countRevision: seq }, b: { counts: { primary: 10 }, totals: { primary: 10 }, countRevision: seq } } });
const op = (id, patch = {}) => ({ opId: id, session: 1, account: 'a', folder: 'INBOX', category: 'primary', unreadDelta: -1, totalDelta: -1, state: 'undo-pending', undoDeadline: 4750, ...patch });
const update = (state, entries, remove = [], source = sample()) => updateCountOperations(state, remove, entries, source);
const show = (state, source = sample(), scope = ['a']) => projectCountOperations(state, source, scope);
test('110 operations share frozen truth through reverse completions, partial failure, Undo and failed observations', () => {
  let state = update({}, Array.from({ length: 110 }, (_, i) => op(String(i))));
  assert.equal(show(state).unread.byAccount.a, 10);
  for (let i = 99; i >= 0; i--) state = update(state, [op(String(i), { state: 'awaiting-observation' })]);
  state = settleCountOperations(state, sample(20, '21'), fence);
  assert.equal(show(state, sample(20, '21')).unread.byAccount.a, 10, 'held Undo prevents double subtraction');
  state = update(state, [], ['109']);
  assert.equal(show(state).unread.byAccount.a, 11, 'Undo removes only its own delta');
  state = update(state, Array.from({ length: 9 }, (_, i) => op(String(i + 100), { state: 'awaiting-observation' })));
  const failed = sample(11, '21'); failed.unread.snapshots.a.stale = true;
  assert.ok(Object.keys(settleCountOperations(state, failed, fence).operations).length);
  const certified = sample(11, '21');
  assert.ok(Object.keys(settleCountOperations(state, certified, fence).operations).length, 'provider truth alone cannot retire category deltas');
  certified.categories.a = { ...certified.categories.a, countRevision: '25', requestedAfter: fence };
  state = settleCountOperations(state, certified, fence);
  assert.equal(Object.keys(state.operations).length, 0);
  assert.equal(show(state, certified).unread.byAccount.a, 11);
});
test('a read delta cannot settle against the frozen archive baseline even after old timer deadlines', () => {
  let state = update({}, [op('archive'), op('read', { category: undefined, totalDelta: 0, state: 'awaiting-observation' })]);
  const readOnly = sample(119, '21');
  state = settleCountOperations(state, readOnly, fence);
  assert.equal(show(state, readOnly).unread.byAccount.a, 118);
  state = update(state, [], ['read']); // known-not-applied compensation/Undo owns this entry only
  assert.equal(show(state).unread.byAccount.a, 119);
  state = update(state, [op('archive', { state: 'awaiting-observation' })]);
  assert.equal(show(settleCountOperations(state, readOnly, { ...fence, version: 2 }), readOnly).unread.byAccount.a, 119);
});
test('mixed category compatibility deltas apply only to their captured unified scope, then require a post-certification query', () => {
  const source = sample(10);
  source.categories.a = { counts: { primary: 6, newsletter: 4 }, totals: { primary: 8, newsletter: 5 } };
  source.categories.b = { counts: { primary: 7, newsletter: 3 }, totals: { primary: 7, newsletter: 3 } };
  let state = update({}, [op('read-a', { category: undefined, totalDelta: 0, state: 'awaiting-observation' }),
    op('read-b', { account: 'b', category: undefined, totalDelta: 0, state: 'awaiting-observation' }),
    op('primary', { account: null, category: 'primary', categoryScope: ['a', 'b'], totalDelta: 0, state: 'awaiting-observation' }),
    op('newsletter', { account: null, category: 'newsletter', categoryScope: ['a', 'b'], totalDelta: 0, state: 'awaiting-observation' })], [], source);
  assert.equal(show(state, source, ['a', 'b']).categoryCounts.primary, 12);
  assert.equal(show(state, source, ['a', 'b']).categoryCounts.newsletter, 6);
  assert.equal(show(state, source, ['a']).categoryCounts.primary, 6);
  assert.equal(show(state, source, ['b', 'a']).categoryCounts.primary, 12);
  const certified = sample(119, '21');
  assert.ok(Object.keys(settleCountOperations(state, certified, fence).operations).length);
  for (const id of ['a', 'b']) certified.categories[id] = { ...certified.categories[id], countRevision: '25', requestedAfter: fence };
  state = settleCountOperations(state, certified, fence);
  assert.equal(Object.keys(state.operations).length, 0);
});
test('non-Inbox archive deltas never charge Inbox or categories; unknown authoritative counts remain unknown', () => {
  const state = update({}, [op('sent', { folder: 'Sent' })]);
  assert.equal(show(state).unread.byAccount.a, 120);
  assert.equal(show(state).categoryCounts.primary, 120);
  assert.equal(show(state).folders.a[0].total_count, 4);
  const unknown = sample(); unknown.unread.byAccount.a = null; unknown.unread.snapshots.a.totalCount = null;
  const pending = update({}, [op('unknown')], [], unknown);
  assert.equal(show(pending, unknown).unread.byAccount.a, null);
});
test('destination credits use the cohort-start baseline when archive responses arrive after an intermediate STATUS', () => {
  const initial = sample(10);
  let state = update({}, [op('first'), op('second')], [], initial);
  const includesSecond = sample(9); includesSecond.folders.a[0] = { ...includesSecond.folders.a[0], unread_count: 5, total_count: 6 };
  state = update(state, [op('second', { state: 'awaiting-observation' }),
    op('second:destination', { folder: 'Sent', category: undefined, unreadDelta: 1, totalDelta: 1, state: 'awaiting-observation' })], [], includesSecond);
  assert.equal(show(state, includesSecond).folders.a[0].total_count, 6, 'do not add the same provider-applied destination twice');
  const includesBoth = sample(8); includesBoth.folders.a[0] = { ...includesBoth.folders.a[0], unread_count: 6, total_count: 7 };
  state = update(state, [op('first', { state: 'awaiting-observation' }),
    op('first:destination', { folder: 'Sent', category: undefined, unreadDelta: 1, totalDelta: 1, state: 'awaiting-observation' })], [], includesBoth);
  assert.equal(show(state, includesBoth).folders.a[0].total_count, 7);
  assert.equal(show(state, includesBoth).unread.byAccount.a, 8);
});
test('category compatibility and archive deltas sum before clamping the displayed exact scope', () => {
  const source = sample(1);
  source.categories.a = { counts: { primary: 1 }, totals: { primary: 1 } };
  source.categories.b = { counts: { primary: 0 }, totals: { primary: 0 } };
  const state = update({}, [op('archive', { unreadDelta: -2, totalDelta: -2 }),
    op('unread', { account: null, categoryScope: ['a', 'b'], unreadDelta: 1, totalDelta: 0 })], [], source);
  assert.equal(show(state, source, ['a', 'b']).categoryCounts.primary, 0, 'baseline1 plus archive-2 plus read+1 equals0');
  assert.equal(show(state, source, ['a']).categoryCounts.primary, 0, 'unified-only compatibility does not appear in account view');
});
test('a category missing at cohort start still needs a category query requested after certification', () => {
  const source = sample(10); source.categories = {};
  const state = update({}, [op('archive', { state: 'awaiting-observation' })], [], source);
  const certified = sample(9, '21'); certified.categories = {};
  assert.equal(Object.keys(settleCountOperations(state, certified, fence).operations).length, 1);
  certified.categories.a = { counts: { primary: 9 }, totals: { primary: 12 }, countRevision: '25', requestedAfter: fence };
  assert.equal(Object.keys(settleCountOperations(state, certified, fence).operations).length, 0);
});
