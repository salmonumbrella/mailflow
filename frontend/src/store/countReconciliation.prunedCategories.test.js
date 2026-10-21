import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true } : nextLoad(url, context);
} });
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { useStore } = await import('./index.js');
globalThis.window = new EventTarget(); globalThis.document = new EventTarget();
const { api } = await import('../utils/api.js');
const { beginCountIntent, countWriteTracker } = await import('../utils/countWriteTracker.js');
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const epoch = 'pruned-category.test';
const lease = { token: `${epoch}.1`, expiresInMs: 360000 };
afterEach(async () => { useStore.getState().setLocked(true); await flush(); });

for (const mode of ['bounce', 'unchanged', 'disabled']) {
  test(`pruned category observation: ${mode} observes scoped DB truth after the admitted write`, async t => {
    const requests = [], categoryRequests = [];
    let committed = false, refreshIssued = false, releaseWrite;
    const counts = certified => {
      const ids = useStore.getState().accounts.filter(a => a.enabled).map(a => a.id);
      return { lease, byAccount: Object.fromEntries(ids.map(id => [id, id === 'a' ? (committed ? 7 : 10) : 20])),
        snapshots: Object.fromEntries(ids.map(id => [id, {
          totalCount: id === 'a' ? 13 : 23, revision: certified ? '11' : '1',
          known: true, stale: false, observedAt: new Date().toISOString(), epoch,
          quiescentAtStart: certified, refreshSeqAtStart: certified ? '10' : '0',
        }])) };
    };
    t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
      const path = new URL(url, 'https://synthetic.test');
      if (path.pathname.endsWith('/counts/refresh')) {
        assert.equal(committed, true);
        assert.equal(countWriteTracker.inspect().inFlight + countWriteTracker.inspect().localIntents, 0);
        requests.push('refresh'); refreshIssued = true;
        return { ok: true, json: async () => ({ epoch, refreshSeq: '10' }) };
      }
      if (path.pathname.endsWith('/unread-counts')) {
        requests.push(refreshIssued ? 'provider-certified' : 'lease');
        return { ok: true, json: async () => counts(refreshIssued) };
      }
      if (path.pathname.endsWith('/category-counts')) {
        const account = path.searchParams.get('accountId');
        assert.equal(committed, true);
        assert.equal(useStore.getState().serverUnreadCounts.snapshots.b.quiescentAtStart, true);
        assert.equal(useStore.getState().serverUnreadCounts.snapshots.b.refreshSeqAtStart, '10');
        assert.ok(useStore.getState().accounts.some(a => a.id === account && a.enabled), 'excluded accounts are not falsely certified');
        requests.push(`category:${account}`); categoryRequests.push(account);
        const count = account === 'a' ? 7 : 20;
        return { ok: true, json: async () => ({ countRevision: '12', counts: { primary: count },
          byAccount: { [account]: { counts: { primary: count }, totals: { primary: account === 'a' ? 13 : 23 } } } }) };
      }
      assert.ok(path.pathname.endsWith('/messages/bulk-read'));
      assert.equal(opts.method, 'POST'); assert.ok(opts.headers['X-Count-Op']);
      return new Promise(resolve => { releaseWrite = () => {
        committed = true;
        resolve({ ok: true, json: async () => ({ ok: true }) });
      }; });
    });
    const s = useStore.getState(); s.setUser({ id: `pruned-category-${mode}.test` }); s.setLocked(false);
    const generation = useStore.getState().countGeneration;
    s.setAccounts([{ id: 'a', enabled: true }, { id: 'b', enabled: true }], generation);
    s.setUnreadCounts(counts(false), generation);
    s.setCategoryCounts({ primary: 30 }, '1', generation, {
      a: { counts: { primary: 10 }, totals: { primary: 13 } },
      b: { counts: { primary: 20 }, totals: { primary: 23 } },
    });
    const initialCategoryA = structuredClone(useStore.getState().serverCategoryCounts.a);
    assert.equal(initialCategoryA.requestedAfter, null, 'initial absence is normalized by setCategoryCounts');
    const end = beginCountIntent();
    let write;
    try {
      s.decrementUnread('a', 3); s.adjustCategoryCount('primary', -3);
      const origins = Object.keys(useStore.getState().countOperations.operations);
      assert.equal(origins.length, 2);
      assert.deepEqual(Object.keys(useStore.getState().countOperations.categoryBaselines).sort(), ['a', 'b']);
      write = api.bulkRead(['first.test', 'second.test', 'third.test'], true);
      await flush(); assert.equal(typeof releaseWrite, 'function');
      if (mode !== 'unchanged') {
        s.updateAccount('a', { enabled: false }, generation);
        if (mode === 'bounce') s.updateAccount('a', { enabled: true }, generation);
        for (const id of origins) assert.equal(useStore.getState().countOperations.operations[id], undefined);
        assert.deepEqual(useStore.getState().countOperations.categoryBaselines, {});
      }
      assert.equal(countWriteTracker.inspect().localIntents, 1);
      assert.deepEqual(categoryRequests, []);
      releaseWrite(); await write; await flush();
      assert.equal(countWriteTracker.inspect().inFlight, 0);
      assert.equal(refreshIssued, false, 'the action still owns its local lifetime after HTTP completion');
      end(); await flush();
      assert.deepEqual(categoryRequests.sort(), mode === 'disabled' ? ['b'] : ['a', 'b'],
        'the cohort observes its eligible category accounts even after every origin and baseline was pruned');
      assert.ok(requests.indexOf('category:b') > requests.indexOf('provider-certified'));
      assert.equal(useStore.getState().unreadCounts.total, mode === 'disabled' ? 20 : 27);
      assert.equal(useStore.getState().categoryCounts.primary, mode === 'disabled' ? 20 : 27);
      assert.deepEqual(useStore.getState().countOperations.operations, {});
      assert.equal(useStore.getState().countObservationNeeded, false);
      assert.equal(countWriteTracker.inspect().localIntents, 0);
      if (mode === 'disabled') {
        assert.equal(useStore.getState().serverCategoryCounts.a.counts.primary, 10);
        assert.deepEqual(useStore.getState().serverCategoryCounts.a, initialCategoryA, 'disabled account keeps its initial observation without a certification stamp');
      } else {
        assert.equal(useStore.getState().serverCategoryCounts.a.requestedAfter.seq, '10');
      }
    } finally {
      s.setLocked(true); releaseWrite?.(); end();
      await write?.catch(() => {}); await flush();
    }
  });
}
