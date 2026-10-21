const scopeKey = op => JSON.stringify([op.account, op.folder]);
const scopedIds = op => op.categoryScope || (op.folder === 'INBOX' && op.account ? [op.account] : []);
const empty = () => ({ operations: {}, baselines: {}, categoryBaselines: {} });
const numericDelta = (base, delta) => Number.isFinite(base) ? Math.max(0, base + delta) : base;
const sum = (ops, field) => ops.reduce((n, op) => n + (op[field] || 0), 0);
const snapshot = (source, account, folder) => folder === 'INBOX'
  ? source.unread.snapshots?.[account]
  : (() => { const f = source.folders[account]?.find(f => f.path === folder); return f && { ...f, known: f.counts_known, stale: f.counts_stale }; })();
const certified = (sample, fence) => sample?.known && !sample.stale && sample.quiescentAtStart && sample.epoch === fence.epoch
  && BigInt(sample.refreshSeqAtStart || '0') >= BigInt(fence.seq);

// Every signed adjustment has the same lifecycle. Baselines belong to the cohort, so an
// intermediate observation (or another operation's Undo) cannot rebase the remaining deltas.
export function updateCountOperations(state, removeIds, entries, source) {
  const operations = { ...state.operations }, baselines = { ...state.baselines }, categoryBaselines = { ...state.categoryBaselines };
  for (const id of removeIds) delete operations[id];
  for (const op of entries) {
    if (op.account) {
      // A destination may only become known in a response, after STATUS already includes
      // that write. Capture its baseline before the cohort's first write, not at discovery.
      if (!Object.values(baselines).some(base => base.account === op.account)) {
        for (const folder of [{ path: 'INBOX', unread_count: source.unread.byAccount[op.account], total_count: source.unread.snapshots?.[op.account]?.totalCount },
          ...(source.folders[op.account] || []).filter(f => f.path !== 'INBOX')]) {
          baselines[JSON.stringify([op.account, folder.path])] = { account: op.account, folder: folder.path, unread: folder.unread_count, total: folder.total_count };
        }
      }
      baselines[scopeKey(op)] ||= { account: op.account, folder: op.folder }; // unknown at cohort start stays unknown
    }
    for (const account of scopedIds(op)) {
      if (!categoryBaselines[account]) categoryBaselines[account] = source.categories[account] || { counts: {}, totals: {} };
    }
    operations[op.opId] = op;
  }
  const remaining = Object.values(operations);
  if (!remaining.length) return empty();
  return { operations,
    baselines: Object.fromEntries(Object.entries(baselines).filter(([, base]) => remaining.some(op => op.account === base.account))),
    categoryBaselines: Object.fromEntries(Object.entries(categoryBaselines).filter(([account]) => remaining.some(op => scopedIds(op).includes(account)))) };
}

export function settleCountOperations(state, source, fence) {
  const ops = Object.values(state.operations || {});
  if (!ops.length) return empty();
  if (!fence || ops.some(op => op.state !== 'awaiting-observation')) return state;
  if (Object.values(state.baselines || {}).some(base => ops.some(op => op.account === base.account && op.folder === base.folder) && !certified(snapshot(source, base.account, base.folder), fence))) return state;
  for (const account of Object.keys(state.categoryBaselines || {})) {
    const category = source.categories[account], after = category?.requestedAfter;
    if (!after || after.epoch !== fence.epoch || after.version !== fence.version || BigInt(after.seq) < BigInt(fence.seq)
      || BigInt(category.countRevision || '0') <= BigInt(fence.seq)) return state;
  }
  return empty();
}

export function projectCountOperations(state, source, scope) {
  const operations = Object.values(state.operations || {});
  const unread = { ...source.unread, byAccount: { ...source.unread.byAccount }, snapshots: { ...source.unread.snapshots } };
  const folders = Object.fromEntries(Object.entries(source.folders).map(([id, rows]) => [id, rows.map(row => ({ ...row }))]));
  for (const [account, rows] of Object.entries(folders)) {
    const inbox = rows.find(row => row.path === 'INBOX');
    if (inbox) Object.assign(inbox, { unread_count: unread.byAccount[account], total_count: unread.snapshots[account]?.totalCount });
  }
  for (const [key, base] of Object.entries(state.baselines || {})) {
    const ops = operations.filter(op => op.account && scopeKey(op) === key);
    if (!ops.length) continue;
    const count = numericDelta(base.unread, sum(ops, 'unreadDelta')), total = numericDelta(base.total, sum(ops, 'totalDelta'));
    const folder = folders[base.account]?.find(row => row.path === base.folder);
    if (folder) Object.assign(folder, { unread_count: count, total_count: total, counts_pending: true });
    if (base.folder === 'INBOX') {
      unread.byAccount[base.account] = count;
      unread.snapshots[base.account] = { ...unread.snapshots[base.account], totalCount: total, pending: true };
    }
  }
  const categories = {};
  for (const [account, observation] of Object.entries(source.categories)) {
    const base = state.categoryBaselines?.[account] || observation;
    const counts = { ...base.counts }, totals = { ...base.totals };
    const ops = operations.filter(op => op.account === account && op.folder === 'INBOX' && op.category);
    for (const category of new Set(ops.map(op => op.category))) {
      const matching = ops.filter(op => op.category === category);
      counts[category] = (counts[category] || 0) + sum(matching, 'unreadDelta');
      totals[category] = (totals[category] || 0) + sum(matching, 'totalDelta');
    }
    categories[account] = { counts, totals };
  }
  const categoryCounts = {}, categoryTotals = {};
  for (const account of scope) {
    for (const [category, n] of Object.entries(categories[account]?.counts || {})) categoryCounts[category] = (categoryCounts[category] || 0) + n;
    for (const [category, n] of Object.entries(categories[account]?.totals || {})) categoryTotals[category] = (categoryTotals[category] || 0) + n;
  }
  const key = JSON.stringify([...scope].sort());
  for (const category of new Set(operations.filter(op => op.categoryScope && JSON.stringify([...op.categoryScope].sort()) === key).map(op => op.category))) {
    const ops = operations.filter(op => op.category === category && op.categoryScope && JSON.stringify([...op.categoryScope].sort()) === key);
    categoryCounts[category] = (categoryCounts[category] || 0) + sum(ops, 'unreadDelta');
    categoryTotals[category] = (categoryTotals[category] || 0) + sum(ops, 'totalDelta');
  }
  return { unread, folders, categoryCounts: Object.fromEntries(Object.entries(categoryCounts).map(([key, n]) => [key, Math.max(0, n)])),
    categoryTotals: Object.fromEntries(Object.entries(categoryTotals).map(([key, n]) => [key, Math.max(0, n)])) };
}
