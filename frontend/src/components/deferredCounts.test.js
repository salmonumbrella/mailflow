// Execute the real, named component action boundaries with the real count store. The
// surrounding pane rendering is covered separately; only lexical UI adapters are supplied.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, next) { return url.endsWith('.json') ? { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` } : next(url, context); } });
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { useStore } = await import('../store/index.js');
globalThis.window = new EventTarget(); globalThis.document = new EventTarget();
const { api } = await import('../utils/api.js');
const { beginCountIntent, countWriteTracker } = await import('../utils/countWriteTracker.js');
const guards = await import('../utils/pendingDeletes.js');
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const snapshots = () => ({ byAccount: { a: 10 }, snapshots: { a: { totalCount: 13, revision: '1', known: true, stale: false, observedAt: new Date().toISOString() } } });
function action(name, env, file = 'MessagePane.jsx') {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const start = source.indexOf(`  const ${name} =`), end = source.indexOf('\n  const ', start + 1);
  assert.ok(start >= 0 && end > start);
  const snippet = source.slice(start, end), close = snippet.match(/\n {2}(?:\};|\}, \[[^\]]*\]\);)/);
  assert.ok(close, 'named declaration ends before unrelated component effects');
  return new Function(...Object.keys(env), `${snippet.slice(0, close.index + close[0].length)};return ${name};`)(...Object.values(env));
}
afterEach(async () => { useStore.getState().setLocked(true); await flush(); });
const cases = [
  ['handleDelete', 'deleteMessage', undefined],
  ['handleMoveToFolder', 'bulkMove', 'Archive'],
  ['performSingleSpamLabel', 'markSpam', 'spam'],
  ['handleArchive', 'bulkArchive', undefined],
  ['scheduleDelete', 'deleteMessage', null, 'MessageList.jsx'],
  ['handleBulkDelete', 'bulkDelete', null, 'MessageList.jsx'],
  ['handleBulkMove', 'bulkMove', null, 'MessageList.jsx'],
  ['performSpamLabel', 'markSpam', null, 'MessageList.jsx'],
  ['handleContextAction', 'bulkMove', null, 'MessageList.jsx'],
];

const inverseAccounts = [{ id: 'a', enabled: true }, { id: 'b', enabled: true }];
const inverseSnapshots = () => ({ byAccount: { a: 10, b: 20 }, snapshots: Object.fromEntries(inverseAccounts.map(account => [account.id, {
  totalCount: 30, revision: '1', known: true, stale: false, observedAt: new Date().toISOString(),
}])) });
const inverseRow = (id, account = 'b') => ({ id, account_id: account, folder: 'INBOX', is_read: false, subject: 'Synthetic', date: '2026-10-20' });
function inverseEnv(row, notifications, extra = {}) {
  return { ...guards, ...useStore.getState(), useStore, api, beginCountIntent, message: row,
    useCallback: fn => fn, t: key => key, closeWindowIfWindowed() {}, advanceSelectionAfterRemoval() {}, setShowMovePicker() {},
    pendingDeleteTimers: { current: new Map() }, isThreadListRow: () => false, expandedThreadId: null, setExpandedThreadId() {},
    resolveMessagesForThreadAction: async message => [message], keepDraftsApart: list => list,
    searchHasMore: false, searchFetchedOffsetRef: { current: 0 }, prefetchSearchAfterRemoval() {},
    setSelectedIds() {}, setSelectionModeActive() {}, setShowFolderPicker() {}, setSearchReloadToken() {}, selectedIds: new Set(), displayMessages: [row],
    addNotification: value => notifications.push(value), ...extra };
}
async function invokeInverseBoundary(name, argument, file, row, env) {
  const perform = action(name, env, file);
  if (!file) await perform(argument);
  else if (name === 'scheduleDelete') await perform(row);
  else if (name === 'performSpamLabel') await perform([row], 'spam');
  else if (name === 'handleContextAction') await perform('moveTo', row, 'Archive');
  else await perform([row.id], [row], 'Archive');
}

