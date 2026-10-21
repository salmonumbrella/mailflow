import { afterEach, beforeEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true } : nextLoad(url, context);
} });
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { useStore } = await import('./index.js');
globalThis.window = new EventTarget();
const accounts = [{ id: 'a', enabled: true }, { id: 'b', enabled: true }];
const snapshot = (a, b, revision = '1') => ({ byAccount: { a, b }, snapshots: Object.fromEntries(['a','b'].map(id => [id, { revision, known: true, stale: false, observedAt: new Date().toISOString() }])) });
beforeEach(() => {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  useStore.getState().setUser({ id: 'u' });
  useStore.getState().setLocked(false);
  useStore.getState().setAccounts(accounts);
  useStore.getState().setUnreadCounts(snapshot(10,20));
});
afterEach(() => { useStore.getState().setLocked(true); mock.timers.reset(); });
test('account cohorts retain their own deltas through long waits and intermediate observations', () => {
  const store = useStore.getState();
  store.decrementUnread('a');
  mock.timers.tick(4000);
  store.decrementUnread('b', 2);
  assert.equal(useStore.getState().unreadCounts.total, 27);
  mock.timers.tick(60000);
  store.setUnreadCounts(snapshot(9, 20, '2'));
  assert.equal(useStore.getState().unreadCounts.byAccount.a, 9);
  assert.equal(useStore.getState().unreadCounts.byAccount.b, 18);
  assert.equal(Object.keys(useStore.getState().countOperations.operations).length, 2);
  assert.equal(useStore.getState().unreadCounts.snapshots.a.pending, true);
  assert.equal(useStore.getState().unreadCounts.snapshots.b.pending, true);
});

test('the store adopts provider truth only after certification and the post-certification category query', () => {
  const store = useStore.getState();
  store.decrementUnread('a');
  store.setUnreadCounts(snapshot(10, 20, '2'));
  assert.equal(useStore.getState().unreadCounts.byAccount.a, 9, 'pre-write poll cannot bounce the count');
  mock.timers.tick(60000);
  store.setUnreadCounts(snapshot(9, 20, '3'));
  assert.equal(useStore.getState().unreadCounts.byAccount.a, 9, 'intermediate truth cannot subtract twice');
  const fence = { epoch: 'store.test', seq: '4', version: 0 };
  useStore.setState({ countFence: fence });
  const observed = snapshot(9, 20, '5');
  observed.snapshots.a = { ...observed.snapshots.a, epoch: fence.epoch, quiescentAtStart: true, refreshSeqAtStart: fence.seq };
  store.setUnreadCounts(observed);
  assert.equal(Object.keys(useStore.getState().countOperations.operations).length, 1, 'provider certificate alone cannot settle local category changes');
  store.setCategoryCounts({}, '6', store.countGeneration, { a: { counts: {}, totals: {} } }, fence);
  assert.equal(Object.keys(useStore.getState().countOperations.operations).length, 0);
  assert.equal(useStore.getState().unreadCounts.byAccount.a, 9);
  mock.timers.tick(30000);
  assert.equal(useStore.getState().unreadCounts.byAccount.a, 9);
});
test('locking cancels pending work and rejects delayed snapshots', () => {
  useStore.getState().decrementUnread('a');
  useStore.getState().setLocked(true);
  useStore.getState().setUnreadCounts(snapshot(9,20,'2'));
  mock.timers.tick(10000);
  assert.deepEqual(useStore.getState().unreadCounts.byAccount,{});
  assert.deepEqual(useStore.getState().countOperations,{});
});
test('changing unified scope does not turn the displayed optimistic count into a new baseline', () => {
  useStore.getState().decrementUnread('a');
  useStore.getState().updateAccount('b',{ include_in_unified_inbox: false });
  assert.equal(useStore.getState().unreadCounts.total,9);
  assert.equal(useStore.getState().serverUnreadCounts.byAccount.a,10);
  mock.timers.tick(60000);
  assert.equal(useStore.getState().unreadCounts.total,9, 'elapsed time cannot turn an optimistic count into provider truth');
});

