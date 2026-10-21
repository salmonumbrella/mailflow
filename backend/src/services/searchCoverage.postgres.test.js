import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import pg from 'pg';

vi.mock('./db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
import { query, withTransaction } from './db.js';
import { getSearchCoverage } from './searchCoverage.js';
import { publishSearchGeneration } from './searchIndex.js';
import { claimSearchIndexJob, enqueueSearchIndexJob, setSearchCoverageAction,
  settleSearchIndexJob } from './searchIndexJobs.js';

const accountId = '11111111-1111-4111-8111-111111111111';
const foreignId = '22222222-2222-4222-8222-222222222222';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const owner = 'coverage-owner';

// Removes the common false-positive proofs: completed job bookkeeping, legacy
// body text and a generation for the wrong account or source contract.
// AUTHORING ONLY: no PG connection/collection has been executed for this file.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('live body search coverage', () => {
  let db, profile;
  const schema = `search_coverage_${process.pid}`;
  const coverage = async (ids = [accountId]) => getSearchCoverage(ids, {
    userId: owner, profileForAccount: () => profile,
  });
  const one = async () => (await coverage())[0];
  const source = (key = 'provider:901') => ({ sourceKey: key, messageId: id(1),
    folder: 'INBOX', uid: '1', uidValidity: '7', sourceGeneration: '0' });
  const publish = async (targets = [{ id: id(1), folder: 'INBOX', uid: '1', uidValidity: '7' }],
    sourceKey = '["7b","provider:901","0"]') => publishSearchGeneration({ accountId, sourceKey, targets,
    extraction: { complete: true, identity: { accountId, folder: 'INBOX', uid: '1', uidValidity: '7' },
      requiredParts: ['1'], textParts: [{ part: '1', text: 'coveragequartz' }] } });
  const addCopy = async () => db.query(`INSERT INTO messages(id,account_id,folder,uid,provider_msgid)
    VALUES ($1,$2,'Label',2,'901')`, [id(2), accountId]);

  beforeAll(async () => {
    db = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await db.connect();
    await db.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
    query.mockImplementation((...args) => db.query(...args));
    withTransaction.mockImplementation(async fn => {
      await db.query('BEGIN');
      try { const result = await fn(db); await db.query('COMMIT'); return result; }
      catch (error) { await db.query('ROLLBACK'); throw error; }
    });
  });
  afterAll(async () => {
    if (db) { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.end(); }
  });
  beforeEach(async () => {
    profile = { labelStore: true, skipFolderNames: ['spam', 'trash'] };
    await db.query(`DROP TABLE IF EXISTS search_index_jobs,search_index_accounts,search_text_chunks,
      search_text_generations,archive_coverage,background_download_debits,messages,folders,email_accounts CASCADE;
      CREATE TABLE email_accounts(id uuid PRIMARY KEY,user_id text,enabled boolean DEFAULT true,
        imap_host text DEFAULT 'imap.example.test',oauth_provider text);
      CREATE TABLE folders(account_id uuid REFERENCES email_accounts ON DELETE CASCADE,path text,
        uid_validity bigint,no_select boolean DEFAULT false,special_use text,PRIMARY KEY(account_id,path));
      CREATE TABLE messages(id uuid PRIMARY KEY,account_id uuid REFERENCES email_accounts ON DELETE CASCADE,
        folder text,uid bigint,date timestamptz DEFAULT now(),is_deleted boolean DEFAULT false,body_text text);
      INSERT INTO email_accounts(id,user_id) VALUES ('${accountId}','${owner}'),('${foreignId}','other-owner');
      INSERT INTO folders VALUES ('${accountId}','INBOX',7,false,NULL),('${accountId}','Label',9,false,NULL),
        ('${accountId}','Archive',11,false,NULL),('${accountId}','Spam',12,false,NULL),
        ('${foreignId}','INBOX',7,false,NULL);
      INSERT INTO messages(id,account_id,folder,uid,body_text) VALUES
        ('${id(1)}','${accountId}','INBOX',1,'legacy display cache'),
        ('${id(9)}','${foreignId}','INBOX',9,'private foreign cache');`);
    for (const name of ['0069_gmail_archive_coverage', '0072_verified_search_text', '0075_search_index_jobs']) {
      await db.query(readFileSync(new URL(`../../migrations/${name}.sql`, import.meta.url), 'utf8'));
    }
    await db.query("UPDATE folders SET special_use=$1 WHERE path='Archive'", ['\\All']);
    await db.query("UPDATE messages SET provider_msgid='901' WHERE account_id=$1", [accountId]);
    await db.query(`INSERT INTO archive_coverage(account_id,folder,uid_validity,bootstrap_complete)
      VALUES ($1,'INBOX',7,true),($1,'Label',9,true),($1,'Archive',11,false)`, [accountId]);
  });

  it('keeps an empty queue and legacy display body incomplete without a live generation', async () => {
    expect(await one()).toMatchObject({ complete: false, status: 'catching-up',
      body: { sources: 1, verified: 0, pending: 1, cachedComplete: false },
      metadata: { physicalRows: 1 }, providerMessageCount: null, estimateMs: null });
  });

  it('requires every current copy to carry an exact-contract live pointer and regresses after relocation NULL', async () => {
    await addCopy();
    await publish();
    expect((await one()).body).toMatchObject({ sources: 1, physicalRows: 2, verified: 0, pending: 1 });
    await publish([{ id: id(1), folder: 'INBOX', uid: '1', uidValidity: '7' },
      { id: id(2), folder: 'Label', uid: '2', uidValidity: '9' }]);
    expect(await one()).toMatchObject({ complete: false, status: 'cached-bodies-verified',
      body: { sources: 1, verified: 1, pending: 0, cachedComplete: true } });
    await db.query('UPDATE messages SET search_generation_id=NULL WHERE id=$1', [id(2)]);
    expect((await one()).body).toMatchObject({ verified: 0, pending: 1, cachedComplete: false });
  });

  it.each(['["7b","provider:901","1"]', '["7b","provider:902","0"]'])('rejects a live generation for the wrong source version %s', async version => {
    await publish(undefined, version);
    expect((await one()).body).toMatchObject({ verified: 0, pending: 1 });
  });

  it('does not certify a complete job whose live message pointer is absent', async () => {
    await enqueueSearchIndexJob(accountId, source());
    const published = await publish();
    await settleSearchIndexJob(await claimSearchIndexJob(accountId), { status: 'complete', generationId: published.generationId });
    await db.query('UPDATE messages SET search_generation_id=NULL WHERE account_id=$1', [accountId]);
    expect(await one()).toMatchObject({ jobCounts: { complete: 1 }, body: { verified: 0, pending: 1 }, complete: false });
  });

  it('rejects a generation pointer owned by another account even when its source text matches', async () => {
    const { rows: [generation] } = await db.query(`INSERT INTO search_text_generations(account_id,source_key)
      VALUES ($1,'["7b","provider:901","0"]') RETURNING id`, [foreignId]);
    await db.query('UPDATE messages SET search_generation_id=$1 WHERE id=$2', [generation.id, id(1)]);
    expect((await one()).body).toMatchObject({ verified: 0, pending: 1 });
  });

  it('labels physical fallback honestly when a ready account still has a legacy archive row without identity', async () => {
    await db.query(`INSERT INTO messages(id,account_id,folder,uid,is_archive_residue)
      VALUES ($1,$2,'Archive',2,true)`, [id(2), accountId]);
    expect(await one()).toMatchObject({ identity: { mode: 'mixed', physicalSources: 1, bootstrapComplete: true },
      body: { sources: 2, pending: 2 } });
  });

  it('counts terminal provider evidence once and exposes its honest structure overrun', async () => {
    await addCopy();
    await enqueueSearchIndexJob(accountId, source());
    await settleSearchIndexJob(await claimSearchIndexJob(accountId), { status: 'unsupported',
      reason: 'structure-too-large', downloadBytes: 264193, structureOverrunBytes: 1 });
    expect(await one()).toMatchObject({ complete: false, status: 'unsupported',
      body: { sources: 1, physicalRows: 2, verified: 0, unsupported: 1, pending: 0 },
      unsupported: [{ reason: 'structure-too-large', sources: 1,
        observedDownloadBytes: '264193', structureOverrunBytes: '1' }] });
    await setSearchCoverageAction(accountId, 'retry');
    expect((await one()).body.unsupported).toBe(1);
  });

  it('uses physical fallback when the actual global identity bootstrap is not ready', async () => {
    await addCopy();
    await db.query("UPDATE archive_coverage SET bootstrap_complete=false WHERE folder='Label'");
    await publish();
    expect(await one()).toMatchObject({ identity: { mode: 'physical', bootstrapComplete: false },
      body: { sources: 2, verified: 0, pending: 2 } });
  });

  it('invalidates physical verification when the folder epoch rolls over', async () => {
    profile = { labelStore: false };
    await publish(undefined, '["7b","physical:INBOX:7:1","0"]');
    expect((await one()).body.verified).toBe(1);
    await db.query("UPDATE folders SET uid_validity=8 WHERE path='INBOX'");
    expect((await one()).body).toMatchObject({ verified: 0, pending: 1 });
  });

  it('includes only residue in the actual archive folder and excludes deleted, Spam and no-select rows', async () => {
    await db.query("UPDATE messages SET folder='Archive',uid=3,is_archive_residue=true WHERE id=$1", [id(1)]);
    await db.query(`INSERT INTO messages(id,account_id,folder,uid,provider_msgid,is_archive_residue)
      VALUES ($1,$2,'Label',2,'902',true),($3,$2,'Spam',4,'903',false)`, [id(2), accountId, id(4)]);
    await db.query("INSERT INTO folders VALUES ($1,'Hidden',99,true,NULL)", [accountId]);
    await db.query("INSERT INTO messages(id,account_id,folder,uid) VALUES ($1,$2,'Hidden',5)", [id(5), accountId]);
    expect((await one()).body).toMatchObject({ sources: 1, physicalRows: 1, pending: 1 });
  });

  it('keeps current archive membership progress and unknown provider denominator separate from bodies', async () => {
    await publish();
    await db.query("UPDATE archive_coverage SET phase='scan',scan_cursor=500,last_error='synthetic pending' WHERE folder='Archive'");
    expect(await one()).toMatchObject({ complete: false, providerMessageCount: null, estimateMs: null,
      archive: { phase: 'scan', scanCursor: '500', lastError: 'synthetic pending', currentEpoch: true },
      body: { verified: 1 } });
    await db.query("UPDATE folders SET uid_validity=12 WHERE path='Archive'");
    expect((await one()).archive.currentEpoch).toBe(false);
  });

  it('reads the shared durable current-UTC-day debit without charging or changing jobs', async () => {
    await db.query(`INSERT INTO background_download_debits(account_id,day,bytes) VALUES
      ($1,(now() AT TIME ZONE 'UTC')::date,123456),($1,(now() AT TIME ZONE 'UTC')::date-1,999999)`, [accountId]);
    await enqueueSearchIndexJob(accountId, source());
    const before = (await db.query('SELECT * FROM search_index_jobs')).rows;
    const result = await one();
    expect(result.budget.chargedBytes).toBe('123456');
    expect(result.budget.limitBytes).toBeNull();
    expect((await db.query('SELECT * FROM search_index_jobs')).rows).toEqual(before);
    expect((await db.query('SELECT sum(bytes)::text AS n FROM background_download_debits')).rows[0].n).toBe('1123455');
  });

  it('distinguishes pause, failed work and disabled state without making any complete', async () => {
    await enqueueSearchIndexJob(accountId, source());
    await settleSearchIndexJob(await claimSearchIndexJob(accountId), { status: 'failed', reason: 'missing-part' });
    expect(await one()).toMatchObject({ status: 'failed', body: { failed: 1, pending: 0 }, complete: false });
    await setSearchCoverageAction(accountId, 'pause');
    expect(await one()).toMatchObject({ status: 'paused', paused: true, complete: false });
    await db.query('UPDATE email_accounts SET enabled=false WHERE id=$1', [accountId]);
    expect(await one()).toMatchObject({ status: 'disabled', enabled: false, complete: false });
  });

  it('omits foreign and deleted accounts even in a mixed or repeated request', async () => {
    expect((await coverage([foreignId, accountId, accountId])).map(row => row.accountId)).toEqual([accountId]);
    await db.query('DELETE FROM email_accounts WHERE id=$1', [accountId]);
    expect(await coverage()).toEqual([]);
  });

  it.each([1, 42, 0xdeadbeef])('never certifies a partially pointed source through generated relocations (seed %s)', async seed => {
    await addCopy();
    const published = await publish([{ id: id(1), folder: 'INBOX', uid: '1', uidValidity: '7' },
      { id: id(2), folder: 'Label', uid: '2', uidValidity: '9' }]);
    const pointed = new Set([1, 2]); let random = seed >>> 0;
    const trace = [];
    for (let step = 0; step < 12; step++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const target = (random & 1) + 1, present = Boolean(random & 4);
      trace.push([target, present]);
      if (present) pointed.add(target); else pointed.delete(target);
      await db.query('UPDATE messages SET search_generation_id=$1 WHERE id=$2', [present ? published.generationId : null, id(target)]);
      const result = await one();
      expect(result.body.verified, JSON.stringify({ seed, step, trace })).toBe(pointed.size === 2 ? 1 : 0);
      expect(result.complete).toBe(false);
      expect(result.body.sources).toBe(1);
    }
  });
});