for (const [name, method, argument, file] of cases.filter(([name]) => name !== 'handleArchive')) {
  for (const outcome of ['old-undo', 'old-known-refusal', 'fresh', 'other-account', 'session']) {
    test(`owned inverse: ${file || 'MessagePane.jsx'} ${name} ${outcome}`, async () => {
      mock.timers.enable({ apis: ['setTimeout'] }); mock.method(console, 'error', () => {});
      const originals = { [method]: api[method], refreshCounts: api.refreshCounts, getUnreadCounts: api.getUnreadCounts, getFolders: api.getFolders };
      const notifications = []; let rejectWrite, calls = 0;
      api[method] = () => { calls++; return new Promise((_resolve, reject) => { rejectWrite = reject; }); };
      api.refreshCounts = async () => new Promise(() => {});
      api.getUnreadCounts = async () => inverseSnapshots(); api.getFolders = async () => [];
      const s = useStore.getState(); s.setUser({ id: `${name}-${outcome}-inverse.test` }); s.setLocked(false);
      s.setAccounts(inverseAccounts); s.setUnreadCounts(inverseSnapshots());
      const generation = useStore.getState().countGeneration;
      const bounce = () => { s.updateAccount('b', { enabled: false }, generation); s.updateAccount('b', { enabled: true }, generation); };
      const row = inverseRow(`${name}-${outcome}.test`, outcome === 'other-account' ? 'a' : 'b');
      if (outcome === 'fresh') bounce();
      s.setMessages([row]);
      try {
        await invokeInverseBoundary(name, argument, file, row, inverseEnv(row, notifications)); await flush();
        assert.equal(countWriteTracker.inspect().localIntents, 1);
        assert.equal(useStore.getState().unreadCounts.byAccount[row.account_id], outcome === 'other-account' ? 9 : 19);
        if (outcome === 'session') {
          s.setLocked(true); s.setLocked(false); s.setAccounts(inverseAccounts); s.setUnreadCounts(inverseSnapshots());
          const end = beginCountIntent();
          try {
            notifications[0].onUndo(); notifications[0].onUndo(); await flush();
            assert.equal(countWriteTracker.inspect().localIntents, 1, 'old completion cannot end the new session intent');
            assert.equal(useStore.getState().unreadCounts.byAccount.b, 20);
          } finally { end(); }
        } else if (outcome === 'old-known-refusal') {
          mock.timers.tick(4500); await flush(); assert.equal(calls, 1);
          bounce(); assert.equal(countWriteTracker.inspect().localIntents, 1);
          rejectWrite(Object.assign(new Error('known-refusal.test'), { notApplied: true })); await flush();
        } else {
          if (outcome !== 'fresh') bounce();
          notifications[0].onUndo(); notifications[0].onUndo(); await flush();
          mock.timers.tick(5000); await flush(); assert.equal(calls, 0);
        }
        assert.equal(useStore.getState().unreadCounts.byAccount.a, 10);
        assert.equal(useStore.getState().unreadCounts.byAccount.b, 20, 'an old origin cannot credit a pruned debit');
        assert.equal(countWriteTracker.inspect().localIntents, 0);
      } finally {
        rejectWrite?.(Object.assign(new Error('cleanup.test'), { notApplied: true }));
        s.setLocked(true); s.setUser(null); guards.clearDeleteGuard(row.id); Object.assign(api, originals);
        await flush(); mock.timers.reset(); mock.restoreAll();
      }
    });
  }
}