test('archive operations survive time and intermediate observations; session tokens reject old responses', () => {
  const store = useStore.getState();
  store.setCategoryCounts({ primary: 10 }, '1', store.countGeneration, { a: { counts: { primary: 10 }, totals: { primary: 10 } } });
  const token = store.beginArchiveCount('one', [{ id: 'one', account_id: 'a', folder: 'INBOX', category: 'primary', is_read: false }], 104750);
  store.beginArchiveCount('two', [{ id: 'two', account_id: 'a', folder: 'INBOX', category: 'primary', is_read: false }], 104751);
  store.finishArchiveCount('one', { countTargets: [{ id: 'one', account_id: 'a', folder: 'INBOX', category: 'primary', is_read: false }] }, token);
  store.setUnreadCounts(snapshot(9, 20, '6'));
  mock.timers.tick(60000);
  assert.equal(useStore.getState().unreadCounts.byAccount.a, 8);
  assert.equal(useStore.getState().categoryCounts.primary, 8);
  store.cancelArchiveCount('two', token);
  store.setCategoryCounts({ primary: 9 }, '6', store.countGeneration, { a: { counts: { primary: 9 }, totals: { primary: 9 } } });
  assert.equal(useStore.getState().unreadCounts.byAccount.a, 9);
  assert.equal(useStore.getState().categoryCounts.primary, 9);
  store.setUser({ id: 'other' });
  store.finishArchiveCount('one', { countTargets: [] }, token);
  store.setUnreadCounts(snapshot(99, 20, '7'), token);
  assert.deepEqual(useStore.getState().unreadCounts.byAccount, {});
});

test('read toggles during an archive burst cannot clear or rebase its cohort', () => {
  const store = useStore.getState();
  const token = store.beginArchiveCount('archive', [{ id: 'one', account_id: 'a', folder: 'INBOX', is_read: false }], 104750);
  store.decrementUnread('a');
  assert.equal(useStore.getState().unreadCounts.byAccount.a, 8, 'separate read is visible during Undo');
  store.incrementUnread('a');
  assert.equal(useStore.getState().unreadCounts.byAccount.a, 9, 'read rollback cannot roll back the archive');
  store.decrementUnread('a');
  mock.timers.tick(30000);
  assert.equal(useStore.getState().unreadCounts.byAccount.a, 8, 'legacy expiry cannot replace the archive baseline');
  assert.equal(Object.values(useStore.getState().countOperations.operations).find(op => op.group === 'archive').state, 'undo-pending');
  store.finishArchiveCount('archive', { countTargets: [{ id: 'one', account_id: 'a', folder: 'INBOX', is_read: false }] }, token);
  store.setUnreadCounts(snapshot(8, 20, '11'));
  store.setCategoryCounts({}, '11');
  assert.equal(useStore.getState().unreadCounts.byAccount.a, 8);
});

