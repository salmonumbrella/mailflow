import { query, withTransaction } from './db.js';
import { extractNativeLabelReferences, validateNativeLabelRuleReferences, ruleReferenceError } from './nativeLabelRuleReferences.js';

// No new durable state: references live in the already-backed-up rule JSON.
export async function saveNativeLabelRule(userId, id, body) {
  const previous = id ? (await query('SELECT * FROM inbox_rules WHERE id=$1 AND user_id=$2', [id, userId])).rows[0] : null;
  if (id && !previous) throw ruleReferenceError('not_found', 'Rule not found', 404);
  return withTransaction(async client => {
    // Lock both scopes in a stable order before the rule. An account switch
    // cannot race subtree deletion or a membership action in either scope.
    const ids = [...new Set([previous?.account_id, body.accountId].filter(Boolean))].sort();
    const accounts = [];
    for (const accountId of ids) {
      const row = (await client.query('SELECT id,user_id,storage_generation FROM email_accounts WHERE id=$1 AND user_id=$2 FOR UPDATE', [accountId, userId])).rows[0];
      if (!row) throw ruleReferenceError('not_found', 'Account not found', 404);
      accounts.push(row);
    }
    const current = id ? (await client.query('SELECT * FROM inbox_rules WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, userId])).rows[0] : null;
    if (id && (!current || current.account_id !== previous.account_id)) throw ruleReferenceError('rule_changed', 'Rule scope changed. Refresh before saving.');
    const account = accounts.find(row => row.id === body.accountId);
    const rule = { user_id: userId, account_id: body.accountId || null, enabled: body.enabled !== false,
      conditions: body.conditions, actions: body.actions, condition_logic: body.conditionLogic,
      storage_generation: current?.account_id === body.accountId ? current.storage_generation : account?.storage_generation ?? null };
    const refs = extractNativeLabelReferences(rule);
    if (refs.length && !rule.account_id) throw ruleReferenceError('native_label_account_required', 'Native label rules require one owned account', 400);
    if (refs.length && (!account || body.expectedStorageGeneration !== account.storage_generation)) {
      throw ruleReferenceError('storage_generation_conflict', 'Refresh native labels and choose the current account before saving this rule.');
    }
    // Missing references may be retained only when disabling/editing an existing
    // disabled rule, never introduced through a new or changed reference.
    const oldRefs = current ? extractNativeLabelReferences(current) : [];
    const allowMissing = !rule.enabled && current?.account_id === rule.account_id && refs.every(ref => oldRefs.includes(ref));
    await validateNativeLabelRuleReferences(client, { userId, rule, account, allowMissing });
    const move = rule.actions.find(action => action.type === 'move');
    if (move && account) {
      const { rows: [folders] } = await client.query('SELECT COUNT(*) AS total,COUNT(*) FILTER (WHERE path=$2) AS match FROM folders WHERE account_id=$1', [account.id, move.value]);
      if (Number(folders.total) > 0 && Number(folders.match) === 0) throw ruleReferenceError('invalid_move_destination', 'Move destination folder not found for this account', 400);
    }
    const params = [body.name || '', rule.account_id, rule.enabled, !!body.stopProcessing, body.conditionLogic === 'OR' ? 'OR' : 'AND', JSON.stringify(rule.conditions), JSON.stringify(rule.actions), rule.storage_generation, userId];
    let saved;
    if (id) {
      saved = await client.query(`UPDATE inbox_rules SET name=$1,account_id=$2,enabled=$3,stop_processing=$4,
        condition_logic=$5,conditions=$6,actions=$7,storage_generation=$8,updated_at=clock_timestamp()
        WHERE user_id=$9 AND id=$10 RETURNING *,updated_at::text AS rule_revision`, [...params, id]);
    } else {
      saved = await client.query(`INSERT INTO inbox_rules(name,account_id,enabled,stop_processing,condition_logic,conditions,actions,storage_generation,user_id,priority)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,(SELECT COALESCE(MAX(priority),-1)+1 FROM inbox_rules WHERE user_id=$9)) RETURNING *,updated_at::text AS rule_revision`, params);
    }
    return saved.rows[0];
  });
}

export async function validateNativeRuleForRun(userId, rule) {
  if (!extractNativeLabelReferences(rule).length) return;
  await withTransaction(async client => {
    const account = (await client.query('SELECT id,user_id,storage_generation FROM email_accounts WHERE id=$1 AND user_id=$2 FOR UPDATE', [rule.account_id, userId])).rows[0];
    const current = (await client.query('SELECT *,updated_at::text AS rule_revision FROM inbox_rules WHERE id=$1 AND user_id=$2 FOR UPDATE', [rule.id, userId])).rows[0];
    if (!current?.enabled || current.rule_revision !== rule.rule_revision) throw ruleReferenceError('rule_changed', 'The rule changed. Refresh before running.');
    await validateNativeLabelRuleReferences(client, { userId, rule: current, account });
  });
}
