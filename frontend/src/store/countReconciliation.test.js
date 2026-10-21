import { test, afterEach, mock } from 'node:test';
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
const { runThreadAction, archiveThread, spamThread } = await import('../utils/threadActions.js');
const lease = { token: 'reconcile.test.1', expiresInMs: 360000 };
const counts = (unread, certified = false) => ({ lease, byAccount: { a: unread }, snapshots: { a: { totalCount: 13, revision: certified ? '41' : '1', known: true, stale: false, observedAt: new Date().toISOString(), epoch: 'reconcile.test', quiescentAtStart: certified, refreshSeqAtStart: certified ? '40' : '0' } } });
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
afterEach(async () => { useStore.getState().setLocked(true); await flush(); });
test('held local intent and pre-certification category responses cannot retire a mixed read cohort', async () => {
  const requests = [];
  let observed = counts(10), releaseCategory;
  globalThis.fetch = async (url, opts = {}) => {
    requests.push(url);
    if (url.endsWith('/counts/refresh')) return { ok: true, json: async () => ({ epoch: 'reconcile.test', lease, refreshSeq: '40' }) };
    if (url.endsWith('/unread-counts')) return { ok: true, json: async () => observed };
    if (url.includes('/category-counts')) return new Promise(resolve => { releaseCategory = () => resolve({ ok: true, json: async () => ({ counts: { primary: 9 }, byAccount: { a: { counts: { primary: 9 }, totals: { primary: 13 } } }, countRevision: '50' }) }); });
    assert.equal(opts.method, 'POST');
    assert.ok(opts.headers['X-Count-Op']);
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const s = useStore.getState(); s.setUser({ id: 'reconcile-user.test' }); s.setLocked(false);
  s.setAccounts([{ id: 'a', enabled: true }]); s.setUnreadCounts(observed);
  s.setCategoryCounts({ primary: 10 }, '1', useStore.getState().countGeneration, { a: { counts: { primary: 10 }, totals: { primary: 13 } } });
  const end = beginCountIntent();
  s.decrementUnread('a'); s.adjustCategoryCount('primary', -1);
  await api.bulkRead(['message.test'], true); await flush();
  assert.equal(requests.some(url => url.endsWith('/counts/refresh')), false);
  s.setUnreadCounts(counts(9));
  assert.equal(useStore.getState().unreadCounts.byAccount.a, 9);
  assert.equal(useStore.getState().categoryCounts.primary, 9);
  assert.ok(Object.keys(useStore.getState().countOperations.operations).length);
  end(); await flush();
  assert.ok(requests.filter(url => url.endsWith('/unread-counts')).length <= 2, 'an unqualified poll must back off rather than schedule itself continuously');
  assert.equal(requests.filter(url => url.endsWith('/counts/refresh')).length, 1);
  assert.equal(releaseCategory, undefined, 'cached unqualified counts cannot start the retirement query');
  observed = counts(9, true); s.setUnreadCounts(observed); await flush();
  assert.equal(typeof releaseCategory, 'function');
  assert.equal(useStore.getState().categoryCounts.primary, 9);
  releaseCategory(); await flush();
  assert.equal(Object.keys(useStore.getState().countOperations.operations).length, 0);
  assert.equal(useStore.getState().unreadCounts.byAccount.a, 9);
  assert.equal(useStore.getState().unreadCounts.snapshots.a.pending, false);
});
test('a newer intent invalidates an in-flight refresh and obtains a new certificate after the old response returns', async () => {
  let refreshes = 0, releaseOld;
  globalThis.fetch = async url => {
    if (url.endsWith('/counts/refresh')) {
      refreshes++;
      if (refreshes === 1) return new Promise(resolve => { releaseOld = () => resolve({ ok: true, json: async () => ({ epoch: 'reconcile.test', refreshSeq: '40' }) }); });
      return { ok: true, json: async () => ({ epoch: 'reconcile.test', refreshSeq: '42' }) };
    }
    if (url.endsWith('/unread-counts')) {
      const value = counts(10, refreshes > 1);
      if (refreshes > 1) Object.assign(value.snapshots.a, { revision: '43', refreshSeqAtStart: '42' });
      return { ok: true, json: async () => value };
    }
    if (url.includes('/category-counts')) return { ok: true, json: async () => ({ counts: { primary: 10 }, byAccount: { a: { counts: { primary: 10 }, totals: { primary: 13 } } }, countRevision: '50' }) };
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const s = useStore.getState(); s.setUser({ id: 'newer-intent.test' }); s.setLocked(false);
  s.setAccounts([{ id: 'a', enabled: true }]); s.setUnreadCounts(counts(10));
  s.decrementUnread('a');
  await api.bulkRead(['read.test'], true); await flush();
  assert.equal(typeof releaseOld, 'function');
  assert.equal(useStore.getState().unreadCounts.byAccount.a, 9);
  const end = beginCountIntent(); s.incrementUnread('a'); end(); await flush();
  assert.equal(useStore.getState().unreadCounts.byAccount.a, 10);
  releaseOld(); await flush();
  assert.equal(refreshes, 2, 'a retired old request must not swallow the newer idle obligation');
  assert.equal(useStore.getState().countFence.seq, '42');
  assert.equal(Object.keys(useStore.getState().countOperations.operations).length, 0);
  assert.equal(useStore.getState().unreadCounts.byAccount.a, 10);
});

test('the shared thread action holds its local intent through Undo time and asynchronous target resolution', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  let refreshes = 0, commits = 0, resolveTargets;
  globalThis.fetch = async url => {
    if (url.endsWith('/counts/refresh')) { refreshes++; return { ok: true, json: async () => ({ epoch: 'reconcile.test', refreshSeq: '40' }) }; }
    if (url.includes('/category-counts')) return { ok: true, json: async () => ({ byAccount: { a: { counts: { primary: 9 }, totals: { primary: 12 } } }, countRevision: '50' }) };
    return { ok: true, json: async () => counts(commits ? 9 : 10, true) };
  };
  const s = useStore.getState(); s.setUser({ id: 'thread-intent.test' }); s.setLocked(false);
  s.setAccounts([{ id: 'a', enabled: true }]); s.setUnreadCounts(counts(10));
  const message = { id: 'thread-row.test', account_id: 'a', folder: 'INBOX', is_read: false };
  s.setMessages([message]);
  try {
    runThreadAction({ messages: [message], resolve: () => new Promise(resolve => { resolveTargets = resolve; }), commit: async () => { commits++; }, notification: {}, addNotification() {} });
    await flush();
    assert.equal(refreshes, 0, 'an Undo-pending removal cannot be certified before its request exists');
    assert.equal(useStore.getState().unreadCounts.byAccount.a, 9);
    mock.timers.tick(4500); await flush();
    assert.equal(typeof resolveTargets, 'function');
    mock.timers.tick(60000); await flush();
    assert.equal(refreshes, 0, 'asynchronous thread resolution remains part of the same intent');
    assert.equal(useStore.getState().unreadCounts.byAccount.a, 9);
    resolveTargets([message]); await flush();
    assert.equal(commits, 1);
    assert.equal(refreshes, 1);
    assert.equal(useStore.getState().unreadCounts.byAccount.a, 9);
    assert.equal(Object.keys(useStore.getState().countOperations.operations).length, 0);
  } finally { resolveTargets?.([message]); mock.timers.reset(); }
});
for (const [label, notApplied] of [['known pre-mutation refusal', true], ['uncertain network', false], ['uncertain5xx', false], ['generic409', false]]) {
  test(`thread action rollback respects ${label} and always releases its local lifetime`, async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    mock.method(console, 'error', () => {});
    let releaseRefresh, notification;
    globalThis.fetch = async url => {
      assert.ok(url.endsWith('/counts/refresh'));
      return new Promise(resolve => { releaseRefresh = () => resolve({ ok: true, json: async () => ({ epoch: 'reconcile.test', refreshSeq: '40' }) }); });
    };
    const s = useStore.getState(); s.setUser({ id: `thread-${label}.test` }); s.setLocked(false);
    s.setAccounts([{ id: 'a', enabled: true }]); s.setUnreadCounts(counts(10));
    const message = { id: 'failure.test', account_id: 'a', folder: 'INBOX', is_read: false };
    s.setMessages([message]);
    try {
      runThreadAction({ messages: [message], commit: async () => { throw Object.assign(new Error(label), { notApplied, status: label === 'generic409' ? 409 : 500 }); }, notification: { failTitle: 'failure' }, addNotification: value => { if (value.type === 'error') notification = value; } });
      mock.timers.tick(4500); await flush();
      assert.equal(useStore.getState().unreadCounts.byAccount.a, notApplied ? 10 : 9);
      assert.equal(useStore.getState().messages.length, notApplied ? 1 : 0);
      assert.equal(notification?.body, label);
      assert.equal(typeof releaseRefresh, 'function', 'failure releases the local hold so truth can be requested');
    } finally { s.setLocked(true); releaseRefresh?.(); mock.timers.reset(); mock.restoreAll(); }
  });
}
test('thread Undo is idempotent and cancels dispatch while releasing its intent', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  let undo, commits = 0;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ epoch: 'reconcile.test', refreshSeq: '40' }) });
  const s = useStore.getState(); s.setUser({ id: 'thread-undo.test' }); s.setLocked(false);
  s.setAccounts([{ id: 'a', enabled: true }]); s.setUnreadCounts(counts(10));
  const message = { id: 'undo.test', account_id: 'a', folder: 'INBOX', is_read: false }; s.setMessages([message]);
  try {
    runThreadAction({ messages: [message], commit: async () => { commits++; }, notification: {}, addNotification: n => { undo = n.onUndo; } });
    undo(); undo();
    assert.equal(useStore.getState().unreadCounts.byAccount.a, 10);
    mock.timers.tick(60000); await flush();
    assert.equal(commits, 0);
  } finally { mock.timers.reset(); }
});
test('a session change during thread resolution cannot dispatch the old user action', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  let resolveTargets, commits = 0;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ epoch: 'reconcile.test', refreshSeq: '40' }) });
  const s = useStore.getState(); s.setUser({ id: 'thread-old.test' }); s.setLocked(false);
  s.setAccounts([{ id: 'a', enabled: true }]); s.setUnreadCounts(counts(10));
  const message = { id: 'old.test', account_id: 'a', folder: 'INBOX', is_read: false }; s.setMessages([message]);
  try {
    runThreadAction({ messages: [message], resolve: () => new Promise(resolve => { resolveTargets = resolve; }), commit: async () => { commits++; }, notification: {}, addNotification() {} });
    mock.timers.tick(4500); await flush();
    s.setUser({ id: 'thread-new.test' });
    resolveTargets([message]); await flush();
    assert.equal(commits, 0);
    assert.deepEqual(useStore.getState().messages, []);
  } finally { resolveTargets?.([message]); mock.timers.reset(); }
});

