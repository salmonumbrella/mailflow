import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCountSnapshots, mergeFolderSnapshots, selectAuthoritativeInboxSnapshot } from './countSnapshots.js';
import { updateCountOperations, settleCountOperations, projectCountOperations } from './countOperations.js';
const sample = (a, b, revision = '1') => ({ byAccount: { a, b, x: 7 }, snapshots: Object.fromEntries(['a', 'b', 'x'].map(id => [id, { revision, known: true, stale: false, observedAt: new Date(0).toISOString() }])) });
const fence = { epoch: 'snapshot.test', seq: '10', version: 1 };
const source = unread => ({ unread, folders: {}, categories: {} });
const op = (opId, account, unreadDelta, state = 'awaiting-observation') => ({ opId, session: 1, account, folder: 'INBOX', unreadDelta, totalDelta: 0, state });
const begin = entries => updateCountOperations({}, [], entries, source(sample(10, 20)));
const shown = (state, unread = sample(10, 20)) => projectCountOperations(state, source(unread), ['a', 'b']).unread.byAccount;
const qualified = (a = 9, b = 20) => {
  const observed = sample(a, b, '11');
  for (const snapshot of Object.values(observed.snapshots)) Object.assign(snapshot, { epoch: fence.epoch, quiescentAtStart: true, refreshSeqAtStart: fence.seq });
  return { ...source(observed), categories: Object.fromEntries(['a', 'b', 'x'].map(id => [id, { counts: {}, totals: {}, countRevision: '12', requestedAfter: fence }])) };
};
test('reflected reads never get subtracted from a newer server snapshot a second time', () => {
  const state = begin([op('read-a', 'a', -1), op('read-b', 'b', -3)]);
  const updated = mergeCountSnapshots(sample(10, 20), sample(9, 17, '2'));
  assert.deepEqual(shown(state, updated), { a: 9, b: 17, x: 7 });
  const truth = qualified(9, 17);
  assert.equal(Object.keys(settleCountOperations(state, truth, fence).operations).length, 0);
});
test('arrivals in another account cannot acknowledge a pending read', () => {
  const state = begin([op('read-a', 'a', -1)]), updated = sample(9, 21, '2');
  assert.equal(Object.keys(settleCountOperations(state, source(updated), fence).operations).length, 1);
  assert.deepEqual(shown(state, updated), { a: 9, b: 21, x: 7 });
});
test('continuous clicks keep the original cohort baseline until a qualifying observation', () => {
  let state = begin([op('one', 'a', -1)]);
  state = updateCountOperations(state, [], [op('two', 'a', -1)], source(sample(9, 20, '2')));
  assert.equal(shown(state, sample(50, 20, '3')).a, 8);
  assert.equal(Object.keys(state.operations).length, 2);
});
test('known inverse deltas cancel only their deduction while another account stays pending', () => {
  let state = begin([op('one', 'a', -1), op('other', 'b', -2)]);
  state = updateCountOperations(state, [], [op('inverse', 'a', 1)], source(sample(9, 20, '2')));
  assert.deepEqual(shown(state), { a: 10, b: 18, x: 7 });
});
test('ordering uses per-account integer revisions without losing64bit precision', () => {
  const newer = sample(9, 17, '9007199254740993'), old = sample(10, 20, '9007199254740992');
  assert.deepEqual(mergeCountSnapshots(newer, old).byAccount, newer.byAccount);
});
test('a failed observation retains count but supersedes the old success freshness', () => {
  const initial = sample(10, 20), failed = sample(10, 20);
  failed.snapshots.a = { ...failed.snapshots.a, attemptRevision: '2', stale: true };
  const next = mergeCountSnapshots(initial, failed);
  assert.equal(mergeCountSnapshots(next, initial).snapshots.a.stale, true);
});
test('unknown counts stay unknown and time alone can make an authoritative snapshot stale', () => {
  const unknown = sample(null, 20); unknown.snapshots.a.known = false;
  const state = updateCountOperations({}, [], [op('unknown', 'a', -1)], source(unknown));
  assert.equal(shown(state, unknown).a, null);
  const fixture = { user: { id: 'snapshot-user.test' }, countGeneration: 1, countSnapshotGeneration: 1, serverUnreadCounts: sample(10, 20), unreadCounts: sample(10, 20) };
  assert.equal(selectAuthoritativeInboxSnapshot(fixture, 'a', 180001).stale, true);
});
test('folder responses cannot overwrite a later observation or reintroduce removed folders', () => {
  const old = [{ path: 'INBOX', unread_count: 4, status_attempt_revision: '3' }, { path: 'removed' }];
  const incoming = [{ path: 'INBOX', unread_count: 5, status_attempt_revision: '2', name: 'Inbox' }];
  const [folder] = mergeFolderSnapshots(old, incoming);
  assert.equal(folder.unread_count, 4); assert.equal(folder.name, 'Inbox');
  assert.equal(mergeFolderSnapshots(old, incoming).length, 1);
});
test('an observation timestamp alone cannot expire or certify an unsettled cohort', () => {
  const state = begin([op('one', 'a', -1)]), observed = sample(10, 20, '2');
  observed.snapshots.a.observedAt = '2099-01-01T00:00:00Z';
  assert.equal(Object.keys(settleCountOperations(state, source(observed), null).operations).length, 1);
  assert.equal(shown(state, observed).a, 9);
});
test('a successful observation from before the requested refresh cannot settle the cohort', () => {
  const state = begin([op('one', 'a', -1)]), observed = qualified();
  observed.unread.snapshots.a.refreshSeqAtStart = '9';
  assert.equal(Object.keys(settleCountOperations(state, observed, fence).operations).length, 1);
  assert.equal(shown(state, observed.unread).a, 9);
});
test('a qualifying observation and post-certification category query hand back provider truth', () => {
  const state = begin([op('one', 'a', -1)]), observed = qualified();
  const settled = settleCountOperations(state, observed, fence);
  assert.equal(Object.keys(settled.operations).length, 0);
  assert.equal(shown(settled, observed.unread).a, 9);
});
test('settlement reads the observation certificate, never a matching count', () => {
  const state = begin([op('one', 'a', -1)]), observed = qualified();
  delete observed.unread.snapshots.a.quiescentAtStart;
  assert.equal(Object.keys(settleCountOperations(state, observed, fence).operations).length, 1);
});
test('a held operation in another account prevents partial cohort retirement', () => {
  let state = begin([op('one', 'a', -1), op('other', 'b', -2, 'undo-pending')]);
  const observed = qualified(9, 18);
  assert.equal(Object.keys(settleCountOperations(state, observed, fence).operations).length, 2);
  assert.deepEqual(shown(state, observed.unread), { a: 9, b: 18, x: 7 });
  state = updateCountOperations(state, ['other'], [op('other', 'b', -2)], observed);
  assert.equal(Object.keys(settleCountOperations(state, observed, fence).operations).length, 0);
});
test('missing refresh or epoch metadata stays pending instead of falling back to time', () => {
  const state = begin([op('one', 'a', -1)]);
  for (const field of ['epoch', 'refreshSeqAtStart']) {
    const observed = qualified(); delete observed.unread.snapshots.a[field];
    assert.equal(Object.keys(settleCountOperations(state, observed, fence).operations).length, 1);
  }
});
test('a category query requested before certification cannot retire the local query baseline', () => {
  const state = begin([op('one', 'a', -1)]), observed = qualified();
  observed.categories.a.requestedAfter = null;
  assert.equal(Object.keys(settleCountOperations(state, observed, fence).operations).length, 1);
  observed.categories.a.requestedAfter = fence;
  assert.equal(Object.keys(settleCountOperations(state, observed, fence).operations).length, 0);
});
import { unreadDeltaByAccount } from './countSnapshots.js';

