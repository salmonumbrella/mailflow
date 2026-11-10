// Rules retain UUID references after deletion. No provider or membership writes here.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const NATIVE_LABEL_ACTIONS = new Set(['apply_native_label', 'remove_native_label']);
export function ruleReferenceError(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}
export function extractNativeLabelReferences(rule) {
  const actions = Array.isArray(rule.actions) ? rule.actions : [];
  const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
  if (actions.length > 200 || conditions.length > 200) throw ruleReferenceError('invalid_rule', 'A rule may have at most 200 conditions and actions', 400);
  const refs = [...actions.filter(a => NATIVE_LABEL_ACTIONS.has(a?.type)).map(a => a.value),
    ...conditions.filter(c => c?.field === 'native_label').map(c => c.value)];
  if (refs.some(id => typeof id !== 'string' || !UUID.test(id))) throw ruleReferenceError('invalid_label_reference', 'Native label references must be UUIDs', 400);
  return [...new Set(refs.map(id => id.toLowerCase()))];
}
export function nativeLabelDelta(actions) {
  const delta = { addLabelIds: [], removeLabelIds: [] };
  for (const action of actions || []) {
    if (!NATIVE_LABEL_ACTIONS.has(action?.type)) continue;
    if (typeof action.value !== 'string' || !UUID.test(action.value)) throw ruleReferenceError('invalid_label_reference', 'Native label references must be UUIDs', 400);
    delta[action.type === 'apply_native_label' ? 'addLabelIds' : 'removeLabelIds'].push(action.value.toLowerCase());
  }
  for (const key of Object.keys(delta)) delta[key] = [...new Set(delta[key])].sort();
  if (delta.addLabelIds.length > 100 || delta.removeLabelIds.length > 100) throw ruleReferenceError('invalid_label_reference', 'A rule may apply or remove at most 100 labels', 400);
  if (delta.addLabelIds.some(id => delta.removeLabelIds.includes(id))) throw ruleReferenceError('conflicting_label_actions', 'Cannot apply and remove the same native label in one rule', 400);
  return delta;
}
// This slice accepts the existing flat rule language only. Fail closed instead
// of relying on the legacy editor's permissive normalization.
export function validateNativeLabelRuleShape(rule) {
  const bad = () => { throw ruleReferenceError('invalid_native_label_rule', 'Native label rules require supported flat conditions and actions', 400); };
  if (!Array.isArray(rule.conditions) || !rule.conditions.length || !Array.isArray(rule.actions) || !rule.actions.length || rule.actions.length > 200 || rule.conditions.length > 200 ||
      !['AND', 'OR', undefined].includes(rule.condition_logic)) bad();
  const textOperators = new Set(['contains', 'not_contains', 'equals', 'starts_with', 'ends_with', 'regex']);
  for (const c of rule.conditions) {
    if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some(key => !['field', 'operator', 'value', 'headerName'].includes(key))) bad();
    if (['from', 'to', 'subject', 'body', 'header'].includes(c.field)) {
      if (!textOperators.has(c.operator) || typeof c.value !== 'string' || !c.value.trim()) bad();
      if (c.field === 'header' && (typeof c.headerName !== 'string' || !c.headerName.trim())) bad();
    } else if (c.field === 'has_attachment') {
      if (![undefined, 'contains', 'equals'].includes(c.operator) || ![undefined, '', true].includes(c.value)) bad();
    } else if (c.field === 'read_status') {
      if (![undefined, 'equals', 'contains'].includes(c.operator) || !['read', 'unread'].includes(c.value)) bad();
    } else bad();
  }
  const simple = new Set(['archive', 'delete', 'mark_read', 'star', 'notify']);
  for (const action of rule.actions) {
    if (!action || typeof action !== 'object' || Array.isArray(action) || Object.keys(action).some(key => !['type', 'value'].includes(key))) bad();
    if (NATIVE_LABEL_ACTIONS.has(action.type)) {
      if (typeof action.value !== 'string' || !UUID.test(action.value)) bad();
    } else if (simple.has(action.type)) {
      if (![undefined, '', null].includes(action.value)) bad();
    } else if (['move', 'forward', 'set_category'].includes(action.type)) {
      if (typeof action.value !== 'string' || !action.value.trim()) bad();
      if (action.type === 'set_category' && !['primary', 'newsletter', 'promotion', 'automated', 'social'].includes(action.value)) bad();
      if (action.type === 'forward' && (!/^[^\s@<>(),;:]+@[^\s@<>(),;:]+\.[^\s@<>(),;:]+$/.test(action.value) || /[\r\n\0]/.test(action.value))) bad();
    } else bad();
  }
}
export async function validateNativeLabelRuleReferences(client, { userId, rule, account, allowMissing = false }) {
  const refs = extractNativeLabelReferences(rule);
  nativeLabelDelta(rule.actions);
  if (!refs.length) return [];
  validateNativeLabelRuleShape(rule);
  if (!rule.account_id || !account || account.id !== rule.account_id || account.user_id !== userId) {
    throw ruleReferenceError('native_label_account_required', 'Native label rules require one owned account', 400);
  }
  if (rule.storage_generation !== account.storage_generation) throw ruleReferenceError('storage_generation_conflict', 'This rule belongs to a previous mailbox. Create a new rule for this mailbox.');
  if ((rule.conditions || []).some(c => c?.field === 'native_label')) throw ruleReferenceError('unsupported_label_condition', 'Native label conditions are not supported yet', 400);
  const { rows } = await client.query('SELECT id,full_path FROM mail_labels WHERE account_id=$1 AND id=ANY($2::uuid[])', [account.id, refs]);
  const result = refs.map(id => ({ id, path: rows.find(row => row.id === id)?.full_path ?? null, missing: !rows.some(row => row.id === id) }));
  if (!allowMissing && result.some(ref => ref.missing)) throw ruleReferenceError('missing_label_reference', 'A referenced native label is unavailable. Repair the rule before enabling or running it.');
  return result;
}
// Caller holds the account lock before locking the rule. This is the writer's
// transaction callback, not a preflight that could race definition deletion.
export async function verifyNativeLabelRule(client, { userId, input }) {
  const { rows: [rule] } = await client.query('SELECT *,updated_at::text AS rule_revision FROM inbox_rules WHERE id=$1 AND user_id=$2 FOR UPDATE', [input.ruleId, userId]);
  if (!rule?.enabled || rule.account_id !== input.accountId || rule.storage_generation !== input.storageGeneration || rule.rule_revision !== input.ruleRevision) {
    throw ruleReferenceError('rule_changed', 'The rule changed or was disabled. No label action was applied.');
  }
  const account = { id: input.accountId, user_id: userId, storage_generation: input.storageGeneration };
  await validateNativeLabelRuleReferences(client, { userId, rule, account });
  const delta = nativeLabelDelta(rule.actions);
  if (JSON.stringify(delta.addLabelIds) !== JSON.stringify(input.addLabelIds) || JSON.stringify(delta.removeLabelIds) !== JSON.stringify(input.removeLabelIds)) {
    throw ruleReferenceError('rule_changed', 'The label action no longer matches this rule.');
  }
}
export async function findLabelRuleReferences(client, accountId, labelIds) {
  const { rows } = await client.query('SELECT id,name,enabled,conditions,actions FROM inbox_rules WHERE account_id=$1 ORDER BY priority,id', [accountId]);
  const targets = new Set(labelIds);
  return rows.filter(rule => extractNativeLabelReferences(rule).some(id => targets.has(id)))
    .map(({ id, name, enabled }) => ({ id, name, enabled }));
}
