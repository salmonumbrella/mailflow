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
vi.mock('./ruleForwarder.js', () => ({ forwardRuleMessage: async args => {
  await h.prepare?.('forward');
  if (args.beforeDispatch) await args.beforeDispatch();
  h.calls.push('forward');
  if (h.uncertain) throw new Error('SMTP lost acknowledgement');
  return 'sent';
} }));
import { applyInboxRules } from './inboxRules.js';
import { runMigrations } from './migrations.js';
import { readMailboxIdentity, observeMailboxIdentity, writeObservedMessage } from './messageIdentity.js';
import { createDefinition } from './nativeLabelDefinitions.js';
import { captureRuleMembershipSource, captureRuleMembershipSourceInTransaction, mutateMemberships } from './nativeLabelMemberships.js';
const ADMIN_URL = process.env.MAILFLOW_TEST_DATABASE_URL;
describe.skipIf(!ADMIN_URL)('guarded rule runtime on PostgreSQL', () => {
  const dbName = `mailflow_runtime_${randomBytes(5).toString('hex')}`;
  let admin, account, user, message, label, imap;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(ADMIN_URL); url.pathname = `/${dbName}`;
    h.pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
    vi.spyOn(console, 'log').mockImplementation(() => {}); await runMigrations();
  }, 60_000);
  afterAll(async () => { await h.pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin?.end(); vi.restoreAllMocks(); });
  const tuple = row => Object.fromEntries(['id','account_id','entity_id','storage_generation','folder','uid_validity','uid'].map(k => [k,row[k]]));
  const capture = () => captureRuleMembershipSource(user, tuple(message));
  const updateExternally = async () => {
    const proof = await capture();
    await mutateMemberships(user, { accountId: account.id, storageGeneration: account.storage_generation, mutationId: randomUUID(),
      targets: [{ entityId: message.entity_id, expectedMetadataVersion: proof.expectedMetadataVersion }], addLabelIds: [label.id], removeLabelIds: [] });
  };
  beforeEach(async () => {
    h.calls = []; h.loseCommit = false; h.prepare = null; h.afterDispatch = null; h.uncertain = false;
    await h.pool.query('TRUNCATE users CASCADE');
    user = (await h.pool.query("INSERT INTO users(username) VALUES ('owner') RETURNING id")).rows[0].id;
    account = (await h.pool.query("INSERT INTO email_accounts(user_id,name,email_address,folder_mappings) VALUES ($1,'one','one@test',$2::jsonb) RETURNING *", [user,JSON.stringify({archive:'Archive',trash:'Trash'})])).rows[0];
    const ctx = await observeMailboxIdentity(await readMailboxIdentity(account, 'INBOX'), { mailbox: { path: 'INBOX', uidValidity: 123n }, capabilities: new Set() });
    message = (await writeObservedMessage(ctx, { uid:1 }, client => client.query(`INSERT INTO messages(account_id,folder,uid,message_id,subject,from_email,is_read,has_attachments)
      VALUES ($1,'INBOX',1,'<same@test>','Invoice','alice@test',false,false) RETURNING *`, [account.id]), {
      captureRuleSource: (tx, source) => captureRuleMembershipSourceInTransaction(tx, user, source),
    })).rows[0];
    label = (await createDefinition(user, { accountId: account.id, mutationId: randomUUID(), name: 'Work' })).result.label;
    imap = {
      setFlag: vi.fn(async (_account,_uid,_folder,flag,_value, options) => {
        await h.prepare?.(flag);
        if (options.beforeDispatch) await options.beforeDispatch();
        h.calls.push(flag);
        await h.afterDispatch?.();
        // Real account reentry after the claim catches retained database locks.
        await capture();
        if (h.uncertain) throw new Error('STORE lost acknowledgement');
      }),
      bulkMoveMessages: vi.fn(async (_account, _uids, _from, _to, options) => {
        await h.prepare?.('move'); if (options.beforeDispatch) await options.beforeDispatch();
        h.calls.push('move'); await capture();
        return { uidMap: new Map(), succeeded:[1], identityPending:true };
      }),
      _enqueueFlagPush: vi.fn(), _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(), syncFolderOnDemand: vi.fn(async()=>{}), broadcast: vi.fn(),
    };
  });
  const makeRule = async (actions, options={}) => (await h.pool.query(`INSERT INTO inbox_rules(user_id,account_id,storage_generation,name,conditions,actions,condition_logic,stop_processing,priority)
    VALUES ($1,$2,$3,'Runtime',$4::jsonb,$5::jsonb,$6,$7,$8) RETURNING *,updated_at::text AS rule_revision`,
    [user,account.id,account.storage_generation,JSON.stringify(options.conditions || [{field:'native_label',operator:'not_has',value:label.id}]),JSON.stringify(actions),options.logic||'AND',!!options.stop,options.priority||0])).rows[0];
  const run = rule => applyInboxRules([{...message,fromEmail:message.from_email,subject:message.subject}], account, imap, rule ? {rule} : {});
  const claims = async () => (await h.pool.query('SELECT action_ordinal,status FROM inbox_rule_action_attempts ORDER BY action_ordinal')).rows;
  it('captures complete exact source, raw fields, version and known empty membership during ingestion',async()=>{
    expect(message._nativeLabelProof).toMatchObject({availability:'known',expectedMetadataVersion:'0',labelIds:[],rawFields:{subject:'Invoice',from_email:'alice@test',is_read:false}});
    await updateExternally();
    const result=await run(await makeRule([{type:'star'},{type:'set_category',value:'social'},{type:'notify'}]));
    expect(result.failedCount).toBe(1);expect(h.calls).toEqual([]);expect(await claims()).toEqual([]);
    expect((await h.pool.query('SELECT category FROM messages WHERE id=$1',[message.id])).rows[0].category).toBe(null);
  });
  it.each(['mark_read','star','archive','move','delete','forward'])('guards condition-only %s after preparation; conflict prevents dispatch',async type=>{
    const action={type,...(type==='move'?{value:'Archive'}:type==='forward'?{value:'dest@test.example'}:{})};
    const rule=await makeRule([action,{type:'notify'}]);h.prepare=updateExternally;
    const result=await run(rule);expect(result.failedCount).toBeGreaterThan(0);expect(h.calls).toEqual([]);
    expect(await claims()).toEqual(['archive','move','delete'].includes(type)?[{action_ordinal:1,status:'confirmed'}]:[]);expect(imap._enqueueFlagPush).not.toHaveBeenCalled();
  });
  it('guards local category, notification and stop as durable atomic effects',async()=>{
    const rule=await makeRule([{type:'set_category',value:'social'},{type:'notify'}],{stop:true});
    const result=await run(rule);expect(result.failedCount).toBe(0);
    expect(await claims()).toEqual([{action_ordinal:0,status:'confirmed'},{action_ordinal:1,status:'confirmed'},{action_ordinal:2,status:'confirmed'}]);
    expect((await h.pool.query('SELECT category FROM messages WHERE id=$1',[message.id])).rows[0].category).toBe('social');
  });
  it('retains a pending flag claim after uncertain dispatch and never queues a retry or later effect',async()=>{
    const rule=await makeRule([{type:'mark_read'},{type:'star'},{type:'set_category',value:'social'}]);h.uncertain=true;
    const result=await run(rule);expect(h.calls).toEqual(['\\Seen']);expect(result.identityPending).toBe(true);
    expect(await claims()).toEqual([{action_ordinal:0,status:'pending'}]);expect(imap._enqueueFlagPush).not.toHaveBeenCalled();
    // Re-running the original snapshot conflicts, it cannot silently refresh.
    await run(rule);expect(h.calls).toHaveLength(1);
  });
  it('validates missing negative refs before an ordinary true OR branch',async()=>{
    const rule=await makeRule([{type:'star'}],{logic:'OR',conditions:[{field:'subject',operator:'contains',value:'invoice'},{field:'native_label',operator:'not_has',value:randomUUID()}]});
    const result=await run(rule);expect(result.failedCount).toBe(1);expect(h.calls).toEqual([]);
  });
  it('unknown negative membership does not execute; true OR still needs a known source',async()=>{
    message._nativeLabelProof={availability:'unknown',labelIds:null};
    const negative=await makeRule([{type:'star'}]);expect((await run(negative)).unknownCount).toBe(1);
    const or=await makeRule([{type:'star'}],{logic:'OR',conditions:[{field:'subject',operator:'contains',value:'invoice'},...negative.conditions]});
    expect((await run(or)).failedCount).toBe(1);expect(h.calls).toEqual([]);
  });
  it('advances held membership through own label writes and defers prior MOVE through that chain',async()=>{
    await makeRule([{type:'move',value:'Archive'}],{priority:0});
    await makeRule([{type:'apply_native_label',value:label.id}],{priority:1});
    await makeRule([{type:'star'}],{priority:2,conditions:[{field:'native_label',operator:'has',value:label.id}]});
    await run();expect(h.calls).toEqual(['\\Flagged','move']);
    expect((await h.pool.query('SELECT metadata_version::text FROM message_entities WHERE id=$1',[message.entity_id])).rows[0].metadata_version).toBe('3');
  });
  it('uses a reservation and dispatch guard for annotated-only exact search conditions',async()=>{
    const rule=await makeRule([{type:'star'}],{conditions:[{field:'from',operator:'contains',value:'alice',semantics:'search_v1'}]});
    expect((await run(rule)).failedCount).toBe(0);expect(h.calls).toEqual(['\\Flagged']);
    expect(await claims()).toEqual([{action_ordinal:0,status:'confirmed'}]);
  });
  it('keeps ordinary independent rules available after a native conflict',async()=>{
    await makeRule([{type:'star'}],{priority:0});await updateExternally();
    await makeRule([{type:'set_category',value:'primary'}],{priority:1,conditions:[{field:'subject',operator:'contains',value:'invoice'}]});
    await run();expect(h.calls).toEqual([]);
    expect((await h.pool.query('SELECT category FROM messages WHERE id=$1',[message.id])).rows[0].category).toBe('primary');
  });
  it('allows an external edit ordered after a committed claim, but blocks the next effect',async()=>{
    const rule=await makeRule([{type:'star'},{type:'mark_read'},{type:'notify'}]);
    h.afterDispatch=updateExternally;
    const result=await run(rule);
    expect(h.calls).toEqual(['\\Flagged']);expect(result.failedCount).toBe(1);
    expect(await claims()).toEqual([{action_ordinal:0,status:'confirmed'}]);
  });
  it.each(['disable','revision','reorder','account'])('blocks %s changes while an effect waits for provider resources',async kind=>{
    const rule=await makeRule([{type:'star'},{type:'notify'}]);
    h.prepare=async()=>{
      if(kind==='account')await h.pool.query('UPDATE email_accounts SET enabled=false WHERE id=$1',[account.id]);
      else await h.pool.query(kind==='disable'?'UPDATE inbox_rules SET enabled=false WHERE id=$1':
        kind==='reorder'?'UPDATE inbox_rules SET priority=priority+1,updated_at=clock_timestamp() WHERE id=$1':
        "UPDATE inbox_rules SET updated_at=updated_at+INTERVAL '1 microsecond' WHERE id=$1",[rule.id]);
    };
    expect((await run(rule)).failedCount).toBe(1);expect(h.calls).toEqual([]);expect(await claims()).toEqual([]);
  });
  it('commits stop before source filing and does not reach a later ordinary action',async()=>{
    await makeRule([{type:'move',value:'Archive'}],{priority:0,stop:true});
    await makeRule([{type:'set_category',value:'social'}],{priority:1,conditions:[{field:'subject',operator:'contains',value:'invoice'}]});
    await run();expect(h.calls).toEqual(['move']);
    expect(await claims()).toEqual([{action_ordinal:0,status:'pending'},{action_ordinal:1,status:'confirmed'}]);
  });
  it('rejects more than 200 guarded rules before dispatching any effect',async()=>{
    for(let i=0;i<201;i++)await makeRule([{type:'star'}],{priority:i});
    await expect(run()).rejects.toThrow('at most 200');expect(h.calls).toEqual([]);expect(await claims()).toEqual([]);
  });

  it('reports a lost action-claim commit acknowledgement as pending without dispatch or replay',async()=>{
    const rule=await makeRule([{type:'star'},{type:'notify'}]);h.prepare=async()=>{h.loseCommit=true;};
    const result=await run(rule);expect(result.identityPending).toBe(true);expect(h.calls).toEqual([]);
    expect(await claims()).toEqual([{action_ordinal:0,status:'pending'}]);
    await run(rule);expect(h.calls).toEqual([]);
  });

});
