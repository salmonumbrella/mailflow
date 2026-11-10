import { randomBytes, randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
const h = vi.hoisted(() => ({ pool: null, loseCommit: false }));
vi.mock('./db.js', () => ({
  pool: { connect: (...args) => h.pool.connect(...args) }, query: (...args) => h.pool.query(...args),
  withTransaction: async fn => {
    const client = await h.pool.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); if (h.loseCommit) { h.loseCommit=false; throw Object.assign(new Error('lost COMMIT response'),{code:'commit_outcome_unknown'}); } return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  },
}));
import { validateNativeLabelRuleReferences, nativeLabelDelta } from './nativeLabelRuleReferences.js';
import { createNativeRuleExecution, getNativeRuleExecutionProof, commitNativeRuleDecision, claimNativeRuleAction, completeNativeRuleAction } from './nativeLabelRuleDecisions.js';
import { runMigrations } from './migrations.js';
import { readMailboxIdentity, observeMailboxIdentity, writeObservedMessage } from './messageIdentity.js';
import { createDefinition } from './nativeLabelDefinitions.js';
import { mutateMemberships, validateMembershipRequest, undoMemberships, validateUndoRequest, captureRuleMembershipSource, captureRuleMembershipBatch } from './nativeLabelMemberships.js';
const ADMIN_URL = process.env.MAILFLOW_TEST_DATABASE_URL;
describe('rule decision public boundaries', () => {
  it('rejects caller-provided Undo state and malformed identities before database access', () => {
    const input = { accountId: randomUUID(), storageGeneration: randomUUID(), originalMutationId: randomUUID(), mutationId: randomUUID() };
    expect(validateUndoRequest(input)).toEqual(input);
    for (const change of [{ originalMutationId: undefined }, { mutationId: 'bad' }, { targets: [] }, { undo_state: {} }, { labelIds: [] }]) {
      expect(() => validateUndoRequest({ ...input, ...change })).toThrow();
    }
  });
  it('preserves decimal versions and refuses ambiguous/unbounded requests', () => {
    const base = { accountId: randomUUID(), storageGeneration: randomUUID(), targets: [{ entityId: randomUUID(), expectedMetadataVersion: '9007199254740993' }], mutationId: randomUUID(), addLabelIds: [randomUUID()], removeLabelIds: [] };
    expect(validateMembershipRequest(base, true).targets[0].expectedMetadataVersion).toBe('9007199254740993');
    for (const change of [{ targets: [] }, { targets: Array(201).fill(base.targets[0]) }, { targets: [base.targets[0], base.targets[0]] },
      { targets: [{ ...base.targets[0], expectedMetadataVersion: 0 }] }, { targets: [{ ...base.targets[0], expectedMetadataVersion: '9223372036854775808' }] },
      { addLabelIds: [], removeLabelIds: [] }, { removeLabelIds: base.addLabelIds }, { extra: true }, { accountId: 'bad' }]) {
      expect(() => validateMembershipRequest({ ...base, ...change }, true)).toThrow();
    }
  });
});
describe.skipIf(!ADMIN_URL)('native rule decisions on PostgreSQL', () => {
  const dbName = `mailflow_decision_${randomBytes(5).toString('hex')}`;
  let admin, account, user, stranger, message, second, label;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(ADMIN_URL); url.pathname = `/${dbName}`;
    h.pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
    vi.spyOn(console, 'log').mockImplementation(() => {}); await runMigrations();
  }, 60_000);
  afterAll(async () => { await h.pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin?.end(); vi.restoreAllMocks(); });
  const observe = async (acct, uid) => {
    const ctx = await observeMailboxIdentity(await readMailboxIdentity(acct, 'INBOX'), { mailbox: { path: 'INBOX', uidValidity: 123n }, capabilities: new Set() });
    return (await writeObservedMessage(ctx, { uid }, client => client.query(`INSERT INTO messages(account_id,folder,uid,message_id,subject)
      VALUES ($1,'INBOX',$2,'<same@test>','Same headers are not identity') RETURNING *`, [acct.id, uid]))).rows[0];
  };
  beforeEach(async () => {
    await h.pool.query('TRUNCATE users CASCADE');
    user = (await h.pool.query("INSERT INTO users(username) VALUES ('owner') RETURNING id")).rows[0].id;
    stranger = (await h.pool.query("INSERT INTO users(username) VALUES ('stranger') RETURNING id")).rows[0].id;
    const add = async (owner, name) => (await h.pool.query('INSERT INTO email_accounts(user_id,name,email_address) VALUES ($1,$2,$3) RETURNING *', [owner, name, `${name}@test`])).rows[0];
    account = await add(user, 'one'); await add(stranger, 'other');
    message = await observe(account, 1); second = await observe(account, 2);
    label = (await createDefinition(user, { accountId: account.id, mutationId: randomUUID(), name: 'Work' })).result.label;
  });
  const tuple = row => Object.fromEntries(['id','account_id','entity_id','storage_generation','folder','uid_validity','uid'].map(k => [k,row[k]]));
  const capture = () => captureRuleMembershipSource(user, tuple(message));
  const makeRule = async (actions = [{type:'archive'}]) => (await h.pool.query(`INSERT INTO inbox_rules(user_id,account_id,storage_generation,name,conditions,actions)
    VALUES ($1,$2,$3,'Decision',$4::jsonb,$5::jsonb) RETURNING *,updated_at::text AS rule_revision`,
  [user,account.id,account.storage_generation,JSON.stringify([{field:'native_label',operator:'not_has',value:label.id}]),JSON.stringify(actions)])).rows[0];
  const verify = async (client,{userId,input,before}) => {
    const rule = (await client.query('SELECT *,updated_at::text AS rule_revision FROM inbox_rules WHERE id=$1 FOR UPDATE',[input.ruleId])).rows[0];
    if (!rule?.enabled || rule.user_id!==userId || rule.rule_revision!==input.ruleRevision) throw Object.assign(new Error('changed'),{code:'rule_changed'});
    await validateNativeLabelRuleReferences(client,{userId,rule,account});
    if (before && before.targets[0].labelIds.includes(label.id)) throw Object.assign(new Error('false'),{code:'condition_false'});
    return { actions:rule.actions,conditionEvidence:{value:true} };
  };
  const request = rule => ({ruleId:rule.id,ruleRevision:rule.rule_revision,mutationId:randomUUID(),...nativeLabelDelta(rule.actions)});
  const decide = (token,req,options={}) => commitNativeRuleDecision(user,token,req,{verifyDecision:verify,...options});
  const claim = (token,req,action={type:'archive'},ordinal=0,options={}) => claimNativeRuleAction(user,token,{decisionId:req.mutationId,actionOrdinal:ordinal,action},{verifyRule:verify,...options});
  it('reserves empty decisions once, with exact historical replay and no Undo',async()=>{
    const token=createNativeRuleExecution(await capture()),rule=await makeRule(),req=request(rule);
    const first=await decide(token,req); expect(first.result.undoSupported).toBe(false);
    expect(first.result.targets[0].metadataVersion).toBe('1'); expect(first.result.receipt.inputVersion).toBe('0');
    expect(await decide(token,req)).toEqual({result:first.result,changed:false});
    expect((await h.pool.query('SELECT operation_kind,undo_state FROM native_label_mutations')).rows[0]).toEqual({operation_kind:'rule_decision',undo_state:null});
    await expect(undoMemberships(user,{accountId:account.id,storageGeneration:account.storage_generation,mutationId:randomUUID(),originalMutationId:req.mutationId})).rejects.toMatchObject({code:'undo_unavailable'});
    await expect(decide(token,{...req,ruleRevision:'changed'})).rejects.toMatchObject({code:'mutation_conflict'});
  });
  it('permits an earlier deferred effect through confirmed own writes but not an external version',async()=>{
    const token=createNativeRuleExecution(await capture()),r1=await makeRule(),q1=request(r1); await decide(token,q1);
    const r2=await makeRule([{type:'apply_native_label',value:label.id}]),q2=request(r2); await decide(token,q2);
    expect(getNativeRuleExecutionProof(token)).toMatchObject({expectedMetadataVersion:'2',labelIds:[label.id]});
    expect(await claim(token,q1)).toMatchObject({claimed:true});
    await completeNativeRuleAction(user,token,{decisionId:q1.mutationId,actionOrdinal:0,status:'confirmed'});
    expect(await claim(token,q1)).toMatchObject({claimed:false});
    await mutateMemberships(user,{accountId:account.id,storageGeneration:account.storage_generation,targets:[{entityId:message.entity_id,expectedMetadataVersion:'2'}],mutationId:randomUUID(),addLabelIds:[],removeLabelIds:[label.id]});
    await expect(claim(token,q2,{type:'apply_native_label',value:label.id})).rejects.toMatchObject({code:'stale_metadata_version'});
  });
  it('does not authorize a replay or forged execution token',async()=>{
    const proof=await capture(),token=createNativeRuleExecution(proof),rule=await makeRule(),req=request(rule); await decide(token,req);
    const restarted=createNativeRuleExecution(proof);
    await expect(claim(restarted,req)).rejects.toMatchObject({code:'invalid_rule_action'});
    await expect(claim({},req)).rejects.toMatchObject({code:'rule_execution_unavailable'});
    await expect(claim(token,req,{type:'delete'})).rejects.toMatchObject({code:'invalid_rule_action'});
  });
  it('claims once under concurrent dispatch and leaves consumed claims pending after interruption',async()=>{
    const token=createNativeRuleExecution(await capture()),req=request(await makeRule()); await decide(token,req);
    const results=await Promise.allSettled([claim(token,req),claim(token,req)]);
    expect(results.filter(r=>r.status==='fulfilled'&&r.value.claimed)).toHaveLength(1);
    expect((await h.pool.query('SELECT status FROM inbox_rule_action_attempts')).rows).toEqual([{status:'claimed'}]);
    await completeNativeRuleAction(user,token,{decisionId:req.mutationId,actionOrdinal:0,status:'pending',outcome:{reason:'ack lost'}});
    expect(await claim(token,req)).toMatchObject({claimed:false});
    expect(await completeNativeRuleAction(user,token,{decisionId:req.mutationId,actionOrdinal:0,status:'confirmed'})).toEqual({recorded:false});
    await expect(h.pool.query("UPDATE inbox_rule_action_attempts SET status='claimed'")).rejects.toMatchObject({code:'23514'});
    await expect(h.pool.query("UPDATE inbox_rule_action_attempts SET action_hash=$1",['f'.repeat(64)])).rejects.toMatchObject({code:'23514'});
  });
  it('releases account locks before provider work and guards only the dispatch authorization point',async()=>{
    const token=createNativeRuleExecution(await capture()),req=request(await makeRule()); await decide(token,req); await claim(token,req);
    // This callback re-enters the same account transaction. It would deadlock if
    // the claim retained any database lock while dispatching.
    const provider=async()=>{await capture();return 'confirmed';};
    const status=await provider();
    await h.pool.query('UPDATE message_entities SET metadata_version=metadata_version+1 WHERE id=$1',[message.entity_id]);
    expect(await completeNativeRuleAction(user,token,{decisionId:req.mutationId,actionOrdinal:0,status})).toEqual({recorded:true});
  });
  it('rejects rule microsecond revision changes after decision and leaves no claim',async()=>{
    const token=createNativeRuleExecution(await capture()),req=request(await makeRule()); await decide(token,req);
    await h.pool.query("UPDATE inbox_rules SET updated_at=updated_at+INTERVAL '1 microsecond' WHERE id=$1",[req.ruleId]);
    await expect(claim(token,req)).rejects.toMatchObject({code:'rule_changed'});
    expect((await h.pool.query('SELECT * FROM inbox_rule_action_attempts')).rows).toHaveLength(0);
  });
  it('treats missing evidence as unknown, not known empty; rejects forged membership evidence',async()=>{
    const proof=await capture();expect(proof.availability).toBe('known');expect(proof.labelIds).toEqual([]);
    expect(()=>createNativeRuleExecution({...proof,labelIds:undefined})).toThrow();
    expect(()=>createNativeRuleExecution({...proof,availability:'unknown'})).toThrow();
    const token=createNativeRuleExecution({...proof,labelIds:[label.id]});
    await expect(decide(token,request(await makeRule()))).rejects.toMatchObject({code:'rule_evidence_changed'});
  });
  it('keeps a local effect and confirmed claim atomic',async()=>{
    const token=createNativeRuleExecution(await capture()),req=request(await makeRule());await decide(token,req);
    await claim(token,req,{type:'archive'},0,{applyLocal:async(client,{source})=>{
      await client.query("UPDATE messages SET subject='Local guarded write' WHERE id=$1",[source.id]);return {done:true};
    }});
    expect((await h.pool.query('SELECT status,outcome FROM inbox_rule_action_attempts')).rows).toEqual([{status:'confirmed',outcome:{done:true}}]);
  });
  it.each(['source','epoch','alias','version'])('conflicts on an intervening %s change without adopting it',async kind=>{
    const token=createNativeRuleExecution(await capture()),req=request(await makeRule());
    if(kind==='source')await h.pool.query('DELETE FROM messages WHERE id=$1',[message.id]);
    if(kind==='epoch')await h.pool.query('UPDATE mailbox_identity_epochs SET uid_validity=124 WHERE account_id=$1',[account.id]);
    if(kind==='alias')await h.pool.query('UPDATE message_entities SET canonical_entity_id=$2 WHERE id=$1',[message.entity_id,second.entity_id]);
    if(kind==='version')await h.pool.query('UPDATE message_entities SET metadata_version=1 WHERE id=$1',[message.entity_id]);
    await expect(decide(token,req)).rejects.toMatchObject({code:kind==='version'?'stale_metadata_version':'rule_source_changed'});
    expect((await h.pool.query('SELECT * FROM native_label_mutations')).rows).toHaveLength(0);
  });
  it('captures batch raw fields and explicit unknowns in one bounded consistent snapshot',async()=>{
    await h.pool.query('UPDATE messages SET from_email=NULL,subject=NULL,is_read=NULL,has_attachments=NULL WHERE id=$1',[message.id]);
    const [known,missing,unavailable]=await captureRuleMembershipBatch(user,[tuple(message),{...tuple(message),id:randomUUID()},{...tuple(second),entity_id:null}]);
    expect(known).toMatchObject({availability:'known',expectedMetadataVersion:'0',labelIds:[],rawFields:{from_email:null,subject:null,is_read:null,has_attachments:null}});
    expect(missing).toMatchObject({availability:'unknown',labelIds:null,expectedMetadataVersion:null});
    expect(unavailable).toMatchObject({availability:'unknown',labelIds:null,rawFields:{subject:'Same headers are not identity'}});
  });
  it('waits behind a concurrent writer and captures its version and memberships together',async()=>{
    const blocker=await h.pool.connect();await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM email_accounts WHERE id=$1 FOR UPDATE',[account.id]);
    const pending=captureRuleMembershipBatch(user,[tuple(message)]);
    await blocker.query('UPDATE message_entities SET metadata_version=1 WHERE id=$1',[message.entity_id]);
    await blocker.query('INSERT INTO native_label_memberships(account_id,storage_generation,entity_id,label_id) VALUES ($1,$2,$3,$4)',[account.id,account.storage_generation,message.entity_id,label.id]);
    await blocker.query('COMMIT');blocker.release();
    expect((await pending)[0]).toMatchObject({availability:'known',expectedMetadataVersion:'1',labelIds:[label.id]});
  });
  it('does not resurrect expired decision receipts or claim tombstones',async()=>{
    const token=createNativeRuleExecution(await capture()),req=request(await makeRule()); await decide(token,req);
    await h.pool.query('UPDATE native_label_mutations SET response=NULL,undo_state=NULL WHERE mutation_id=$1',[req.mutationId]);
    await expect(claim(token,req)).rejects.toMatchObject({code:'rule_lineage_conflict'});
    expect((await h.pool.query('SELECT * FROM inbox_rule_action_attempts')).rows).toHaveLength(0);
    await expect(decide(token,{...req,mutationId:randomUUID()})).rejects.toMatchObject({code:'rule_execution_unavailable'});
  });

  it('freezes an execution after a lost decision COMMIT response rather than retrying a fresh ID',async()=>{
    const token=createNativeRuleExecution(await capture()),req=request(await makeRule());h.loseCommit=true;
    await expect(decide(token,req)).rejects.toMatchObject({code:'commit_outcome_unknown'});
    expect((await h.pool.query('SELECT response FROM native_label_mutations WHERE mutation_id=$1',[req.mutationId])).rows[0].response.targets[0].metadataVersion).toBe('1');
    await expect(decide(token,{...req,mutationId:randomUUID()})).rejects.toMatchObject({code:'rule_execution_unavailable'});
    await expect(claim(token,req)).rejects.toMatchObject({code:'rule_execution_unavailable'});
  });
  it('never dispatches or rearms an action after a lost claim COMMIT response',async()=>{
    const token=createNativeRuleExecution(await capture()),req=request(await makeRule());await decide(token,req);h.loseCommit=true;
    await expect(claim(token,req)).rejects.toMatchObject({code:'commit_outcome_unknown'});
    expect((await h.pool.query('SELECT status FROM inbox_rule_action_attempts')).rows).toEqual([{status:'claimed'}]);
    await expect(claim(token,req)).rejects.toMatchObject({code:'rule_execution_unavailable'});
    await completeNativeRuleAction(user,token,{decisionId:req.mutationId,actionOrdinal:0,status:'pending'});
    expect((await h.pool.query('SELECT status FROM inbox_rule_action_attempts')).rows).toEqual([{status:'pending'}]);
  });

  it('does not rearm a live execution if restore removes a newer consumed claim',async()=>{
    const token=createNativeRuleExecution(await capture()),req=request(await makeRule());await decide(token,req);await claim(token,req);
    // An older backup can legitimately predate the action row. The still-live
    // process must retain consumption, while a restarted process has no token.
    await h.pool.query('DELETE FROM inbox_rule_action_attempts WHERE decision_id=$1',[req.mutationId]);
    expect(await claim(token,req)).toMatchObject({claimed:false});
    expect((await h.pool.query('SELECT * FROM inbox_rule_action_attempts')).rows).toHaveLength(0);
  });

  it.each(['ASCII', 'multibyte'])('enforces exact UTF-8 outcome byte boundaries for %s JSON',async encoding=>{
    const token=createNativeRuleExecution(await capture()),req=request(await makeRule());await decide(token,req);await claim(token,req);
    const overhead=Buffer.byteLength(JSON.stringify({detail:''}),'utf8');
    const remaining=16384-overhead;
    const detail=encoding==='ASCII'?'x'.repeat(remaining):'界'.repeat(Math.floor(remaining/3))+'x'.repeat(remaining%3);
    const atLimit={detail},overLimit={detail:detail+'x'};
    expect(Buffer.byteLength(JSON.stringify(atLimit),'utf8')).toBe(16384);
    expect(Buffer.byteLength(JSON.stringify(overLimit),'utf8')).toBe(16385);
    await expect(completeNativeRuleAction(user,token,{decisionId:req.mutationId,actionOrdinal:0,status:'confirmed',outcome:overLimit})).rejects.toMatchObject({code:'invalid_action_outcome'});
    expect((await h.pool.query('SELECT status,outcome FROM inbox_rule_action_attempts')).rows).toEqual([{status:'claimed',outcome:null}]);
    expect(await completeNativeRuleAction(user,token,{decisionId:req.mutationId,actionOrdinal:0,status:'confirmed',outcome:atLimit})).toEqual({recorded:true});
    expect((await h.pool.query('SELECT status,outcome FROM inbox_rule_action_attempts')).rows).toEqual([{status:'confirmed',outcome:atLimit}]);
  });

});