for (const boundary of ['scheduleDelete', 'performSpamLabel']) {
  test(`owned inverse partial: ${boundary} retains successful and uncertain shares in its original op`, async () => {
    mock.timers.enable({ apis: ['setTimeout'] }); mock.method(console, 'error', () => {});
    const originals = { bulkDelete: api.bulkDelete, markSpam: api.markSpam, refreshCounts: api.refreshCounts,
      getUnreadCounts: api.getUnreadCounts, getFolders: api.getFolders };
    const rows = ['known.test', 'success.test', 'uncertain.test'].map(id => inverseRow(id));
    const visible = { ...rows[0], unread_count: 3 }, notifications = [];
    let rejectUncertain;
    api.refreshCounts = async () => new Promise(() => {});
    api.getUnreadCounts = async () => inverseSnapshots(); api.getFolders = async () => [];
    api.bulkDelete = async () => ({ deleted: [rows[1].id], unconfirmed: [rows[2].id] });
    api.markSpam = id => id === rows[0].id ? Promise.reject(Object.assign(new Error('known.test'), { notApplied: true }))
      : id === rows[1].id ? Promise.resolve({ ok: true }) : new Promise((_resolve, reject) => { rejectUncertain = reject; });
    const s = useStore.getState(); s.setUser({ id: `${boundary}-partial-inverse.test` }); s.setLocked(false);
    s.setAccounts(inverseAccounts); s.setUnreadCounts(inverseSnapshots()); s.setMessages(boundary === 'scheduleDelete' ? [visible] : rows);
    const env = inverseEnv(visible, notifications, { isThreadListRow: () => true, resolveMessagesForThreadAction: async () => rows });
    try {
      const perform = action(boundary, env, 'MessageList.jsx');
      if (boundary === 'scheduleDelete') await perform(visible); else await perform(rows, 'spam');
      const [id] = Object.keys(useStore.getState().countOperations.operations);
      const origin = useStore.getState().countOperations.operations[id];
      assert.equal(origin.unreadDelta, -3); assert.equal(useStore.getState().unreadCounts.byAccount.b, 17);
      mock.timers.tick(4500); await flush();
      if (boundary === 'performSpamLabel') {
        assert.equal(countWriteTracker.inspect().localIntents, 1, 'all member outcomes remain inside the action lifetime');
        assert.equal(useStore.getState().unreadCounts.byAccount.b, 17, 'no early partial inverse while the uncertain member is held');
        rejectUncertain(new Error('network-uncertain.test')); await flush();
      }
      assert.equal(countWriteTracker.inspect().localIntents, 0);
      assert.deepEqual(Object.keys(useStore.getState().countOperations.operations), [id]);
      assert.deepEqual(useStore.getState().countOperations.operations[id], { ...origin, unreadDelta: -2 });
      assert.equal(useStore.getState().unreadCounts.byAccount.b, 18, 'only the one known-refused share is reversed');
      assert.deepEqual(useStore.getState().messages.map(message => message.id), [rows[0].id]);
    } finally {
      rejectUncertain?.(new Error('cleanup.test')); s.setLocked(true); s.setUser(null);
      rows.forEach(row => guards.clearDeleteGuard(row.id)); Object.assign(api, originals);
      await flush(); mock.timers.reset(); mock.restoreAll();
    }
  });
}

