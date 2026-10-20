import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PassThrough, Readable } from 'node:stream';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import pg from 'pg';
vi.mock('./encryption.js', () => ({
  encrypt: value => 'enc:' + value,
  decrypt: value => value.startsWith('enc:') ? value.slice(4) : value,
  isEncrypted: value => value.startsWith('enc:'),
}));
import { restoreBackup, writeBackup } from './backup.js';

const account = '11111111-1111-4111-8111-111111111111';
const absent = '22222222-2222-4222-8222-222222222222';
const mib = 1024 ** 2;
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('backup quota PostgreSQL', () => {
  let db, peer, ownsTables = false;
  beforeAll(async () => {
    db = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await db.connect();
    // This runner targets the task-only database. Refuse to alter pre-existing public tables.
    const present = await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    if (present.rows.length) throw new Error('Backup fixture requires an empty task database public schema');
    await db.query(`BEGIN;
      CREATE TABLE schema_migrations(version text);
      INSERT INTO schema_migrations VALUES('0069_gmail_archive_coverage');
      CREATE TABLE users(id text PRIMARY KEY, username text);
      CREATE TABLE email_accounts(id uuid PRIMARY KEY, enabled boolean DEFAULT true, name text);
      CREATE TABLE messages(id bigint PRIMARY KEY, account_id uuid REFERENCES email_accounts ON DELETE CASCADE);
      ${readFileSync(new URL('../../migrations/0069_gmail_archive_coverage.sql', import.meta.url), 'utf8')}
      COMMIT;`);
    ownsTables = true;
    peer = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await peer.connect();
  });
  afterAll(async () => {
    await peer?.end();
    if (db) {
      await db.query('ROLLBACK');
      if (ownsTables) await db.query('DROP TABLE archive_coverage, background_download_debits, messages, email_accounts, users, schema_migrations');
      await db.end();
    }
  });
  async function seed(bytes, username, id = account) {
    await db.query('TRUNCATE users, email_accounts CASCADE');
    await db.query('INSERT INTO users VALUES($1,$2)', ['user-a', username]);
    await db.query('INSERT INTO email_accounts(id,name) VALUES($1,$2)', [id, username]);
    if (bytes != null) await db.query("INSERT INTO background_download_debits VALUES($1,'2026-10-20',$2)", [id, bytes]);
    await db.query("INSERT INTO archive_coverage(account_id,folder,uid_validity,bootstrap_complete) VALUES($1,$2,9,true)", [id, username]);
  }
  async function backup(scope = 'setup') {
    const out = new PassThrough(), chunks = [];
    out.on('data', chunk => chunks.push(chunk));
    await writeBackup(db, { scope, appVersion: '4.0.3', out });
    return Buffer.concat(chunks);
  }
  const debitRows = () => db.query('SELECT account_id,day::text,bytes::text FROM background_download_debits ORDER BY account_id,day');
  function alterBackup(bytes, change) {
    const lines = gunzipSync(bytes).toString('utf8').trim().split('\n').map(JSON.parse);
    change(lines);
    return gzipSync(lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  }
  for (const scope of ['setup', 'full']) it.each([
    ['same host', 800 * mib, 100 * mib, 800 * mib],
    ['fresh host', null, 100 * mib, 100 * mib],
    ['higher backup', 100 * mib, 800 * mib, 800 * mib],
    ['empty backup', 800 * mib, null, 800 * mib],
  ])(`${scope}: %s keeps the greater debit while replacing ordinary setup`, async (_name, current, incoming, expected) => {
    await seed(incoming, 'backup');
    const bytes = await backup(scope);
    if (current == null) await db.query('TRUNCATE users, email_accounts CASCADE');
    else {
      await seed(current, 'current');
      await db.query("INSERT INTO background_download_debits VALUES($1,'2026-10-19',3)", [account]);
    }
    await restoreBackup(db, Readable.from([bytes]));
    expect((await debitRows()).rows).toEqual([
      ...(current == null ? [] : [{ account_id: account, day: '2026-10-19', bytes: '3' }]),
      { account_id: account, day: '2026-10-20', bytes: String(expected) },
    ]);
    expect((await db.query('SELECT username FROM users')).rows).toEqual([{ username: 'backup' }]);
    expect((await db.query('SELECT name FROM email_accounts')).rows).toEqual([{ name: 'backup' }]);
    expect((await db.query('SELECT folder FROM archive_coverage')).rows).toEqual(scope === 'full' ? [{ folder: 'backup' }] : []);
  });
  it('skips absent accounts in current and incoming debits without weakening footer validation', async () => {
    await seed(100 * mib, 'backup');
    const bytes = alterBackup(await backup(), lines => {
      lines.find(line => line.table === 'background_download_debits').rows.push({ account_id: absent, day: '2026-10-20', bytes: '7' });
      lines.at(-1).rowCounts.background_download_debits++;
    });
    await seed(800 * mib, 'current', absent);
    const result = await restoreBackup(db, Readable.from([bytes]));
    expect((await debitRows()).rows).toEqual([{ account_id: account, day: '2026-10-20', bytes: String(100 * mib) }]);
    expect(result.rows).toBe(3); // One user, one account, one imported debit; the orphan is skipped.
    const bad = alterBackup(bytes, lines => { lines.at(-1).rowCounts.background_download_debits++; });
    await expect(restoreBackup(db, Readable.from([bad]))).rejects.toThrow(/inconsistent/);
    expect((await debitRows()).rows).toEqual([{ account_id: account, day: '2026-10-20', bytes: String(100 * mib) }]);
  });
  it('rolls back the snapshot, cascade and restore together on an invalid file', async () => {
    await seed(100 * mib, 'backup');
    const bytes = alterBackup(await backup(), lines => { lines.at(-1).rowCounts.background_download_debits++; });
    await seed(800 * mib, 'current');
    await expect(restoreBackup(db, Readable.from([bytes]))).rejects.toThrow(/inconsistent/);
    expect((await debitRows()).rows[0].bytes).toBe(String(800 * mib));
    expect((await db.query('SELECT username FROM users')).rows).toEqual([{ username: 'current' }]);
  });
  it('blocks a concurrent atomic debit until restore commits, then retains both charges', async () => {
    await seed(100 * mib, 'backup');
    const bytes = await backup();
    await seed(800 * mib, 'current');
    let writer;
    const client = { async query(sql, args) {
      const result = await db.query(sql, args);
      if (typeof sql === 'string' && sql.startsWith('SELECT account_id, day::text')) {
        writer = peer.query(`INSERT INTO background_download_debits(account_id,day,bytes)
          SELECT id,'2026-10-20'::date,5 FROM email_accounts WHERE id=$1 AND enabled
          ON CONFLICT(account_id,day) DO UPDATE SET bytes=background_download_debits.bytes+EXCLUDED.bytes`, [account]);
        const deadline = Date.now() + 2000;
        let blocked = false;
        while (!blocked && Date.now() < deadline) {
          blocked = (await db.query('SELECT $1::int=ANY(pg_blocking_pids($2)) AS blocked', [db.processID, peer.processID])).rows[0].blocked;
          if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
      }
      return result;
    } };
    try {
      await restoreBackup(client, Readable.from([bytes]));
      expect(writer).toBeDefined();
      await writer;
      expect((await debitRows()).rows[0].bytes).toBe(String(800 * mib + 5));
    } finally { await db.query('ROLLBACK'); await writer; }
  });
});
