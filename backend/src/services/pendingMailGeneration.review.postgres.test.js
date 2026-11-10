import { randomBytes } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ pool: null }));
vi.mock('./db.js', () => ({
  pool: { connect: (...args) => h.pool.connect(...args) },
  query: (...args) => h.pool.query(...args),
}));
import { runMigrations } from './migrations.js';
import { applyStorageIdentityDecision, getIdentityStatus } from './messageIdentity.js';
import { restoreBackup, writeBackup } from './backup.js';

const ADMIN_URL = process.env.MAILFLOW_TEST_DATABASE_URL;
describe.skipIf(!ADMIN_URL)('independent pending-job replacement review on PostgreSQL', () => {
  const dbName = `mailflow_job_review_${randomBytes(5).toString('hex')}`;
  let admin, account;
  beforeAll(async () => {
    vi.stubEnv('ENCRYPTION_KEY', '8b'.repeat(32));
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${dbName}`;
    h.pool = new pg.Pool({ connectionString: url.toString(), max: 6 });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runMigrations();
  }, 60_000);
  afterAll(async () => {
    await h.pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  beforeEach(async () => {
    await h.pool.query('TRUNCATE users CASCADE');
    const owner = (await h.pool.query("INSERT INTO users(username) VALUES ('job-review') RETURNING id")).rows[0];
    account = (await h.pool.query("INSERT INTO email_accounts(user_id,name,email_address) VALUES($1,'Mailbox','review@example.test') RETURNING *", [owner.id])).rows[0];
  });
  const replace = client => applyStorageIdentityDecision(client, {
    accountId: account.id, expectedGeneration: account.storage_generation, decision: 'replace',
  });
  const transaction = async fn => {
    const client = await h.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  };
  const waitBlocked = async pid => {
    for (let i = 0; i < 200; i++) {
      if ((await h.pool.query('SELECT cardinality(pg_blocking_pids($1)) AS n', [pid])).rows[0].n) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Activation did not wait for the replacement account lock');
  };
  const cancelled = async () => (await h.pool.query(`INSERT INTO scheduled_messages
    (user_id,account_id,client_key,send_at,due_at,storage_generation,status,status_before,purge_after)
    VALUES($1,$2,gen_random_uuid(),NOW()+INTERVAL '1 day',NOW()+INTERVAL '1 day',$3,'cancelled','scheduled',NOW()+INTERVAL '10 minutes') RETURNING *`,
  [account.user_id, account.id, account.storage_generation])).rows[0];
  const disabledRule = async () => (await h.pool.query(`INSERT INTO inbox_rules(user_id,account_id,storage_generation,enabled)
    VALUES($1,$2,$3,false) RETURNING *`, [account.user_id, account.id, account.storage_generation])).rows[0];
  const replacementWins = async activate => {
    const replacer = await h.pool.connect(), activator = await h.pool.connect();
    try {
      await replacer.query('BEGIN');
      await replace(replacer);
      const pid = (await activator.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const pending = activate(activator).then(value => ({ value }), error => ({ error }));
      await waitBlocked(pid);
      await replacer.query('COMMIT');
      expect((await pending).error).toMatchObject({ code: '23514', message: expect.stringContaining('storage_generation_conflict:') });
    } finally {
      await replacer.query('ROLLBACK');
      replacer.release();
      activator.release();
    }
  };

  it.each(['scheduled', 'editing', 'sending', 'paused', 'failed', 'uncertain'])('rejects concurrent revival to %s after replacement wins without dropping the old job', async status => {
    const job = await cancelled();
    await replacementWins(client => client.query('UPDATE scheduled_messages SET status=$2 WHERE id=$1', [job.id, status]));
    expect((await h.pool.query('SELECT * FROM scheduled_messages WHERE id=$1', [job.id])).rows[0]).toMatchObject({
      status: 'cancelled', storage_generation: account.storage_generation, status_before: 'scheduled',
    });
  });

  it('rejects concurrent rule enable after replacement wins, while enabled global rules stay global', async () => {
    const rule = await disabledRule();
    const global = (await h.pool.query('INSERT INTO inbox_rules(user_id) VALUES($1) RETURNING *', [account.user_id])).rows[0];
    await replacementWins(client => client.query('UPDATE inbox_rules SET enabled=true WHERE id=$1', [rule.id]));
    expect((await h.pool.query('SELECT * FROM inbox_rules WHERE id=$1', [rule.id])).rows[0]).toMatchObject({ enabled: false, storage_generation: account.storage_generation });
    expect((await h.pool.query('SELECT * FROM inbox_rules WHERE id=$1', [global.id])).rows[0]).toMatchObject({ enabled: true, account_id: null, storage_generation: null });
  });

  it.each(['setup', 'full'])('round-trips held prior-generation jobs through %s backup without adopting or losing them', async scope => {
    const job = await cancelled(), rule = await disabledRule();
    const snooze = (await h.pool.query(`INSERT INTO snoozed_messages(user_id,account_id,message_id_header,original_folder,snooze_until,storage_generation)
      VALUES($1,$2,'<held@example.test>','INBOX',NOW()+INTERVAL '1 day',$3) RETURNING *`,
    [account.user_id, account.id, account.storage_generation])).rows[0];
    const replacement = await transaction(replace);
    const out = new PassThrough(), chunks = [];
    out.on('data', chunk => chunks.push(chunk));
    const client = await h.pool.connect();
    try {
      await writeBackup(client, { scope, appVersion: 'review', out });
      await restoreBackup(client, Readable.from([Buffer.concat(chunks)]));
    } finally { client.release(); }
    expect((await h.pool.query('SELECT storage_generation FROM email_accounts WHERE id=$1', [account.id])).rows[0].storage_generation).toBe(replacement.storageGeneration);
    expect((await h.pool.query('SELECT * FROM scheduled_messages WHERE id=$1', [job.id])).rows[0]).toMatchObject({ status: 'cancelled', storage_generation: account.storage_generation });
    expect((await h.pool.query('SELECT * FROM inbox_rules WHERE id=$1', [rule.id])).rows[0]).toMatchObject({ enabled: false, storage_generation: account.storage_generation });
    expect((await h.pool.query('SELECT * FROM snoozed_messages WHERE id=$1', [snooze.id])).rows[0]).toMatchObject({ storage_generation: account.storage_generation });
    expect(await getIdentityStatus(account.id)).toMatchObject({ heldSnoozeCount: '1' });
    await expect(h.pool.query("UPDATE scheduled_messages SET status='scheduled' WHERE id=$1", [job.id])).rejects.toMatchObject({ code: '23514' });
    await expect(h.pool.query('UPDATE inbox_rules SET enabled=true WHERE id=$1', [rule.id])).rejects.toMatchObject({ code: '23514' });
  });
});
