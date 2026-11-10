// Explicit three-valued logic. Missing evidence is never an empty membership set.
export const TRUE = 'true';
export const FALSE = 'false';
export const UNKNOWN = 'unknown';
export const hasNativeLabelConditions = rule => Array.isArray(rule.conditions) && rule.conditions.some(c => c?.field === 'native_label');
export const hasGuardedRuleConditions = rule => hasNativeLabelConditions(rule) || (Array.isArray(rule.conditions) && rule.conditions.some(c => c?.semantics === 'search_v1'));
export function aggregateConditions(values, logic = 'AND') {
  if (!values.length) return FALSE;
  if (logic === 'OR') return values.includes(TRUE) ? TRUE : values.includes(UNKNOWN) ? UNKNOWN : FALSE;
  return values.includes(FALSE) ? FALSE : values.includes(UNKNOWN) ? UNKNOWN : TRUE;
}
export function evaluateNativeLabelCondition(condition, proof) {
  if (!['has', 'not_has'].includes(condition.operator)) throw new Error('Invalid native label operator');
  if (proof?.availability !== 'known' || !Array.isArray(proof.labelIds)) return UNKNOWN;
  const present = proof.labelIds.includes(condition.value);
  return (condition.operator === 'has' ? present : !present) ? TRUE : FALSE;
}
export const ruleDecisionActions = rule => [...rule.actions, ...(rule.stop_processing ? [{ type: 'stop_processing' }] : [])];
