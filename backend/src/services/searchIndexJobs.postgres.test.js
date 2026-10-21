import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import pg from 'pg';

vi.mock('./db.js', () => ({ withTransaction: vi.fn() }));
import { withTransaction } from './db.js';
import {
  claimSearchIndexJob, enqueueSearchIndexJob, guardSearchIndexJob,
  heartbeatSearchIndexJob, invalidateSearchIndexRun, pendingSearchBodyBytes,
  readSearchIndexJobState, resetSearchIndexLeasesAfterRestore, setSearchCoverageAction, settleSearchIndexJob,
} from './searchIndexJobs.js';

const account = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const message = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const source = (n = 1, extra = {}) => ({ sourceKey: `physical:${n}`, messageId: message(n),
  folder: 'INBOX', uid: String(n), uidValidity: '7', sourceGeneration: '1', ...extra });
const generationId = '33333333-3333-4333-8333-333333333333';
const outcomes = [
  ['deferred', { status: 'deferred', deferAt: 2000000000000, bodyBytes: 17055744,
    identity: { accountId: account, folder: 'INBOX', uid: 1, uidValidity: '7' } }],
  ['clear bound', { status: 'retry', reason: 'bound-changed', deferAt: 2000000000000 }],
  ['unsupported', { status: 'unsupported', reason: 'structure-too-large', downloadBytes: 264193, structureOverrunBytes: 1 }],
  ['failed', { status: 'failed', reason: 'missing-part', deferAt: 2000000000000 }],
  ['cancelled', { status: 'cancelled', deferAt: 2000000000000 }],
  ['complete', { status: 'complete', generationId }],
];