test('confirmed normal archive adds only its actual destination folder and preserves Inbox source contract', () => {
  const s = useStore.getState();
  s.setFolders('a', [{ path: 'INBOX', unread_count: 10, total_count: 13 }, { path: 'Archive', unread_count: 5, total_count: 8 }]);
  const target = { id: 'normal', account_id: 'a', folder: 'INBOX', category: 'primary', is_read: false };
  const token = s.beginArchiveCount('normal', [target], 104750);
  s.updateArchiveCount('normal', [target], token);
  s.finishArchiveCount('normal', { countTargets: [{ ...target, destinationFolder: 'Archive' }] }, token);
  const archive = useStore.getState().folders.a.find(f => f.path === 'Archive');
  assert.equal(archive.unread_count, 6);
  assert.equal(archive.total_count, 9);
  assert.equal(useStore.getState().unreadCounts.byAccount.a, 9);
});
test('a compatibility delta never expires into a cached pre-write snapshot while its local intent remains held', async () => {
  const { beginCountIntent } = await import('../utils/countWriteTracker.js');
  const end = beginCountIntent();
  try {
    useStore.getState().decrementUnread('a');
    mock.timers.tick(60000);
    assert.equal(useStore.getState().unreadCounts.byAccount.a, 9);
    assert.equal(useStore.getState().unreadCounts.snapshots.a.pending, true);
    useStore.getState().setUnreadCounts(snapshot(9, 20, '50'));
    assert.equal(useStore.getState().unreadCounts.byAccount.a, 9, 'a snapshot containing the read cannot double-subtract or retire a held intent');
  } finally { end(); }
});
test('account navigation immediately projects category optimism only into its captured exact scope', () => {
  const store = useStore.getState();
  store.setCategoryCounts({ primary: 30 }, '1', store.countGeneration, {
    a: { counts: { primary: 10 }, totals: { primary: 13 } }, b: { counts: { primary: 20 }, totals: { primary: 20 } },
  });
  store.adjustCategoryCount('primary', -1);
  assert.equal(useStore.getState().categoryCounts.primary, 29);
  store.setSelectedAccount('a');
  assert.equal(useStore.getState().categoryCounts.primary, 10, 'scope changes before any category refetch');
  store.setSelectedAccount(null);
  assert.equal(useStore.getState().categoryCounts.primary, 29, 'switching back restores the still-pending scoped delta');
});
test('an uncertain archive completion keeps its original baseline after an intermediate reflected snapshot', () => {
  const s = useStore.getState();
  const target = { id: 'uncertain.test', account_id: 'a', folder: 'INBOX', category: 'primary', is_read: false };
  const generation = s.beginArchiveCount('uncertain', [target], 104750);
  s.setUnreadCounts(snapshot(9, 20, '10'));
  assert.equal(useStore.getState().unreadCounts.byAccount.a, 9);
  s.finishArchiveCount('uncertain', { countTargets: [], unconfirmed: [target.id] }, generation);
  assert.equal(useStore.getState().unreadCounts.byAccount.a, 9, 'uncertain response must neither roll back nor rebase onto reflected truth');
  assert.equal(useStore.getState().unreadCounts.snapshots.a.pending, true);
});
test('repeated archive group admission cannot duplicate its delta or leak a local intent', async () => {
  const { countWriteTracker } = await import('../utils/countWriteTracker.js');
  const s = useStore.getState(), target = { id: 'duplicate.test', account_id: 'a', folder: 'INBOX', is_read: false };
  const generation = s.beginArchiveCount('same-group', [target], 104750);
  s.beginArchiveCount('same-group', [target], 104750);
  assert.equal(useStore.getState().unreadCounts.byAccount.a, 9);
  s.cancelArchiveCount('same-group', generation);
  assert.equal(countWriteTracker.inspect().localIntents, 0);
  assert.equal(useStore.getState().unreadCounts.byAccount.a, 10);
});