describe('unreadDeltaByAccount (#476 badge attribution)', () => {
  it('splits a cross-account conversation unread delta per account', () => {
    const msgs = [
      { id: 'w', account_id: 'work', is_read: false },
      { id: 'h', account_id: 'home', is_read: false },
    ];
    const d = unreadDeltaByAccount(msgs, true, 'work');
    assert.deepEqual([...d.entries()].sort(), [['home', 1], ['work', 1]]);
  });

  it('counts only messages whose state actually changes', () => {
    const msgs = [
      { id: 'a', account_id: 'work', is_read: true },   // already read: no change when marking read
      { id: 'b', account_id: 'work', is_read: false },
    ];
    assert.deepEqual([...unreadDeltaByAccount(msgs, true, 'work')], [['work', 1]]);
    assert.deepEqual([...unreadDeltaByAccount(msgs, false, 'work')], [['work', 1]]);
  });

  it('charges a message with no account to the acted-on row account', () => {
    const msgs = [{ id: 'x', is_read: false }];
    assert.deepEqual([...unreadDeltaByAccount(msgs, true, 'work')], [['work', 1]]);
  });

  it('is empty when nothing changes', () => {
    assert.equal(unreadDeltaByAccount([{ id: 'a', account_id: 'work', is_read: true }], true, 'work').size, 0);
    assert.equal(unreadDeltaByAccount(null, true, 'work').size, 0);
  });
});
test('retaining a newer folder observation also retains its own certificate metadata', () => {
  const [folder] = mergeFolderSnapshots([{ path: 'INBOX', unread_count: 4, status_attempt_revision: '30', epoch: 'new.test', quiescentAtStart: false, refreshSeqAtStart: '25' }],
    [{ path: 'INBOX', unread_count: 5, status_attempt_revision: '20', epoch: 'old.test', quiescentAtStart: true, refreshSeqAtStart: '99' }]);
  assert.equal(folder.epoch, 'new.test');
  assert.equal(folder.quiescentAtStart, false, 'old certificate must not be grafted onto a newer count revision');
  assert.equal(folder.refreshSeqAtStart, '25');
});
