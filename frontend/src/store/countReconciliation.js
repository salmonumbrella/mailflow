import { reconcileArchiveDeleteGuards } from '../utils/pendingDeletes.js';
import { api } from '../utils/api.js';
import { countWriteTracker, observeCountWrites } from '../utils/countWriteTracker.js';
import { countProjection } from './archiveCounts.js';

const certified = (sample, fence) => sample?.known && !sample.stale && sample.quiescentAtStart && sample.epoch === fence.epoch
  && BigInt(sample.refreshSeqAtStart || '0') >= BigInt(fence.seq);
const hasOperations = state => Object.keys(state.countOperations.operations || {}).length > 0;
function providerReady(state, fence) {
  if (!state.accounts.filter(a => a.enabled).every(a => certified(state.serverUnreadCounts.snapshots[a.id], fence))) return false;
  return Object.values(state.countOperations.operations || {}).every(op => {
    if (!op.account || op.folder === 'INBOX') return true;
    const row = state.serverFolders[op.account]?.find(f => f.path === op.folder);
    return row && certified({ ...row, known: row.counts_known, stale: row.counts_stale }, fence);
  });
}

// One refresh obligation covers HTTP work, local Undo/queue waits, and the whole signed
// cohort. Retry timers request observations; they never expire a delta or certify truth.
export function bindCountReconciliation(store) {
  let active, timer, queued = false;
  // Observation scope belongs to the cohort even when authoritative exclusion
  // prunes every optimistic origin. It does not preserve deltas or baselines.
  const categoryAccounts = new Set(Object.keys(store.getState().countOperations.categoryBaselines || {}));
  const needed = () => store.getState().countObservationNeeded || hasOperations(store.getState());
  const valid = token => {
    const s = store.getState(), writes = countWriteTracker.inspect();
    return !!s.user && !s.isLocked && s.countGeneration === token.generation && writes.version === token.version && !writes.inFlight && !writes.localIntents;
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; void reconcile(); });
  };
  const reconcile = async () => {
    clearTimeout(timer); timer = null;
    const writes = countWriteTracker.inspect(), token = { generation: store.getState().countGeneration, version: writes.version };
    if (active || !needed() || !valid(token)) return;
    active = token;
    try {
      let fence = store.getState().countFence;
      if (!fence || fence.version !== token.version) {
        const ops = writes.opIds.map(id => ({ leaseToken: id.slice(0, id.lastIndexOf(':')), uuid: id.slice(id.lastIndexOf(':') + 1) }));
        const response = await api.refreshCounts(ops);
        if (!valid(token)) return;
        fence = { epoch: response.epoch, seq: response.refreshSeq, version: token.version };
        store.setState(countProjection(store.getState(), { countFence: fence }));
      }
      if (!providerReady(store.getState(), fence)) {
        const observed = await api.getUnreadCounts();
        if (!valid(token)) return;
        store.getState().setUnreadCounts(observed, token.generation);
        const folders = new Set(Object.values(store.getState().countOperations.operations || {}).filter(op => op.account && op.folder !== 'INBOX').map(op => op.account));
        for (const account of folders) {
          const rows = await api.getFolders(account);
          if (!valid(token)) return;
          store.getState().setFolders(account, rows, token.generation);
        }
      }
      if (valid(token) && providerReady(store.getState(), fence)) {
        for (const account of categoryAccounts) {
          if (!store.getState().accounts.some(row => row.id === account && row.enabled)) continue;
          const category = store.getState().serverCategoryCounts[account], after = category?.requestedAfter;
          if (after?.epoch === fence.epoch && after.version === fence.version && after.seq === fence.seq && BigInt(category.countRevision || '0') > BigInt(fence.seq)) continue;
          // This REQUEST begins only after the qualifying provider observation. The DB
          // query's own revision fence still orders its response against older queries.
          const data = await api.getCategoryCounts({ accountId: account });
          if (!valid(token)) return;
          store.getState().setCategoryCounts(data.counts || {}, data.countRevision || '0', token.generation, data.byAccount, fence);
        }
        if (valid(token) && !hasOperations(store.getState())) {
          categoryAccounts.clear();
          store.setState(countProjection(store.getState(), { countObservationNeeded: false }));
          countWriteTracker.acknowledge(token.version);
        }
      }
    } catch { /* unavailable observations retain the cohort and retry */ }
    finally {
      if (active === token) {
        active = null;
        if (needed()) {
          if (valid(token)) { timer = setTimeout(schedule, 1000); timer.unref?.(); }
          else schedule(); // a newer idle obligation may have arrived while this request was held
        }
      }
    }
  };
  observeCountWrites({
    generation: () => store.getState().countGeneration,
    accounts: () => store.getState().accounts.filter(account => account.enabled).map(account => account.id),
    start: event => {
      for (const account of event.accountIds || []) categoryAccounts.add(account);
      store.setState(countProjection(store.getState(), { countWrites: event, countFence: null, countObservationNeeded: true }));
    },
    idle: event => { store.setState(countProjection(store.getState(), { countWrites: event })); schedule(); },
  });
  store.subscribe((state, previous) => {
    if (state.countGeneration !== previous.countGeneration || state.isLocked) categoryAccounts.clear();
    else for (const account of Object.keys(state.countOperations.categoryBaselines || {})) categoryAccounts.add(account);
    if (state.countGeneration !== previous.countGeneration || state.countOperations !== previous.countOperations) {
      const retired = reconcileArchiveDeleteGuards(state.countGeneration, new Set(Object.values(state.countOperations.operations || {}).map(op => op.group)));
      if (retired && state.countGeneration === previous.countGeneration && state.user && !state.isLocked && typeof window !== 'undefined') {
        window.dispatchEvent(new Event('mailflow:refresh'));
      }
    }
    if (state.countGeneration !== previous.countGeneration || state.isLocked) { clearTimeout(timer); timer = null; active = null; }
    if (!active && state.user && !state.isLocked && needed()) schedule();
  });
}