for (const transition of ['removed', 'disabled']) {
  test(`authoritative ${transition} account releases only unavailable presentation obligations and keeps local lifetimes`, async () => {
    const { countWriteTracker } = await import('../utils/countWriteTracker.js');
    const { setPendingDelete, applyDeleteGuard } = await import('../utils/pendingDeletes.js');
    const s = useStore.getState(), generation = s.countGeneration;
    const rows = ['a', 'b'].map(account => ({ id: `lifecycle-${account}.test`, account_id: account, folder: 'INBOX', category: 'primary', is_read: false }));
    const a = s.beginArchiveCount('healthy', [rows[0]], 104750);
    const b = s.beginArchiveCount('removed', [rows[1]], 104750);
    rows.forEach((row, i) => setPendingDelete(row.id, { archive: true, generation, group: i ? 'removed' : 'healthy' }));
    s.finishArchiveCount('healthy', { countTargets: [rows[0]] }, a);
    s.adjustCategoryCount('primary', -1); // captured [a,b] cannot be decomposed after removal
    assert.equal(countWriteTracker.inspect().localIntents, 1);
    const prior = Object.keys(useStore.getState().countOperations.operations).length;
    // Neither an unbound view/reorder call nor a stale authoritative callback is proof.
    s.setAccounts([{ id: 'a', enabled: true }]);
    assert.equal(Object.keys(useStore.getState().countOperations.operations).length, prior);
    s.setAccounts(accounts, generation);
    s.setAccounts([{ id: 'a', enabled: true }], generation - 1);
    assert.equal(Object.keys(useStore.getState().countOperations.operations).length, prior);
    if (transition === 'removed') s.setAccounts([{ id: 'a', enabled: true }], generation);
    else s.updateAccount('b', { enabled: false }, generation);
    const remaining = Object.values(useStore.getState().countOperations.operations);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].account, 'a');
    assert.equal(useStore.getState().countFence, null);
    assert.equal(applyDeleteGuard([rows[0]]).length, 0, 'healthy guard remains operation-owned');
    assert.equal(applyDeleteGuard([rows[1]]).length, 1, 'removed account is excluded without provider-completion certification');
    assert.equal(countWriteTracker.inspect().localIntents, 1, 'a server-side lifetime is not cancelled by hiding its presentation');
    s.finishArchiveCount('removed', { countTargets: [rows[1]] }, b);
    assert.equal(countWriteTracker.inspect().localIntents, 0);
    assert.equal(Object.values(useStore.getState().countOperations.operations).some(op => op.account === 'b'), false);
    const fence = { epoch: 'lifecycle.test', seq: '70', version: useStore.getState().countWrites.version };
    useStore.setState({ countFence: fence });
    const observed = snapshot(25, 20, '71');
    observed.snapshots.a = { ...observed.snapshots.a, epoch: fence.epoch, quiescentAtStart: true, refreshSeqAtStart: fence.seq };
    s.setUnreadCounts(observed, generation);
    s.setCategoryCounts({ primary: 25 }, '72', generation, { a: { counts: { primary: 25 }, totals: { primary: 28 } } }, fence);
    assert.equal(useStore.getState().unreadCounts.byAccount.a, 25, 'unreachable account work cannot freeze healthy provider truth');
    assert.equal(Object.keys(useStore.getState().countOperations.operations).length, 0);
    assert.equal(applyDeleteGuard([rows[0]]).length, 1);
  });
}

test('late mixed-account archive resolution and completion cannot revive an authoritatively removed account', () => {
  const s = useStore.getState(), generation = s.countGeneration;
  const rows = ['a', 'b'].map(account => ({ id: `late-${account}.test`, account_id: account, folder: 'INBOX', is_read: false }));
  s.beginArchiveCount('mixed-account-held', [rows[0]], 104750);
  s.setAccounts([{ id: 'a', enabled: true }], generation);
  const targets = s.updateArchiveCount('mixed-account-held', rows, generation);
  assert.deepEqual(targets.map(row => row.account_id), ['a']);
  s.finishArchiveCount('mixed-account-held', { countTargets: rows }, generation);
  assert.equal(Object.values(useStore.getState().countOperations.operations).some(op => op.account === 'b'), false);
  s.incrementUnread('b');
  assert.equal(Object.values(useStore.getState().countOperations.operations).some(op => op.account === 'b'), false,
    'a late legacy inverse cannot recreate excluded presentation obligations');
});

for (const transition of ['removed', 'disabled']) {
  test(`authoritative re-enable after ${transition} admits fresh work without reviving the old group`, async () => {
    const { countWriteTracker } = await import('../utils/countWriteTracker.js');
    const s = useStore.getState(), generation = s.countGeneration;
    const old = { id: 'old-account.test', account_id: 'b', folder: 'INBOX', is_read: false };
    const fresh = { ...old, id: 'new-account.test' };
    s.beginArchiveCount('old-account', [old], 104750);
    if (transition === 'removed') s.setAccounts([accounts[0]], generation);
    else s.updateAccount('b', { enabled: false }, generation);
    assert.equal(Object.keys(useStore.getState().countOperations.operations).length, 0);
    assert.equal(countWriteTracker.inspect().localIntents, 1);
    if (transition === 'removed') s.setAccounts(accounts, generation);
    else s.updateAccount('b', { enabled: true }, generation);
    s.beginArchiveCount('new-account', [fresh], 104750);
    assert.equal(countWriteTracker.inspect().localIntents, 2);
    s.finishArchiveCount('old-account', { countTargets: [old] }, generation);
    assert.equal(countWriteTracker.inspect().localIntents, 1);
    const remaining = Object.values(useStore.getState().countOperations.operations);
    assert.deepEqual(remaining.map(op => op.targetId), [fresh.id], 'old completion cannot reintroduce previously excluded presentation');
    assert.equal(useStore.getState().unreadCounts.byAccount.b, 19, 'newly enabled account retains only its new debit');
    s.cancelArchiveCount('new-account', generation);
    assert.equal(countWriteTracker.inspect().localIntents, 0);
  });
}

