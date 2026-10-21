import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import pg from 'pg';

vi.mock('./db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('./searchIndex.js', async original => {
  const actual = await original();
  return { ...actual, publishSearchGeneration: vi.fn(actual.publishSearchGeneration) };
});
vi.mock('./searchIndexJobs.js', async original => {
  const actual = await original();
  return { ...actual, settleSearchIndexJob: vi.fn(actual.settleSearchIndexJob) };
});
import { query, withTransaction } from './db.js';
import { publishSearchGeneration } from './searchIndex.js';
import { claimSearchIndexJob, enqueueSearchIndexJob, setSearchCoverageAction, settleSearchIndexJob } from './searchIndexJobs.js';
import { runSearchIndexBatch as runSearchIndexBatchImpl } from './searchIndexWorker.js';
import { createSearchIndexSourceProducer } from './searchIndexSources.js';

const accountId = '11111111-1111-4111-8111-111111111111';
const messageId = '00000000-0000-4000-8000-000000000001';
const source = { sourceKey: 'physical:INBOX:7:1', messageId, folder: 'INBOX', uid: '1', uidValidity: '7', sourceGeneration: '0' };
const identity = { accountId, folder: 'INBOX', uid: 1, uidValidity: '7' };
const complete = () => ({ complete: true, requiredParts: ['1'], textParts: [{ part: '1', text: 'verifiedquartz' }],
  identity, downloadBytes: 3147, bodyBytes: 1092, structureOverrunBytes: 0 });

