// Independent acceptance: real runtime/identity/decision SQL and actual engine methods.
// Only provider transports are fake. No IMAP or SMTP connection leaves this process.
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ pool: null }));
vi.mock('./db.js', () => ({
  pool: { connect: (...args) => h.pool.connect(...args) }, query: (...args) => h.pool.query(...args),
  withTransaction: async fn => {
    const tx = await h.pool.connect();
    try { await tx.query('BEGIN'); const result = await fn(tx); await tx.query('COMMIT');
      if (h.loseClaimCommit && result?.claimed) { h.loseClaimCommit=false; throw Object.assign(new Error('lost claim COMMIT acknowledgement'),{code:'commit_outcome_unknown'}); }
      return result; }
    catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
  },
}));
vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./encryption.js', async original => ({ ...await original(), decrypt: value => value }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: async () => ({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null }), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: async () => ({ allowPrivateHosts: true, allowInsecureTls: true }) }));
vi.mock('./mailAccess.js', () => ({ getAccountAddresses: vi.fn(async () => []) }));
vi.mock('./smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
import { ImapFlow } from 'imapflow';
import { createAccountSmtpTransport } from './smtpTransport.js';
import { runMigrations } from './migrations.js';
import { ImapManager, evictPool } from './imapManager.js';
import { applyInboxRules } from './inboxRules.js';
import { forwardRuleMessage } from './ruleForwarder.js';
import { readMailboxIdentity, observeMailboxIdentity, writeObservedMessage, withAccountIdentity } from './messageIdentity.js';
import { createDefinition } from './nativeLabelDefinitions.js';
import { captureRuleMembershipSource, captureRuleMembershipSourceInTransaction, mutateMemberships } from './nativeLabelMemberships.js';
const ADMIN_URL = process.env.MAILFLOW_TEST_DATABASE_URL;
describe.skipIf(!ADMIN_URL)('independent actual provider dispatch boundary', () => {
  const database = `mailflow_boundary_${randomBytes(5).toString('hex')}`;
  let admin, account, user, message, label, manager, client, transport, prep, effect, events;
  const source = row => Object.fromEntries(['id','account_id','entity_id','storage_generation','folder','uid_validity','uid'].map(key => [key,row[key]]));
  const capture = () => captureRuleMembershipSource(user, source(message));
  const editMembership = async () => {
    const proof = await capture();
    await mutateMemberships(user, { accountId: account.id, storageGeneration: account.storage_generation, mutationId: randomUUID(),
      targets: [{ entityId: message.entity_id, expectedMetadataVersion: proof.expectedMetadataVersion }], addLabelIds: [label.id], removeLabelIds: [] });
  };
  const reenter = () => withAccountIdentity(account, async tx => { await tx.query('SELECT 1'); });
  beforeAll(async () => {
    vi.stubEnv('ENCRYPTION_KEY', 'ab'.repeat(32));
    admin = new pg.Client({ connectionString: ADMIN_URL }); await admin.connect(); await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(ADMIN_URL); url.pathname = `/${database}`;
    h.pool = new pg.Pool({ connectionString: url.toString(), max: 10, statement_timeout: 1800 });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runMigrations();
  }, 60_000);
  afterAll(async () => { await h.pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${database}`); await admin?.end(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  afterEach(() => { if (account) evictPool(account.id); });
  beforeEach(async () => {
    await h.pool.query('TRUNCATE users CASCADE'); prep = null; effect = null; events = []; h.loseClaimCommit=false;
    user = (await h.pool.query("INSERT INTO users(username) VALUES ('boundary-owner') RETURNING id")).rows[0].id;
    account = (await h.pool.query(`INSERT INTO email_accounts(user_id,name,email_address,imap_host,auth_user,auth_pass,folder_mappings)
      VALUES ($1,'Boundary','me@example.test','imap.example.test','synthetic','synthetic',$2::jsonb) RETURNING *`, [user,JSON.stringify({archive:'Archive',trash:'Trash'})])).rows[0];
    await h.pool.query("INSERT INTO folders(account_id,path,name,no_select) VALUES ($1,'Archive','Archive',false),($1,'Trash','Trash',false)", [account.id]);
    const context = await observeMailboxIdentity(await readMailboxIdentity(account,'INBOX'), { mailbox: {path:'INBOX',uidValidity:10n},capabilities:new Set() });
    message = (await writeObservedMessage(context,{uid:1}, tx => tx.query(`INSERT INTO messages(account_id,folder,uid,message_id,subject,from_email,is_read,has_attachments)
      VALUES ($1,'INBOX',1,'<boundary@test>','Invoice','alice@test',false,false) RETURNING *`,[account.id]), {
      captureRuleSource: (tx, tuple) => captureRuleMembershipSourceInTransaction(tx,user,tuple),
    })).rows[0];
    label = (await createDefinition(user,{accountId:account.id,mutationId:randomUUID(),name:'Work'})).result.label;
    const dispatch = async kind => { events.push(kind); await reenter(); await effect?.(kind); return true; };
    client = Object.assign(new EventEmitter(), {
      usable:true, mailbox:null, capabilities:new Set(['MOVE','UIDPLUS']), connect:vi.fn(async()=>{}),close:vi.fn(),logout:vi.fn(async()=>{}),noop:vi.fn(async()=>true),
      getMailboxLock:vi.fn(async folder => { events.push('mailbox-preparation'); await prep?.('mailbox'); client.mailbox={path:folder,uidValidity:10n}; return { release:vi.fn(()=>events.push('mailbox-release')) }; }),
      status:vi.fn(async()=>{events.push('destination-preparation'); await prep?.('destination'); return {uidNext:9,uidValidity:20n};}),
      messageFlagsAdd:vi.fn(async()=>dispatch('STORE')),messageFlagsRemove:vi.fn(async()=>dispatch('STORE')),
      messageMove:vi.fn(async()=>{await dispatch('MOVE');return {uidMap:new Map([[1,9]]),uidValidity:20n};}),
    });
    ImapFlow.mockImplementation(function(){return client;});
    transport={sendMail:vi.fn(async()=>dispatch('SMTP'))};
    createAccountSmtpTransport.mockImplementation(async()=>{ events.push('smtp-preparation');await prep?.('smtp');return {account,transport}; });
    manager=Object.assign(Object.create(ImapManager.prototype),{
      _flagOpChains:new Map(),connections:new Map(),_enqueueFlagPush:vi.fn(),_guardMoveUid:vi.fn(),_unguardMoveUid:vi.fn(),broadcast:vi.fn(),syncFolderOnDemand:vi.fn(async()=>{}),
      fetchMessageBody:vi.fn(async()=>{events.push('body-preparation');await prep?.('body');return {text:'Body',html:null,attachments:[{part:'2',filename:'one.txt',type:'text/plain',size:1}]};}),
      fetchMultipleAttachments:vi.fn(async()=>{events.push('attachment-preparation');await prep?.('attachment');return new Map([['2',Buffer.from('x')]]);}),
    });
  });
  const makeRule = async (actions, options={}) => (await h.pool.query(`INSERT INTO inbox_rules(user_id,account_id,storage_generation,name,conditions,actions,condition_logic,stop_processing,priority)
    VALUES ($1,$2,$3,'Boundary',$4::jsonb,$5::jsonb,'AND',$6,$7) RETURNING *,updated_at::text AS rule_revision`,
    [user,account.id,account.storage_generation,JSON.stringify(options.conditions||[{field:'native_label',operator:'not_has',value:label.id}]),JSON.stringify(actions),!!options.stop,options.priority||0])).rows[0];
  const run = rule => applyInboxRules([{...message,fromEmail:message.from_email}],account,manager,rule?{rule}:{});
  const claims = async () => (await h.pool.query('SELECT action_ordinal,status FROM inbox_rule_action_attempts ORDER BY action_ordinal')).rows;
  const noDispatch = () => { expect(client.messageFlagsAdd).not.toHaveBeenCalled();expect(client.messageMove).not.toHaveBeenCalled();expect(transport.sendMail).not.toHaveBeenCalled(); };

  it.each(['mark_read','star','archive','move','delete'])('%s rejects an edit during real resource preparation',async type=>{
    const rule=await makeRule([{type,...(type==='move'?{value:'Archive'}:{})}]);
    prep=async stage=>{if(stage==='mailbox'){prep=null;await editMembership();}};
    const result=await run(rule); expect(result.failedCount).toBe(1); noDispatch(); expect(await claims()).toEqual([]);
    expect(manager._enqueueFlagPush).not.toHaveBeenCalled(); expect(events).toContain('mailbox-preparation');
  });
  it('MOVE guards after destination preparation and releases account locks before guard/provider reentry',async()=>{
    const rule=await makeRule([{type:'move',value:'Archive'}]);
    prep=async stage=>{if(stage==='destination'){await reenter();await editMembership();}};
    expect((await run(rule)).failedCount).toBe(1);noDispatch();expect(events).toContain('destination-preparation');
    expect((await h.pool.query('SELECT state FROM mail_identity_operations')).rows).toEqual([{state:'failed'}]);
  });
  it.each(['body','attachment','smtp'])('SMTP guard is later than %s preparation',async stage=>{
    const rule=await makeRule([{type:'forward',value:'recipient@example.test'},{type:'star'}]);
    prep=async current=>{if(current===stage){await reenter();await editMembership();}};
    expect((await run(rule)).failedCount).toBe(1);noDispatch();expect(await claims()).toEqual([]);
    expect(events).toContain(`${stage}-preparation`);expect(events).toContain('smtp-preparation');
  });
  it.each(['mark_read','move','forward'])('%s dispatch reenters real account locking after claim without deadlock',async type=>{
    const rule=await makeRule([{type,...(type==='move'?{value:'Archive'}:type==='forward'?{value:'recipient@example.test'}:{})}]);
    expect((await run(rule)).failedCount).toBe(0);expect(await claims()).toEqual([{action_ordinal:0,status:'confirmed'}]);
    expect(events.filter(event=>['STORE','MOVE','SMTP'].includes(event))).toHaveLength(1);
  });
  it.each(['mark_read','star'])('%s loses acknowledgement once, retains pending and never queues ordinary retry',async type=>{
    const rule=await makeRule([{type},{type:'set_category',value:'social'},{type:'notify'}],{stop:true});
    effect=async()=>{throw new Error('lost acknowledgement');};
    const result=await run(rule);expect(result.identityPending).toBe(true);expect(client.messageFlagsAdd).toHaveBeenCalledTimes(1);expect(manager._enqueueFlagPush).not.toHaveBeenCalled();
    expect(await claims()).toEqual([{action_ordinal:0,status:'pending'},{action_ordinal:3,status:'confirmed'}]);
    expect((await h.pool.query('SELECT category FROM messages WHERE id=$1',[message.id])).rows[0].category).toBe(null);
    await run(rule);expect(client.messageFlagsAdd).toHaveBeenCalledTimes(1);
  });
  it('a false STORE response is one pending attempt and never changes the local read flag',async()=>{
    const rule=await makeRule([{type:'mark_read'}]);client.messageFlagsAdd.mockResolvedValue(false);
    expect((await run(rule)).identityPending).toBe(true);expect(client.messageFlagsAdd).toHaveBeenCalledTimes(1);expect(manager._enqueueFlagPush).not.toHaveBeenCalled();
    expect(await claims()).toEqual([{action_ordinal:0,status:'pending'}]);
    expect((await h.pool.query('SELECT is_read FROM messages WHERE id=$1',[message.id])).rows[0].is_read).toBe(false);
  });
  it.each(['star','move','forward'])('%s never dispatches when its committed claim acknowledgement is lost',async type=>{
    const rule=await makeRule([{type,...(type==='move'?{value:'Archive'}:type==='forward'?{value:'recipient@example.test'}:{})}]);
    h.loseClaimCommit=true;
    expect((await run(rule)).identityPending).toBe(true);noDispatch();expect(await claims()).toEqual([{action_ordinal:0,status:'pending'}]);
    await run(rule);noDispatch();expect(await claims()).toEqual([{action_ordinal:0,status:'pending'}]);
    if(type==='move')expect((await h.pool.query('SELECT state FROM mail_identity_operations')).rows).toEqual([{state:'failed'}]);
  });
  it('uncertain SMTP preserves its tombstone and a replay cannot send again',async()=>{
    const rule=await makeRule([{type:'forward',value:'recipient@example.test'}]);effect=async()=>{throw new Error('lost SMTP acknowledgement');};
    expect((await run(rule)).identityPending).toBe(true);expect(await claims()).toEqual([{action_ordinal:0,status:'pending'}]);
    await expect(forwardRuleMessage({ruleId:rule.id,message,account,imapManager:manager,recipient:'recipient@example.test',beforeDispatch:vi.fn()})).rejects.toThrow('Forward delivery pending');
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    expect((await h.pool.query('SELECT status FROM inbox_rule_forwards')).rows).toEqual([{status:'pending'}]);
  });
  it.each(['cache_uuid','uid_reuse','generation','epoch'])('original source survives a %s change during resource wait without UID retargeting',async change=>{
    const rule=await makeRule([{type:'star'}]);
    prep=async()=>{prep=null;if(change==='cache_uuid')await h.pool.query('UPDATE messages SET id=$1 WHERE id=$2',[randomUUID(),message.id]);
      else if(change==='uid_reuse'){
        await h.pool.query('DELETE FROM messages WHERE id=$1',[message.id]);
        const context=await readMailboxIdentity(account,'INBOX');
        await writeObservedMessage(context,{uid:1},tx=>tx.query("INSERT INTO messages(account_id,folder,uid,subject) VALUES ($1,'INBOX',1,'Replacement') RETURNING *",[account.id]));
      }
      else if(change==='generation')await h.pool.query('UPDATE email_accounts SET storage_generation=$1 WHERE id=$2',[randomUUID(),account.id]);
      else await observeMailboxIdentity(await readMailboxIdentity(account,'INBOX'),{mailbox:{path:'INBOX',uidValidity:11n},capabilities:new Set()});};
    expect((await run(rule)).failedCount).toBe(1);noDispatch();expect(await claims()).toEqual([]);
  });
  it('annotated-only rule receives the same late provider guard',async()=>{
    const rule=await makeRule([{type:'star'}],{conditions:[{field:'subject',operator:'contains',value:'Invoice',semantics:'search_v1'}]});
    prep=async()=>{prep=null;await editMembership();};expect((await run(rule)).failedCount).toBe(1);noDispatch();expect(await claims()).toEqual([]);
  });
  it.each(['set_category','notify'])('local %s guard rejects a change after reservation and before atomic bookkeeping',async type=>{
    const rule=await makeRule([{type,...(type==='set_category'?{value:'social'}:{})}]);
    manager.broadcast=vi.fn(editMembership);
    expect((await run(rule)).failedCount).toBe(1);expect(await claims()).toEqual([]);noDispatch();
    expect((await h.pool.query('SELECT category FROM messages WHERE id=$1',[message.id])).rows[0].category).toBe(null);
  });
  it('a failed stop guard does not stop an independent later ordinary rule',async()=>{
    await makeRule([{type:'notify'}],{stop:true,priority:0});
    await makeRule([{type:'set_category',value:'social'}],{priority:1,conditions:[{field:'subject',operator:'contains',value:'Invoice'}]});
    manager.broadcast=vi.fn(editMembership);
    await run();expect(await claims()).toEqual([]);noDispatch();
    expect((await h.pool.query('SELECT category FROM messages WHERE id=$1',[message.id])).rows[0].category).toBe('social');
  });
  it('successful local category, notify and stop commit durable outcomes without provider calls',async()=>{
    const rule=await makeRule([{type:'set_category',value:'social'},{type:'notify'}],{stop:true});
    expect((await run(rule)).failedCount).toBe(0);noDispatch();
    expect(await claims()).toEqual([{action_ordinal:0,status:'confirmed'},{action_ordinal:1,status:'confirmed'},{action_ordinal:2,status:'confirmed'}]);
    expect((await h.pool.query('SELECT category FROM messages WHERE id=$1',[message.id])).rows[0].category).toBe('social');
  });
  it('a post-claim edit does not retroactively cancel SMTP, but blocks the later STORE',async()=>{
    const rule=await makeRule([{type:'forward',value:'recipient@example.test'},{type:'star'}]);
    effect=async kind=>{if(kind==='SMTP')await editMembership();};
    expect((await run(rule)).failedCount).toBe(1);expect(transport.sendMail).toHaveBeenCalledTimes(1);expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    expect(await claims()).toEqual([{action_ordinal:0,status:'confirmed'}]);
  });
  it('an external edit after a confirmed own receipt still blocks an earlier deferred MOVE',async()=>{
    await makeRule([{type:'move',value:'Archive'}],{priority:0});
    await makeRule([{type:'apply_native_label',value:label.id},{type:'star'}],{priority:1});
    effect=async kind=>{if(kind==='STORE')await editMembership();};
    await run();expect(client.messageFlagsAdd).toHaveBeenCalledTimes(1);expect(client.messageMove).not.toHaveBeenCalled();
    expect(await claims()).toEqual([{action_ordinal:1,status:'confirmed'}]);
  });
  it('negative control: ordinary rules remain independent of membership edits during preparation',async()=>{
    const rule=await makeRule([{type:'move',value:'Archive'}],{conditions:[{field:'subject',operator:'contains',value:'Invoice'}]});
    prep=async stage=>{if(stage==='destination'){prep=null;await editMembership();}};
    expect((await run(rule)).failedCount).toBe(0);expect(client.messageMove).toHaveBeenCalledTimes(1);expect(await claims()).toEqual([]);
  });
  it('an earlier deferred MOVE uses later confirmed own receipt lineage',async()=>{
    await makeRule([{type:'move',value:'Archive'}],{priority:0});
    await makeRule([{type:'apply_native_label',value:label.id},{type:'star'}],{priority:1});
    await run();expect(events.filter(event=>['STORE','MOVE'].includes(event))).toEqual(['STORE','MOVE']);
    expect(await claims()).toEqual([{action_ordinal:0,status:'confirmed'},{action_ordinal:1,status:'confirmed'}]);
  });
  it('unknown MOVE cannot bypass its barrier through a later ordinary destination flush',async()=>{
    await makeRule([{type:'move',value:'Archive'}],{priority:0});
    await makeRule([{type:'star'}],{priority:1});
    await makeRule([{type:'move',value:'Other'}],{priority:2,conditions:[{field:'subject',operator:'contains',value:'Invoice'}]});
    effect=async kind=>{if(kind==='MOVE')throw new Error('lost MOVE acknowledgement');};
    const result=await run();expect(result.identityPending).toBe(true);expect(client.messageMove).toHaveBeenCalledTimes(1);expect(client.messageFlagsAdd).toHaveBeenCalledTimes(1);
    expect((await claims()).filter(claim=>claim.status==='pending')).toHaveLength(1);
  });
});
