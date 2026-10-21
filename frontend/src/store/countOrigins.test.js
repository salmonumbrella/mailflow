import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true } : nextLoad(url, context);
} });
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { useStore } = await import('./index.js');
globalThis.window = new EventTarget();
const { api } = await import('../utils/api.js');
const { beginCountIntent, countWriteTracker } = await import('../utils/countWriteTracker.js');
const accounts = [{ id: 'a', enabled: true }, { id: 'b', enabled: true }];
const originalApi = { refreshCounts: api.refreshCounts, getUnreadCounts: api.getUnreadCounts, getCategoryCounts: api.getCategoryCounts };
const flush = async () => { for (let n = 0; n < 150; n++) await Promise.resolve(); };
const observations = (certified = false) => ({ byAccount: { a: 10, b: 20 }, snapshots: Object.fromEntries(accounts.map(account => [account.id, {
  totalCount: 30, revision: certified ? '11' : '1', known: true, stale: false, observedAt: new Date().toISOString(),
  epoch: 'origins.test', quiescentAtStart: certified, refreshSeqAtStart: certified ? '10' : '0',
}])) });
const categories = account => ({ counts: { primary: account === 'a' ? 10 : 20 }, totals: { primary: 30 } });
const factories = [
  ['increment', (s, n) => s.incrementUnread('a', n)],
  ['decrement', (s, n) => s.decrementUnread('a', n)],
  ['category', (s, n) => s.adjustCategoryCount('primary', n)],
];
beforeEach(() => {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  api.refreshCounts = async () => new Promise(() => {});
  const s = useStore.getState(); s.setUser({ id: 'count-origin.test' }); s.setLocked(false);
  useStore.setState({ selectedAccountId: null }); s.setAccounts(accounts);
  s.setUnreadCounts(observations());
  s.setCategoryCounts({ primary: 30 }, '1', useStore.getState().countGeneration, { a: categories('a'), b: categories('b') });
});
afterEach(async () => {
  useStore.getState().setLocked(true); useStore.getState().setUser(null);
  Object.assign(api, originalApi); await flush(); mock.timers.reset();
});

