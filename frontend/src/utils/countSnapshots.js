// Freshness allowance for the per-account totals, which come from INBOX. INBOX is polled every
// monitor cycle, so three cycles of slack. Mirrors STATUS_STALE_MS in backend folderStatus.js;
// rotating folders get a longer, rotation-derived allowance computed server-side.
export const ACCOUNT_COUNT_STALE_MS = 180000;
const revision = snapshot => BigInt(snapshot?.attemptRevision || snapshot?.revision || '0');

// A snapshot is independently ordered per account. Comparing unified totals cannot
// acknowledge individual reads: arrivals and writes in another account can cancel them.
export function mergeCountSnapshots(previous, incoming) {
  const byAccount = {}, snapshots = {};
  for (const [id, count] of Object.entries(incoming.byAccount || {})) {
    const old = previous.snapshots?.[id], next = incoming.snapshots?.[id];
    const keep = old && revision(old) > revision(next);
    byAccount[id] = keep ? previous.byAccount[id] : count;
    snapshots[id] = keep ? old : next;
  }
  return { ...incoming, byAccount, snapshots };
}

export function mergeFolderSnapshots(previous = [], incoming = []) {
  const old = new Map(previous.map(f => [f.path, f]));
  return incoming.map(f => {
    const p = old.get(f.path);
    // Folder metadata comes from the current list; only retain newer observations.
    if (!p || BigInt(p.status_attempt_revision || '0') <= BigInt(f.status_attempt_revision || '0')) return f;
    const fields = ['total_count', 'unread_count', 'counts_known', 'counts_stale', 'server_counts_at',
      'server_count_revision', 'status_attempt_revision', 'status_attempted_at', 'status_error', 'epoch', 'quiescentAtStart', 'refreshSeqAtStart'];
    return { ...f, ...Object.fromEntries(fields.map(k => [k, p[k]])) };
  });
}

// How many of `messages` change unread state when the conversation is marked `read`, grouped
// by the account whose badge each change belongs to. A message with no account_id is charged
// to `fallbackAccountId`, the acted-on row's account.
//
// With conversations on, one thread row can hold another account's copy of the same email
// (#476). Charging the row's whole unread_count to the row's own account, which is what the
// pre-resolution estimate has to do, moves that copy's unread off the wrong badge: the row's
// account drops by two, the other account drops by nothing, and the sidebar is wrong until
// the next qualifying server observation. The unified total is a sum, so it stays right;
// only the per-account split is off. Pure.
export function unreadDeltaByAccount(messages, read, fallbackAccountId) {
  const out = new Map();
  for (const m of messages || []) {
    if (!m) continue;
    const changes = read ? !m.is_read : !!m.is_read;
    if (!changes) continue;
    const account = m.account_id ?? fallbackAccountId;
    out.set(account, (out.get(account) || 0) + 1);
  }
  return out;
}

// Presentation may use a recent authoritative zero only when the canonical projection has
// no pending write for this account. Optimistic totals never become evidence of emptiness.
export function selectAuthoritativeInboxSnapshot(state, accountId, now = Date.now()) {
  const source = state.serverUnreadCounts?.snapshots?.[accountId];
  const current = !!state.user && !state.isLocked && state.countSnapshotGeneration === state.countGeneration;
  const known = current && !!source?.known && Number.isFinite(source.totalCount) && source.totalCount >= 0;
  const age = source?.observedAt ? now - new Date(source.observedAt).getTime() : Infinity;
  return { known, stale: !known || !!source?.stale || !Number.isFinite(age) || age > ACCOUNT_COUNT_STALE_MS,
    pending: !current || !!state.unreadCounts?.snapshots?.[accountId]?.pending,
    totalCount: known ? source.totalCount : null,
    unreadCount: known ? state.serverUnreadCounts.byAccount[accountId] : null, generation: state.countGeneration };
}
