import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import pg from 'pg';

vi.mock('./db.js',()=>({query:vi.fn(),withTransaction:vi.fn()}));
import { query, withTransaction } from './db.js';
import { createSearchIndexSourceProducer } from './searchIndexSources.js';

// The SQL is read from the REAL named manager writer, never copied into a second
// writer. Before implementation, extraction falls back to that writer's original
// UPSERT so missing discriminator fields are assertions, not collection failures.
const managerSource=readFileSync(new URL('./imapManager.js',import.meta.url),'utf8');
const writerSQL=mode=>{
  const method=managerSource.indexOf(mode==='sync'?'async syncMessages':'async backfillMessages');
  const insert=managerSource.indexOf('INSERT INTO messages',method);
  return managerSource.slice(managerSource.lastIndexOf('`',insert)+1,managerSource.indexOf('`, [',insert));
};
const accountId='11111111-1111-4111-8111-111111111111';
const account={id:accountId,imap_host:'imap.gmail.com'};
const profile={labelStore:true};
const values=(provider='901')=>[accountId,1,'Work','<arrival@example.test>','arrival','Sender','sender@example.test',
  '[]','[]','[]',null,'2026-10-21T00:00:00Z','',true,false,false,'[]',null,null,'[]',
  null,'<arrival@example.test>',true,null,null,null,'[]',null,null,null,null,null,provider];

describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('phase1 actual metadata SQL discriminator',()=>{
  let db,realDb,connectSpy,producer;
  const schema=`index_arrivals_${process.pid}`;
  const rows=async()=> (await db.query('SELECT * FROM search_index_jobs')).rows;
  const handoff=vi.fn();
  beforeAll(async()=>{
    db=new pg.Client({connectionString:process.env.MAILFLOW_TEST_DATABASE_URL});
    await db.connect();await db.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
    // Reuse the actual db.withTransaction COMMIT/ROLLBACK implementation while
    // connecting ONLY our owned client. Its production pool never connects.
    realDb=await vi.importActual('./db.js');
    connectSpy=vi.spyOn(realDb.pool,'connect').mockImplementation(async()=>({query:(...args)=>db.query(...args),release:()=>{}}));
    query.mockImplementation((...args)=>db.query(...args));withTransaction.mockImplementation(realDb.withTransaction);
  });
  afterAll(async()=>{
    connectSpy?.mockRestore();if(realDb)await realDb.pool.end();
    if(db){await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await db.end();}
  });
  beforeEach(async()=>{
    handoff.mockReset();
    await db.query(`DROP TABLE IF EXISTS search_index_jobs,search_index_accounts,search_text_chunks,search_text_generations,
      archive_coverage,background_download_debits,messages,folders,email_accounts,commit_parent CASCADE;
      CREATE TABLE email_accounts(id uuid PRIMARY KEY,enabled boolean DEFAULT true,user_id text);
      CREATE TABLE folders(account_id uuid REFERENCES email_accounts ON DELETE CASCADE,path text,name text,
        uid_validity bigint,no_select boolean DEFAULT false,special_use text,PRIMARY KEY(account_id,path));
      CREATE TABLE messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid REFERENCES email_accounts ON DELETE CASCADE,
        uid bigint,folder text,message_id text,subject text,from_name text,from_email text,to_addresses jsonb,cc_addresses jsonb,
        reply_to jsonb,in_reply_to text,date timestamptz,snippet text,is_read boolean,is_starred boolean,has_attachments boolean,
        flags jsonb,body_html text,body_text text,attachments jsonb,thread_references text,thread_id text,is_bulk boolean,category text,
        list_unsubscribe text,list_unsubscribe_post text,delivery_addresses jsonb,sender_name text,sender_email text,
        forwarded_from_name text,forwarded_from_email text,forwarded_via text,read_changed_at timestamptz,star_changed_at timestamptz,
        is_deleted boolean DEFAULT false,UNIQUE(account_id,uid,folder));
      INSERT INTO email_accounts VALUES('${accountId}',true,'arrival-owner');
      INSERT INTO folders VALUES('${accountId}','Work','Work',7,false,NULL),('${accountId}','Archive','Archive',11,false,'\\All');`);
    for(const migration of ['0069_gmail_archive_coverage','0072_verified_search_text','0075_search_index_jobs'])
      await db.query(readFileSync(new URL(`../../migrations/${migration}.sql`,import.meta.url),'utf8'));
    await db.query("INSERT INTO archive_coverage(account_id,folder,uid_validity,bootstrap_complete) VALUES($1,'Work',7,true)",[accountId]);
    producer=createSearchIndexSourceProducer({isOpen:()=>true});
    handoff.mockImplementation(async result=>producer.enqueueRows(account,[result.id],{profile}));
  });
  const write=async(mode,provider='901',client=db)=>(await client.query(writerSQL(mode),values(provider))).rows[0];
  const assertArrival=(row,prior)=>{
    expect(row).toMatchObject({account_id:accountId,is_deleted:false,is_archive_residue:false,
      inserted_row:prior===null,prior_provider_msgid:prior});
  };
  // Only these post-COMMIT tests explicitly invoke the real idempotent enqueue
  // helper. The separate 24 real-manager controls prove production consumption;
  // this fixture is SQL/transaction evidence, not a live union activation proof.
  for(const mode of ['sync','backfill']){
    it(`${mode}: an actual insert returns its written row and one durable source job`,async()=>{
      const row=await write(mode);assertArrival(row,null);
      expect((await db.query('SELECT id FROM messages')).rows[0].id).toBe(row.id);
      await handoff(row);expect(await rows()).toHaveLength(1);
    });
    it(`${mode}: unchanged-provider refresh is no arrival even with a true notification flag`,async()=>{
      const first=await write(mode);await handoff(first);
      const row={...await write(mode),is_new:true};
      expect(row.id).toBe(first.id);expect(row).toMatchObject({inserted_row:false,prior_provider_msgid:'901',provider_msgid:'901'});
      expect(row.is_new).toBe(true);expect(handoff).toHaveBeenCalledOnce();expect(await rows()).toHaveLength(1);
    });
    it.each([null,'older-provider'])(`${mode}: SQL correlates provider transition from %s`,async old=>{
      await write(mode,old);const row=await write(mode,'902');
      expect(row).toMatchObject({inserted_row:false,prior_provider_msgid:old,provider_msgid:'902',is_deleted:false});
      await handoff(row);expect(await rows()).toHaveLength(1);
    });
    it(`${mode}: a retained deleted row stays deleted and emits no eligible arrival`,async()=>{
      await write(mode,'old');await db.query('UPDATE messages SET is_deleted=true');
      const row=await write(mode,'902');expect(row).toMatchObject({is_deleted:true,inserted_row:false,prior_provider_msgid:'old',provider_msgid:'902'});
      expect(handoff).not.toHaveBeenCalled();expect(await rows()).toEqual([]);
    });
    it(`${mode}: two-client conflict uses snapshot insertion and duplicate handoff leaves one job`,async()=>{
      const peer=new pg.Client({connectionString:process.env.MAILFLOW_TEST_DATABASE_URL});let pending;
      await peer.connect();
      try{
        await peer.query(`SET search_path TO ${schema}; BEGIN`);const first=await write(mode,'901',peer);
        pending=db.query(writerSQL(mode),values('901'));pending.catch(()=>{});
        await vi.waitFor(async()=>{
          const lock=(await peer.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[db.processID])).rows[0];
          expect(lock?.wait_event_type).toBe('Lock');
        },{timeout:1500,interval:25});
        expect(handoff).not.toHaveBeenCalled();await peer.query('COMMIT');
        const second=(await pending).rows[0];assertArrival(first,null);assertArrival(second,null);expect(second.id).toBe(first.id);
        await handoff(first);await handoff(second);expect(handoff).toHaveBeenCalledTimes(2);expect(await rows()).toHaveLength(1);
      }finally{
        await peer.query('ROLLBACK');if(pending)await Promise.allSettled([pending]);await peer.end();
      }
    });
    it(`${mode}: actual outer transaction rollback returns no committed ids`,async()=>{
      await expect(withTransaction(async client=>{const row=await write(mode,'901',client);expect(row.id).toBeTruthy();throw new Error('rollback control');})
        .then(handoff)).rejects.toThrow('rollback control');
      expect((await db.query('SELECT id FROM messages')).rows).toEqual([]);expect(handoff).not.toHaveBeenCalled();expect(await rows()).toEqual([]);
    });
    it(`${mode}: a real deferred-FK COMMIT failure returns no ids after the callback`,async()=>{
      await db.query(`CREATE TABLE commit_parent(email text PRIMARY KEY);
        ALTER TABLE messages ADD CONSTRAINT commit_failure_fk FOREIGN KEY(from_email) REFERENCES commit_parent(email) DEFERRABLE INITIALLY DEFERRED`);
      let callbackRow;
      await expect(withTransaction(async client=>{callbackRow=await write(mode,'901',client);return callbackRow;}).then(handoff))
        .rejects.toMatchObject({code:'23503'});
      expect(callbackRow.id).toBeTruthy();expect((await db.query('SELECT id FROM messages')).rows).toEqual([]);
      expect(handoff).not.toHaveBeenCalled();expect(await rows()).toEqual([]);
    });
  }
});
