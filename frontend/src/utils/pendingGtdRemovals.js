import { removeGtdThreadFromSections } from './gtd.js';

export const pendingGtdRemovalMap = new Map();
export const completedGtdRemovalMap = new Map();

function normalizeStates(states) {
  return [...new Set((states || []).filter(Boolean))].sort();
}

function removalKey(identity, states) {
  return JSON.stringify([identity, normalizeStates(states)]);
}

function setExpiring(map, identity, states, ttlMs, suppressedStates = new Set()) {
  const normalizedStates = normalizeStates(states);
  const key = removalKey(identity, normalizedStates);
  const existing = map.get(key);
  if (existing?.timer) clearTimeout(existing.timer);
  const entry = { identity, states: normalizedStates, suppressedStates, timer: null };
  entry.timer = setTimeout(() => {
    if (map.get(key) === entry) map.delete(key);
  }, ttlMs);
  map.set(key, entry);
  return entry;
}

function clearRemoval(map, identity, states) {
  const key = removalKey(identity, states);
  const existing = map.get(key);
  if (existing?.timer) clearTimeout(existing.timer);
  map.delete(key);
}

export function setPendingGtdRemoval(identity, states) {
  clearRemoval(completedGtdRemovalMap, identity, states);
  return setExpiring(pendingGtdRemovalMap, identity, states, 30000);
}

export function setCompletedGtdRemoval(identity, states, token) {
  const pending = pendingGtdRemovalMap.get(removalKey(identity, states));
  // A later classification or Done may have replaced this request's removal.
  if (token !== undefined && pending !== token) return;
  const suppressedStates = new Set(pending?.suppressedStates);
  clearRemoval(pendingGtdRemovalMap, identity, states);
  setExpiring(completedGtdRemovalMap, identity, states, 10000, suppressedStates);
}

export function clearGtdRemovalGuard(identity, states) {
  clearRemoval(pendingGtdRemovalMap, identity, states);
  clearRemoval(completedGtdRemovalMap, identity, states);
}

export function releaseGtdRemovalState(identity, state) {
  for (const map of [pendingGtdRemovalMap, completedGtdRemovalMap]) {
    for (const entry of map.values()) {
      if (entry.identity !== identity || !entry.states.includes(state)) continue;
      entry.suppressedStates.add(state);
      if (entry.states.every(value => entry.suppressedStates.has(value))) {
        clearRemoval(map, entry.identity, entry.states);
      }
    }
  }
}

export function applyGtdRemovalGuard(sections) {
  if (pendingGtdRemovalMap.size === 0 && completedGtdRemovalMap.size === 0) return sections;
  let guarded = sections;
  for (const removal of [...pendingGtdRemovalMap.values(), ...completedGtdRemovalMap.values()]) {
    guarded = removeGtdThreadFromSections(guarded, removal.identity,
      removal.states.filter(state => !removal.suppressedStates.has(state)));
  }
  return guarded;
}
