// Process-local authority plus durable, single-use dispatch claims. Journal replay
// is history, never authority to reconstruct an execution after restart.
import { createHash, randomUUID } from 'crypto';
import { withTransaction } from './db.js';
import { reserveRuleMembershipDecision, guardRuleMembershipSource } from './nativeLabelMemberships.js';

const executions = new WeakMap();
const fail = (code, message) => { throw Object.assign(new Error(message), { status: 409, code }); };
const copy = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'null').digest('hex');
const stateFor = token => {
  const state = executions.get(token);
  if (!state || state.poisoned) fail('rule_execution_unavailable', 'This rule execution cannot authorize further actions');
  return state;
};
export function createNativeRuleExecution(proof, { maxDecisions = 200 } = {}) {
  if (!Number.isInteger(maxDecisions) || maxDecisions < 1 || maxDecisions > 200) fail('rule_execution_limit', 'At most 200 native decisions may run for one message');
  if (proof?.availability !== 'known' || !Array.isArray(proof.labelIds) || !proof.source?.canonicalEntityId
      || typeof proof.expectedMetadataVersion !== 'string') fail('identity_unavailable', 'A complete native membership snapshot is required');
  const token = Object.freeze({});
  executions.set(token, { executionId: randomUUID(), proof: copy(proof), rootVersion: proof.expectedMetadataVersion,
    receipts: [], requests: new Map(), claimedActions: new Set(), maxDecisions, busy: false, poisoned: false });
  return token;
}
export function getNativeRuleExecutionProof(token) { return copy(stateFor(token).proof); }
export function invalidateNativeRuleExecution(token) { const state = executions.get(token); if (state) state.poisoned = true; }

export async function commitNativeRuleDecision(userId, token, request, { verifyDecision, broadcast } = {}) {
  const state = stateFor(token);
  if (state.busy) fail('rule_execution_busy', 'A decision is already in flight');
  if (typeof verifyDecision !== 'function') fail('rule_verifier_required', 'A server rule verifier is required');
  const previous = state.requests.get(request.mutationId);
  if (previous && digest(previous.request) !== digest(request)) fail('mutation_conflict', 'The decision ID was reused for another request');
  if (!previous && state.receipts.length >= state.maxDecisions) fail('rule_execution_limit', 'The native decision limit was reached');
  const raw = previous?.raw ?? { ...copy(request), ...copy(state.proof), accountId: state.proof.source.account_id,
    storageGeneration: state.proof.source.storage_generation, executionId: state.executionId,
    previousReceiptId: state.receipts.at(-1)?.decisionId ?? null };
  state.requests.set(request.mutationId, { request: copy(request), raw });
  state.busy = true;
  let outcome;
  try {
    outcome = await reserveRuleMembershipDecision(userId, raw, {
      verifyDecision,
      receipt: ({ verified, before, result }) => {
        if (!Array.isArray(verified?.actions) || verified.actions.length > 201) fail('invalid_rule_decision', 'The rule verifier must return its bounded persisted actions');
        return { decisionId: result.mutationId, executionId: state.executionId, previousReceiptId: raw.previousReceiptId,
          inputVersion: before.targets[0].metadataVersion, outputVersion: result.targets[0].metadataVersion,
          ruleId: raw.ruleId, ruleRevision: raw.ruleRevision, source: copy(raw.source),
          actions: verified.actions.map((action, ordinal) => ({ ordinal, hash: digest(action) })),
          conditionEvidence: copy(verified.conditionEvidence ?? null) };
      },
    });
    if (outcome.changed) {
      const receipt = outcome.result.receipt;
      if (receipt.inputVersion !== state.proof.expectedMetadataVersion || receipt.previousReceiptId !== (state.receipts.at(-1)?.decisionId ?? null)) {
        fail('rule_lineage_conflict', 'The confirmed decision does not extend this execution');
      }
      state.receipts.push(copy(receipt));
      state.proof.expectedMetadataVersion = receipt.outputVersion;
      state.proof.labelIds = copy(outcome.result.targets[0].labelIds);
    }
  } catch (error) {
    // Includes lost COMMIT acknowledgments. A fresh decision ID must not recover
    // permission for downstream effects from a possibly committed reservation.
    state.poisoned = true;
    throw error;
  } finally { state.busy = false; }
  if (outcome.changed && broadcast) {
    try { await broadcast({ type: 'label_memberships_changed', accountId: raw.accountId, storageGeneration: raw.storageGeneration,
      entityIds: [raw.source.canonicalEntityId] }, userId); }
    catch { console.warn('Rule decision notification failed'); }
  }
  return outcome;
}

