import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateCountOperations, settleCountOperations, projectCountOperations } from './countOperations.js';
const fence = { epoch: 'archive.test', seq: '20', version: 3 };
const source = (a = 120, b = 120, certified = false) => ({ unread: { byAccount: { a, b, x: 8 }, snapshots: Object.fromEntries(['a', 'b', 'x'].map(id => [id, { totalCount: id === 'x' ? 9 : 123, known: true, stale: false, epoch: fence.epoch, quiescentAtStart: certified, refreshSeqAtStart: certified ? '20' : '0' }])) },
  folders: { a: [{ path: 'Sent', unread_count: 5, total_count: 8, counts_known: true }] }, categories: { a: { counts: { primary: a }, totals: { primary: 123 } }, b: { counts: { primary: b }, totals: { primary: 123 } }, x: { counts: { primary: 8 }, totals: { primary: 9 } } } });
const op = (id, account = 'a', folder = 'INBOX') => ({ opId: String(id), session: 1, account, folder, category: 'primary', unreadDelta: -1, totalDelta: -1, state: 'undo-pending' });
const update = (state, entries, remove = [], observed = source()) => updateCountOperations(state, remove, entries, observed);
const show = (state, observed = source(), scope = ['a', 'b']) => projectCountOperations(state, observed, scope);
test('110 mixed-account archives preserve their own cohort through different completion orders and own Undo', () => {
  for (const order of [Array.from({ length: 110 }, (_, i) => i), Array.from({ length: 110 }, (_, i) => 109 - i), Array.from({ length: 110 }, (_, i) => (i * 37) % 110)]) {
    let state = update({}, Array.from({ length: 110 }, (_, i) => op(i, i % 2 ? 'b' : 'a')));
    for (const id of order) state = update(state, [{ ...op(id, id % 2 ? 'b' : 'a'), state: 'awaiting-observation' }], [], source(65, 65));
    assert.equal(show(state, source(65, 65)).unread.byAccount.a, 65);
    assert.equal(show(state, source(65, 65)).unread.byAccount.b, 65);
    state = update(state, [], ['0', '1']);
    assert.equal(show(state).unread.byAccount.a, 66);
    assert.equal(show(state).unread.byAccount.b, 66);
  }
});
test('partial known-not-applied archive rows release only their actual source-folder delta', () => {
  let state = update({}, [op('sent', 'a', 'Sent'), op('inbox')]);
  assert.equal(show(state).unread.byAccount.a, 119);
  state = update(state, [], ['inbox']);
  assert.equal(show(state).unread.byAccount.a, 120);
  assert.equal(show(state).folders.a[0].unread_count, 4);
  assert.equal(show(state).categoryCounts.primary, 240);
});
test('a category response from an earlier mutation version cannot retire the current cohort', () => {
  let state = update({}, [{ ...op('one'), state: 'awaiting-observation' }]);
  const observed = source(119, 120, true);
  observed.categories.a = { ...observed.categories.a, countRevision: '200', requestedAfter: { ...fence, version: 2 } };
  assert.equal(Object.keys(settleCountOperations(state, observed, fence).operations).length, 1);
  observed.categories.a.requestedAfter = fence;
  state = settleCountOperations(state, observed, fence);
  assert.equal(Object.keys(state.operations).length, 0);
});
test('an opted-out account archive changes its own category view without charging the unified scope', () => {
  const state = update({}, [op('opted-out', 'x')]);
  assert.equal(show(state).categoryCounts.primary, 240);
  assert.equal(show(state, source(), ['x']).categoryCounts.primary, 7);
  assert.equal(show(state, source(), ['x']).categoryTotals.primary, 8);
});