// Authoring only until the lead supplies a dedicated task DB and focused slot.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('durable search index job state', () => {
  const schema = `index_jobs_${process.pid}`;
  let db, peer;
  const tx = async (client, fn) => {
    await client.query('BEGIN');
    try { const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (err) { await client.query('ROLLBACK'); throw err; }
  };
  const job = async key => (await db.query('SELECT * FROM search_index_jobs WHERE account_id=$1 AND source_key=$2',
    [account, key || 'physical:1'])).rows[0];
  const expire = () => db.query("UPDATE search_index_jobs SET lease_expires_at=now()-interval '1 second' WHERE account_id=$1", [account]);
  const guard = claim => tx(db, client => guardSearchIndexJob(client, claim));

  beforeAll(async () => {
    db = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    peer = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await db.connect(); await peer.connect();
    await db.query(`CREATE SCHEMA ${schema}`);
    await peer.query(`SET search_path TO ${schema}`);
    withTransaction.mockImplementation(fn => tx(db, fn));
  });
  afterAll(async () => {
    if (peer) await peer.end();
    if (db) { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.end(); }
  });
  beforeEach(async () => {
    await db.query(`SET search_path TO ${schema}; DROP TABLE IF EXISTS search_index_jobs,search_index_accounts,messages,folders,email_accounts CASCADE;
      CREATE TABLE email_accounts(id uuid PRIMARY KEY,enabled boolean DEFAULT true,user_id text DEFAULT 'coverage-owner');
      CREATE TABLE folders(account_id uuid REFERENCES email_accounts ON DELETE CASCADE,path text,uid_validity bigint,PRIMARY KEY(account_id,path));
      CREATE TABLE messages(id uuid PRIMARY KEY,account_id uuid REFERENCES email_accounts ON DELETE CASCADE,folder text,uid bigint,date timestamptz,is_deleted boolean DEFAULT false);
      INSERT INTO email_accounts(id,enabled) VALUES ('${account}',true),('${other}',true);
      INSERT INTO folders VALUES ('${account}','INBOX',7),('${other}','INBOX',7);
      INSERT INTO messages VALUES ('${message(1)}','${account}','INBOX',1,now(),false),
        ('${message(2)}','${account}','INBOX',2,now()+interval '1 day',false);`);
    await db.query(readFileSync(new URL('../../migrations/0075_search_index_jobs.sql', import.meta.url), 'utf8'));
    withTransaction.mockImplementation(fn => tx(db, fn));
  });

  it('claims newest first, reclaims expiry, and permits only one running job per account', async () => {
    await enqueueSearchIndexJob(account, source());
    await enqueueSearchIndexJob(account, source(2));
    const first = await claimSearchIndexJob(account);
    expect(first.source_key).toBe('physical:2');
    expect(await claimSearchIndexJob(account)).toBeNull();
    await expire();
    const next = await claimSearchIndexJob(account);
    expect(next.source_key).toBe(first.source_key);
    expect(BigInt(next.lease_epoch)).toBe(BigInt(first.lease_epoch) + 1n);
    expect(next.lease_token).not.toBe(first.lease_token);
    expect(await guard(first)).toBe(false);
    expect(await guard(next)).toBe(true);
  });

  it('reads scoped job counts separately from body verification', async () => {
    await enqueueSearchIndexJob(account, source());
    await enqueueSearchIndexJob(account, source(2));
    expect(await readSearchIndexJobState(account, { userId: 'coverage-owner' })).toEqual({
      paused: false, jobCounts: { queued: 2, running: 0, complete: 0, failed: 0, unsupported: 0 },
    });
    expect(await readSearchIndexJobState(account, { userId: 'different-owner' })).toBeNull();
    await claimSearchIndexJob(account);
    expect((await readSearchIndexJobState(account)).jobCounts).toEqual({ queued: 1, running: 1, complete: 0, failed: 0, unsupported: 0 });
  });

  it('checks current ownership inside the account-control transaction', async () => {
    await enqueueSearchIndexJob(account, source());
    const before = await job();
    expect(await setSearchCoverageAction(account, 'pause', { userId: 'different-owner' })).toBeNull();
    expect(await job()).toEqual(before);
    expect((await readSearchIndexJobState(account)).paused).toBe(false);
    await setSearchCoverageAction(account, 'pause', { userId: 'coverage-owner' });
    expect((await readSearchIndexJobState(account)).paused).toBe(true);
  });

  it('lets Trash rewrite and delete finish while publication holds the job row, leaving its locator untouched', async () => {
    await enqueueSearchIndexJob(account, source());
    const before = await job();
    let peerActive = false;
    await db.query('BEGIN');
    try {
      await db.query('SELECT * FROM search_index_jobs WHERE account_id=$1 AND source_key=$2 FOR UPDATE', [account, 'physical:1']);
      await peer.query('BEGIN');
      peerActive = true;
      await peer.query("SET LOCAL lock_timeout='500ms'");
      // Exact post-IMAP storage operation from deleteMessage, followed by the
      // parent deletion used by reconcile/expunge. Neither may lock the job.
      const { rows: [moved] } = await peer.query(`UPDATE messages SET folder=$1,uid=$2,id=gen_random_uuid()
        WHERE id=$3 RETURNING id`, ['Trash', 91, message(1)]);
      expect(moved.id).not.toBe(message(1));
      expect((await peer.query('DELETE FROM messages WHERE id=$1 RETURNING id', [moved.id])).rows)
        .toEqual([{ id: moved.id }]);
      await peer.query('COMMIT');
      peerActive = false;
      expect(await job()).toEqual(before);
    } finally {
      try { if (peerActive) await peer.query('ROLLBACK'); }
      finally { await db.query('ROLLBACK'); }
    }
    expect(await job()).toEqual(before);
    expect((await db.query('SELECT id FROM messages WHERE id=$1', [message(1)])).rows).toEqual([]);
  });

  it.each(['enqueue', 'claim'])('allows an identity account fence while %s holds the control write lock', async operation => {
    await enqueueSearchIndexJob(account, source());
    let markHeld, release;
    const held = new Promise(resolve => { markHeld = resolve; });
    const resume = new Promise(resolve => { release = resolve; });
    withTransaction.mockImplementation(fn => tx(db, client => fn({ query: async (sql, params) => {
      const result = await client.query(sql, params);
      if (/SELECT \* FROM search_index_accounts .*FOR UPDATE/.test(sql)) {
        markHeld(); await resume;
      }
      return result;
    } })));
    const pending = operation === 'enqueue' ? enqueueSearchIndexJob(account, source(2)) : claimSearchIndexJob(account);
    let peerActive = false;
    try {
      await Promise.race([held, pending.then(() => { throw new Error('Control lock barrier not reached'); })]);
      await peer.query('BEGIN');
      peerActive = true;
      await peer.query("SET LOCAL lock_timeout='500ms'");
      // Native account SHARE fence used by identity writes; no dependency on
      // the separately owned identity implementation, absent from this base.
      expect((await peer.query('SELECT id FROM email_accounts WHERE id=$1 AND enabled FOR SHARE', [account])).rows)
        .toEqual([{ id: account }]);
      await peer.query(`INSERT INTO messages(id,account_id,folder,uid,date) VALUES ($1,$2,'INBOX',3,now())`, [message(3), account]);
      await peer.query('COMMIT');
      peerActive = false;
    } finally {
      try { if (peerActive) await peer.query('ROLLBACK'); }
      finally { release(); await pending; }
    }
    expect((await db.query('SELECT id FROM messages WHERE id=$1', [message(3)])).rows).toEqual([{ id: message(3) }]);
  });

  it('serializes concurrent claims on the real control row', async () => {
    await enqueueSearchIndexJob(account, source());
    await enqueueSearchIndexJob(account, source(2));
    let connections = 0;
    withTransaction.mockImplementation(fn => tx(connections++ === 0 ? db : peer, fn));
    const claims = await Promise.all([claimSearchIndexJob(account), claimSearchIndexJob(account)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await db.query("SELECT count(*)::int AS n FROM search_index_jobs WHERE state='running'")).rows[0].n).toBe(1);
  });

  it.each(outcomes)('fences stale %s writes without changing the replacement row', async (_name, outcome) => {
    await enqueueSearchIndexJob(account, source());
    const old = await claimSearchIndexJob(account);
    await expire();
    await claimSearchIndexJob(account);
    const before = await job();
    expect(await settleSearchIndexJob(old, outcome)).toBe(false);
    expect(await job()).toEqual(before);
  });

  it('fences heartbeat and stale-job without any outcome write', async () => {
    await enqueueSearchIndexJob(account, source());
    const old = await claimSearchIndexJob(account);
    await expire(); await claimSearchIndexJob(account);
    const before = await job();
    expect(await heartbeatSearchIndexJob(old)).toBe(false);
    expect(await settleSearchIndexJob(old, { status: 'stale-job' })).toBe(false);
    expect(await job()).toEqual(before);
  });

  it.each(outcomes)('compares captured run_epoch for %s even when lease token and epoch match', async (_name, outcome) => {
    await enqueueSearchIndexJob(account, source());
    const old = await claimSearchIndexJob(account);
    await db.query('UPDATE search_index_accounts SET run_epoch=run_epoch+2 WHERE account_id=$1', [account]);
    const before = await job();
    expect(await settleSearchIndexJob(old, outcome)).toBe(false);
    expect(await heartbeatSearchIndexJob(old)).toBe(false);
    expect(await guard(old)).toBe(false);
    expect(await job()).toEqual(before);
  });

  it('pause/resume A/B/A and bigint epochs invalidate old claims without rounding', async () => {
    await enqueueSearchIndexJob(account, source());
    await db.query("UPDATE search_index_accounts SET run_epoch=9007199254740993 WHERE account_id=$1", [account]);
    await db.query("UPDATE search_index_jobs SET lease_epoch=9007199254740993 WHERE account_id=$1", [account]);
    const old = await claimSearchIndexJob(account);
    expect(old.run_epoch).toBe('9007199254740993');
    expect(old.lease_epoch).toBe('9007199254740994');
    await setSearchCoverageAction(account, 'pause');
    expect(await claimSearchIndexJob(account)).toBeNull();
    await setSearchCoverageAction(account, 'resume');
    expect(await guard(old)).toBe(false);
    const next = await claimSearchIndexJob(account);
    expect(next.run_epoch).toBe('9007199254740995');
  });

  it('persists the deferred bound as a quotation and clears it on bound-changed', async () => {
    await enqueueSearchIndexJob(account, source());
    const claim = await claimSearchIndexJob(account);
    expect(await settleSearchIndexJob(claim, outcomes[0][1])).toBe(true);
    const deferred = await job();
    expect(deferred.state).toBe('queued');
    expect(deferred.attempts).toBe(0);
    expect(pendingSearchBodyBytes(deferred)).toBe(17055744);
    expect(await claimSearchIndexJob(account)).toBeNull();
    await db.query('UPDATE search_index_jobs SET defer_at=now() WHERE account_id=$1', [account]);
    const retry = await claimSearchIndexJob(account);
    expect(pendingSearchBodyBytes(retry)).toBe(17055744);
    await settleSearchIndexJob(retry, outcomes[1][1]);
    expect(pendingSearchBodyBytes(await job())).toBeUndefined();
  });

  it('invalidates a pending quotation on physical epoch or source-generation change', async () => {
    await enqueueSearchIndexJob(account, source());
    await settleSearchIndexJob(await claimSearchIndexJob(account), outcomes[0][1]);
    await db.query('UPDATE folders SET uid_validity=8 WHERE account_id=$1', [account]);
    await enqueueSearchIndexJob(account, source(1, { uidValidity: '8', sourceGeneration: '2' }));
    expect(pendingSearchBodyBytes(await job())).toBeUndefined();
    expect((await job()).source_generation).toBe('2');
    expect(await enqueueSearchIndexJob(account, source(1, { uidValidity: '8' }))).toBe(false);
    expect((await job()).source_generation).toBe('2');
  });

  it('counts a failed attempt but neither cancellation nor deferral, and does not extend an expired lease', async () => {
    await enqueueSearchIndexJob(account, source());
    const failed = await claimSearchIndexJob(account);
    await settleSearchIndexJob(failed, outcomes[3][1]);
    expect((await job()).attempts).toBe(1);
    await setSearchCoverageAction(account, 'retry');
    const cancelled = await claimSearchIndexJob(account);
    await settleSearchIndexJob(cancelled, outcomes[4][1]);
    expect((await job()).attempts).toBe(0);
    await db.query('UPDATE search_index_jobs SET defer_at=now()');
    const expired = await claimSearchIndexJob(account);
    await expire();
    const before = await job();
    expect(await heartbeatSearchIndexJob(expired)).toBe(false);
    expect(await job()).toEqual(before);
  });

  it('never selects terminal structure-too-large again on retry, resume or restored leases', async () => {
    await enqueueSearchIndexJob(account, source());
    const claim = await claimSearchIndexJob(account);
    await settleSearchIndexJob(claim, outcomes[2][1]);
    const terminal = await job();
    expect(terminal.state).toBe('unsupported');
    expect(terminal.observed_download_bytes).toBe('264193');
    expect(terminal.structure_overrun_bytes).toBe('1');
    for (const action of ['retry', 'pause', 'resume']) {
      await setSearchCoverageAction(account, action);
      expect(await claimSearchIndexJob(account)).toBeNull();
    }
    await tx(db, resetSearchIndexLeasesAfterRestore);
    expect(await claimSearchIndexJob(account)).toBeNull();
    await enqueueSearchIndexJob(account, source());
    expect(await claimSearchIndexJob(account)).toBeNull();
    await enqueueSearchIndexJob(account, source(1, { sourceGeneration: '2' }));
    expect(await claimSearchIndexJob(account)).not.toBeNull();
  });

  it('restored lower epochs cannot make an in-memory pre-restore claim valid', async () => {
    await enqueueSearchIndexJob(account, source());
    await db.query('UPDATE search_index_jobs SET lease_epoch=99');
    const old = await claimSearchIndexJob(account);
    await db.query('UPDATE search_index_jobs SET lease_epoch=1');
    await db.query('UPDATE search_index_accounts SET run_epoch=0');
    await tx(db, resetSearchIndexLeasesAfterRestore);
    const restored = await job();
    expect(restored.state).toBe('queued');
    expect(restored.lease_token).toBeNull(); expect(restored.lease_expires_at).toBeNull();
    expect(await guard(old)).toBe(false);
    expect(await settleSearchIndexJob(old, outcomes[5][1])).toBe(false);
    expect(await job()).toEqual(restored);
  });

  it('does not resurrect deleted accounts or let retry steal running/complete jobs', async () => {
    await enqueueSearchIndexJob(account, source());
    const claim = await claimSearchIndexJob(account);
    await setSearchCoverageAction(account, 'retry');
    expect(await guard(claim)).toBe(true);
    await settleSearchIndexJob(claim, outcomes[5][1]);
    await setSearchCoverageAction(account, 'retry');
    expect((await job()).generation_id).toBe(generationId);
    expect(await claimSearchIndexJob(account)).toBeNull();
    await db.query('DELETE FROM email_accounts WHERE id=$1', [account]);
    expect(await claimSearchIndexJob(account)).toBeNull();
    expect(await setSearchCoverageAction(account, 'resume')).toBeNull();
    expect((await db.query('SELECT * FROM search_index_accounts')).rows).toEqual([]);
  });

  it('requires a live source locator and enabled account without borrowing another account message', async () => {
    expect(await enqueueSearchIndexJob(other, source())).toBe(false);
    expect(await enqueueSearchIndexJob(account, source(1, { uid: '99' }))).toBe(false);
    expect(await enqueueSearchIndexJob(account, source(1, { uidValidity: '99' }))).toBe(false);
    await enqueueSearchIndexJob(account, source());
    const claim = await claimSearchIndexJob(account);
    await db.query('UPDATE email_accounts SET enabled=false WHERE id=$1', [account]);
    const before = await job();
    expect(await guard(claim)).toBe(false);
    expect(await settleSearchIndexJob(claim, outcomes[5][1])).toBe(false);
    expect(await job()).toEqual(before);
  });

  it('rejects partial pending/terminal groups, negative bounds and unknown states in PostgreSQL', async () => {
    await enqueueSearchIndexJob(account, source());
    for (const assignment of ["pending_folder='INBOX'", 'pending_body_bytes=-1',
      "unsupported_reason='structure-too-large'", "state='invented'"]) {
      await expect(db.query(`UPDATE search_index_jobs SET ${assignment} WHERE account_id=$1`, [account])).rejects.toMatchObject({ code: '23514' });
    }
    await db.query("UPDATE search_index_jobs SET pending_folder='INBOX',pending_uid=1,pending_uid_validity=7,pending_body_bytes=0 WHERE account_id=$1", [account]);
    expect(pendingSearchBodyBytes(await job())).toBe(0);
    await expect(db.query('UPDATE search_index_jobs SET pending_body_bytes=-1')).rejects.toMatchObject({ code: '23514' });
    for (const column of ['pending_folder', 'pending_uid', 'pending_uid_validity', 'pending_body_bytes']) {
      await expect(db.query(`UPDATE search_index_jobs SET ${column}=NULL`)).rejects.toMatchObject({ code: '23514' });
    }
    const claim = await claimSearchIndexJob(account);
    await settleSearchIndexJob(claim, outcomes[2][1]);
    for (const column of ['unsupported_reason', 'unsupported_folder', 'unsupported_uid', 'unsupported_uid_validity',
      'unsupported_source_generation', 'observed_download_bytes', 'structure_overrun_bytes']) {
      await expect(db.query(`UPDATE search_index_jobs SET ${column}=NULL`)).rejects.toMatchObject({ code: '23514' });
    }
  });

  it.each([1, 42, 0xdeadbeef])('preserves lease invariants through seeded operation sequences (seed %s)', async seed => {
    await enqueueSearchIndexJob(account, source());
    const claims = [];
    let random = seed >>> 0;
    for (let step = 0; step < 24; step++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const operation = random % 6;
      if (operation === 0) { const claim = await claimSearchIndexJob(account); if (claim) claims.push(claim); }
      if (operation === 1) await setSearchCoverageAction(account, 'pause');
      if (operation === 2) await setSearchCoverageAction(account, 'resume');
      if (operation === 3) await setSearchCoverageAction(account, 'retry');
      if (operation === 4) await invalidateSearchIndexRun(account);
      if (operation === 5) await expire();
      const current = await job();
      for (const claim of claims) {
        if (claim.lease_token !== current.lease_token || claim.run_epoch !== current.run_epoch) {
          const before = await job();
          expect(await settleSearchIndexJob(claim, outcomes[4][1]), `seed=${seed},step=${step}`).toBe(false);
          expect(await job()).toEqual(before);
        }
      }
      expect((await db.query("SELECT count(*)::int AS n FROM search_index_jobs WHERE state='running'")).rows[0].n).toBeLessThanOrEqual(1);
    }
  });
});
