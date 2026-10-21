import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import pg from 'pg';

vi.mock('./db.js',()=>({withTransaction:vi.fn()}));
import { withTransaction } from './db.js';
import { claimSearchIndexJob,enqueueSearchIndexJob,guardSearchIndexJob,invalidateSearchIndexRun,
  pruneSearchIndexLocators,settleSearchIndexJob } from './searchIndexJobs.js';

const account='11111111-1111-4111-8111-111111111111';
const message=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const source=n=>({sourceKey:`physical:INBOX:7:${n}`,messageId:message(n),folder:'INBOX',uid:String(n),uidValidity:'7',sourceGeneration:'0'});

describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('search locator cleanup fences and quoted-work progress',()=>{
  let db,peer;
  const schema=`index_locators_${process.pid}`;
  const row=async()=> (await db.query('SELECT * FROM search_index_jobs ORDER BY source_key')).rows[0];
  const tx=async fn=>{
    await db.query('BEGIN');
    try{const result=await fn(db);await db.query('COMMIT');return result;}
    catch(error){await db.query('ROLLBACK');throw error;}
  };
  beforeAll(async()=>{
    db=new pg.Client({connectionString:process.env.MAILFLOW_TEST_DATABASE_URL});
    peer=new pg.Client({connectionString:process.env.MAILFLOW_TEST_DATABASE_URL});
    await db.connect();await peer.connect();
    await db.query(`CREATE SCHEMA ${schema};SET search_path TO ${schema}`);
    await peer.query(`SET search_path TO ${schema}`);
    withTransaction.mockImplementation(tx);
  });
  afterAll(async()=>{
    if(peer)await peer.end();
    if(db){await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await db.end();}
  });
  beforeEach(async()=>{
    await db.query(`DROP TABLE IF EXISTS search_index_jobs,search_index_accounts,messages,folders,email_accounts CASCADE;
      CREATE TABLE email_accounts(id uuid PRIMARY KEY,enabled boolean DEFAULT true,user_id text);
      CREATE TABLE folders(account_id uuid REFERENCES email_accounts ON DELETE CASCADE,path text,uid_validity bigint,PRIMARY KEY(account_id,path));
      CREATE TABLE messages(id uuid PRIMARY KEY,account_id uuid REFERENCES email_accounts ON DELETE CASCADE,folder text,uid bigint,date timestamptz,is_deleted boolean DEFAULT false);
      INSERT INTO email_accounts VALUES('${account}',true,'locator-owner');
      INSERT INTO folders VALUES('${account}','INBOX',7);
      INSERT INTO messages VALUES('${message(1)}','${account}','INBOX',1,now()-interval '1 day',false),
        ('${message(2)}','${account}','INBOX',2,now(),false);`);
    await db.query(readFileSync(new URL('../../migrations/0075_search_index_jobs.sql',import.meta.url),'utf8'));
    await enqueueSearchIndexJob(account,source(1));
  });

  it('claims a persisted whole-body quote before fresh structure work without bypassing deferAt',async()=>{
    const claim=await claimSearchIndexJob(account);
    await settleSearchIndexJob(claim,{status:'deferred',deferAt:Date.now()+3600000,bodyBytes:17055744,
      identity:{accountId:account,folder:'INBOX',uid:1,uidValidity:'7'}});
    await enqueueSearchIndexJob(account,source(2));
    const fresh=await claimSearchIndexJob(account);expect(fresh.source_key).toBe(source(2).sourceKey);
    await settleSearchIndexJob(fresh,{status:'complete',generationId:'33333333-3333-4333-8333-333333333333'});
    expect(await claimSearchIndexJob(account)).toBeNull();
    await db.query('UPDATE search_index_jobs SET defer_at=now() WHERE source_key=$1',[source(1).sourceKey]);
    // Fresh higher-priority work must not repeatedly consume the fresh minute.
    await db.query("UPDATE search_index_jobs SET state='queued',priority_at=now() WHERE source_key=$1",[source(2).sourceKey]);
    const quoted=await claimSearchIndexJob(account);expect(quoted.source_key).toBe(source(1).sourceKey);
    expect(quoted.pending_body_bytes).toBe('17055744');
  });

  it('waits behind a real publication guard and never deletes its unexpired orphan claim',async()=>{
    const claim=await claimSearchIndexJob(account);await db.query('DELETE FROM messages WHERE id=$1',[message(1)]);
    const before=await row();
    await peer.query('BEGIN');expect(await guardSearchIndexJob(peer,claim)).toBe(true);
    const cleaning=pruneSearchIndexLocators(account);
    const observed=cleaning.then(value=>({value}),error=>({error}));
    try{
      await expect.poll(async()=> (await peer.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[db.processID])).rows[0].blocked,
        {timeout:1000,interval:10}).toBe(true);
      await peer.query('COMMIT');expect(await observed).toEqual({value:0});expect(await row()).toEqual(before);
    }finally{await peer.query('ROLLBACK');await observed;}
  });

  it('fences a pre-disconnect cleanup when the run epoch changed even if its orphan is queued',async()=>{
    const old=await claimSearchIndexJob(account);await db.query('DELETE FROM messages WHERE id=$1',[message(1)]);
    await invalidateSearchIndexRun(account);const before=await row();
    expect(await pruneSearchIndexLocators(account,{sourceKey:old.source_key,leaseEpoch:old.lease_epoch,runEpoch:old.run_epoch})).toBe(0);
    expect(await row()).toEqual(before);
    expect(await pruneSearchIndexLocators(account)).toBe(1);expect(await row()).toBeUndefined();
  });

  it('does not let a stale cleanup epoch remove a reclaimed and later expired replacement',async()=>{
    const old=await claimSearchIndexJob(account);
    await db.query("UPDATE search_index_jobs SET lease_expires_at=now()-interval '1 second'");
    const replacement=await claimSearchIndexJob(account);expect(replacement.lease_token).not.toBe(old.lease_token);
    await db.query('DELETE FROM messages WHERE id=$1',[message(1)]);
    await db.query("UPDATE search_index_jobs SET lease_expires_at=now()-interval '1 second'");const before=await row();
    expect(await pruneSearchIndexLocators(account,{sourceKey:old.source_key,leaseEpoch:old.lease_epoch,runEpoch:old.run_epoch})).toBe(0);
    expect(await row()).toEqual(before);expect(await pruneSearchIndexLocators(account)).toBe(1);
  });
});
