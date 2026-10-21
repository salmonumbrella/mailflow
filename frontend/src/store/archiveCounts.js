import { updateCountOperations, settleCountOperations, projectCountOperations } from '../utils/countOperations.js';
import { beginCountIntent } from '../utils/countWriteTracker.js';
import { isAccountInUnifiedInbox } from '../utils/unifiedInbox.js';
import { ACCOUNT_COUNT_STALE_MS } from '../utils/countSnapshots.js';

export const countScopeAccounts = state => state.accounts.filter(a => state.selectedAccountId ? a.id === state.selectedAccountId && a.enabled : isAccountInUnifiedInbox(a)).map(a => a.id).sort();
export const countSource = state => ({ unread: state.serverUnreadCounts, folders: state.serverFolders, categories: state.serverCategoryCounts });
const groupEntries = (state, group) => Object.values(state.countOperations.operations || {}).filter(op => op.group === group);
export function excludeUnavailableCountOperations(state, accounts, accountId) {
  const enabled = new Set(accounts.filter(account => account.enabled).map(account => account.id));
  const excluded = new Set(state.countExcludedAccounts || []);
  const known = accountId ? [accountId] : new Set([...state.accounts.map(account => account.id), ...excluded,
    ...Object.values(state.countOperations.operations || {}).flatMap(op => op.categoryScope || (op.account ? [op.account] : []))]);
  for (const id of known) {
    if (enabled.has(id)) excluded.delete(id);
    else excluded.add(id);
  }
  const remove = Object.values(state.countOperations.operations || {}).filter(op =>
    excluded.has(op.account) || op.categoryScope?.some(id => excluded.has(id))).map(op => op.opId);
  return { countExcludedAccounts: [...excluded],
    countOperations: remove.length ? updateCountOperations(state.countOperations, remove, [], countSource(state)) : state.countOperations };
}
export function countProjection(state, patch = {}) {
  const s = { ...state, ...patch };
  const serverUnreadCounts = { ...s.serverUnreadCounts, byAccount: { ...s.serverUnreadCounts.byAccount }, snapshots: { ...s.serverUnreadCounts.snapshots } };
  for (const [id, list] of Object.entries(s.serverFolders || {})) {
    const inbox = list.find(f => f.path === 'INBOX'), old = serverUnreadCounts.snapshots[id];
    if (!inbox || BigInt(inbox.status_attempt_revision || '0') <= BigInt(old?.attemptRevision || old?.revision || '0')) continue;
    serverUnreadCounts.byAccount[id] = inbox.unread_count;
    serverUnreadCounts.snapshots[id] = { epoch: inbox.epoch, quiescentAtStart: inbox.quiescentAtStart, refreshSeqAtStart: inbox.refreshSeqAtStart,
      totalCount: inbox.total_count, revision: inbox.server_count_revision || '0', attemptRevision: inbox.status_attempt_revision,
      observedAt: inbox.server_counts_at, known: inbox.counts_known, stale: inbox.counts_stale };
  }
  for (const [id, sample] of Object.entries(serverUnreadCounts.snapshots)) if (sample) serverUnreadCounts.snapshots[id] = {
    ...sample, stale: sample.stale || !sample.observedAt || Date.now() - new Date(sample.observedAt).getTime() > ACCOUNT_COUNT_STALE_MS,
  };
  const source = countSource({ ...s, serverUnreadCounts });
  const idle = !s.countWrites.inFlight && !s.countWrites.localIntents;
  const fence = idle && s.countFence?.version === s.countWrites.version ? s.countFence : null;
  const countOperations = settleCountOperations(s.countOperations, source, fence);
  const scope = countScopeAccounts(s), shown = projectCountOperations(countOperations, source, scope);
  for (const [id, sample] of Object.entries(shown.unread.snapshots)) if (sample) shown.unread.snapshots[id] = {
    ...sample, pending: !!sample.pending || !idle || !!s.countObservationNeeded,
  };
  shown.unread.total = s.accounts.filter(isAccountInUnifiedInbox).reduce((n, a) => n + (shown.unread.byAccount[a.id] || 0), 0);
  shown.unread.complete = s.accounts.filter(isAccountInUnifiedInbox).every(a => {
    const sample = shown.unread.snapshots[a.id]; return sample?.known && !sample.stale && !sample.pending;
  });
  return { ...patch, serverUnreadCounts, countOperations, unreadCounts: shown.unread, folders: shown.folders,
    categoryCounts: shown.categoryCounts, categoryTotals: shown.categoryTotals,
    categoryKnown: !!s.user && !s.isLocked && scope.length > 0 && scope.every(id => !!s.serverCategoryCounts[id]),
    categoryPending: !idle || !!s.countObservationNeeded || Object.keys(countOperations.categoryBaselines || {}).some(id => scope.includes(id)) };
}

