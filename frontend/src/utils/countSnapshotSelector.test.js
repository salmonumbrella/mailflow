import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectAuthoritativeInboxSnapshot } from './countSnapshots.js';
const state = () => ({ user: { id: 'user.test' }, isLocked: false, countGeneration: 3, countSnapshotGeneration: 3,
  serverUnreadCounts: { byAccount: { a: 1 }, snapshots: { a: { known: true, stale: false, totalCount: 1, observedAt: new Date(1000).toISOString() } } },
  unreadCounts: { byAccount: { a: 0 }, snapshots: { a: { known: true, totalCount: 0, pending: true } } } });
test('empty presentation receives authoritative totals, canonical pending and exact180s age, never optimistic zero', () => {
  const s = state();
  assert.deepEqual(selectAuthoritativeInboxSnapshot(s, 'a', 181000), { known: true, stale: false, pending: true, totalCount: 1, unreadCount: 1, generation: 3 });
  assert.equal(selectAuthoritativeInboxSnapshot(s, 'a', 181001).stale, true);
  assert.equal(selectAuthoritativeInboxSnapshot(s, 'missing', 1000).known, false);
});
test('logout, lock and stale snapshot generations cannot certify known-empty account switches', () => {
  for (const patch of [{ user: null }, { isLocked: true }, { countSnapshotGeneration: 2 }]) {
    const s = { ...state(), ...patch };
    s.serverUnreadCounts.snapshots.a.totalCount = 0;
    const observed = selectAuthoritativeInboxSnapshot(s, 'a', 1000);
    assert.equal(observed.known, false);
    assert.equal(observed.stale, true);
  }
});
