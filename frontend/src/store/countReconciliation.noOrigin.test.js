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
afterEach(async () => { useStore.getState().setLocked(true); await flush(); });

for (const mode of ['success', 'uncertain-applied', 'disabled']) {
  test(`no-origin label read: ${mode} observes uncached INBOX sibling category truth`, async t => {
    const label = { id: 'label-copy.test', account_id: 'a', folder: 'Labels/Work', is_read: false };
    const targets = mode === 'disabled' ? [label, { ...label, id: 'label-copy-b.test', account_id: 'b' }] : [label];
    // The sibling exists only in fake server/provider truth, never the client cache.
    const sibling = { id: 'uncached-inbox.test', account_id: 'a', folder: 'INBOX', is_read: false };
    const epoch = `no-origin-${mode}.test`, lease = { token: `${epoch}.1`, expiresInMs: 360000 };
    let releaseWrite, committed = false, refreshIssued = false, attempts = 0;
    const categories = [], order = [];
    const observations = certified => ({ lease,
      byAccount: Object.fromEntries(useStore.getState().accounts.filter(a => a.enabled).map(a => [a.id,
        a.id === 'a' ? (sibling.is_read ? 9 : 10) : (mode === 'disabled' && committed ? 19 : 20)])),
      snapshots: Object.fromEntries(useStore.getState().accounts.filter(a => a.enabled).map(a => [a.id, {
        known: true, stale: false, totalCount: 30, observedAt: new Date().toISOString(), epoch,
        revision: certified ? '11' : '1', quiescentAtStart: certified, refreshSeqAtStart: certified ? '10' : '0',
      }])),
    });
    t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
      const path = new URL(url, 'https://synthetic.test');
      if (path.pathname.endsWith('/counts/refresh')) {
        assert.equal(committed, true);
        assert.equal(countWriteTracker.inspect().inFlight + countWriteTracker.inspect().localIntents, 0);
        refreshIssued = true; order.push('refresh');
        return { ok: true, json: async () => ({ epoch, refreshSeq: '10' }) };
      }
      if (path.pathname.endsWith('/unread-counts')) {
        order.push(refreshIssued ? 'provider-certified' : 'lease');
        return { ok: true, json: async () => observations(refreshIssued) };
      }
      if (path.pathname.endsWith('/category-counts')) {
        const account = path.searchParams.get('accountId');
        assert.equal(refreshIssued, true);
        assert.equal(useStore.getState().serverUnreadCounts.snapshots.b.refreshSeqAtStart, '10');
        assert.ok(useStore.getState().accounts.some(a => a.id === account && a.enabled));
        order.push(`category:${account}`); categories.push(account);
        const count = account === 'a' ? 9 : 19;
        return { ok: true, json: async () => ({ countRevision: '12', counts: { primary: count },
          byAccount: { [account]: { counts: { primary: count }, totals: { primary: 30 } } } }) };
      }
      assert.ok(path.pathname.endsWith('/messages/bulk-read'));
      assert.deepEqual(JSON.parse(opts.body).ids, targets.map(row => row.id));
      assert.ok(opts.headers['X-Count-Op']);
      attempts++;
      return new Promise((resolve, reject) => { releaseWrite = () => {
        committed = true; sibling.is_read = true;
        if (mode === 'uncertain-applied') reject(new Error('synthetic.test uncertain network result'));
        else resolve({ ok: true, json: async () => ({ ok: true }) });
      }; });
    });
    const s = useStore.getState(); s.setUser({ id: `${epoch}-user` }); s.setLocked(false);
    const generation = useStore.getState().countGeneration;
    s.setAccounts([{ id: 'a', enabled: true }, { id: 'b', enabled: true }], generation);
    s.setUnreadCounts(observations(false), generation);
    s.setCategoryCounts({ primary: 30 }, '1', generation, {
      a: { counts: { primary: 10 }, totals: { primary: 30 } },
      b: { counts: { primary: 20 }, totals: { primary: 30 } },
    });
    const end = beginCountIntent(targets.map(row => row.account_id));
    let outcome;
    try {
      await flush();
      assert.equal(refreshIssued, false, 'queue waiting is inside the local intent');
      assert.deepEqual(useStore.getState().countOperations.operations, {}, 'NONE does not create a fake zero origin');
      outcome = api.bulkRead(targets.map(row => row.id), true).then(value => ({ value }), error => ({ error }));
      await flush(); assert.equal(typeof releaseWrite, 'function');
      assert.equal(useStore.getState().unreadCounts.byAccount.a, 10);
      assert.equal(useStore.getState().categoryCounts.primary, 30);
      if (mode === 'disabled') s.updateAccount('a', { enabled: false }, generation);
      releaseWrite();
      const result = await outcome;
      assert.equal(!!result.error, mode === 'uncertain-applied');
      assert.equal(attempts, 1, 'an uncertain network outcome is not replayed');
      await flush(); assert.equal(refreshIssued, false, 'funnel completion alone cannot end the action');
      end(); await flush();
      assert.equal(useStore.getState().unreadCounts.byAccount[mode === 'disabled' ? 'b' : 'a'], mode === 'disabled' ? 19 : 9);
      assert.equal(useStore.getState().categoryCounts.primary, mode === 'disabled' ? 19 : 29,
        'a cohort without optimistic origins must still re-observe its category truth');
      assert.deepEqual(categories, mode === 'disabled' ? ['b'] : ['a'], 'scope is target-bounded, not every account');
      assert.ok(order.indexOf(`category:${mode === 'disabled' ? 'b' : 'a'}`) > order.indexOf('provider-certified'));
      if (mode === 'disabled') {
        assert.equal(useStore.getState().serverCategoryCounts.a.counts.primary, 10);
        assert.equal(useStore.getState().serverCategoryCounts.a.requestedAfter, null);
      }
      assert.deepEqual(useStore.getState().countOperations.operations, {});
      assert.deepEqual(countWriteTracker.inspect().accountIds, []);
      assert.equal(countWriteTracker.inspect().localIntents, 0);
      assert.equal(useStore.getState().countObservationNeeded, false);
    } finally {
      s.setLocked(true); releaseWrite?.(); end(); await outcome; await flush();
    }
  });
}