export function archiveCountActions(set, get) {
  const intents = new Map();
  const release = key => { intents.get(key)?.end(); intents.delete(key); };
  const valid = generation => generation === get().countGeneration && !get().isLocked;
  const key = (group, generation) => JSON.stringify([generation, group]);
  const originHandle = (generation, opId, created) => {
    const state = () => !created ? 'none' : valid(generation) && get().countOperations.operations?.[opId] ? 'live' : 'pruned';
    return {
      state,
      replace: delta => {
        if (!Number.isFinite(delta) || state() !== 'live') return false;
        set(s => countProjection(s, { countOperations: updateCountOperations(s.countOperations, [opId],
          [{ ...s.countOperations.operations[opId], unreadDelta: delta }], countSource(s)) }));
        return true;
      },
      revert: () => {
        if (state() !== 'live') return false;
        set(s => countProjection(s, { countOperations: updateCountOperations(s.countOperations, [opId], [], countSource(s)) }));
        return true;
      },
    };
  };
  const replaceGroup = (state, group, targets, phase, extra = {}, retained = []) => {
    const prior = groupEntries(state, group), held = new Set(Object.values(state.countOperations.operations || {}).filter(op => op.group !== group).map(op => op.targetId));
    const excluded = new Set([...(state.countExcludedAccounts || []), ...(intents.get(key(group, state.countGeneration))?.excluded || [])]);
    const unique = [...new Map(targets.filter(t => !held.has(t.id) && !excluded.has(t.account_id)).map(t => [`${t.id}:${t.folder}`, t])).values()];
    const entries = unique.map(t => ({ opId: `${group}:${t.id}:${t.folder}`, group, targetId: t.id, session: state.countGeneration,
      account: t.account_id, folder: t.folder, category: t.category || 'primary', unreadDelta: -(t.countUnread ?? (t.is_read ? 0 : 1)), totalDelta: -(t.countTotal ?? 1), state: phase, ...extra }));
    return { targets: unique, countOperations: updateCountOperations(state.countOperations, prior.map(op => op.opId), entries.concat(retained), countSource(state)) };
  };
  return {
    countGeneration: 0, countSnapshotGeneration: -1, countOperations: {}, countFence: null, countExcludedAccounts: [],
    countWrites: { version: 0, inFlight: 0, localIntents: 0 }, countObservationNeeded: false,
    serverFolders: {}, serverCategoryCounts: {}, categoryRevisions: {}, categoryTotals: {}, categoryPending: false, categoryKnown: false,
    clearCountIntents: () => { for (const id of intents.keys()) release(id); },
    excludeArchiveAccounts: accounts => { for (const intent of intents.values()) for (const id of accounts) intent.excluded.add(id); },
    adjustUnread: (account, delta) => {
      const generation = get().countGeneration, opId = crypto.randomUUID();
      let created = false;
      set(state => {
        if (state.isLocked || !Number.isFinite(delta) || delta === 0 || state.countExcludedAccounts?.includes(account)) return {};
        created = true;
        return countProjection(state, { countOperations: updateCountOperations(state.countOperations, [], [{ opId, session: generation,
          account, folder: 'INBOX', unreadDelta: delta, totalDelta: 0, state: 'awaiting-observation' }], countSource(state)) });
      });
      return originHandle(generation, opId, created);
    },
    adjustCategoryCount: (category, delta) => {
      const generation = get().countGeneration, opId = crypto.randomUUID();
      let created = false;
      set(state => {
        const categoryScope = countScopeAccounts(state);
        if (state.isLocked || !Number.isFinite(delta) || delta === 0 || !categoryScope.length
          || categoryScope.some(id => state.countExcludedAccounts?.includes(id))) return {};
        created = true;
        return countProjection(state, { countOperations: updateCountOperations(state.countOperations, [], [{ opId, session: generation,
          account: null, category: category || 'primary', categoryScope, unreadDelta: delta, totalDelta: 0, state: 'awaiting-observation' }], countSource(state)) });
      });
      return originHandle(generation, opId, created);
    },
    beginArchiveCount: (group, targets, undoDeadline) => {
      const s = get();
      if (s.isLocked) return null;
      if (intents.has(key(group, s.countGeneration)) || groupEntries(s, group).length) return s.countGeneration;
      intents.set(key(group, s.countGeneration), { end: beginCountIntent(), excluded: new Set(s.countExcludedAccounts || []) });
      const result = replaceGroup(get(), group, targets, 'undo-pending', { undoDeadline });
      set(countProjection(get(), { countOperations: result.countOperations }));
      return s.countGeneration;
    },
    updateArchiveCount: (group, targets, generation) => {
      if (!valid(generation) || !groupEntries(get(), group).length) return [];
      const result = replaceGroup(get(), group, targets, 'in-flight');
      set(countProjection(get(), { countOperations: result.countOperations }));
      return result.targets;
    },
    finishArchiveCount: (group, result, generation) => {
      try {
        if (!valid(generation)) return;
        const s = get(), prior = groupEntries(s, group);
        if (!prior.length) return;
        const unconfirmed = prior.filter(op => result.unconfirmed?.includes(op.targetId));
        const targets = (result.countTargets || []).flatMap(t => [t, ...(t.destinationFolder ? [{ ...t, folder: t.destinationFolder, countTotal: -1, countUnread: t.is_read ? 0 : -1 }] : [])]);
        const replacement = replaceGroup(s, group, targets, 'awaiting-observation', {}, unconfirmed.map(op => ({ ...op, state: 'awaiting-observation' })));
        set(countProjection(s, { countOperations: replacement.countOperations }));
      } finally { release(key(group, generation)); }
    },
    cancelArchiveCount: (group, generation) => get().finishArchiveCount(group, { countTargets: [] }, generation),
  };
}
