import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import express from 'express';
import { EventEmitter } from 'node:events';

vi.mock('./db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('imapflow',()=>({ImapFlow:vi.fn(()=>{throw new Error('Unexpected IMAP login');})}));
vi.mock('./aiProvider.js',()=>({getAiStatus:vi.fn(),completeText:vi.fn()}));
vi.mock('../routes/oauth.js',()=>({refreshMicrosoftToken:vi.fn(),refreshGoogleToken:vi.fn()}));
vi.mock('./encryption.js',()=>({decrypt:value=>value,encrypt:value=>value}));
vi.mock('../middleware/auth.js',()=>({requireAuth:(req,_res,next)=>{req.session={userId:'source-owner'};next();}}));
import { query, withTransaction } from './db.js';
import { isIdentityBootstrapComplete } from './archiveCoverage.js';
import { claimSearchIndexJob, enqueueSearchIndexJob, setSearchCoverageAction, settleSearchIndexJob, invalidateSearchIndexRun } from './searchIndexJobs.js';
import { createSearchIndexSourceProducer } from './searchIndexSources.js';
import { runSearchIndexBatch as runSearchIndexBatchImpl } from './searchIndexWorker.js';
import { publishSearchGeneration } from './searchIndex.js';
import { ImapManager,providerProfile } from './imapManager.js';
import searchRoutes from '../routes/search.js';
import { createSearchIndexWindowTracker,searchIndexWindowQuery } from './searchIndexWindow.js';
import { createSearchIndexLifecycle } from './searchIndexLifecycle.js';

const accountId = '11111111-1111-4111-8111-111111111111';
const messageId = '00000000-0000-4000-8000-000000000001';
const copyId = '00000000-0000-4000-8000-000000000002';
const profile = { labelStore: true };
const account = { id: accountId, imap_host: 'source-contract.example.test' };
const physicalKey = 'physical:INBOX:7:1', providerKey = 'provider:901';
const identity = { accountId, folder: 'INBOX', uid: 1, uidValidity: '7' };
const extraction = () => ({ complete: true, identity, requiredParts: ['1'], textParts: [{ part: '1', text: 'sourcequartz' }], downloadBytes: 3147, bodyBytes: 1092, structureOverrunBytes: 0, lossyDecode: false });
const source = key => ({ sourceKey: key, messageId, folder: 'INBOX', uid: '1', uidValidity: '7', sourceGeneration: '0' });

// AUTHORING ONLY. No collection or PG execution until the producer implementation
// is complete, reviewed and receives its own exact dedicated m87r focused grant.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('search source producer contract and terminal transfer', () => {
  let db,server,base,producer;
  const runSearchIndexBatch=(account,options)=>runSearchIndexBatchImpl(account,{enqueueRows:producer.enqueueRows,...options});
  const schema = `index_sources_${process.pid}`;
  const rows = async () => (await db.query('SELECT * FROM search_index_jobs ORDER BY source_key')).rows;
  const ready = () => db.query('UPDATE archive_coverage SET bootstrap_complete=true');
  const seed = async () => { for(let i=0;i<4;i++)await producer(account,{profile}); };
  const tx = async fn => {
    await db.query('BEGIN');
    try { const result = await fn(db); await db.query('COMMIT'); return result; }
    catch (error) { await db.query('ROLLBACK'); throw error; }
  };
  const terminalPhysical = async () => {
    await seed();
    const claim = await claimSearchIndexJob(accountId);
    expect(claim.source_key).toBe(physicalKey);
    await settleSearchIndexJob(claim, { status: 'unsupported', reason: 'structure-too-large', downloadBytes: 264193, structureOverrunBytes: 1 });
  };
  const copy = () => db.query(`INSERT INTO messages(id,account_id,folder,uid,date,provider_msgid)
    VALUES ($1,$2,'Label',2,now(),'901')`, [copyId, accountId]);

  beforeAll(async () => {
    db = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await db.connect(); await db.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
    query.mockImplementation((...args) => db.query(...args)); withTransaction.mockImplementation(tx);
    const app=express();app.use('/search',searchRoutes);
    await new Promise(resolve=>{server=app.listen(0,'127.0.0.1',resolve);});base=`http://127.0.0.1:${server.address().port}/search`;
  });
  afterAll(async () => { if(server)await new Promise(resolve=>server.close(resolve)); if (db) { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.end(); } });
  beforeEach(async () => {
    producer=createSearchIndexSourceProducer({isOpen:()=>true});
    await db.query(`DROP TABLE IF EXISTS search_index_jobs,search_index_accounts,search_text_chunks,search_text_generations,
      archive_coverage,background_download_debits,messages,folders,email_accounts CASCADE;
      CREATE TABLE email_accounts(id uuid PRIMARY KEY,enabled boolean DEFAULT true,user_id text);
      CREATE TABLE folders(account_id uuid REFERENCES email_accounts ON DELETE CASCADE,path text,uid_validity bigint,
        no_select boolean DEFAULT false,special_use text,PRIMARY KEY(account_id,path));
      CREATE TABLE messages(id uuid PRIMARY KEY,account_id uuid REFERENCES email_accounts ON DELETE CASCADE,
        folder text,uid bigint,date timestamptz,is_deleted boolean DEFAULT false);
      INSERT INTO email_accounts VALUES ('${accountId}',true,'source-owner');
      INSERT INTO folders VALUES ('${accountId}','INBOX',7,false,NULL),('${accountId}','Label',9,false,NULL),
        ('${accountId}','Archive',11,false,NULL);
      INSERT INTO messages VALUES ('${messageId}','${accountId}','INBOX',1,now(),false);`);
    for (const name of ['0069_gmail_archive_coverage','0072_verified_search_text','0075_search_index_jobs']) {
      await db.query(readFileSync(new URL(`../../migrations/${name}.sql`, import.meta.url),'utf8'));
    }
    await db.query(`ALTER TABLE folders ADD COLUMN name text;
      UPDATE folders SET name=path;
      ALTER TABLE email_accounts ADD COLUMN include_in_unified_inbox boolean DEFAULT true,
      ADD COLUMN name text,ADD COLUMN email_address text,ADD COLUMN color text;
      ALTER TABLE messages ADD COLUMN message_id text,ADD COLUMN subject text DEFAULT '',ADD COLUMN from_name text DEFAULT '',
        ADD COLUMN from_email text DEFAULT '',ADD COLUMN to_addresses jsonb,ADD COLUMN cc_addresses jsonb,
        ADD COLUMN reply_to jsonb,ADD COLUMN delivery_addresses jsonb,ADD COLUMN thread_id text,
        ADD COLUMN in_reply_to text,ADD COLUMN thread_references text,ADD COLUMN snippet text,
        ADD COLUMN is_read boolean DEFAULT false,ADD COLUMN is_starred boolean DEFAULT false,
        ADD COLUMN has_attachments boolean DEFAULT false,ADD COLUMN search_vector tsvector DEFAULT ''::tsvector,ADD COLUMN body_text text;`);
    await db.query("UPDATE folders SET special_use=$1 WHERE path='Archive'",['\\All']);
    await db.query("UPDATE messages SET provider_msgid='901'");
    await db.query(`INSERT INTO archive_coverage(account_id,folder,uid_validity,bootstrap_complete)
      VALUES ($1,'INBOX',7,true),($1,'Label',9,false)`, [accountId]);
  });

  it('uses actual global readiness rather than the source folder checkpoint, then retires the physical key once ready', async () => {
    expect(await isIdentityBootstrapComplete(accountId,profile)).toBe(false);
    await seed();
    expect((await rows()).map(j => [j.source_key,j.source_generation])).toEqual([[physicalKey,'0']]);
    await ready(); expect(await isIdentityBootstrapComplete(accountId,profile)).toBe(true);
    await seed();
    expect((await rows()).map(j => [j.source_key,j.source_generation])).toEqual([[providerKey,'0']]);
  });

  it('transfers terminal physical evidence in place, then makes zero fetches across restart and controls', async () => {
    await terminalPhysical(); const before = (await rows())[0];
    await ready(); await seed();
    const after = (await rows())[0];
    expect(after).toMatchObject({ source_key: providerKey, state: 'unsupported', source_generation: '0',
      unsupported_folder: 'INBOX', unsupported_uid: '1', unsupported_uid_validity: '7', unsupported_source_generation: '0',
      observed_download_bytes: '264193', structure_overrun_bytes: '1', lease_epoch: before.lease_epoch });
    expect(await rows()).toHaveLength(1);
    const fetchMessageBody = vi.fn();
    for (const action of ['resume','retry','pause','resume']) {
      await setSearchCoverageAction(accountId,action); await seed();
      await runSearchIndexBatch(account,{fetchMessageBody,profile,labelStore:true});
    }
    expect(fetchMessageBody).not.toHaveBeenCalled();
    expect((await rows())[0].state).toBe('unsupported');
  });

  it('merges terminal physical evidence into an existing provider row without retaining a duplicate', async () => {
    await terminalPhysical(); await enqueueSearchIndexJob(accountId,source(providerKey));
    await ready(); await seed();
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({ source_key: providerKey,state:'unsupported',unsupported_folder:'INBOX',
      observed_download_bytes:'264193',structure_overrun_bytes:'1',lease_token:null,lease_expires_at:null,pending_body_bytes:null });
    const fetchMessageBody=vi.fn(); await runSearchIndexBatch(account,{fetchMessageBody,profile,labelStore:true});
    expect(fetchMessageBody).not.toHaveBeenCalled();
  });

  it('leaves a running provider row and terminal physical row untouched until expiry permits the merge', async () => {
    await terminalPhysical(); await enqueueSearchIndexJob(accountId,source(providerKey));
    const claim=await claimSearchIndexJob(accountId); expect(claim.source_key).toBe(providerKey);
    await ready(); const before=await rows(); await seed(); expect(await rows()).toEqual(before);
    await db.query("UPDATE search_index_jobs SET lease_expires_at=now()-interval '1 second' WHERE source_key=$1",[providerKey]);
    await seed(); expect(await rows()).toHaveLength(1); expect((await rows())[0].state).toBe('unsupported');
    const fetchMessageBody=vi.fn(); await runSearchIndexBatch(account,{fetchMessageBody,profile,labelStore:true});
    expect(fetchMessageBody).not.toHaveBeenCalled();
  });

  it('never steals an unexpired physical claim during readiness transition, then rekeys after expiry', async () => {
    await seed();const claim=await claimSearchIndexJob(accountId);expect(claim.source_key).toBe(physicalKey);
    const before=await rows();await ready();await seed();expect(await rows()).toEqual(before);
    await db.query("UPDATE search_index_jobs SET lease_expires_at=now()-interval '1 second'");
    await seed();expect((await rows()).map(j=>j.source_key)).toEqual([providerKey]);
    const fetchMessageBody=vi.fn(async()=>extraction());
    await runSearchIndexBatch(account,{fetchMessageBody,profile,labelStore:true});
    expect(fetchMessageBody).toHaveBeenCalledTimes(1);expect((await rows())[0].state).toBe('complete');
  });

  it('retires ordinary physical work with one shared provider hydration and no pointer copy', async () => {
    await seed(); await ready(); await copy(); await seed();
    expect((await rows()).map(j=>j.source_key)).toEqual([providerKey]);
    const fetchMessageBody=vi.fn(async()=>extraction());
    await runSearchIndexBatch(account,{fetchMessageBody,profile,labelStore:true});
    expect(fetchMessageBody).toHaveBeenCalledTimes(1);
    const pointers=(await db.query('SELECT search_generation_id FROM messages ORDER BY id')).rows.map(r=>r.search_generation_id);
    expect(pointers[0]).toBeTruthy(); expect(pointers[1]).toBe(pointers[0]);
  });

  it('reverifies COMPLETE for a newly discovered copy, preserving old pointers until actual publication', async () => {
    await ready(); await seed();
    const fetchMessageBody=vi.fn(async()=>extraction());
    await runSearchIndexBatch(account,{fetchMessageBody,profile,labelStore:true});
    const old=(await db.query('SELECT search_generation_id FROM messages WHERE id=$1',[messageId])).rows[0].search_generation_id;
    await copy(); await seed();
    expect((await rows())[0]).toMatchObject({source_key:providerKey,state:'queued',attempts:0,lease_token:null});
    expect((await db.query('SELECT id,search_generation_id FROM messages ORDER BY id')).rows)
      .toEqual([{id:messageId,search_generation_id:old},{id:copyId,search_generation_id:null}]);
    await runSearchIndexBatch(account,{fetchMessageBody,profile,labelStore:true});
    expect(fetchMessageBody).toHaveBeenCalledTimes(2);
    const pointers=(await db.query('SELECT search_generation_id FROM messages ORDER BY id')).rows.map(r=>r.search_generation_id);
    expect(pointers[0]).toBeTruthy();expect(pointers[0]).not.toBe(old);expect(pointers[1]).toBe(pointers[0]);
    await seed();expect((await rows())[0].state).toBe('complete');
  });

  it('does not reverify or erase a provider terminal on representative loss; a generation bump alone re-arms it', async () => {
    await terminalPhysical(); await ready(); await seed(); await copy();
    await db.query('DELETE FROM messages WHERE id=$1',[messageId]); await seed();
    expect((await rows())[0]).toMatchObject({source_key:providerKey,state:'unsupported',message_id:copyId,
      folder:'Label',uid:'2',uid_validity:'9',unsupported_folder:'INBOX',unsupported_uid:'1',unsupported_uid_validity:'7'});
    const fetchMessageBody=vi.fn();await runSearchIndexBatch(account,{fetchMessageBody,profile,labelStore:true});
    expect(fetchMessageBody).not.toHaveBeenCalled();
    await enqueueSearchIndexJob(accountId,{sourceKey:providerKey,messageId:copyId,folder:'Label',uid:'2',uidValidity:'9',sourceGeneration:'1'});
    expect((await rows())[0]).toMatchObject({state:'queued',source_generation:'1',unsupported_reason:null});
    await seed(); // The older producer contract must not downgrade a newer row.
    expect((await rows())[0].source_generation).toBe('1');
    const rearmed=vi.fn(async()=>({...extraction(),identity:{accountId,folder:'Label',uid:2,uidValidity:'9'}}));
    await runSearchIndexBatch(account,{fetchMessageBody:rearmed,profile,labelStore:true});
    expect(rearmed).toHaveBeenCalledTimes(1);
    expect((await rows())[0]).toMatchObject({state:'complete',source_generation:'1'});
  });

  it.each([false,true])('indexes an archive residue through the real extractor and body-search route (normal copy %s)',async withNormal=>{
    await ready();
    if(withNormal)await db.query(`INSERT INTO messages(id,account_id,folder,uid,date,provider_msgid,is_archive_residue)
      VALUES ($1,$2,'Archive',5,now(),'901',true)`,[copyId,accountId]);
    else await db.query("UPDATE messages SET folder='Archive',uid=5,is_archive_residue=true");
    await seed();
    const manager=Object.create(ImapManager.prototype);manager._secondaryConnectBlocked=()=>null;
    const reads=[];const locks=[];const bytes=Buffer.from('archiveuniquequartz clue');
    const fetchMessageBody=vi.fn(async(a,uid,folder,options)=>{
      reads.push({folder,uid:String(uid),purpose:options.purpose});
      const client=Object.assign(new EventEmitter(),{
        usable:true,mailbox:{path:folder,uidValidity:BigInt(options.uidValidity)},
        getMailboxLock:async(path,opts)=>{locks.push({path,...opts});return{release(){}};},
        fetch:async function*(requested,q){
          if(q.bodyStructure)yield{uid:Number(requested),bodyStructure:{part:'1',type:'text/plain',size:bytes.length}};
          if(q.bodyParts)yield{uid:Number(requested),bodyParts:new Map(q.bodyParts.map(p=>[p.key,bytes.subarray(p.start,p.start+p.maxLength)]))};
        },
      });
      return manager.fetchMessageBody(a,uid,folder,{...options,client});
    });
    await runSearchIndexBatch(account,{fetchMessageBody,profile});
    expect(reads).toEqual([{folder:withNormal?'INBOX':'Archive',uid:withNormal?'1':'5',purpose:'search'}]);
    expect(locks).toEqual([{path:withNormal?'INBOX':'Archive',readOnly:true}]);
    const pointers=(await db.query('SELECT id,search_generation_id FROM messages ORDER BY id')).rows;
    expect(pointers.every(r=>r.search_generation_id && r.search_generation_id===pointers[0].search_generation_id)).toBe(true);
    const routeError=vi.spyOn(console,'error');
    try {
      const response=await fetch(`${base}/?${new URLSearchParams({q:'archiveuniquequartz clue',accountId})}`);
      const diagnostics=routeError.mock.calls.map(args=>args.map(value=>value instanceof Error?value.stack:String(value)).join(' ')).join('\n');
      expect(response.status,diagnostics).toBe(200);const result=await response.json();
      expect(result.messages.map(m=>m.id).sort()).toEqual(withNormal?[messageId,copyId]:[messageId]);
      expect(result.messages.some(m=>m.folder==='Archive')).toBe(true);
    } finally {routeError.mockRestore();}
  });

  it('excludes residue markers outside the actual account archive from both sources and publication targets',async()=>{
    await ready();
    await db.query("INSERT INTO folders(account_id,path,uid_validity) VALUES($1,'Other',13)",[accountId]);
    await db.query("INSERT INTO archive_coverage(account_id,folder,uid_validity,bootstrap_complete) VALUES($1,'Other',13,true)",[accountId]);
    await db.query(`INSERT INTO messages(id,account_id,folder,uid,date,provider_msgid,is_archive_residue)
      VALUES($1,$2,'Other',8,now(),'901',true)`,[copyId,accountId]);
    await seed();const fetchMessageBody=vi.fn(async()=>extraction());await runSearchIndexBatch(account,{fetchMessageBody,profile});
    expect(fetchMessageBody).toHaveBeenCalledTimes(1);
    const pointers=(await db.query('SELECT id,search_generation_id FROM messages ORDER BY id')).rows;
    expect(pointers[0].search_generation_id).toBeTruthy();expect(pointers[1]).toEqual({id:copyId,search_generation_id:null});
  });

  it('catches a >N newest burst without waiting for the independent older traversal to wrap',async()=>{
    await db.query('DELETE FROM messages');
    await db.query(`INSERT INTO messages(id,account_id,folder,uid,date)
      SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$1,'INBOX',n,
        '2026-10-01T00:00:00Z'::timestamptz-n*interval '1 second' FROM generate_series(1,100)n`,[accountId]);
    await producer(account,{profile,limit:2});await producer(account,{profile,limit:2});
    await db.query(`INSERT INTO messages(id,account_id,folder,uid,date)
      SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$1,'INBOX',n,
        '2026-10-20T00:00:00Z'::timestamptz+n*interval '1 second' FROM generate_series(101,107)n`,[accountId]);
    for(let i=0;i<8;i++)await producer(account,{profile,limit:2});
    const visited=(await rows()).map(j=>Number(j.uid));
    expect(visited.filter(uid=>uid>=101).sort((a,b)=>a-b)).toEqual([101,102,103,104,105,106,107]);
    expect(visited).not.toContain(100); // The older traversal has not wrapped.
  });

  it('preserves microseconds and NULL ordering across real bounded SQL windows',async()=>{
    await db.query('DELETE FROM messages');
    await db.query(`INSERT INTO messages(id,account_id,folder,uid,date) VALUES
      ('00000000-0000-4000-8000-000000000001',$1,'INBOX',1,'2026-10-21T12:00:00.123457Z'),
      ('00000000-0000-4000-8000-000000000002',$1,'INBOX',2,'2026-10-21T12:00:00.123456Z'),
      ('00000000-0000-4000-8000-000000000003',$1,'INBOX',3,'2026-10-21T12:00:00.123455Z'),
      ('00000000-0000-4000-8000-000000000004',$1,'INBOX',4,NULL),
      ('00000000-0000-4000-8000-000000000005',$1,'INBOX',5,NULL)`,[accountId]);
    const tracker=createSearchIndexWindowTracker(),eligibility={normalPaths:['INBOX'],archiveFolder:null};
    const firstPlan=tracker.next(accountId,2);let statement=searchIndexWindowQuery(accountId,eligibility,firstPlan);
    const first=(await db.query(statement.text,statement.values)).rows;expect(first.map(r=>r.uid)).toEqual(['1','2']);
    tracker.commit(firstPlan,first);const older=tracker.next(accountId,2);
    expect(older.after.date).toBe('2026-10-21T12:00:00.123456Z');
    statement=searchIndexWindowQuery(accountId,eligibility,older);const second=(await db.query(statement.text,statement.values)).rows;
    expect(second.map(r=>r.uid)).toEqual(['3','5']);tracker.commit(older,second);
    const newest=tracker.next(accountId,2);statement=searchIndexWindowQuery(accountId,eligibility,newest);
    tracker.commit(newest,(await db.query(statement.text,statement.values)).rows);
    statement=searchIndexWindowQuery(accountId,eligibility,tracker.next(accountId,2));
    expect((await db.query(statement.text,statement.values)).rows.map(r=>r.uid)).toEqual(['4']);
  });

  it('keeps two interleaved accounts on independent bounded cursors',async()=>{
    const other='22222222-2222-4222-8222-222222222222';
    await db.query('DELETE FROM messages');await db.query("INSERT INTO email_accounts(id,user_id) VALUES($1,'other-owner')",[other]);
    await db.query("INSERT INTO folders(account_id,path,uid_validity) VALUES($1,'INBOX',7)",[other]);
    await db.query(`INSERT INTO messages(id,account_id,folder,uid,date)
      SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
        CASE WHEN n%2=0 THEN $1::uuid ELSE $2::uuid END,'INBOX',n,'2026-10-21T00:00:00Z'::timestamptz+n*interval '1 second'
      FROM generate_series(1,8)n`,[accountId,other]);
    await producer(account,{profile,limit:2});await producer({id:other},{profile:{},limit:2});
    await producer(account,{profile,limit:2});
    let found=(await rows()).filter(j=>j.account_id===other).map(j=>Number(j.uid)).sort((a,b)=>a-b);
    expect(found).toEqual([5,7]);
    await producer({id:other},{profile:{},limit:2});
    found=(await rows()).filter(j=>j.account_id===other).map(j=>Number(j.uid)).sort((a,b)=>a-b);expect(found).toEqual([1,3,5,7]);
    expect((await rows()).filter(j=>j.account_id===accountId).map(j=>Number(j.uid)).sort((a,b)=>a-b)).toEqual([2,4,6,8]);
  });

  it('does not advance a rolled-back producer window',async()=>{
    await db.query('DELETE FROM messages');
    await db.query(`INSERT INTO messages(id,account_id,folder,uid,date)
      SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$1,'INBOX',n,
        '2026-10-21T00:00:00Z'::timestamptz+n*interval '1 second' FROM generate_series(1,4)n`,[accountId]);
    withTransaction.mockImplementationOnce(fn=>tx(async client=>{await fn(client);throw new Error('simulated producer rollback');}));
    await expect(producer(account,{profile,limit:2})).rejects.toThrow('simulated producer rollback');expect(await rows()).toEqual([]);
    await producer(account,{profile,limit:2});expect((await rows()).map(j=>Number(j.uid)).sort()).toEqual([3,4]);
  });

  it('does not advance a paused or aborted call',async()=>{
    await db.query('DELETE FROM messages');
    await db.query(`INSERT INTO messages(id,account_id,folder,uid,date)
      SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$1,'INBOX',n,
        '2026-10-21T00:00:00Z'::timestamptz+n*interval '1 second' FROM generate_series(1,4)n`,[accountId]);
    await producer(account,{profile,limit:2});await setSearchCoverageAction(accountId,'pause');
    await producer(account,{profile,limit:2});expect(await rows()).toHaveLength(2);
    await setSearchCoverageAction(accountId,'resume');await producer(account,{profile,limit:2,signal:AbortSignal.abort()});
    expect(await rows()).toHaveLength(2);await producer(account,{profile,limit:2});expect(await rows()).toHaveLength(4);
  });

  it('recovers an invalid concurrent index and explains an ordered bounded account window',async()=>{
    await db.query('DELETE FROM messages');
    const other='22222222-2222-4222-8222-222222222222';
    await db.query("INSERT INTO email_accounts(id,user_id) VALUES($1,'plan-other')",[other]);
    await db.query("INSERT INTO folders(account_id,path,uid_validity) VALUES($1,'INBOX',7)",[other]);
    await db.query(`INSERT INTO messages(id,account_id,folder,uid,date)
      SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
        CASE WHEN n%2=0 THEN $1::uuid ELSE $2::uuid END,'INBOX',n,
        '2026-10-21T00:00:00Z'::timestamptz+n*interval '1 microsecond' FROM generate_series(1,3000)n`,[accountId,other]);
    await expect(db.query('CREATE INDEX CONCURRENTLY idx_messages_account_search_source_order ON messages ((id::text::integer))')).rejects.toMatchObject({code:'22P02'});
    const validity=async()=> (await db.query(`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='idx_messages_account_search_source_order'`,[schema])).rows[0].indisvalid;
    expect(await validity()).toBe(false);
    const migration=readFileSync(new URL('../../migrations/0078_search_index_source_order.sql',import.meta.url),'utf8');
    const statements=migration.replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean);
    for(const sql of statements)await db.query(sql);expect(await validity()).toBe(true);
    for(const sql of statements)await db.query(sql);expect(await validity()).toBe(true);
    await db.query('ANALYZE messages');
    const statement=searchIndexWindowQuery(accountId,{normalPaths:['INBOX'],archiveFolder:null},{limit:2,
      after:{date:'2026-10-21T00:00:00.001500Z',id:'00000000-0000-4000-8000-000000001500'},above:null});
    const explained=(await db.query('EXPLAIN (ANALYZE,FORMAT JSON) '+statement.text,statement.values)).rows[0]['QUERY PLAN'][0];
    // Preserve the actual ordered access and timing in the focused console log;
    // this synthetic plan is separate from the parent's 120k/full-chain gate.
    console.info('search-index-source-window-plan',JSON.stringify({sql:statement.text,values:statement.values,...explained}));
    const flatten=node=>[node,...(node.Plans||[]).flatMap(flatten)];const nodes=flatten(explained.Plan);
    const ordered=nodes.filter(n=>n['Index Name']==='idx_messages_account_search_source_order');
    expect(ordered.length).toBeGreaterThan(0);expect(nodes.filter(n=>n['Relation Name']==='messages'&&n['Node Type']==='Seq Scan')).toEqual([]);
    for(const index of ordered){expect(index['Actual Rows']).toBeLessThanOrEqual(2);expect(index['Rows Removed by Filter']||0).toBeLessThanOrEqual(2);}
    expect((await db.query(statement.text,statement.values)).rows.map(r=>r.uid)).toEqual(['1498','1496']);
  });

  it('keeps a contradictory complete provider pointer, retires terminal physical evidence and logs it', async () => {
    await terminalPhysical(); await ready();
    const generation=await publishSearchGeneration({accountId,sourceKey:'["7b","provider:901","0"]',
      targets:[{id:messageId,folder:'INBOX',uid:'1',uidValidity:'7'}],extraction:extraction()});
    await enqueueSearchIndexJob(accountId,source(providerKey));const claim=await claimSearchIndexJob(accountId);
    await settleSearchIndexJob(claim,{status:'complete',generationId:generation.generationId});
    const warning=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try {await seed();expect((await rows()).map(j=>[j.source_key,j.state])).toEqual([[providerKey,'complete']]);
      expect(warning).toHaveBeenCalled();
      expect((await db.query('SELECT search_generation_id FROM messages WHERE id=$1',[messageId])).rows[0].search_generation_id).toBe(generation.generationId);
    } finally {warning.mockRestore();}
  });

  describe('targeted arrival handoff W4',()=>{
  // W4 controls are authored before the helper implementation. The factory's
  // enqueueRows is the required lifecycle-bound completion consumer.
  const handoff=(ids,options={})=>{
    expect(typeof producer.enqueueRows).toBe('function');
    return producer.enqueueRows(account,ids,{profile,...options});
  };
  const arrival=async(date='2000-01-01T00:00:00Z')=>{
    await db.query(`INSERT INTO messages(id,account_id,folder,uid,date,provider_msgid,is_archive_residue)
      VALUES($1,$2,'Archive',5,$3,'902',true)`,[copyId,accountId,date]);
  };
  it.each([['2026-10-21T00:00:00Z','2000-01-01T00:00:00Z'],['2099-01-01T00:00:00Z','2026-10-21T00:00:00Z']])
    ('targets a committed back-dated arrival below high %s without an older wrap',async(high,date)=>{
      await ready();await db.query('UPDATE messages SET date=$1',[high]);
      await producer(account,{profile,limit:1});await arrival(date);
      expect(await rows()).toHaveLength(1);
      expect(await handoff([copyId,copyId])).toMatchObject({deferred:false,reason:null});
      expect((await rows()).find(j=>j.source_key==='provider:902')).toMatchObject({message_id:copyId,state:'queued'});
    });

  it('reports post-COMMIT handoff storage failure distinctly and recovers by rescan with retry disabled',async()=>{
    await ready();await db.query("UPDATE messages SET date='2026-10-21T00:00:00Z'");
    await db.query(`INSERT INTO messages(id,account_id,folder,uid,date,provider_msgid)
      SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$1,'INBOX',n,
        '1990-01-01T00:00:00Z'::timestamptz-n*interval '1 day','old-'||n FROM generate_series(100,110)n`,[accountId]);
    await producer(account,{profile,limit:1});await producer(account,{profile,limit:1});
    await arrival('2000-01-01T00:00:00Z');
    const admission=(await db.query('SELECT * FROM messages WHERE id=$1',[copyId])).rows[0];
    withTransaction.mockImplementationOnce(async()=>{throw new Error('budget-shaped disk quota storage outage');});
    expect(await handoff([copyId])).toMatchObject({changed:0,deferred:true,reason:'search-index-handoff-failed'});
    expect((await db.query('SELECT * FROM messages WHERE id=$1',[copyId])).rows[0]).toEqual(admission);
    expect((await db.query('SELECT * FROM background_download_debits')).rows).toEqual([]);
    for(let i=0;i<3;i++)await producer(account,{profile,limit:1}); // no handoff retry
    expect((await rows()).find(j=>j.source_key==='provider:902')).toBeTruthy();
    expect((await rows()).find(j=>j.uid==='110')).toBeUndefined(); // older never wrapped
  });

  it('finds a deeply back-dated committed row after restart within the disclosed full-pass window bound',async()=>{
    await ready();await db.query("UPDATE messages SET date='2026-10-21T00:00:00Z'");
    await db.query(`INSERT INTO messages(id,account_id,folder,uid,date,provider_msgid)
      SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$1,'INBOX',n,
        '2020-01-01T00:00:00Z'::timestamptz-n*interval '1 day','old-'||n FROM generate_series(100,105)n`,[accountId]);
    await arrival();producer=createSearchIndexSourceProducer({isOpen:()=>true}); // no remembered event
    await producer(account,{profile,limit:2});
    expect((await rows()).find(j=>j.source_key==='provider:902')).toBeUndefined();
    for(let i=0;i<2*Math.ceil(8/2);i++)await producer(account,{profile,limit:2});
    expect((await rows()).find(j=>j.source_key==='provider:902')).toBeTruthy();
  });

  it.each([false,true])('defers paused discovery and rescans on resume, including restart mid-pause %s',async restart=>{
    await ready();await producer(account,{profile,limit:1});await producer(account,{profile,limit:1});
    await setSearchCoverageAction(accountId,'pause');await arrival();
    if(restart)producer=createSearchIndexSourceProducer({isOpen:()=>true});
    expect(await handoff([copyId])).toMatchObject({changed:0,deferred:true,reason:'stopped'});
    expect(await claimSearchIndexJob(accountId)).toBeNull();
    expect((await rows()).find(j=>j.source_key==='provider:902')).toBeUndefined();
    await setSearchCoverageAction(accountId,'resume');
    for(let i=0;i<4;i++)await producer(account,{profile,limit:1});
    expect((await rows()).find(j=>j.source_key==='provider:902')).toBeTruthy();
  });

  it('refuses date discovery and targeted handoff while the real lifecycle is quiescing or stopped',async()=>{
    const lifecycle=createSearchIndexLifecycle({runBatch:async()=>{},invalidateRun:async()=>{}});
    producer=createSearchIndexSourceProducer({isOpen:id=>lifecycle.isOpen(id)});
    expect(await handoff([messageId])).toMatchObject({deferred:true,reason:'stopped'});
    await lifecycle.resume(accountId);await lifecycle.quiesce();
    expect(await producer(account,{profile})).toMatchObject({deferred:true,reason:'stopped'});
    expect(await handoff([messageId])).toMatchObject({deferred:true,reason:'stopped'});
    expect(await rows()).toEqual([]);lifecycle.resumeScheduling(); // does not reopen account
    expect(await handoff([messageId])).toMatchObject({deferred:true,reason:'stopped'});
  });

  it('defers an active publication without lease theft, then requeues at committed completion for one next hydration',async()=>{
    await ready();await producer(account,{profile});
    const fetchMessageBody=vi.fn(async()=>{
      if(fetchMessageBody.mock.calls.length===1){
        await copy();const claimed=(await rows())[0];
        expect(await handoff([copyId])).toMatchObject({deferred:true,reason:'active-lease'});
        expect((await rows())[0]).toEqual(claimed);
      }
      return extraction();
    });
    await runSearchIndexBatch(account,{fetchMessageBody,profile});
    expect(fetchMessageBody).toHaveBeenCalledTimes(1);
    expect((await rows())[0]).toMatchObject({state:'queued',attempts:0,lease_token:null});
    expect((await db.query('SELECT search_generation_id FROM messages WHERE id=$1',[copyId])).rows[0].search_generation_id).toBeNull();
    await runSearchIndexBatch(account,{fetchMessageBody,profile});expect(fetchMessageBody).toHaveBeenCalledTimes(2);
    const pointers=(await db.query('SELECT search_generation_id FROM messages ORDER BY id')).rows.map(r=>r.search_generation_id);
    expect(pointers[0]).toBeTruthy();expect(pointers[1]).toBe(pointers[0]);
  });

  it('reclaims an expired lease and publishes to copies admitted since its old target snapshot',async()=>{
    await ready();await producer(account,{profile});const claim=await claimSearchIndexJob(accountId);
    await copy();await db.query("UPDATE search_index_jobs SET lease_expires_at=now()-interval '1 second'");
    const fetchMessageBody=vi.fn(async()=>extraction());await runSearchIndexBatch(account,{fetchMessageBody,profile});
    expect(fetchMessageBody).toHaveBeenCalledTimes(1);expect(BigInt((await rows())[0].lease_epoch)).toBeGreaterThan(BigInt(claim.lease_epoch));
    const pointers=(await db.query('SELECT search_generation_id FROM messages ORDER BY id')).rows.map(r=>r.search_generation_id);
    expect(pointers[0]).toBeTruthy();expect(pointers[1]).toBe(pointers[0]);
  });

  it.each(['foreign','deleted','missing','ineligible'])('reports a %s actual row id without deferred repair',async kind=>{
    if(kind==='foreign'){
      const other='22222222-2222-4222-8222-222222222222';
      await db.query("INSERT INTO email_accounts(id,user_id) VALUES($1,'other-owner')",[other]);
      await db.query("INSERT INTO folders(account_id,path,uid_validity) VALUES($1,'INBOX',7)",[other]);
      await db.query('UPDATE messages SET account_id=$1',[other]);
    } else if(kind==='deleted')await db.query('UPDATE messages SET is_deleted=true');
    else if(kind==='missing')await db.query('DELETE FROM messages');
    else await db.query('UPDATE messages SET is_archive_residue=true');
    expect(await handoff([messageId])).toMatchObject({changed:0,deferred:false,reason:null,rejected:kind==='ineligible'?0:1});
    expect(await rows()).toEqual([]);
  });

  it('rejects an uncommitted id without resetting the cursor, then finds it on the next older window after COMMIT',async()=>{
    await ready();await db.query("UPDATE messages SET date='2030-01-01T00:00:00Z'");
    await producer(account,{profile,limit:1});
    const writer=new pg.Client({connectionString:process.env.MAILFLOW_TEST_DATABASE_URL});await writer.connect();let committed=false;
    try{
      await writer.query(`SET search_path TO ${schema}; BEGIN`);
      await writer.query(`INSERT INTO messages(id,account_id,folder,uid,date,provider_msgid) VALUES($1,$2,'Label',2,'2000-01-01T00:00:00Z','902')`,[copyId,accountId]);
      expect(await handoff([copyId])).toMatchObject({changed:0,deferred:false,reason:null,rejected:1});
      expect((await rows()).find(j=>j.source_key==='provider:902')).toBeUndefined();
      await writer.query('COMMIT');committed=true;
      await producer(account,{profile,limit:1});
      expect((await rows()).find(j=>j.source_key==='provider:902')).toBeTruthy();
    } finally{if(!committed)await writer.query('ROLLBACK');await writer.end();}
  });

  it('rejects an oversized direct id handoff instead of silently truncating it',async()=>{
    expect(typeof producer.enqueueRows).toBe('function');
    await expect(producer.enqueueRows(account,Array(51).fill(messageId),{profile})).rejects.toThrow('50');
    expect(await rows()).toEqual([]);
  });


  it('advances past a newer-contract group without resetting the date window or downgrading its job',async()=>{
    await ready();await db.query("UPDATE messages SET date='2030-01-01T00:00:00Z'");
    await enqueueSearchIndexJob(accountId,{...source(providerKey),sourceGeneration:'1'});
    const published=await publishSearchGeneration({accountId,sourceKey:'["7b","provider:901","1"]',
      targets:[{id:messageId,folder:'INBOX',uid:'1',uidValidity:'7'}],extraction:extraction()});
    await settleSearchIndexJob(await claimSearchIndexJob(accountId),{status:'complete',generationId:published.generationId});
    const before=(await rows())[0];await arrival();
    expect(await producer(account,{profile,limit:1})).toMatchObject({reason:'newer-contract'});
    await producer(account,{profile,limit:1});
    expect((await rows()).find(j=>j.source_key===providerKey)).toEqual(before);
    expect((await rows()).find(j=>j.source_key==='provider:902')).toBeTruthy();
  });

  it('advances past a zero-row transfer refusal without repeating the first metadata window',async()=>{
    await ready();await db.query("UPDATE messages SET date='2030-01-01T00:00:00Z'");
    await enqueueSearchIndexJob(accountId,source(physicalKey));await arrival();
    // A real PG BEFORE trigger supplies a zero-row RETURNING response, exactly
    // the executor's fence-refusal branch, without changing its production SQL.
    await db.query(`CREATE FUNCTION refuse_search_rekey() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.source_key LIKE 'physical:%' AND NEW.source_key LIKE 'provider:%' THEN RETURN NULL; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER refuse_search_rekey BEFORE UPDATE ON search_index_jobs FOR EACH ROW EXECUTE FUNCTION refuse_search_rekey()`);
    expect(await producer(account,{profile,limit:1})).toMatchObject({reason:'stale-source'});
    await producer(account,{profile,limit:1});
    expect((await rows()).find(j=>j.source_key===physicalKey)).toBeTruthy();
    expect((await rows()).find(j=>j.source_key==='provider:902')).toBeTruthy();
  });

  it('advances active-lease date windows without theft while leaving membership recovery to completion or reclaim',async()=>{
    await ready();await db.query("UPDATE messages SET date='2030-01-01T00:00:00Z'");
    await enqueueSearchIndexJob(accountId,source(providerKey));const claim=await claimSearchIndexJob(accountId);
    await copy();await db.query("UPDATE messages SET date='2020-01-01T00:00:00Z' WHERE id=$1",[copyId]);
    const nextId='00000000-0000-4000-8000-000000000003';
    await db.query(`INSERT INTO messages(id,account_id,folder,uid,date,provider_msgid)
      VALUES($1,$2,'Label',3,'2010-01-01T00:00:00Z','902')`,[nextId,accountId]);
    expect(await producer(account,{profile,limit:1})).toMatchObject({reason:'active-lease'});
    for(let i=0;i<3;i++)await producer(account,{profile,limit:1});
    expect((await rows()).find(j=>j.source_key===providerKey)).toEqual(claim);
    expect((await rows()).find(j=>j.source_key==='provider:902')).toBeTruthy();
  });

  it('ignores routine Spam and Trash arrivals without restarting the unfinished older traversal',async()=>{
    const scopedProfile={...profile,skipFolderNames:['spam','trash']};await ready();
    await db.query("UPDATE messages SET date='2030-01-01T00:00:00Z'");await arrival();
    await db.query(`INSERT INTO folders(account_id,path,uid_validity) VALUES($1,'Spam',8),($1,'Trash',9)`,[accountId]);
    const ignored=['00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004'];
    await db.query(`INSERT INTO messages(id,account_id,folder,uid,date,provider_msgid) VALUES
      ($1,$3,'Spam',1,'2099-01-01T00:00:00Z','903'),($2,$3,'Trash',2,'2099-01-01T00:00:00Z','904')`,[...ignored,accountId]);
    await producer(account,{profile:scopedProfile,limit:1});
    for(let i=0;i<3;i++)expect(await handoff(ignored,{profile:scopedProfile})).toMatchObject({changed:0,deferred:false,reason:null,rejected:0});
    await producer(account,{profile:scopedProfile,limit:1});
    expect((await rows()).find(j=>j.source_key==='provider:902')).toBeTruthy();
    expect((await rows()).some(j=>j.source_key==='provider:903'||j.source_key==='provider:904')).toBe(false);
  });

  it.each([false,true])('retries an actual busy committed row after settle, eligible %s, without an older wrap or rescan',async eligible=>{
    const managed={...account,imap_host:'imap.gmail.com'},managedProfile=providerProfile(managed);
    let release;const pending=new Promise(done=>{release=done;});
    const manager=Object.create(ImapManager.prototype);
    manager._searchIndex=createSearchIndexLifecycle({runBatch:async()=>pending,invalidateRun:invalidateSearchIndexRun});
    producer=createSearchIndexSourceProducer({isOpen:id=>manager._searchIndex.isOpen(id)});manager._searchIndexSources=producer;
    await manager._searchIndex.resume(accountId);await ready();await db.query("UPDATE messages SET date='2099-01-01T00:00:00Z'");
    await producer(managed,{profile:managedProfile,limit:1});
    if(eligible)await arrival();
    else{
      await db.query("INSERT INTO folders(account_id,path,uid_validity) VALUES($1,'[Gmail]/Starred',8)",[accountId]);
      await db.query(`INSERT INTO messages(id,account_id,folder,uid,date,provider_msgid)
        VALUES($1,$2,'[Gmail]/Starred',5,'2000-01-01T00:00:00Z','902')`,[copyId,accountId]);
    }
    const rescan=vi.spyOn(producer,'rescan'),enqueue=vi.spyOn(producer,'enqueueRows'),active=manager._searchIndex.run(managed);
    try{
      expect(await manager.enqueueCommittedSearchRows(managed,[copyId])).toMatchObject({deferred:true,reason:'active-batch'});
      expect(enqueue).not.toHaveBeenCalled();expect(rescan).not.toHaveBeenCalled();
      release();await active;await vi.waitFor(()=>expect(enqueue).toHaveBeenCalledTimes(1));
      await manager._searchIndex.settled(accountId);await Promise.resolve();
      const result=await enqueue.mock.results[0].value;
      expect(result).toMatchObject({deferred:false,reason:null,rejected:0,changed:eligible?1:0});
      expect(Boolean((await rows()).find(j=>j.source_key==='provider:902'))).toBe(eligible);
      expect(rescan).not.toHaveBeenCalled();
    }finally{release();await Promise.allSettled([active,manager._searchIndex.settled(accountId)]);rescan.mockRestore();enqueue.mockRestore();}
  });

  it('uses the real disconnect epoch after a rolled-back restore to rescan rows passed by the older cursor',async()=>{
    const lifecycle=createSearchIndexLifecycle({runBatch:async()=>{},invalidateRun:invalidateSearchIndexRun});
    producer=createSearchIndexSourceProducer({isOpen:id=>lifecycle.isOpen(id)});await lifecycle.resume(accountId);
    await ready();await db.query("UPDATE messages SET date='2026-10-21T00:00:00Z'");
    await db.query(`INSERT INTO messages(id,account_id,folder,uid,date,provider_msgid)
      SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$1,'INBOX',n,
        '1990-01-01T00:00:00Z'::timestamptz-n*interval '1 day','old-'||n FROM generate_series(100,110)n`,[accountId]);
    await producer(account,{profile,limit:1});await producer(account,{profile,limit:1});await arrival();
    const before=(await db.query('SELECT run_epoch FROM search_index_accounts')).rows[0].run_epoch;
    await lifecycle.quiesce();
    await db.query('BEGIN; UPDATE search_index_accounts SET run_epoch=9007199254740993; ROLLBACK');
    const after=(await db.query('SELECT run_epoch FROM search_index_accounts')).rows[0].run_epoch;
    expect(BigInt(after)).toBe(BigInt(before)+1n);
    lifecycle.resumeScheduling();await lifecycle.resume(accountId);
    for(let i=0;i<3;i++)await producer(account,{profile,limit:1});
    expect((await rows()).find(j=>j.source_key==='provider:902')).toBeTruthy();
    expect((await rows()).find(j=>j.uid==='110')).toBeUndefined();
  });

  });

});
