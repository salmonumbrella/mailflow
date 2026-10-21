import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import { gunzipSync, gzipSync } from 'node:zlib';
import pg from 'pg';

vi.mock('./db.js', () => ({ withTransaction: vi.fn() }));
import { withTransaction } from './db.js';
import { restoreBackup, unclassifiedTables, writeBackup } from './backup.js';
import { publishSearchGeneration } from './searchIndex.js';
import { claimSearchIndexJob, enqueueSearchIndexJob, guardSearchIndexJob,
  setSearchCoverageAction, settleSearchIndexJob } from './searchIndexJobs.js';

const account = '11111111-1111-4111-8111-111111111111';
const message = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const source = n => ({ sourceKey: `physical:${n}`, messageId: message(n),
  folder: 'INBOX', uid: String(n), uidValidity: '7', sourceGeneration: '1' });

// Real service roundtrips on the dedicated task DB; no IMAP worker is started.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('search job backup and restore', () => {
  const schema = `index_backup_${process.pid}`;
  const previousKey = process.env.ENCRYPTION_KEY;
  let db, client;
  const phases = [];
  const tx = async fn => {
    await db.query('BEGIN');
    try { const result = await fn(db); await db.query('COMMIT'); return result; }
    catch (err) { await db.query('ROLLBACK'); throw err; }
  };
  const rows = async table => (await db.query(`SELECT * FROM ${table} ORDER BY account_id,source_key`)).rows;
  const backup = async scope => {
    const out = new PassThrough();
    const chunks = [];
    out.on('data', chunk => chunks.push(chunk));
    await writeBackup(client, { scope, appVersion: '4.0.3', out });
    return Buffer.concat(chunks);
  };

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '4a'.repeat(32); // synthetic, test-only key
    db = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await db.connect();
    await db.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
    // Only catalog queries are redirected; data, FK, TRUNCATE and restore SQL
    // execute against the real private fixture schema via search_path.
    client = { query: (sql, values) => {
      const text = typeof sql === 'string' ? sql : sql.text;
      if (text.startsWith('TRUNCATE ')) phases.push('truncate');
      return db.query(typeof sql === 'string' ? text.replaceAll("'public'", `'${schema}'`)
        : { ...sql, text: text.replaceAll("'public'", `'${schema}'`) }, values);
    } };
    withTransaction.mockImplementation(tx);
  });
  afterAll(async () => {
    if (db) { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.end(); }
    if (previousKey == null) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = previousKey;
  });
  beforeEach(async () => {
    phases.length = 0;
    await db.query(`DROP TABLE IF EXISTS search_index_jobs,search_index_accounts,search_text_chunks,search_text_generations,
      archive_coverage,background_download_debits,unfetchable_uids,messages,folders,email_accounts,schema_migrations CASCADE;
      CREATE TABLE schema_migrations(version text); INSERT INTO schema_migrations VALUES ('0075_search_index_jobs');
      CREATE TABLE email_accounts(id uuid PRIMARY KEY,enabled boolean DEFAULT true);
      CREATE TABLE folders(account_id uuid REFERENCES email_accounts ON DELETE CASCADE,path text,uid_validity bigint,PRIMARY KEY(account_id,path));
      CREATE TABLE messages(id uuid PRIMARY KEY,account_id uuid REFERENCES email_accounts ON DELETE CASCADE,folder text,uid bigint,date timestamptz,is_deleted boolean DEFAULT false,body_text text);
      INSERT INTO email_accounts VALUES ('${account}',true);
      INSERT INTO folders VALUES ('${account}','INBOX',7);
      INSERT INTO messages VALUES ('${message(1)}','${account}','INBOX',1,now(),false,'retained body'),
        ('${message(2)}','${account}','INBOX',2,now()+interval '1 day',false,'second body');`);
    for (const name of ['0058_unfetchable_uids', '0069_gmail_archive_coverage', '0072_verified_search_text', '0075_search_index_jobs']) {
      await db.query(readFileSync(new URL(`../../migrations/${name}.sql`, import.meta.url), 'utf8'));
    }
    await enqueueSearchIndexJob(account, source(1));
    await enqueueSearchIndexJob(account, source(2));
  });

  it('classifies pause as setup and restores setup without cached jobs or messages', async () => {
    expect(await unclassifiedTables(client)).toEqual([]);
    await setSearchCoverageAction(account, 'pause');
    const bytes = await backup('setup');
    const manifest = JSON.parse(gunzipSync(bytes).toString('utf8').split('\n')[0]);
    expect(manifest.tables).toEqual(expect.arrayContaining(['email_accounts', 'search_index_accounts', 'background_download_debits']));
    expect(manifest.tables).toHaveLength(3);
    await setSearchCoverageAction(account, 'resume');
    await restoreBackup(client, Readable.from([bytes]));
    expect((await db.query('SELECT paused FROM search_index_accounts')).rows).toEqual([{ paused: true }]);
    expect(await rows('search_index_jobs')).toEqual([]);
    expect((await db.query('SELECT * FROM messages')).rows).toEqual([]);
  });

  it('full restore preserves terminal diagnostics and bounds while nulling leases despite lower epochs', async () => {
    const unsupported = await claimSearchIndexJob(account);
    await settleSearchIndexJob(unsupported, { status: 'unsupported', reason: 'structure-too-large', downloadBytes: 264193 });
    const first = await claimSearchIndexJob(account);
    await settleSearchIndexJob(first, { status: 'deferred', deferAt: 2000000000000, bodyBytes: 17055744,
      identity: { accountId: account, folder: 'INBOX', uid: 1, uidValidity: '7' } });
    await db.query('UPDATE search_index_jobs SET defer_at=now() WHERE source_key=$1', ['physical:1']);
    await claimSearchIndexJob(account);
    const beforeBackup = await rows('search_index_jobs');
    const bytes = await backup('full');
    const before = await rows('search_index_jobs');
    expect(before).toEqual(beforeBackup);
    await db.query("UPDATE search_index_jobs SET lease_epoch=100,lease_expires_at=now()-interval '1 second' WHERE state='running'");
    await db.query('UPDATE search_index_accounts SET run_epoch=100');
    const preRestore = await claimSearchIndexJob(account);
    await restoreBackup(client, Readable.from([bytes]));
    const restored = await rows('search_index_jobs');
    expect(restored.find(row => row.source_key === 'physical:2')).toEqual(before.find(row => row.source_key === 'physical:2'));
    const pending = restored.find(row => row.source_key === 'physical:1');
    expect(pending.state).toBe('queued');
    expect(pending.lease_token).toBeNull(); expect(pending.lease_expires_at).toBeNull();
    expect(pending.pending_body_bytes).toBe('17055744');
    expect(BigInt(pending.lease_epoch)).toBeLessThan(BigInt(preRestore.lease_epoch));
    expect(await tx(client => guardSearchIndexJob(client, preRestore))).toBe(false);
    expect((await db.query('SELECT body_text FROM messages ORDER BY uid')).rows).toEqual([{ body_text: 'retained body' }, { body_text: 'second body' }]);
  });

  it.each(['full', 'setup'])('%s restore preserves the approved cache union and monotonic daily debit contract', async scope => {
    const claim = await claimSearchIndexJob(account);
    const published = await publishSearchGeneration({ accountId: account, sourceKey: claim.source_key,
      targets: [{ id: message(2), uid: 2, folder: 'INBOX', uidValidity: '7' }],
      extraction: { complete: true, requiredParts: ['1'], textParts: [{ part: '1', text: 'verifiedquartz' }],
        identity: { accountId: account, folder: 'INBOX', uid: 2, uidValidity: '7' } },
      guard: client => guardSearchIndexJob(client, claim) });
    expect(published.published).toBe(true);
    await settleSearchIndexJob(claim, { status: 'complete', generationId: published.generationId });
    const pending = await claimSearchIndexJob(account);
    await settleSearchIndexJob(pending, { status: 'deferred', deferAt: 2000000000000, bodyBytes: 17055744,
      identity: { accountId: account, folder: 'INBOX', uid: 1, uidValidity: '7' } });
    await db.query('UPDATE search_index_jobs SET defer_at=now() WHERE source_key=$1', ['physical:1']);
    await claimSearchIndexJob(account);
    await db.query("INSERT INTO archive_coverage(account_id,folder,uid_validity,bootstrap_complete) VALUES ($1,'INBOX',7,true)", [account]);
    await db.query("INSERT INTO unfetchable_uids(account_id,folder,uid,uid_validity) VALUES ($1,'INBOX',99,7)", [account]);
    await db.query("INSERT INTO background_download_debits(account_id,day,bytes) VALUES ($1,'2026-10-21',100)", [account]);
    const bytes = await backup(scope);
    const manifest = JSON.parse(gunzipSync(bytes).toString('utf8').split('\n')[0]);
    const cache = ['archive_coverage', 'folders', 'messages', 'unfetchable_uids', 'search_text_generations', 'search_text_chunks', 'search_index_jobs'];
    if (scope === 'full') {
      expect(manifest.tables).toEqual(expect.arrayContaining(cache));
      expect(manifest.tables.indexOf('search_text_generations')).toBeLessThan(manifest.tables.indexOf('messages'));
      expect(manifest.tables.indexOf('search_text_generations')).toBeLessThan(manifest.tables.indexOf('search_text_chunks'));
    } else for (const table of cache) expect(manifest.tables).not.toContain(table);
    await db.query('UPDATE background_download_debits SET bytes=400');
    await restoreBackup(client, Readable.from([bytes]));
    expect((await db.query('SELECT bytes::text FROM background_download_debits')).rows).toEqual([{ bytes: '400' }]);
    const expectedCounts = scope === 'full' ? [1, 1, 2, 1, 1, 1, 2] : [0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < cache.length; i++) {
      expect((await db.query(`SELECT count(*)::int AS n FROM ${cache[i]}`)).rows[0].n, cache[i]).toBe(expectedCounts[i]);
    }
    if (scope === 'full') {
      expect((await db.query(`SELECT m.id,c.text FROM messages m JOIN search_text_chunks c ON c.generation_id=m.search_generation_id
        WHERE c.simple_tsv @@ plainto_tsquery('simple','verifiedquartz')`)).rows)
        .toEqual([{ id: message(2), text: 'verifiedquartz' }]);
      expect((await rows('search_index_jobs')).find(row => row.source_key === 'physical:1'))
        .toMatchObject({ state: 'queued', lease_token: null, lease_expires_at: null, pending_body_bytes: '17055744' });
    }
  });

  it('awaits the existing beforeWrite callback before TRUNCATE', async () => {
    const bytes = await backup('full');
    let release;
    const drained = new Promise(resolve => { release = resolve; });
    const restoring = restoreBackup(client, Readable.from([bytes]), { beforeWrite: async () => {
      phases.push('quiesce-start'); await drained; phases.push('drained');
    } });
    try {
      await vi.waitFor(() => expect(phases).toContain('quiesce-start'));
      expect(phases).not.toContain('truncate');
    } finally { release(); }
    await restoring;
    expect(phases).toEqual(['quiesce-start', 'drained', 'truncate']);
    // Proves callback ordering only. Actual index-worker stop/drain is tested
    // with the real lifecycle after that source seam is integrated.
  });

  it('rolls back an inconsistent backup without committing any lease reset', async () => {
    await claimSearchIndexJob(account);
    const bytes = await backup('full');
    const entries = gunzipSync(bytes).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
    entries.at(-1).rowCounts.search_index_jobs++;
    const corrupt = gzipSync(entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    const before = await rows('search_index_jobs');
    await expect(restoreBackup(client, Readable.from([corrupt]))).rejects.toThrow(/inconsistent/);
    expect(await rows('search_index_jobs')).toEqual(before);
  });
});