for (const [name, method, argument, file] of cases) {
  for (const outcome of ['undo', 'success', 'not-applied', 'network', '5xx', '409', 'uncertain200', 'session']) {
    test(`${file || 'MessagePane.jsx'} ${name}: ${outcome} preserves the local-intent and failure contract`, async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      mock.method(console, 'error', () => {});
      const original = api[method], refresh = api.refreshCounts;
      const notifications = []; let calls = 0, release, reject, refreshes = 0;
      api[method] = async () => { calls++; return new Promise((resolve, fail) => { release = resolve; reject = fail; }); };
      api.refreshCounts = async () => { refreshes++; return new Promise(() => {}); };
      const s = useStore.getState(); s.setUser({ id: `${name}-${outcome}.test` }); s.setLocked(false);
      s.setAccounts([{ id: 'a', enabled: true }]); s.setUnreadCounts(snapshots());
      const row = { id: `${name}.test`, account_id: 'a', folder: 'INBOX', is_read: false, subject: 'Synthetic', date: '2026-10-20' };
      s.setMessages([row]);
      const env = { ...guards, ...useStore.getState(), useStore, api, beginCountIntent, message: row,
        useCallback: fn => fn, t: key => key, closeWindowIfWindowed() {}, advanceSelectionAfterRemoval() {}, setShowMovePicker() {},
        pendingDeleteTimers: { current: new Map() }, isThreadListRow: () => false, expandedThreadId: null, setExpandedThreadId() {},
        resolveMessagesForThreadAction: async message => [message], keepDraftsApart: list => list,
        searchHasMore: false, searchFetchedOffsetRef: { current: 0 }, prefetchSearchAfterRemoval() {},
        setSelectedIds() {}, setSelectionModeActive() {}, setShowFolderPicker() {}, setSearchReloadToken() {}, selectedIds: new Set(), displayMessages: [row],
        addNotification: value => notifications.push(value) };
      try {
        const perform = action(name, env, file);
        if (!file) await perform(argument);
        else if (name === 'scheduleDelete') await perform(row);
        else if (name === 'performSpamLabel') await perform([row], 'spam');
        else if (name === 'handleContextAction') await perform('moveTo', row, 'Archive');
        else await perform([row.id], [row], 'Archive');
        await flush();
        assert.equal(useStore.getState().unreadCounts.byAccount.a, 9);
        assert.equal(countWriteTracker.inspect().localIntents, 1, 'optimistic removal holds an intent before HTTP exists');
        assert.equal(refreshes, 0);
        if (outcome === 'undo') {
          notifications[0].onUndo(); notifications[0].onUndo();
          assert.equal(useStore.getState().unreadCounts.byAccount.a, 10);
          assert.equal(countWriteTracker.inspect().localIntents, 0);
          mock.timers.tick(60000); await flush(); assert.equal(calls, 0); return;
        }
        if (outcome === 'session') {
          s.setUser({ id: 'replacement.test' }); mock.timers.tick(60000); await flush();
          assert.equal(calls, 0); assert.equal(countWriteTracker.inspect().localIntents, 0); return;
        }
        mock.timers.tick(4500); await flush(); assert.equal(calls, 1);
        mock.timers.tick(60000); await flush();
        assert.equal(countWriteTracker.inspect().localIntents, 1, 'provider wait remains inside the local lifetime');
        assert.equal(useStore.getState().unreadCounts.byAccount.a, 9);
        assert.equal(refreshes, 0);
        if (outcome === 'uncertain200') release({ archived: [], moved: [], deleted: [], countTargets: [], unconfirmed: [row.id] });
        else if (outcome === 'success') release({ archived: [row.id], countTargets: [row], moved: [row.id], deleted: [row.id] });
        else reject(Object.assign(new Error(outcome), { notApplied: outcome === 'not-applied', status: outcome === '409' ? 409 : 500 }));
        await flush();
        assert.equal(countWriteTracker.inspect().localIntents, 0);
        assert.equal(useStore.getState().unreadCounts.byAccount.a, outcome === 'not-applied' ? 10 : 9);
        assert.equal(useStore.getState().messages.length, outcome === 'not-applied' ? 1 : 0);
        assert.equal(refreshes, 1, 'final completion permits an observation, never timer-based settlement');
        if (!['success', 'uncertain200'].includes(outcome)) assert.ok(notifications.length > 1, 'failure feedback remains visible');
      } finally {
        release?.({ archived: [], countTargets: [], moved: [] });
        s.setLocked(true); s.setUser(null); guards.clearDeleteGuard(row.id); api[method] = original; api.refreshCounts = refresh;
        await flush(); mock.timers.reset(); mock.restoreAll();
      }
    });
  }
}