for (const folder of ['INBOX', 'Sent']) {
  test(`conversation archive uses actual ${folder} source and returned countTargets`, async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const original = api.bulkArchive;
    let undo, release;
    globalThis.fetch = async () => new Promise(() => {});
    const s = useStore.getState(); s.setUser({ id: `archive-${folder}.test` }); s.setLocked(false);
    s.setAccounts([{ id: 'a', enabled: true }]); s.setUnreadCounts(counts(10));
    s.setFolders('a', [{ path: 'Sent', unread_count: 4, total_count: 6 }]);
    s.setCategoryCounts({ primary: 10 }, '1', useStore.getState().countGeneration, { a: { counts: { primary: 10 }, totals: { primary: 13 } } });
    const row = { id: 'archive-source.test', account_id: 'a', folder, category: 'primary', is_read: false };
    s.setMessages([row]);
    api.bulkArchive = async () => new Promise(resolve => { release = resolve; });
    try {
      archiveThread([row], { t: x => x, folder, accountId: 'a', anchorId: row.id, addNotification: n => { undo = n.onUndo; } });
      assert.equal(useStore.getState().unreadCounts.byAccount.a, folder === 'INBOX' ? 9 : 10);
      assert.equal(useStore.getState().categoryCounts.primary, folder === 'INBOX' ? 9 : 10);
      if (folder === 'Sent') assert.equal(useStore.getState().folders.a[0].total_count, 5);
      undo(); undo();
      assert.equal(useStore.getState().unreadCounts.byAccount.a, 10);
      assert.equal(useStore.getState().messages.length, 1);
      archiveThread([row], { t: x => x, folder, accountId: 'a', anchorId: row.id, addNotification() {} });
      mock.timers.tick(4500); await flush();
      assert.equal(typeof release, 'function');
      release({ archived: [row.id], countTargets: [] }); await flush();
      assert.equal(useStore.getState().unreadCounts.byAccount.a, 10, 'a no-op archived ID never authorizes a count debit');
      if (folder === 'Sent') assert.equal(useStore.getState().folders.a[0].total_count, 6);
    } finally { api.bulkArchive = original; useStore.getState().setLocked(true); mock.timers.reset(); }
  });
}

