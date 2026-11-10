const FORWARD_EMAIL_RE = /^[^\s@<>(),;:]+@[^\s@<>(),;:]+\.[^\s@<>(),;:]+$/;

export function isValidForwardAddress(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return !/[\r\n\0]/.test(normalized) && FORWARD_EMAIL_RE.test(normalized);
}

export const isNativeLabelCondition = condition => condition?.field === 'native_label';

export const isNativeLabelAction = action => ['apply_native_label', 'remove_native_label'].includes(action?.type);

// The generation is captured when the editor opens/selects its account, not refreshed
// at submission. Replacing a mailbox must never retarget an existing decision.
export function nativeRuleActionError({ actions = [], conditions = [], accountId, expectedStorageGeneration, accounts, snapshots = {} }) {
  const native = actions.filter(isNativeLabelAction);
  const references = conditions.filter(isNativeLabelCondition);
  if (!native.length && !references.length) return null;
  const account = accounts.find(item => item.id === accountId && item.enabled !== false);
  if (!account || !expectedStorageGeneration || account.storage_generation !== expectedStorageGeneration) return 'nativeLabelRules.accountChanged';
  const snapshot = snapshots[accountId];
  if (!snapshot || snapshot.storageGeneration !== expectedStorageGeneration) return 'nativeLabelRules.unverified';
  for (const condition of references) {
    if (!['has', 'not_has'].includes(condition.operator) || !snapshot.labels.some(label => label.id === condition.value)) return 'nativeLabelRules.missing';
  }
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

// Keep a visible, unresolved condition when scope changes. Dropping a negative
// condition would silently broaden the rule.
export function ruleConditionsForAccount(conditions) {
  return conditions.map(condition => isNativeLabelCondition(condition) ? { ...condition, value: '' } : condition);
}

// Display only: the server remains the source of converted search semantics.
export function exactRuleConditionSummary(condition, t) {
  const operator = t(condition.operator === 'is_not' ? 'nativeLabelRules.convertedIsNot' : 'nativeLabelRules.convertedIs');
  if (condition.field === 'has_attachment') return `${t('admin.rules.fieldHasAttachment')}: ${operator} ${t(condition.value === 'true' ? 'nativeLabelRules.convertedTrue' : 'nativeLabelRules.convertedFalse')}`;
  if (condition.field === 'is_read') return `${t('admin.rules.fieldReadStatus')}: ${operator} ${t(condition.value === 'true' ? 'admin.rules.readStatusRead' : 'admin.rules.readStatusUnread')}`;
  const field = t(condition.field === 'from' ? 'admin.rules.fieldFrom' : 'admin.rules.fieldSubject');
  return `${field} ${t(condition.operator === 'not_contains' ? 'admin.rules.opNotContains' : 'admin.rules.opContains')} “${condition.value}”`;
}