// AUTHORING ONLY: no execution without the lead's exact focused packet grant.
// Real PG, real I1 budget and real guarded publisher; only IMAP is a fake boundary.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('resumable search batch integration', () => {
  const schema = `index_worker_${process.pid}`;
  let db, peer, account, clock, producer, hostNumber = 0;
  const runSearchIndexBatch=(account,options)=>runSearchIndexBatchImpl(account,{enqueueRows:producer.enqueueRows,...options});
  let actualPublish, actualSettle;
  const job = async () => (await db.query('SELECT * FROM search_index_jobs WHERE account_id=$1 AND source_key=$2',
    [accountId, source.sourceKey])).rows[0];
  const pointer = async () => (await db.query('SELECT search_generation_id FROM messages WHERE id=$1', [messageId])).rows[0]?.search_generation_id;
  const expire = () => db.query("UPDATE search_index_jobs SET lease_expires_at=now()-interval '1 second' WHERE account_id=$1", [accountId]);
  const tx = async fn => {
    await db.query('BEGIN');
    try { const value = await fn(db); await db.query('COMMIT'); return value; }
    catch (error) { await db.query('ROLLBACK'); throw error; }
  };

  beforeAll(async () => {
    db = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    peer = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await db.connect(); await peer.connect();
    await db.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
    await peer.query(`SET search_path TO ${schema}`);
    actualPublish = (await vi.importActual('./searchIndex.js')).publishSearchGeneration;
    actualSettle = (await vi.importActual('./searchIndexJobs.js')).settleSearchIndexJob;
  });
  afterAll(async () => {
    if (peer) await peer.end();
    if (db) { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.end(); }
  });
  afterEach(() => { vi.restoreAllMocks(); });
  beforeEach(async () => {
    producer=createSearchIndexSourceProducer({isOpen:()=>true});
    clock = 1800000000000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    account = { id: accountId, user_id: 'worker-owner', protocol: 'imap', imap_host: `worker-${process.pid}-${++hostNumber}.example.test` };
    await db.query(`DROP TABLE IF EXISTS search_index_jobs,search_index_accounts,search_text_chunks,search_text_generations,
      archive_coverage,background_download_debits,messages,folders,email_accounts CASCADE;
      CREATE TABLE email_accounts(id uuid PRIMARY KEY,enabled boolean DEFAULT true,user_id text);
      CREATE TABLE folders(account_id uuid REFERENCES email_accounts ON DELETE CASCADE,path text,uid_validity bigint,no_select boolean DEFAULT false,special_use text,PRIMARY KEY(account_id,path));
      CREATE TABLE messages(id uuid PRIMARY KEY,account_id uuid REFERENCES email_accounts ON DELETE CASCADE,folder text,uid bigint,date timestamptz,is_deleted boolean DEFAULT false);
      INSERT INTO email_accounts VALUES ('${accountId}',true,'worker-owner');
      INSERT INTO folders(account_id,path,uid_validity) VALUES ('${accountId}','INBOX',7);
      INSERT INTO messages VALUES ('${messageId}','${accountId}','INBOX',1,now(),false);`);
    for (const name of ['0069_gmail_archive_coverage', '0072_verified_search_text', '0075_search_index_jobs']) {
      await db.query(readFileSync(new URL(`../../migrations/${name}.sql`, import.meta.url), 'utf8'));
    }
    query.mockImplementation((...args) => db.query(...args));
    withTransaction.mockImplementation(tx);
    publishSearchGeneration.mockImplementation(actualPublish);
    settleSearchIndexJob.mockImplementation(actualSettle);
    await enqueueSearchIndexJob(accountId, source);
  });

  it('persists a denied body quote, resumes once with combined admission and charges the real shared budget', async () => {
    let calls = 0;
    const fetchMessageBody = async (_account, uid, folder, options) => {
      calls++;
      expect({ uid: String(uid), folder, purpose: options.purpose, epoch: String(options.uidValidity) })
        .toEqual({ uid: '1', folder: 'INBOX', purpose: 'search', epoch: '7' });
      if (calls === 1) {
        expect(options.reservedBodyBytes).toBeUndefined();
        expect(await options.admit({ messages: 1, bytes: 264192 })).toEqual({ allowed: true, deferAt: null });
        const denied = await options.admit({ messages: 0, bytes: 17055744 });
        expect(denied.allowed).toBe(false);
        return { status: 'deferred', reason: 'budget', complete: false, requiredParts: ['1'], textParts: [], identity,
          bodyBytes: 17055744, downloadBytes: 2100, structureOverrunBytes: 0, deferAt: denied.deferAt };
      }
      expect(options.reservedBodyBytes).toBe(17055744);
      expect(await options.admit({ messages: 1, bytes: 17319936 })).toEqual({ allowed: true, deferAt: null });
      return complete();
    };
    await runSearchIndexBatch(account, { fetchMessageBody });
    expect(await job()).toMatchObject({ state: 'queued', attempts: 0, pending_body_bytes: '17055744',
      pending_folder: 'INBOX', pending_uid: '1', pending_uid_validity: '7' });
    expect((await job()).defer_at.getTime()).toBe(clock + 60000);
    await runSearchIndexBatch(account, { fetchMessageBody });
    expect(calls).toBe(1); // No spin, debit or fetch before deferAt.
    clock += 60000;
    await db.query('UPDATE search_index_jobs SET defer_at=now() WHERE account_id=$1', [accountId]);
    await runSearchIndexBatch(account, { fetchMessageBody }); // A new call uses durable state only.
    expect(calls).toBe(2);
    expect(await job()).toMatchObject({ state: 'complete', attempts: 0, pending_body_bytes: null });
    expect(await pointer()).toBeTruthy();
    // 264192+1024 initial, then17319936+1024; denied body was not debited.
    expect((await db.query('SELECT bytes::text FROM background_download_debits')).rows).toEqual([{ bytes: '17586176' }]);
  });

  it('makes zero further fetches for terminal structure-too-large across repeated batches and controls', async () => {
    const fetchMessageBody = vi.fn(async () => ({ status: 'unsupported', reason: 'structure-too-large', complete: false,
      textParts: [], requiredParts: [], identity, bodyBytes: null, downloadBytes: 264193, structureOverrunBytes: 1 }));
    await runSearchIndexBatch(account, { fetchMessageBody });
    expect(await job()).toMatchObject({ state: 'unsupported', unsupported_reason: 'structure-too-large',
      unsupported_folder: 'INBOX', unsupported_uid: '1', unsupported_uid_validity: '7', unsupported_source_generation: '0',
      observed_download_bytes: '264193', structure_overrun_bytes: '1', attempts: 0 });
    for (const action of ['retry', 'pause', 'resume']) {
      await setSearchCoverageAction(accountId, action);
      await runSearchIndexBatch(account, { fetchMessageBody });
    }
    await enqueueSearchIndexJob(accountId, source);
    await runSearchIndexBatch(account, { fetchMessageBody });
    expect(fetchMessageBody).toHaveBeenCalledTimes(1);
    expect(await pointer()).toBeNull();
  });

  it('defers a typed initial admission storage retry without treating its quota-shaped detail as provider failure', async () => {
    const fetchMessageBody = async () => ({ status: 'retry', reason: 'budget-failed', detail: 'disk quota storage unavailable',
      complete: false, textParts: [], requiredParts: [], identity, bodyBytes: null, downloadBytes: 0, structureOverrunBytes: 0 });
    await runSearchIndexBatch(account, { fetchMessageBody });
    expect(await job()).toMatchObject({ state: 'queued', attempts: 0, last_error: 'budget-failed',
      lease_token: null, lease_expires_at: null, pending_body_bytes: null });
    expect((await job()).defer_at.getTime()).toBeGreaterThan(clock);
    expect(await pointer()).toBeNull();
    expect((await db.query('SELECT * FROM background_download_debits')).rows).toEqual([]);
  });

  it('preserves an unexpired orphan claim, then prunes it after expiry without fetching', async () => {
    await claimSearchIndexJob(accountId);
    await db.query('DELETE FROM messages WHERE id=$1', [messageId]);
    const before = await job();
    const fetchMessageBody = vi.fn();
    await runSearchIndexBatch(account, { fetchMessageBody });
    expect(await job()).toEqual(before);
    await expire();
    await runSearchIndexBatch(account, { fetchMessageBody });
    expect(await job()).toBeUndefined();
    expect(fetchMessageBody).not.toHaveBeenCalled();
  });

  it('rejects a locator moved by the exact Trash PK rewrite before any fetch', async () => {
    await db.query('UPDATE messages SET folder=$1,uid=$2,id=gen_random_uuid() WHERE id=$3', ['Trash', 91, messageId]);
    const fetchMessageBody = vi.fn();
    await runSearchIndexBatch(account, { fetchMessageBody });
    expect(fetchMessageBody).not.toHaveBeenCalled();
    expect(await job()).toBeUndefined();
  });

  it('discards a queued locator after UIDVALIDITY rollover without reusing its body quotation', async () => {
    await db.query('UPDATE folders SET uid_validity=8 WHERE account_id=$1', [accountId]);
    const fetchMessageBody = vi.fn();
    await runSearchIndexBatch(account, { fetchMessageBody });
    expect(fetchMessageBody).not.toHaveBeenCalled();
    expect(await job()).toBeUndefined();
    expect(await pointer()).toBeNull();
  });

  it.each([[0, 60000], [1, 120000], [20, 3600000]])('backs off a failed attempt from %s within the bounded delay', async (attempts, delay) => {
    await db.query('UPDATE search_index_jobs SET attempts=$1', [attempts]);
    const fetchMessageBody = async () => ({ status: 'retry', reason: 'incomplete-part', complete: false,
      textParts: [], requiredParts: ['1'], identity, downloadBytes: 3000, bodyBytes: 1092, structureOverrunBytes: 0 });
    await runSearchIndexBatch(account, { fetchMessageBody });
    expect(await job()).toMatchObject({ state: 'failed', attempts: attempts + 1, last_error: 'incomplete-part' });
    expect((await job()).defer_at.getTime()).toBe(clock + delay);
    expect(await pointer()).toBeNull();
  });

  it('hydrates a verified provider object once for its current account-scoped copies', async () => {
    const copyId = '00000000-0000-4000-8000-000000000002';
    const foreignAccount = '22222222-2222-4222-8222-222222222222';
    const foreignId = '00000000-0000-4000-8000-000000000003';
    await db.query("UPDATE messages SET provider_msgid='901' WHERE id=$1", [messageId]);
    await db.query("INSERT INTO folders(account_id,path,uid_validity) VALUES ($1,'Label',9)", [accountId]);
    await db.query("INSERT INTO messages(id,account_id,folder,uid,date,provider_msgid) VALUES ($1,$2,'Label',2,now(),'901')", [copyId, accountId]);
    await db.query("INSERT INTO archive_coverage(account_id,folder,uid_validity,bootstrap_complete) VALUES ($1,'INBOX',7,true),($1,'Label',9,true)", [accountId]);
    await db.query("INSERT INTO folders(account_id,path,uid_validity,special_use) VALUES ($1,'Archive',11,$2)", [accountId,'\\All']);
    await db.query("INSERT INTO email_accounts VALUES ($1,true,'other-owner')", [foreignAccount]);
    await db.query("INSERT INTO folders(account_id,path,uid_validity) VALUES ($1,'INBOX',7)", [foreignAccount]);
    await db.query("INSERT INTO archive_coverage(account_id,folder,uid_validity,bootstrap_complete) VALUES ($1,'INBOX',7,true)", [foreignAccount]);
    await db.query("INSERT INTO messages(id,account_id,folder,uid,date,provider_msgid) VALUES ($1,$2,'INBOX',1,now(),'901')", [foreignId, foreignAccount]);
    await producer(account,{profile:{labelStore:true}});
    const fetchMessageBody = vi.fn(async () => complete());
    await runSearchIndexBatch(account, { fetchMessageBody, labelStore: true });
    expect(fetchMessageBody).toHaveBeenCalledTimes(1);
    const generation = await pointer();
    expect(generation).toBeTruthy();
    expect((await db.query('SELECT id FROM messages WHERE search_generation_id=$1 ORDER BY id', [generation])).rows)
      .toEqual([{ id: messageId }, { id: copyId }]);
    expect((await db.query('SELECT search_generation_id FROM messages WHERE id=$1', [foreignId])).rows)
      .toEqual([{ search_generation_id: null }]);
  });

  it('keeps unverified provider metadata as physical fallback instead of merging copies', async () => {
    const copyId = '00000000-0000-4000-8000-000000000002';
    await db.query("UPDATE messages SET provider_msgid='901'");
    await db.query("INSERT INTO messages(id,account_id,folder,uid,date,provider_msgid) VALUES ($1,$2,'INBOX',2,now(),'901')", [copyId, accountId]);
    await runSearchIndexBatch(account, { fetchMessageBody: async () => complete(), labelStore: true });
    expect(await pointer()).toBeTruthy();
    expect((await db.query('SELECT search_generation_id FROM messages WHERE id=$1', [copyId])).rows)
      .toEqual([{ search_generation_id: null }]);
  });

  it('defers actual guarded-publication 55P03 without a failed attempt or pointer change', async () => {
    const fetchMessageBody = async () => {
      await peer.query('BEGIN');
      await peer.query('SELECT * FROM search_index_jobs WHERE account_id=$1 FOR UPDATE', [accountId]);
      return complete();
    };
    let observedCode;
    publishSearchGeneration.mockImplementationOnce(async input => {
      try { return await actualPublish(input); }
      catch (error) { observedCode = error.code; throw error; }
      finally { await peer.query('ROLLBACK'); }
    });
    try { await runSearchIndexBatch(account, { fetchMessageBody }); }
    finally { await peer.query('ROLLBACK'); }
    expect(observedCode).toBe('55P03');
    expect(await job()).toMatchObject({ state: 'queued', attempts: 0, lease_token: null, lease_expires_at: null });
    expect((await job()).defer_at.getTime()).toBeGreaterThan(clock);
    expect(await pointer()).toBeNull();
    expect((await db.query('SELECT count(*)::int AS n FROM search_text_generations')).rows[0].n).toBe(0);
  });

  it('reconciles commit-before-ack from the live pointer after reclaim with zero second hydration', async () => {
    const fetchMessageBody = vi.fn(async () => complete());
    settleSearchIndexJob.mockImplementationOnce(async () => { throw new Error('simulated process loss after publication commit'); });
    await expect(runSearchIndexBatch(account, { fetchMessageBody })).rejects.toThrow('simulated process loss after publication commit');
    const published = await pointer();
    expect(published).toBeTruthy();
    expect(await job()).toMatchObject({ state: 'running', generation_id: null });
    await expire();
    await runSearchIndexBatch(account, { fetchMessageBody });
    expect(fetchMessageBody).toHaveBeenCalledTimes(1);
    expect(await pointer()).toBe(published);
    expect(await job()).toMatchObject({ state: 'complete', generation_id: published });
    expect((await db.query('SELECT count(*)::int AS n FROM search_text_generations')).rows[0].n).toBe(1);
  });
});