for (const kind of ['setCategory', 'setCategoryAlways']) {
  for (const held of ['mutation', 'counts']) {
    test(`${kind} rejects a held ${held} continuation after same-account lock/unlock`, async () => {
      const { saveSenderCategory } = await import('../utils/senderCategory.js');
      const originals = { setMessageCategory: api.setMessageCategory, setSenderCategory: api.setSenderCategory, getCategoryCounts: api.getCategoryCounts };
      let releaseMutation, releaseCounts, queries = 0;
      const mutation = async () => held === 'mutation' ? new Promise(resolve => { releaseMutation = resolve; }) : { value: 'sender@mail.test' };
      api.setMessageCategory = mutation; api.setSenderCategory = mutation;
      api.getCategoryCounts = async () => { queries++; return new Promise(resolve => { releaseCounts = resolve; }); };
      const s = useStore.getState(); s.setUser({ id: `${kind}-${held}.test` }); s.setLocked(false);
      s.setAccounts([{ id: 'a', enabled: true }]); s.setUnreadCounts(snapshots());
      s.setCategoryCounts({ primary: 10 }, '1', useStore.getState().countGeneration, { a: { counts: { primary: 10 }, totals: { primary: 13 } } });
      const row = { id: 'category.test', account_id: 'a', folder: 'INBOX', category: 'primary', from_email: 'sender@mail.test', is_read: false };
      s.setMessages([row]);
      const env = { ...useStore.getState(), api, useStore, useCallback: fn => fn, t: x => x, saveSenderCategory,
        categorizationActive: true, activeCategory: 'primary', selectedAccountId: 'a' };
      try {
        const perform = action('handleContextAction', env, 'MessageList.jsx');
        const running = perform(kind, row, kind === 'setCategory' ? 'newsletter' : { scope: 'sender', category: 'newsletter' });
        await flush();
        assert.equal(queries, held === 'mutation' ? 0 : 1);
        s.setLocked(true); s.setLocked(false); s.setAccounts([{ id: 'a', enabled: true }]); s.setUnreadCounts(snapshots());
        s.setMessages([{ ...row, subject: 'New session' }]);
        s.setCategoryCounts({ primary: 3 }, '70', useStore.getState().countGeneration, { a: { counts: { primary: 3 }, totals: { primary: 3 } } });
        releaseMutation?.({ value: 'sender@mail.test' }); await running; await flush();
        if (held === 'mutation') assert.equal(queries, 0, 'old mutation completion cannot dispatch a new-session count query');
        releaseCounts?.({ counts: { primary: 99 }, countRevision: '100', byAccount: { a: { counts: { primary: 99 }, totals: { primary: 99 } } } });
        await flush();
        assert.equal(useStore.getState().categoryCounts.primary, 3);
        assert.equal(useStore.getState().messages[0].category, 'primary', 'sender matches from an old action cannot update the new session');
      } finally { s.setLocked(true); s.setUser(null); Object.assign(api, originals); await flush(); }
    });
  }
}

