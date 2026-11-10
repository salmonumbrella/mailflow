import { createListActionCommitGuard } from './listActionScope.js';

// A snapshot equality check misses user/account/lock changes that happen and reverse
// before an await settles. Observe each store transition and keep invalidation sticky.
// Preparations also supply source and selection keys. Queued actions omit those so
// navigation/removal cannot retarget already frozen messages.
export function createListKeyboardActionGuard(store, rows, { sourceKey, scopeKey } = {}) {
  const identityCurrent = createListActionCommitGuard(rows, store.getState());
  const source = sourceKey?.(store.getState());
  const scope = scopeKey?.();
  let invalidated = false;
  const current = (state = store.getState()) => {
    if (state.isLocked || !identityCurrent(state)
      || (sourceKey && (source == null || sourceKey(state) !== source))
      || (scopeKey && scopeKey() !== scope)) invalidated = true;
    return !invalidated;
  };
  const dispose = store.subscribe(state => { current(state); });
  current();
  return { current, dispose };
}