test('re-enable permits a future archive without reintroducing the removed member of an older mixed group', async () => {
  const { countWriteTracker } = await import('../utils/countWriteTracker.js');
  const s = useStore.getState(), generation = s.countGeneration;
  const rows = ['a', 'b'].map(account => ({ id: `old-mixed-${account}.test`, account_id: account, folder: 'INBOX', is_read: false }));
  s.beginArchiveCount('old-mixed', rows, 104750);
  s.setAccounts([accounts[0]], generation);
  s.setAccounts(accounts, generation);
  s.setUnreadCounts(snapshot(10, 19, '70'), generation); // old B write already appears in provider truth
  assert.equal(countWriteTracker.inspect().localIntents, 1);
  s.finishArchiveCount('old-mixed', { countTargets: rows }, generation);
  assert.equal(countWriteTracker.inspect().localIntents, 0);
  assert.equal(Object.values(useStore.getState().countOperations.operations).some(op => op.account === 'b'), false);
  assert.equal(useStore.getState().unreadCounts.byAccount.b, 19, 'old B must not be subtracted twice after re-enable');
  s.beginArchiveCount('future-b', [{ ...rows[1], id: 'future-b.test' }], 104750);
  assert.equal(useStore.getState().unreadCounts.byAccount.b, 18, 'newly admitted work may use the re-enabled account');
  s.cancelArchiveCount('future-b', generation);
  assert.equal(countWriteTracker.inspect().localIntents, 0);
});

test('empty category data is known only after every account in the exact scope has an observation', () => {
  const s = useStore.getState();
  assert.equal(useStore.getState().categoryKnown, false);
  s.setCategoryCounts({}, '10', s.countGeneration, { a: { counts: {}, totals: {} } });
  assert.equal(useStore.getState().categoryKnown, false, 'unified b remains unobserved');
  s.setSelectedAccount('a');
  assert.equal(useStore.getState().categoryKnown, true);
  s.setSelectedAccount(null);
  assert.equal(useStore.getState().categoryKnown, false);
  s.setCategoryCounts({}, '11', s.countGeneration, { b: { counts: {}, totals: {} } });
  assert.equal(useStore.getState().categoryKnown, true);
  s.setLocked(true);
  assert.equal(useStore.getState().categoryKnown, false);
});

test('the last category archive remains an observed zero after its post-certification query settles', () => {
  const s = useStore.getState(), generation = s.countGeneration;
  s.setSelectedAccount('a');
  s.setCategoryCounts({ primary: 1 }, '10', generation, { a: { counts: { primary: 1 }, totals: { primary: 1 } } });
  const target = { id: 'last-category.test', account_id: 'a', folder: 'INBOX', category: 'primary', is_read: false };
  s.beginArchiveCount('last-category', [target], 104750);
  assert.equal(useStore.getState().categoryTotals.primary, 0);
  s.finishArchiveCount('last-category', { countTargets: [target] }, generation);
  const fence = { epoch: 'last-category.test', seq: '20', version: useStore.getState().countWrites.version };
  useStore.setState({ countFence: fence });
  const observed = snapshot(0, 20, '21');
  observed.snapshots.a = { ...observed.snapshots.a, epoch: fence.epoch, quiescentAtStart: true, refreshSeqAtStart: fence.seq };
  s.setUnreadCounts(observed, generation);
  s.setCategoryCounts({}, '22', generation, { a: { counts: {}, totals: {} } }, fence);
  assert.equal(Object.keys(useStore.getState().countOperations.operations).length, 0);
  assert.equal(useStore.getState().categoryKnown, true, 'an empty aggregate is a successful observation, not missing data');
  assert.deepEqual(useStore.getState().categoryTotals, {}, 'the SQL result has no synthetic category keys');
});
