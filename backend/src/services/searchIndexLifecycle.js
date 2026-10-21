// No scheduler lives here: existing IMAP ticks supply batches, and disconnect
// closes admission synchronously before awaiting the database fence and drain.
export function createSearchIndexLifecycle({ runBatch, invalidateRun }) {
  const accounts = new Map();
  let quiescing = false;
  const record = accountId => {
    if (!accounts.has(accountId)) accounts.set(accountId, {
      open: false, controller: new AbortController(), active: null, stopping: null, stopError: null,
    });
    return accounts.get(accountId);
  };

  const start = (account, options, task) => {
      const state = accounts.get(account.id);
      if (quiescing || !state?.open || state.stopping || options.signal?.aborted) return Promise.resolve(null);
      // A duplicate caller joins the original session batch; its own signal
      // does not replace or cancel that batch. Scheduling uses the session signal.
      if (state.active) return state.active;
      const signal = options.signal ? AbortSignal.any([state.controller.signal, options.signal]) : state.controller.signal;
      const active = Promise.resolve().then(() => {
        // stop() can close this session before this microtask begins.
        if (!state.open || signal.aborted) return null;
        return task(account, { ...options, signal });
      }).finally(() => {
        if (state.active === active) state.active = null;
      });
      state.active = active;
      return active;
  };

  const lifecycle = {
    isOpen(accountId) {
      const state=accounts.get(accountId);
      return Boolean(!quiescing && state?.open && !state.stopping && !state.stopError);
    },
    async resume(accountId) {
      const state = record(accountId);
      if (state.stopping) await state.stopping;
      if (quiescing) return false;
      if (state.stopError) throw state.stopError;
      if (!state.open) {
        state.controller = new AbortController();
        state.open = true;
      }
      return true;
    },

    // Joining metadata discovery can return its discovery outcome. Callers
    // must not infer an IMAP batch or processed count from that joined result.
    run(account, options = {}) { return start(account,options,runBatch); },

    // Read-only join point for one optional busy-handoff continuation.
    settled(accountId) { return accounts.get(accountId)?.active || Promise.resolve(); },

    runDiscovery(account,task) {
      const state=accounts.get(account.id);
      if(!lifecycle.isOpen(account.id))return Promise.resolve({changed:0,deferred:true,reason:'stopped'});
      if(state.active)return Promise.resolve({changed:0,deferred:true,reason:'active-batch'});
      return start(account,{},task).then(result=>result??{changed:0,deferred:true,reason:'stopped'});
    },

    stop(accountId) {
      const state = record(accountId);
      if (state.stopping) return state.stopping;
      state.open = false;
      state.controller.abort();
      const active = state.active;
      const fence = Promise.resolve().then(() => invalidateRun(accountId));
      const stopping = Promise.allSettled([fence, active]).then(([invalidated]) => {
        // Even a failed fence must wait for local work to finish. A restore
        // caller must see that failure rather than proceed to TRUNCATE.
        if (invalidated.status === 'rejected') {
          state.stopError = invalidated.reason;
          throw invalidated.reason;
        }
        state.stopError = null;
      }).finally(() => {
        if (state.stopping === stopping) state.stopping = null;
      });
      state.stopping = stopping;
      return stopping;
    },

    async quiesce() {
      quiescing = true;
      const drained = await Promise.allSettled([...accounts.keys()].map(id => lifecycle.stop(id)));
      const failed = drained.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    },

    resumeScheduling() { quiescing = false; },
  };
  return lifecycle;
}