test('HTTP200 mixed writer-fence outcome retains its uncertain delta and row guard through a reflected STATUS', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const original = api.bulkArchive;
  const { applyDeleteGuard } = await import('../utils/pendingDeletes.js');
  const s = useStore.getState(); s.setUser({ id: 'writer-fence.test' }); s.setLocked(false);
  s.setAccounts([{ id: 'a', enabled: true }]); s.setUnreadCounts(counts(10));
  const rows = ['confirmed.test', 'uncertain.test'].map(id => ({ id, account_id: 'a', folder: 'INBOX', is_read: false }));
  s.setMessages(rows);
  api.bulkArchive = async () => ({ archived: [rows[0].id], countTargets: [rows[0]], unconfirmed: [rows[1].id] });
  globalThis.fetch = async () => new Promise(() => {});
  try {
    archiveThread(rows, { t: x => x, addNotification() {} });
    mock.timers.tick(4500); await flush();
    s.setUnreadCounts(counts(8));
    assert.equal(useStore.getState().unreadCounts.byAccount.a, 8, 'uncertain provider effect cannot be rolled back or subtracted twice');
    assert.equal(useStore.getState().messages.length, 0, 'the uncertain member stays hidden');
    assert.equal(applyDeleteGuard(rows).length, 0, 'both operation-owned row guards remain until certification');
    assert.equal(Object.keys(useStore.getState().countOperations.operations).length, 2);
  } finally { s.setLocked(true); api.bulkArchive = original; mock.timers.reset(); }
});

