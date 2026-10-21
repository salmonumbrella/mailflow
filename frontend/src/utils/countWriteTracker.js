export function affectsCounts(method, path) {
  return !['GET', 'HEAD'].includes(method) && (/^\/mail\/(?:messages(?:\/|$)|mark-all-read$|folders\/(?:delete|empty|rename)$)/.test(path)
    || /^\/gtd\/(?:classify(?:\/undo)?|done)$/.test(path));
}
export const isCountMutationKnownNotApplied = error => error?.notApplied === true;
export function countRequestError(method, path, status, body) {
  const protocol = body.code?.startsWith('count-');
  const residueRefusal = status === 409 && body.code === 'archive-residue-read-only'
    && ((method === 'POST' && ['/gtd/classify', '/gtd/classify/undo', '/gtd/done'].includes(path))
      || (method === 'DELETE' && path === '/gtd/classify'));
  const notApplied = residueRefusal || ['count-epoch-expired', 'count-op-expired', 'count-op-invalid', 'count-op-capacity'].includes(body.code)
    || (!protocol && ([401, 403, 413, 423].includes(status) || ([400, 404].includes(status) && affectsCounts(method, path)
      && /^\/mail\/messages\/(?:[^/]+\/read|bulk-read)$/.test(path))));
  // Protocol and explicit residue refusals are not GTD's only-copy409. Preserve the transport status separately so
  // existing generic409 consumers cannot accidentally offer a resubmission for this refusal.
  return Object.assign(new Error(body.error || 'Request failed'), { code: body.code, httpStatus: status, status: protocol || residueRefusal ? undefined : status, notApplied });
}
export function createCountWriteTracker(callbacks) {
  let session;
  const current = () => {
    const generation = callbacks.generation();
    if (session?.generation !== generation) session = { generation, version: 0, inFlight: 0, localIntents: 0, opIds: new Set(), accountIds: new Set() };
    return session;
  };
  const rememberAccounts = (state, ids = []) => {
    const allowed = new Set(callbacks.accounts?.() || []);
    state.accountIds = new Set([...state.accountIds].filter(id => allowed.has(id)));
    let added = false;
    for (const id of Array.isArray(ids) ? ids : []) if (allowed.has(id) && !state.accountIds.has(id)) {
      state.accountIds.add(id); added = true;
    }
    return added;
  };
  const event = state => {
    rememberAccounts(state);
    return { generation: state.generation, version: state.version, inFlight: state.inFlight,
      localIntents: state.localIntents, opIds: [...state.opIds], accountIds: [...state.accountIds] };
  };
  const notifyIdle = state => {
    if (current() === state && !state.inFlight && !state.localIntents) Promise.resolve(callbacks.idle(event(state))).catch(() => {});
  };
  const valid = state => {
    if (current() !== state) throw Object.assign(new Error('Count session changed before dispatch'), { code: 'count-session-ended', notApplied: true });
  };
  const observeLease = (lease, generation, order = 0) => {
    const state = current();
    if (state.generation === generation && lease?.token && lease.expiresInMs > 0 && order >= (state.leaseReadOrder || 0)) {
      state.lease = { ...lease, until: performance.now() + lease.expiresInMs }; state.leaseReadOrder = order;
    }
  };
  const loadLease = async (state, force = false) => {
    valid(state);
    if (force) state.lease = null;
    if (!state.lease || state.lease.until <= performance.now()) {
      try {
        state.loading ||= Promise.resolve(callbacks.loadLease(force)).then(payload => { if (!state.lease || state.lease.until <= performance.now()) observeLease(payload.lease, state.generation, state.leaseReadOrder || 0); }).finally(() => { state.loading = null; });
        await state.loading;
      } catch (error) {
        // This read failed before dispatch, including after an explicit epoch refusal.
        throw Object.assign(error, { notApplied: true });
      }
    }
    valid(state);
    if (!state.lease) throw Object.assign(new Error('Count session metadata unavailable; retry after refreshing counts'), { code: 'count-lease-unavailable', notApplied: true });
  };
  return {
    generation: () => current().generation,
    inspect: () => event(current()),
    observeLease,
    beginIntent(accountIds = []) {
      const state = current();
      state.version++; state.localIntents++;
      rememberAccounts(state, accountIds);
      callbacks.start(event(state));
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        if (current() !== state) return;
        state.localIntents--;
        notifyIdle(state);
      };
      end.addAccounts = ids => {
        if (ended || current() !== state || !rememberAccounts(state, ids)) return false;
        // The same held lifetime still prevents certification; no second intent/version.
        callbacks.start(event(state));
        return true;
      };
      return end;
    },
    async track(method, path, run) {
      if (!affectsCounts(method, path)) return run({ generation: current().generation });
      const state = current(), uuid = crypto.randomUUID();
      state.version++; state.inFlight++;
      callbacks.start(event(state));
      try {
        await loadLease(state);
        const dispatch = () => { valid(state); const opId = `${state.lease.token}:${uuid}`; state.opIds.add(opId); return run({ opId, generation: state.generation }); };
        try { return await dispatch(); }
        catch (error) {
          if (error.code !== 'count-epoch-expired' || !error.notApplied) throw error;
          await loadLease(state, true);
          return await dispatch(); // only this attempt's explicit admission refusal permits one retry
        }
      } finally {
        state.inFlight--;
        notifyIdle(state);
      }
    },
    acknowledge(version) {
      const state = current();
      if (state.version === version && !state.inFlight && !state.localIntents) {
        state.opIds.clear(); state.accountIds.clear();
      }
    },
  };
}
let callbacks = { generation: () => 0, start() {}, idle() {} }, leaseLoader;
export const countWriteTracker = createCountWriteTracker({
  generation: () => callbacks.generation(), accounts: () => callbacks.accounts?.() || [],
  start: event => callbacks.start(event), idle: event => callbacks.idle(event), loadLease: force => leaseLoader(force),
});
export function observeCountWrites(next) { callbacks = next; }
export function setCountLeaseLoader(loader) { leaseLoader = loader; }

export const beginCountIntent = (accountIds = []) => countWriteTracker.beginIntent(accountIds);