test('bulk archive restores only the known-failed row in a confirmed/known/uncertain response', async () => {
  const { archiveTargetGroupsForRows } = await import('../utils/threadedArchive.js');
  const { createUndoableCommit, UNDO_COMMIT_DELAY_MS } = await import('../utils/undoableAction.js');
  mock.timers.enable({ apis: ['setTimeout'] });
  const refresh = api.refreshCounts; api.refreshCounts = async () => new Promise(() => {});
  const s = useStore.getState(); s.setUser({ id: 'mixed-bulk.test' }); s.setLocked(false);
  s.setAccounts([{ id: 'a', enabled: true }]); s.setUnreadCounts(snapshots());
  const rows = ['confirmed.test', 'known-failed.test', 'uncertain.test'].map(id => ({ id, account_id: 'a', folder: 'INBOX', category: 'primary', is_read: false }));
  s.setMessages(rows);
  const env = { ...guards, ...useStore.getState(), useStore, api, useCallback: fn => fn, t: x => x,
    archiveEstimate: row => row, applyDeleteGuard: guards.applyDeleteGuard, createUndoableCommit, UNDO_COMMIT_DELAY_MS,
    archiveTargetGroupsForRows, selectedAccountId: 'a', selectedFolder: 'INBOX', isThreadListRow: () => false,
    resolveMessagesForThreadAction: async row => [row], archiveViewKeyRef: { current: 'mixed.test' }, refreshRequestRef: { current: { invalidate() {} } },
    setSelectedIds() {}, setSelectionModeActive() {}, setShowFolderPicker() {}, invalidateThreadCache() {},
    restoreMessagesIfViewCurrent: (_view, _ref, messages) => useStore.getState().restoreMessages(messages),
    enqueueArchive: async () => ({ archived: [rows[0].id], countTargets: [rows[0]], unconfirmed: [rows[2].id], noArchiveFolder: ['a'] }),
  };
  try {
    const perform = action('handleBulkArchive', env, 'MessageList.jsx');
    perform(rows.map(row => row.id), rows);
    assert.equal(useStore.getState().unreadCounts.byAccount.a, 7);
    mock.timers.tick(UNDO_COMMIT_DELAY_MS); await flush();
    assert.deepEqual(useStore.getState().messages.map(row => row.id), [rows[1].id]);
    assert.equal(useStore.getState().unreadCounts.byAccount.a, 8, 'uncertain debit remains while only the known failure rolls back');
    assert.equal(guards.applyDeleteGuard([rows[2]]).length, 0);
  } finally { s.setLocked(true); s.setUser(null); rows.forEach(row => guards.clearDeleteGuard(row.id)); api.refreshCounts = refresh; mock.timers.reset(); await flush(); }
});

for (const kind of ['handleEdit', 'handleDelete']) {
  for (const stale of [false, true]) {
    test(`account ${kind} uses its issued generation for ${stale ? 'stale' : 'current'} authoritative result`, async () => {
      const originals = { updateAccount: api.updateAccount, deleteAccount: api.deleteAccount, getUnreadCounts: api.getUnreadCounts };
      let release, dialog;
      api.updateAccount = api.deleteAccount = () => new Promise(resolve => { release = resolve; });
      api.getUnreadCounts = async () => new Promise(() => {});
      const s = useStore.getState(); s.setUser({ id: `account-${kind}-${stale}.test` }); s.setLocked(false);
      const accounts = [{ id: 'a', enabled: true }, { id: 'b', enabled: true }];
      const seed = () => {
        s.setAccounts(accounts);
        s.setUnreadCounts({ byAccount: { a: 10, b: 2 }, snapshots: { ...snapshots().snapshots, b: { ...snapshots().snapshots.a, totalCount: 2 } } });
        s.beginArchiveCount('account-held', [{ id: 'account-held.test', account_id: 'b', folder: 'INBOX', is_read: false }], Date.now() + 4750);
      };
      seed();
      const env = { ...useStore.getState(), useStore, api, accounts, editTarget: { id: 'b' }, autoRecipientFields: () => ({}),
        setSubview() {}, setEditTarget() {}, setConfirmDialog: value => { dialog = value; } };
      try {
        const perform = action(kind, env, 'AdminPanel.jsx');
        let running;
        if (kind === 'handleEdit') running = perform({ name: 'Synthetic' });
        else { perform('b'); running = dialog.onConfirm(); }
        await flush();
        assert.equal(typeof release, 'function');
        if (stale) { s.setLocked(true); s.setLocked(false); seed(); }
        release({ id: 'b', enabled: false }); await running; await flush();
        assert.equal(Object.values(useStore.getState().countOperations.operations).some(op => op.account === 'b'), stale,
          'only a current request-issued authoritative result may exclude unavailable account obligations');
        assert.equal(useStore.getState().accounts.some(account => account.id === 'b' && account.enabled), stale);
        assert.equal(countWriteTracker.inspect().localIntents, 1, 'presentation removal cannot end an active mutation lifetime');
      } finally { s.setLocked(true); s.setUser(null); Object.assign(api, originals); await flush(); }
    });
  }
}
