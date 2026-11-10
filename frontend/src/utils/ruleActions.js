const FORWARD_EMAIL_RE = /^[^\s@<>(),;:]+@[^\s@<>(),;:]+\.[^\s@<>(),;:]+$/;

export function isValidForwardAddress(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return !/[\r\n\0]/.test(normalized) && FORWARD_EMAIL_RE.test(normalized);
}

export const isNativeLabelAction = action => ['apply_native_label', 'remove_native_label'].includes(action?.type);

// The generation is captured when the editor opens/selects its account, not refreshed
// at submission. Replacing a mailbox must never retarget an existing decision.
export function nativeRuleActionError({ actions, accountId, expectedStorageGeneration, accounts, snapshots }) {
  const native = actions.filter(isNativeLabelAction);
  if (!native.length) return null;
  const account = accounts.find(item => item.id === accountId && item.enabled !== false);
  if (!account || !expectedStorageGeneration || account.storage_generation !== expectedStorageGeneration) return 'nativeLabelRules.accountChanged';
  const snapshot = snapshots[accountId];
  if (!snapshot || snapshot.storageGeneration !== expectedStorageGeneration) return 'nativeLabelRules.unverified';
  const decisions = new Map();
  for (const action of native) {
    if (!snapshot.labels.some(label => label.id === action.value)) return 'nativeLabelRules.missing';
    if (decisions.has(action.value) && decisions.get(action.value) !== action.type) return 'nativeLabelRules.conflicting';
    decisions.set(action.value, action.type);
  }
  return null;
}

export function ruleActionsForAccount(actions, accountId) {
  return actions.filter(action => !isNativeLabelAction(action)).flatMap(action => action.type === 'move'
    ? accountId ? [{ ...action, value: '' }] : [] : [action]);
}
