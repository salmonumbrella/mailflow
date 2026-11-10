// Independent wave7 review: use production rule verification and real PostgreSQL.
import { randomBytes, randomUUID } from 'crypto';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { PassThrough, Readable } from 'stream';
const h = vi.hoisted(() => ({ pool: null, loseCommit: false }));
vi.mock('./db.js', () => ({
  pool: { connect: (...args) => h.pool.connect(...args) }, query: (...args) => h.pool.query(...args),
  withTransaction: async fn => {
    const c = await h.pool.connect();
    try { await c.query('BEGIN'); const result = await fn(c); await c.query('COMMIT');
      if (h.loseCommit) { h.loseCommit = false; throw Object.assign(new Error('independent lost commit'), { code: 'commit_outcome_unknown' }); }
      return result;
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  },
}));
import { runMigrations } from './migrations.js';
import { writeBackup, restoreBackup } from './backup.js';
import { readMailboxIdentity, observeMailboxIdentity, writeObservedMessage } from './messageIdentity.js';
import { createDefinition } from './nativeLabelDefinitions.js';
import { captureRuleMembershipSource, captureRuleMembershipBatch, reserveRuleMembershipDecision, mutateMemberships, undoMemberships } from './nativeLabelMemberships.js';
import { createNativeRuleExecution, getNativeRuleExecutionProof, commitNativeRuleDecision, claimNativeRuleAction, completeNativeRuleAction } from './nativeLabelRuleDecisions.js';
import { verifyNativeLabelRule, nativeLabelDelta } from './nativeLabelRuleReferences.js';
import { aggregateConditions, evaluateNativeLabelCondition } from './nativeLabelRuleConditions.js';
const ADMIN = process.env.MAILFLOW_TEST_DATABASE_URL;
describe.skipIf(!ADMIN)('independent durable native decision adversaries', () => {
  const name = `mailflow_audit_${randomBytes(6).toString('hex')}`;
  let admin, account, user, row, label, capturedRaw;
  beforeAll(async () => {
    vi.stubEnv('ENCRYPTION_KEY', '42'.repeat(32));
    admin = new pg.Client({ connectionString: ADMIN }); await admin.connect(); await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(ADMIN); url.pathname = `/${name}`; h.pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
    vi.spyOn(console, 'log').mockImplementation(() => {}); await runMigrations();
  }, 60000);
  afterAll(async () => { await h.pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${name}`); await admin?.end(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  const tuple = r => Object.fromEntries(['id', 'account_id', 'entity_id', 'storage_generation', 'folder', 'uid_validity', 'uid'].map(k => [k, r[k]]));
  const proof = () => captureRuleMembershipSource(user, tuple(row));
  const rule = async (actions = [{ type: 'notify' }], conditions = [{ field: 'native_label', operator: 'not_has', value: label.id }], logic = 'AND') =>
    (await h.pool.query(`INSERT INTO inbox_rules(user_id,account_id,storage_generation,name,conditions,actions,condition_logic)
      VALUES ($1,$2,$3,'audit',$4,$5,$6) RETURNING *,updated_at::text AS rule_revision`,
    [user, account.id, account.storage_generation, JSON.stringify(conditions), JSON.stringify(actions), logic])).rows[0];
  const req = r => ({ ruleId: r.id, ruleRevision: r.rule_revision, mutationId: randomUUID(), ...nativeLabelDelta(r.actions) });
  const decide = (t, q) => commitNativeRuleDecision(user, t, q, { verifyDecision: async (c, context) => {
    capturedRaw = structuredClone(context.input);
    const current = await verifyNativeLabelRule(c, context);
    const currentProof = { availability: 'known', labelIds: context.before.targets[0].labelIds };
    if (aggregateConditions(current.conditions.map(condition => evaluateNativeLabelCondition(condition, currentProof)), current.condition_logic) !== 'true')
      throw Object.assign(new Error('condition is not true'), { code: 'condition_false' });
    return { actions: current.actions, conditionEvidence: { value: true } };
  } });
  const claim = (t, q, action = { type: 'notify' }, ordinal = 0) => claimNativeRuleAction(user, t,
    { decisionId: q.mutationId, actionOrdinal: ordinal, action }, { verifyRule: async (c, ctx) => {
      const current = await verifyNativeLabelRule(c, { ...ctx, input: { ...ctx.input, ...nativeLabelDelta((await c.query('SELECT actions FROM inbox_rules WHERE id=$1', [q.ruleId])).rows[0]?.actions) } });
      return { actions: current.actions };
    } });
  beforeEach(async () => {
    await h.pool.query('TRUNCATE users CASCADE'); h.loseCommit = false; capturedRaw = null;
    user = (await h.pool.query("INSERT INTO users(username) VALUES ('audit') RETURNING id")).rows[0].id;
    account = (await h.pool.query("INSERT INTO email_accounts(user_id,name,email_address) VALUES ($1,'audit','audit@test') RETURNING *", [user])).rows[0];
    const ctx = await observeMailboxIdentity(await readMailboxIdentity(account, 'INBOX'), { mailbox: { path: 'INBOX', uidValidity: 5n }, capabilities: new Set() });
    row = (await writeObservedMessage(ctx, { uid: 7 }, c => c.query("INSERT INTO messages(account_id,uid,folder,from_email,from_name,subject,has_attachments,is_read) VALUES ($1,7,'INBOX',NULL,NULL,NULL,NULL,NULL) RETURNING *", [account.id]))).rows[0];
    label = (await createDefinition(user, { accountId: account.id, name: 'Audit', mutationId: randomUUID() })).result.label;
  });
  it('low-level identical replay after lost decision COMMIT is history only, even after source and rule change', async () => {
    const p = await proof(), t = createNativeRuleExecution(p), q = req(await rule()); h.loseCommit = true;
    await expect(decide(t, q)).rejects.toMatchObject({ code: 'commit_outcome_unknown' });
    const original = (await h.pool.query('SELECT response FROM native_label_mutations WHERE mutation_id=$1', [q.mutationId])).rows[0].response;
    await h.pool.query('UPDATE inbox_rules SET enabled=false WHERE id=$1', [q.ruleId]); await h.pool.query('DELETE FROM messages WHERE id=$1', [row.id]);
    const forbidden = vi.fn(() => { throw new Error('Replay must not verify or mint a receipt'); });
    expect(await reserveRuleMembershipDecision(user, capturedRaw, { verifyDecision: forbidden, receipt: forbidden })).toEqual({ changed: false, result: original });
    expect(forbidden).not.toHaveBeenCalled();
    await expect(claim(t, q)).rejects.toMatchObject({ code: 'rule_execution_unavailable' });
    await expect(claim(createNativeRuleExecution(p), q)).rejects.toMatchObject({ code: 'invalid_rule_action' });
    expect((await h.pool.query('SELECT * FROM inbox_rule_action_attempts')).rows).toHaveLength(0);
  });
  it.each(['confirmed', 'pending', 'failed'])('terminal %s claim rejects every durable field mutation and remains consumed', async status => {
    const t = createNativeRuleExecution(await proof()), q = req(await rule()); await decide(t, q); await claim(t, q);
    await completeNativeRuleAction(user, t, { decisionId: q.mutationId, actionOrdinal: 0, status, outcome: { exact: '9007199254740993' } });
    for (const update of ["status='claimed'", "status='confirmed',outcome='{}'", "rule_revision='forged'", "source='{}'", 'expected_metadata_version=100', "action_hash=repeat('0',64)", 'updated_at=clock_timestamp()'])
      await expect(h.pool.query(`UPDATE inbox_rule_action_attempts SET ${update}`)).rejects.toMatchObject({ code: '23514' });
    expect(await claim(t, q)).toMatchObject({ claimed: false });
  });
  it.each(['setup', 'full'])('actual %s backup before claim cannot rearm a later consumed action', async scope => {
    const p = await proof(), t = createNativeRuleExecution(p), q = req(await rule()); const decision = await decide(t, q);
    const c = await h.pool.connect(); let bytes;
    try {
      const chunks = [], out = new PassThrough(); out.on('data', chunk => chunks.push(chunk));
      await writeBackup(c, { scope, appVersion: 'independent-audit', out }); bytes = Buffer.concat(chunks);
    } finally { c.release(); }
    await claim(t, q);
    await completeNativeRuleAction(user, t, { decisionId: q.mutationId, actionOrdinal: 0, status: 'pending' });
    const restorer = await h.pool.connect();
    try { await restoreBackup(restorer, Readable.from([bytes])); } finally { restorer.release(); }
    expect((await h.pool.query('SELECT response FROM native_label_mutations WHERE mutation_id=$1', [q.mutationId])).rows[0].response).toEqual(decision.result);
    expect((await h.pool.query('SELECT * FROM inbox_rule_action_attempts')).rows).toHaveLength(0);
    expect(await claim(t, q)).toMatchObject({ claimed: false, status: 'consumed' });
    await expect(claim(createNativeRuleExecution(p), q)).rejects.toMatchObject({ code: 'invalid_rule_action' });
    expect(Number((await h.pool.query('SELECT count(*) FROM messages')).rows[0].count)).toBe(scope === 'full' ? 1 : 0);
  });
  it('enforces the 16 KiB outcome bound in UTF-8 bytes rather than UTF-16 code units', async () => {
    const t = createNativeRuleExecution(await proof()), q = req(await rule()); await decide(t, q); await claim(t, q);
    const outcome = { detail: '界'.repeat(6000) };
    expect(JSON.stringify(outcome).length).toBeLessThan(16384);
    expect(Buffer.byteLength(JSON.stringify(outcome), 'utf8')).toBeGreaterThan(16384);
    await expect(completeNativeRuleAction(user, t, { decisionId: q.mutationId, actionOrdinal: 0, status: 'confirmed', outcome }))
      .rejects.toMatchObject({ code: 'invalid_action_outcome' });
    expect((await h.pool.query('SELECT status FROM inbox_rule_action_attempts')).rows).toEqual([{ status: 'claimed' }]);
  });
  it('mixed native delta preserves real Undo, and Undo invalidates later deferred effects', async () => {
    const t = createNativeRuleExecution(await proof()); const q = req(await rule([{ type: 'apply_native_label', value: label.id }, { type: 'notify' }]));
    const result = await decide(t, q); expect(result.result.undoSupported).toBe(true);
    expect((await h.pool.query('SELECT operation_kind,undo_state IS NOT NULL AS undo FROM native_label_mutations')).rows).toEqual([{ operation_kind: 'apply', undo: true }]);
    await undoMemberships(user, { accountId: account.id, storageGeneration: account.storage_generation, mutationId: randomUUID(), originalMutationId: q.mutationId });
    expect((await proof()).labelIds).toEqual([]);
    await expect(claim(t, q, { type: 'notify' }, 1)).rejects.toMatchObject({ code: 'stale_metadata_version' });
  });
  it('prevents public Apply from replaying or hiding an internal empty reservation', async () => {
    const t = createNativeRuleExecution(await proof()), q = req(await rule()); await decide(t, q);
    await expect(mutateMemberships(user, { accountId: account.id, storageGeneration: account.storage_generation, mutationId: q.mutationId,
      targets: [{ entityId: row.entity_id, expectedMetadataVersion: '0' }], addLabelIds: [label.id], removeLabelIds: [] })).rejects.toMatchObject({ code: 'mutation_conflict' });
    expect((await proof()).expectedMetadataVersion).toBe('1'); expect((await proof()).labelIds).toEqual([]);
  });
  it('bounds own-write receipts without preventing an already-authorized deferred claim', async () => {
    const t = createNativeRuleExecution(await proof(), { maxDecisions: 2 }), r = await rule(), q1 = req(r), q2 = req(r);
    await decide(t, q1); await decide(t, q2);
    await expect(decide(t, req(r))).rejects.toMatchObject({ code: 'rule_execution_limit' });
    expect(await claim(t, q1)).toMatchObject({ claimed: true });
    expect((await h.pool.query('SELECT expected_metadata_version::text FROM inbox_rule_action_attempts')).rows[0].expected_metadata_version).toBe('2');
  });
  it.each(['disable', 'revision', 'missing_reference'])('invalidates a deferred ancestor on %s after a later own decision', async change => {
    const t = createNativeRuleExecution(await proof()), first = await rule(), q1 = req(first), q2 = req(await rule());
    await decide(t, q1); await decide(t, q2);
    if (change === 'disable') await h.pool.query('UPDATE inbox_rules SET enabled=false WHERE id=$1', [first.id]);
    if (change === 'revision') await h.pool.query("UPDATE inbox_rules SET updated_at=updated_at+interval '1 microsecond' WHERE id=$1", [first.id]);
    if (change === 'missing_reference') await h.pool.query('DELETE FROM mail_labels WHERE id=$1', [label.id]);
    await expect(claim(t, q1)).rejects.toMatchObject({ code: change === 'missing_reference' ? 'missing_label_reference' : 'rule_changed' });
    expect((await h.pool.query('SELECT * FROM inbox_rule_action_attempts')).rows).toHaveLength(0);
  });
  it('missing negative reference poisons OR despite another true negative branch', async () => {
    const t = createNativeRuleExecution(await proof()), absent = randomUUID();
    const q = req(await rule([{ type: 'notify' }], [{ field: 'native_label', operator: 'not_has', value: label.id }, { field: 'native_label', operator: 'not_has', value: absent }], 'OR'));
    await expect(decide(t, q)).rejects.toMatchObject({ code: 'missing_label_reference' });
    expect((await h.pool.query('SELECT * FROM native_label_mutations')).rows).toHaveLength(0);
  });
  it('does not refresh or mutate opaque proof when caller changes a returned copy', async () => {
    const p = await proof(), t = createNativeRuleExecution(p), copy = getNativeRuleExecutionProof(t);
    p.labelIds.push(label.id); copy.labelIds.push(label.id); copy.expectedMetadataVersion = '99'; copy.rawFields.subject = 'forged';
    expect(getNativeRuleExecutionProof(t)).toMatchObject({ labelIds: [], expectedMetadataVersion: '0', rawFields: { subject: null } });
    await decide(t, req(await rule()));
  });
  it.each(['cache_uuid', 'uid', 'epoch', 'generation', 'alias', 'external_noop'])('rejects %s drift between decision and claim', async change => {
    const t = createNativeRuleExecution(await proof()), q = req(await rule()); await decide(t, q);
    if (change === 'cache_uuid') await h.pool.query('UPDATE messages SET id=$1 WHERE id=$2', [randomUUID(), row.id]);
    if (change === 'uid') {
      await h.pool.query(`INSERT INTO entity_locations(account_id,storage_generation,entity_id,folder_path,uid_validity,uid,status)
        SELECT account_id,storage_generation,entity_id,folder_path,uid_validity,8,status FROM entity_locations WHERE entity_id=$1`, [row.entity_id]);
      await h.pool.query('UPDATE messages SET uid=8 WHERE id=$1', [row.id]);
    }
    if (change === 'epoch') await h.pool.query('UPDATE mailbox_identity_epochs SET uid_validity=6 WHERE account_id=$1', [account.id]);
    if (change === 'generation') await h.pool.query('UPDATE email_accounts SET storage_generation=$1 WHERE id=$2', [randomUUID(), account.id]);
    if (change === 'alias') {
      const other = (await h.pool.query('INSERT INTO message_entities(account_id,storage_generation) VALUES ($1,$2) RETURNING id', [account.id, account.storage_generation])).rows[0].id;
      await h.pool.query('UPDATE message_entities SET canonical_entity_id=$1 WHERE id=$2', [other, row.entity_id]);
    }
    if (change === 'external_noop') await mutateMemberships(user, { accountId: account.id, storageGeneration: account.storage_generation, mutationId: randomUUID(), targets: [{ entityId: row.entity_id, expectedMetadataVersion: '1' }], addLabelIds: [], removeLabelIds: [label.id] });
    await expect(claim(t, q)).rejects.toMatchObject({ code: change === 'generation' ? 'stale_generation' : change === 'external_noop' ? 'stale_metadata_version' : 'rule_source_changed' });
    expect((await h.pool.query('SELECT * FROM inbox_rule_action_attempts')).rows).toHaveLength(0);
  });
  it('snapshot fields remain complete SQL NULLs for known and identity-unknown sources', async () => {
    const results = await captureRuleMembershipBatch(user, [tuple(row)]);
    expect(results[0]).toMatchObject({ availability: 'known', labelIds: [], rawFields: { from_email: null, from_name: null, subject: null, has_attachments: null, is_read: null } });
    await h.pool.query("UPDATE entity_locations SET status='missing' WHERE entity_id=$1", [row.entity_id]);
    const [unknown] = await captureRuleMembershipBatch(user, [tuple(row)]);
    expect(unknown).toMatchObject({ availability: 'unknown', labelIds: null, expectedMetadataVersion: null, rawFields: results[0].rawFields });
    expect(() => createNativeRuleExecution(unknown)).toThrow();
  });
});