async function verifyLineage(client, state, origin) {
  let version = state.rootVersion, previousReceiptId = null;
  const { rows } = await client.query(`SELECT mutation_id,response FROM native_label_mutations
    WHERE account_id=$1 AND mutation_id=ANY($2::uuid[])`, [state.proof.source.account_id, state.receipts.map(r => r.decisionId)]);
  for (const receipt of state.receipts) {
    const saved = rows.find(row => row.mutation_id === receipt.decisionId)?.response?.receipt;
    if (!saved || digest(saved) !== digest(receipt) || receipt.executionId !== state.executionId
        || receipt.inputVersion !== version || receipt.previousReceiptId !== previousReceiptId
        || digest(receipt.source) !== digest(state.proof.source)) fail('rule_lineage_conflict', 'The own-write decision lineage is unavailable');
    version = receipt.outputVersion; previousReceiptId = receipt.decisionId;
  }
  if (!state.receipts.includes(origin) || version !== state.proof.expectedMetadataVersion) fail('rule_lineage_conflict', 'The action has no current trusted ancestor');
}

export async function claimNativeRuleAction(userId, token, { decisionId, actionOrdinal, action }, { verifyRule, applyLocal } = {}) {
  const state = stateFor(token);
  if (state.busy) fail('rule_execution_busy', 'An action or decision is already in flight');
  const receipt = state.receipts.find(r => r.decisionId === decisionId);
  if (!receipt || !Number.isInteger(actionOrdinal) || receipt.actions[actionOrdinal]?.hash !== digest(action)) fail('invalid_rule_action', 'This action was not authorized by this execution');
  if (typeof verifyRule !== 'function') fail('rule_verifier_required', 'A server rule verifier is required');
  const claimKey = `${decisionId}:${actionOrdinal}`;
  if (state.claimedActions.has(claimKey)) return { claimed: false, status: 'consumed', decisionId, actionOrdinal };
  // Retain process-local consumption as well: restoring an older backup while
  // this process is alive must not rearm a dispatch absent from that backup.
  state.claimedActions.add(claimKey);
  state.busy = true;
  try {
    return await guardRuleMembershipSource(userId, state.proof, async (client, { source, input }) => {
      await verifyLineage(client, state, receipt);
      const verified = await verifyRule(client, { userId, input: { ...input, ruleId: receipt.ruleId,
        ruleRevision: receipt.ruleRevision }, source });
      if (digest(verified?.actions?.[actionOrdinal]) !== receipt.actions[actionOrdinal].hash) fail('rule_changed', 'The action no longer matches the saved rule');
      const { rows } = await client.query(`INSERT INTO inbox_rule_action_attempts
        (account_id,storage_generation,decision_id,action_ordinal,action_hash,execution_id,rule_id,rule_revision,source,expected_metadata_version,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,'claimed') ON CONFLICT DO NOTHING RETURNING decision_id`,
      [input.accountId, input.storageGeneration, decisionId, actionOrdinal, receipt.actions[actionOrdinal].hash,
        state.executionId, receipt.ruleId, receipt.ruleRevision, JSON.stringify(source), state.proof.expectedMetadataVersion]);
      if (!rows.length) return { claimed: false, status: 'consumed', decisionId, actionOrdinal };
      if (applyLocal) {
        // Only synchronous database work on this client belongs here, never
        // providers, broadcasts, resource acquisition or a top-level transaction.
        const outcome = await applyLocal(client, { source });
        await finishClaim(client, input.accountId, decisionId, actionOrdinal, 'confirmed', outcome ?? null);
      }
      return { claimed: true, status: applyLocal ? 'confirmed' : 'claimed', decisionId, actionOrdinal };
    });
  } catch (error) { state.poisoned = true; throw error; }
  finally { state.busy = false; }
}
async function finishClaim(client, accountId, decisionId, ordinal, status, outcome) {
  if (!['confirmed', 'failed', 'pending'].includes(status)) fail('invalid_action_outcome', 'Invalid action outcome');
  const encoded = JSON.stringify(outcome ?? null);
  if (Buffer.byteLength(encoded, 'utf8') > 16384) fail('invalid_action_outcome', 'Action outcome exceeds the journal bound');
  return client.query(`UPDATE inbox_rule_action_attempts SET status=$4,outcome=$5::jsonb,updated_at=NOW()
    WHERE account_id=$1 AND decision_id=$2 AND action_ordinal=$3 AND status='claimed' RETURNING status`,
  [accountId, decisionId, ordinal, status, encoded]);
}
export async function completeNativeRuleAction(userId, token, { decisionId, actionOrdinal, status, outcome }) {
  // Completion may record an already-dispatched outcome after the execution was
  // invalidated. It cannot authorize work or change a consumed terminal claim.
  const state = executions.get(token);
  const receipt = state?.receipts.find(r => r.decisionId === decisionId);
  if (!receipt || !receipt.actions[actionOrdinal]) fail('invalid_rule_action', 'Unknown action claim');
  return withTransaction(async client => {
    const owner = await client.query('SELECT id FROM email_accounts WHERE id=$1 AND user_id=$2', [receipt.source.account_id, userId]);
    if (!owner.rows.length) fail('not_found', 'Account not found');
    const result = await finishClaim(client, receipt.source.account_id, decisionId, actionOrdinal, status, outcome);
    return { recorded: result.rows.length === 1 };
  });
}