test('certification releases an uncertain archive guard and refreshes the current normal list once', async () => {
  const { setPendingDelete, applyDeleteGuard } = await import('../utils/pendingDeletes.js');
  const original = api.refreshCounts; api.refreshCounts = async () => new Promise(() => {});
  const s = useStore.getState(); s.setUser({ id: 'uncertain-retirement.test' }); s.setLocked(false);
  s.setAccounts([{ id: 'a', enabled: true }]); s.setUnreadCounts(counts(10));
  const row = { id: 'retirement.test', account_id: 'a', folder: 'INBOX', is_read: false };
  const generation = s.beginArchiveCount('uncertain', [row], 0);
  setPendingDelete(row.id, { archive: true, generation, group: 'uncertain' });
  s.finishArchiveCount('uncertain', { unconfirmed: [row.id] }, generation);
  await flush();
  let refreshes = 0; const onRefresh = () => refreshes++;
  window.addEventListener('mailflow:refresh', onRefresh);
  try {
    assert.equal(applyDeleteGuard([row]).length, 0);
    const fence = { epoch: 'reconcile.test', seq: '40', version: useStore.getState().countWrites.version };
    useStore.setState({ countFence: fence });
    s.setUnreadCounts(counts(10, true));
    assert.equal(applyDeleteGuard([row]).length, 0, 'category query fence still holds the whole cohort');
    s.setCategoryCounts({}, '50', generation, { a: { counts: {}, totals: {} } }, fence);
    await flush();
    assert.equal(Object.keys(useStore.getState().countOperations.operations).length, 0);
    assert.equal(applyDeleteGuard([row]).length, 1);
    assert.equal(refreshes, 1, 'after truth is certified, hidden-but-not-applied mail becomes fetchable again');
  } finally { s.setLocked(true); api.refreshCounts = original; window.removeEventListener('mailflow:refresh', onRefresh); }
});

for (const status of [undefined, 500, 409]) {
  test(`mixed thread spam waits for every member and rolls back only refused IDs (uncertain ${status || 'network'})`, async () => {
    mock.timers.enable({ apis: ['setTimeout'] }); mock.method(console, 'error', () => {});
    const original = api.markSpam, refresh = api.refreshCounts;
    let rejectUncertain, refreshes = 0;
    api.refreshCounts = async () => { refreshes++; return new Promise(() => {}); };
    const s = useStore.getState(); s.setUser({ id: `mixed-spam-${status || 'network'}.test` }); s.setLocked(false);
    const accounts = [{ id: 'a', enabled: true, email_address: 'self@mail.test' }];
    s.setAccounts(accounts); s.setUnreadCounts(counts(10));
    const rows = ['success.test', 'refused.test', 'uncertain.test'].map(id => ({ id, account_id: 'a', folder: 'INBOX', from_email: 'sender@mail.test', is_read: false }));
    s.setMessages(rows);
    api.markSpam = async id => {
      if (id === rows[0].id) return { ok: true };
      if (id === rows[1].id) throw Object.assign(new Error('Admission refused'), { notApplied: true });
      return new Promise((_resolve, reject) => { rejectUncertain = reject; });
    };
    try {
      spamThread(rows, { accounts, t: x => x, addNotification: s.addNotification });
      assert.equal(useStore.getState().unreadCounts.byAccount.a, 7);
      mock.timers.tick(4500); await flush();
      assert.equal(countWriteTracker.inspect().localIntents, 1, 'a refusal cannot end the lifetime of a still-running sibling');
      assert.equal(refreshes, 0);
      assert.equal(useStore.getState().unreadCounts.byAccount.a, 7);
      rejectUncertain(Object.assign(new Error('Uncertain completion'), { status, notApplied: false })); await flush();
      assert.equal(countWriteTracker.inspect().localIntents, 0);
      assert.deepEqual(useStore.getState().messages.map(row => row.id), [rows[1].id]);
      assert.equal(useStore.getState().unreadCounts.byAccount.a, 8, 'success and uncertain rows retain their own debits');
      assert.equal(refreshes, 1);
      assert.ok(useStore.getState().notifications.some(n => n.type === 'error'));
    } finally {
      rejectUncertain?.(new Error('cleanup')); s.setLocked(true); s.setUser(null); api.markSpam = original; api.refreshCounts = refresh;
      await flush(); mock.timers.reset(); mock.restoreAll();
    }
  });
}