for (const [kind, create] of factories) {
  test(`origin ${kind}: live replacement preserves identity and scope; revert is one-shot`, () => {
    const end = beginCountIntent();
    try {
      const origin = create(useStore.getState(), 2);
      assert.equal(origin.state(), 'live');
      const [id] = Object.keys(useStore.getState().countOperations.operations);
      const initial = useStore.getState().countOperations.operations[id];
      assert.equal(origin.replace(-3), true);
      assert.deepEqual(useStore.getState().countOperations.operations[id], { ...initial, unreadDelta: -3 });
      assert.equal(Object.keys(useStore.getState().countOperations.operations).length, 1);
      assert.equal(origin.replace(Number.NaN), false);
      assert.equal(origin.revert(), true); assert.equal(origin.state(), 'pruned');
      assert.equal(origin.revert(), false); assert.equal(origin.replace(1), false);
      assert.equal(Object.keys(useStore.getState().countOperations.operations).length, 0);
      assert.equal(countWriteTracker.inspect().localIntents, 1, 'the handle does not end its caller lifetime');
    } finally { end(); }
  });

  test(`origin ${kind}: zero or missing origin is none and may receive a first fresh delta`, () => {
    const end = beginCountIntent();
    try {
      let missing = null;
      assert.equal(missing?.state() ?? 'none', 'none');
      const zero = create(useStore.getState(), 0);
      assert.equal(zero.state(), 'none'); assert.equal(zero.replace(1), false); assert.equal(zero.revert(), false);
      const invalid = create(useStore.getState(), Number.NaN);
      assert.equal(invalid.state(), 'none'); assert.equal(invalid.replace(1), false);
      assert.equal(Object.keys(useStore.getState().countOperations.operations || {}).length, 0);
      missing = create(useStore.getState(), 1);
      assert.equal(missing.state(), 'live'); assert.equal(missing.revert(), true);
      assert.equal(zero.state(), 'none', 'admission creates a fresh handle, not a revived zero origin');
    } finally { end(); }
  });

  test(`origin ${kind}: locked creation is none without an entry`, () => {
    useStore.getState().setLocked(true);
    const absent = create(useStore.getState(), 1);
    assert.equal(absent.state(), 'none'); assert.equal(absent.revert(), false); assert.equal(absent.replace(1), false);
    assert.equal(Object.keys(useStore.getState().countOperations.operations || {}).length, 0);
  });

  test(`origin ${kind}: excluded at creation is none; re-enable permits a first fresh delta`, () => {
    const end = beginCountIntent();
    try {
      const s = useStore.getState(), generation = s.countGeneration;
      s.updateAccount('a', { enabled: false }, generation);
      if (kind === 'category') s.updateAccount('b', { enabled: false }, generation);
      const absent = create(useStore.getState(), 1);
      assert.equal(absent.state(), 'none'); assert.equal(absent.replace(1), false);
      s.setAccounts(accounts, generation);
      assert.equal(absent.state(), 'none');
      const fresh = create(useStore.getState(), 1);
      assert.equal(fresh.state(), 'live'); assert.equal(fresh.revert(), true);
    } finally { end(); }
  });

  test(`origin ${kind}: exclusion prunes an existing origin permanently without suppressing new work`, () => {
    const end = beginCountIntent();
    try {
      const s = useStore.getState(), generation = s.countGeneration;
      const old = create(s, 1);
      s.updateAccount('a', { enabled: false }, generation); s.updateAccount('a', { enabled: true }, generation);
      assert.equal(old.state(), 'pruned'); assert.equal(old.replace(8), false); assert.equal(old.revert(), false);
      const fresh = create(useStore.getState(), 1);
      const before = useStore.getState().countOperations;
      assert.equal(old.revert(), false); assert.equal(old.replace(8), false);
      assert.deepEqual(useStore.getState().countOperations, before);
      assert.equal(fresh.state(), 'live'); assert.equal(fresh.revert(), true);
    } finally { end(); }
  });

  test(`origin ${kind}: session change prunes old handles; stale ends do not end the new intent`, () => {
    const oldEnd = beginCountIntent(), old = create(useStore.getState(), 1);
    useStore.getState().setLocked(true); useStore.getState().setLocked(false);
    useStore.getState().setAccounts(accounts);
    assert.equal(old.state(), 'pruned'); assert.equal(old.replace(3), false); assert.equal(old.revert(), false);
    const end = beginCountIntent();
    try {
      oldEnd(); oldEnd(); assert.equal(countWriteTracker.inspect().localIntents, 1);
      const fresh = create(useStore.getState(), 1);
      assert.equal(fresh.state(), 'live'); assert.equal(fresh.revert(), true);
    } finally { end(); }
    assert.equal(countWriteTracker.inspect().localIntents, 0);
  });

  test(`origin ${kind}: replace zero retains identity and scope then normal post-intent certification retires it`, async () => {
    const calls = [];
    api.refreshCounts = async () => { calls.push('refresh'); return { epoch: 'origins.test', refreshSeq: '10' }; };
    api.getUnreadCounts = async () => { calls.push('provider'); return observations(true); };
    api.getCategoryCounts = async ({ accountId }) => {
      assert.equal(useStore.getState().serverUnreadCounts.snapshots.a.quiescentAtStart, true);
      calls.push(`category:${accountId}`);
      return { counts: categories(accountId).counts, countRevision: '12', byAccount: { [accountId]: categories(accountId) } };
    };
    const end = beginCountIntent(), origin = create(useStore.getState(), 2);
    const [id] = Object.keys(useStore.getState().countOperations.operations);
    const initial = useStore.getState().countOperations.operations[id];
    assert.equal(origin.replace(0), true); assert.equal(origin.state(), 'live');
    assert.deepEqual(useStore.getState().countOperations.operations[id], { ...initial, unreadDelta: 0 });
    await flush(); assert.deepEqual(calls, [], 'the owning local intent prevents certification');
    end(); await flush();
    assert.equal(countWriteTracker.inspect().localIntents, 0);
    assert.equal(Object.keys(useStore.getState().countOperations.operations).length, 0);
    assert.equal(useStore.getState().countObservationNeeded, false);
    assert.equal(origin.state(), 'pruned'); assert.equal(origin.revert(), false);
    assert.deepEqual(calls, kind === 'category' ? ['refresh', 'provider', 'category:a', 'category:b'] : ['refresh', 'provider', 'category:a']);
  });
}

test('origin category: another account prunes categoryScope while the unread account remains live', () => {
  const end = beginCountIntent();
  try {
    const s = useStore.getState(), generation = s.countGeneration;
    const unread = s.decrementUnread('a'), category = s.adjustCategoryCount('primary', -1);
    s.updateAccount('b', { enabled: false }, generation); s.updateAccount('b', { enabled: true }, generation);
    assert.equal(unread.state(), 'live'); assert.equal(category.state(), 'pruned');
    assert.equal(category.replace(-8), false); assert.equal(category.revert(), false);
    assert.equal(unread.replace(-2), true); assert.equal(useStore.getState().unreadCounts.byAccount.a, 8);
    assert.equal(useStore.getState().categoryCounts.primary, 30, 'pruned category scope is not re-created');
    assert.equal(unread.revert(), true); assert.equal(useStore.getState().unreadCounts.byAccount.a, 10);
  } finally { end(); }
});

test('origin discovered account: none may admit its first fresh delta after re-enable without reviving another origin', () => {
  const end = beginCountIntent();
  try {
    const s = useStore.getState(), generation = s.countGeneration, a = s.decrementUnread('a');
    let b = null;
    s.updateAccount('b', { enabled: false }, generation); s.updateAccount('b', { enabled: true }, generation);
    assert.equal(b?.state() ?? 'none', 'none'); assert.equal(a.state(), 'live');
    b = s.decrementUnread('b', 3);
    assert.equal(b.state(), 'live'); assert.equal(useStore.getState().unreadCounts.byAccount.b, 17);
    assert.equal(a.state(), 'live'); assert.equal(useStore.getState().unreadCounts.byAccount.a, 9);
    assert.equal(b.revert(), true); assert.equal(a.revert(), true);
    assert.equal(useStore.getState().unreadCounts.byAccount.b, 20);
  } finally { end(); }
});
