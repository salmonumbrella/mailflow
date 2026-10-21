import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import pg from 'pg';

vi.mock('./db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('imapflow', () => ({ ImapFlow: vi.fn(() => { throw new Error('Unexpected IMAP login'); }) }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: value => value, encrypt: value => value }));
import { query, withTransaction } from './db.js';
import { prioritizeSearchMessages } from './searchIndexPriority.js';
import { ImapManager } from './imapManager.js';
import { createSearchIndexLifecycle } from './searchIndexLifecycle.js';
import { createSearchIndexSourceProducer } from './searchIndexSources.js';
import { isIdentityBootstrapComplete } from './archiveCoverage.js';

const accountId = '11111111-1111-4111-8111-111111111111';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const owner = 'priority-owner';

// Real queued-row effects: dropping the200-source cap, owner scope, current
// contract or queued-only predicate must change these results. UNEXECUTED.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('bounded metadata search priority', () => {
  let db, open, profile;
  const schema = `index_priority_${process.pid}`;
  const prioritize = (ids, options = {}) => prioritizeSearchMessages(accountId, ids, {
    userId: owner, profile, isOpen: () => open, ...options,
  });
  const count = async () => (await db.query(`SELECT count(*)::int AS n FROM search_index_jobs
    WHERE priority_at IS NOT NULL AND state='queued'`)).rows[0].n;
  beforeAll(async () => {
    db = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await db.connect(); await db.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
    query.mockImplementation((...args) => db.query(...args));
    withTransaction.mockImplementation(async fn => {
      await db.query('BEGIN');
      try { const value = await fn(db); await db.query('COMMIT'); return value; }
      catch (error) { await db.query('ROLLBACK'); throw error; }
    });
  });
  afterAll(async () => { if (db) { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.end(); } });
  beforeEach(async () => {
    open = true; profile = { labelStore: false, skipFolderNames: ['spam'] };
    await db.query(`DROP TABLE IF EXISTS search_index_jobs,search_index_accounts,archive_coverage,
      background_download_debits,messages,folders,email_accounts CASCADE;
      CREATE TABLE email_accounts(id uuid PRIMARY KEY,user_id text,enabled boolean DEFAULT true,
        imap_host text DEFAULT 'imap.example.test',oauth_provider text,protocol text DEFAULT 'imap');
      CREATE TABLE folders(account_id uuid,path text,uid_validity bigint,no_select boolean DEFAULT false,
        special_use text,PRIMARY KEY(account_id,path));
      CREATE TABLE messages(id uuid PRIMARY KEY,account_id uuid,folder text,uid bigint,date timestamptz,
        is_deleted boolean DEFAULT false);
      INSERT INTO email_accounts(id,user_id,enabled) VALUES ('${accountId}','${owner}',true);
      INSERT INTO folders VALUES ('${accountId}','INBOX',7,false,NULL),('${accountId}','Spam',8,false,NULL);`);
    for (const name of ['0069_gmail_archive_coverage', '0072_verified_search_text', '0075_search_index_jobs']) {
      await db.query(readFileSync(new URL(`../../migrations/${name}.sql`, import.meta.url), 'utf8'));
    }
    await db.query(`INSERT INTO messages(id,account_id,folder,uid,date)
      SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$1,'INBOX',n,now()-n*interval '1 second'
      FROM generate_series(1,205)n`, [accountId]);
    await db.query(`INSERT INTO search_index_jobs(account_id,source_key,message_id,folder,uid,uid_validity,source_generation,message_date)
      SELECT account_id,'physical:INBOX:7:'||uid,id,folder,uid,7,0,date FROM messages`);
  });

  it('caps each query at50 ids and the account at200 queued sources', async () => {
    for (let offset = 0; offset < 200; offset += 50) {
      expect(await prioritize(Array.from({ length: 50 }, (_, n) => id(offset + n + 1))))
        .toMatchObject({ changed: 50, deferred: false });
    }
    expect(await count()).toBe(200);
    expect(await prioritize([id(201), id(202), id(203), id(204), id(205)]))
      .toMatchObject({ changed: 0, deferred: false });
    expect(await count()).toBe(200);
    expect(await prioritize([id(1), id(1)])).toMatchObject({ changed: 1 });
    expect(await count()).toBe(200);
    await expect(prioritize(Array.from({ length: 51 }, (_, n) => id(n + 1)))).rejects.toThrow('50');
    expect(await count()).toBe(200);
  });

  it('does not create work for unmatched, deleted, ineligible or foreign metadata ids', async () => {
    await db.query('UPDATE messages SET is_deleted=true WHERE id=$1', [id(1)]);
    await db.query("UPDATE messages SET folder='Spam' WHERE id=$1", [id(2)]);
    await db.query('UPDATE messages SET account_id=$1 WHERE id=$2', ['22222222-2222-4222-8222-222222222222', id(3)]);
    expect(await prioritize([id(1), id(2), id(3), id(999)])).toMatchObject({ changed: 0 });
    expect(await count()).toBe(0);
    expect((await db.query('SELECT count(*)::int AS n FROM search_index_jobs')).rows[0].n).toBe(205);
  });

  it('never steals running jobs or rewrites terminal, complete or newer-contract work', async () => {
    await db.query("UPDATE search_index_jobs SET state='complete' WHERE message_id=$1", [id(1)]);
    await db.query("UPDATE search_index_jobs SET state='running',lease_token=gen_random_uuid(),lease_expires_at=now()+interval '2 minutes' WHERE message_id=$1", [id(2)]);
    await db.query('UPDATE search_index_jobs SET source_generation=1 WHERE message_id=$1', [id(3)]);
    await db.query(`UPDATE search_index_jobs SET state='unsupported',unsupported_reason='structure-too-large',
      unsupported_folder=folder,unsupported_uid=uid,unsupported_uid_validity=uid_validity,
      unsupported_source_generation=source_generation,observed_download_bytes=264193,structure_overrun_bytes=1 WHERE message_id=$1`, [id(4)]);
    const before = (await db.query('SELECT * FROM search_index_jobs WHERE uid<=4 ORDER BY uid')).rows;
    expect(await prioritize([id(1), id(2), id(3), id(4)])).toMatchObject({ changed: 0 });
    expect((await db.query('SELECT * FROM search_index_jobs WHERE uid<=4 ORDER BY uid')).rows).toEqual(before);
  });

  it('requires ownership in the same account-control transaction and respects pause', async () => {
    expect(await prioritize([id(1)], { userId: 'foreign-owner' })).toMatchObject({ changed: 0, deferred: true });
    expect((await db.query('SELECT * FROM search_index_accounts')).rows).toEqual([]);
    await db.query('INSERT INTO search_index_accounts(account_id,paused) VALUES($1,true)', [accountId]);
    expect(await prioritize([id(1)])).toMatchObject({ changed: 0, deferred: true, reason: 'stopped' });
    expect(await count()).toBe(0);
  });

  it('does no database work when the lifecycle is closed or the caller aborts', async () => {
    query.mockClear(); withTransaction.mockClear(); open = false;
    expect(await prioritize([id(1)])).toMatchObject({ changed: 0, deferred: true, reason: 'stopped' });
    open = true; const controller = new AbortController(); controller.abort();
    expect(await prioritize([id(1)], { signal: controller.signal })).toMatchObject({ changed: 0, deferred: true });
    expect(query).not.toHaveBeenCalled(); expect(withTransaction).not.toHaveBeenCalled();
  });

  it('deduplicates ready provider siblings and rejects an obsolete physical key', async () => {
    profile = { labelStore: true };
    await db.query("INSERT INTO folders VALUES($1,'Archive',11,false,$2)", [accountId, '\\All']);
    await db.query('INSERT INTO archive_coverage(account_id,folder,uid_validity,bootstrap_complete) VALUES($1,$2,7,true),($1,$3,8,true)', [accountId, 'INBOX', 'Spam']);
    await db.query("UPDATE messages SET provider_msgid='901' WHERE uid IN(1,2)");
    // Readiness covers the entire normal-message inventory, not just these two hits.
    expect(await isIdentityBootstrapComplete(accountId, profile)).toBe(false);
    await db.query('UPDATE messages SET provider_msgid=(1000+uid)::text WHERE account_id=$1 AND provider_msgid IS NULL', [accountId]);
    expect(await isIdentityBootstrapComplete(accountId, profile)).toBe(true);
    await db.query(`INSERT INTO search_index_jobs(account_id,source_key,message_id,folder,uid,uid_validity,source_generation)
      VALUES($1,'provider:901',$2,'INBOX',1,7,0)`, [accountId, id(1)]);
    expect(await prioritize([id(1), id(2)])).toMatchObject({ changed: 1 });
    expect((await db.query('SELECT source_key FROM search_index_jobs WHERE priority_at IS NOT NULL')).rows)
      .toEqual([{ source_key: 'provider:901' }]);
  });

  it('drives the actual manager discovery and queued-priority path without opening a body', async () => {
    const manager = Object.create(ImapManager.prototype);
    const runBatch = vi.fn(async () => {});
    manager._searchIndex = createSearchIndexLifecycle({ runBatch, invalidateRun: async () => {} });
    manager._searchIndexSources = createSearchIndexSourceProducer({ isOpen: id => manager._searchIndex.isOpen(id) });
    await manager._searchIndex.resume(accountId);
    expect(await manager.prioritizeSearchMessages(accountId, [id(1), id(2)], { userId: owner }))
      .toMatchObject({ changed: 2, deferred: false });
    expect(await count()).toBe(2);
    expect(runBatch).not.toHaveBeenCalled();
    await manager._searchIndex.quiesce();
    query.mockClear();
    expect(await manager.prioritizeSearchMessages(accountId, [id(3)], { userId: owner }))
      .toMatchObject({ changed: 0, deferred: true, reason: 'stopped' });
    expect(query).not.toHaveBeenCalled();
  });

  it('returns busy from the actual manager without awaiting the active body batch or changing its lease', async () => {
    let release; const pending = new Promise(done => { release = done; });
    const manager = Object.create(ImapManager.prototype);
    manager._searchIndex = createSearchIndexLifecycle({ runBatch: async () => pending, invalidateRun: async () => {} });
    manager._searchIndexSources = createSearchIndexSourceProducer({ isOpen: id => manager._searchIndex.isOpen(id) });
    await manager._searchIndex.resume(accountId);
    const active = manager._searchIndex.run({ id: accountId });
    try {
      expect(await manager.prioritizeSearchMessages(accountId, [id(1)], { userId: owner }))
        .toMatchObject({ deferred: true, reason: 'active-batch' });
      expect(await count()).toBe(0);
    } finally { release(); await active; await manager._searchIndex.quiesce(); }
  });
});
