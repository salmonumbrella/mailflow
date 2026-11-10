import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

vi.mock('./messageIdentity.js', () => import('./testSupport/identityTestAdapter.js'));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn() }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('./mailAccess.js', () => ({ getAccountAddresses: vi.fn(async () => []) }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
vi.mock('../index.js', () => ({ imapManager: {} }));
import { query } from './db.js';
import { ImapManager, insertCopiedSibling } from './imapManager.js';
import { RELOCATE_INSERT_COLS } from '../routes/mail.js';

// Explicitly opt-in disposable PostgreSQL, connection-local temp tables only.
// Execute the actual ingestion/copy SQL, not a reimplementation of COALESCE in JS.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('RFC822.SIZE storage lifecycle on PostgreSQL', () => {
  let database;
  const account = { id: '22222222-2222-4222-8222-222222222222', user_id: 'u-size',
    email_address: 'me@example.test', imap_host: 'imap.gmail.com' };
  const migration = new URL('../../migrations/0078_messages_rfc822_size.sql', import.meta.url);
  const sizeOf = async (uid, folder = 'INBOX') => (await database.query(
    'SELECT rfc822_size_bytes FROM messages WHERE account_id=$1 AND uid=$2 AND folder=$3',
    [account.id, uid, folder])).rows[0]?.rfc822_size_bytes;

  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    const baseline = await readFile(new URL('../../migrations/0001_baseline.sql', import.meta.url), 'utf8');
    const create = baseline.match(/CREATE TABLE IF NOT EXISTS messages \([\s\S]*?\n\);/)[0]
      .replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE')
      .replace('REFERENCES email_accounts(id) ON DELETE CASCADE', '');
    await database.query(create);
    const columns = new Set((await database.query(`SELECT attname FROM pg_attribute
      WHERE attrelid = 'pg_temp.messages'::regclass AND attnum > 0`)).rows.map(r => r.attname));
    const types = { is_bulk: 'boolean', bcc_addresses: 'jsonb', delivery_addresses: 'jsonb', plugin_annotations: 'jsonb' };
    for (const col of RELOCATE_INSERT_COLS.split(',').map(s => s.trim())) {
      if (!columns.has(col) && col !== 'rfc822_size_bytes') {
        await database.query(`ALTER TABLE messages ADD COLUMN ${col} ${types[col] || 'text'}`);
      }
    }
    // The migration must leave already cached mail unknown, not measured as zero.
    await database.query(`INSERT INTO messages(account_id, uid) VALUES ($1, 1)`, [account.id]);
    await database.query(await readFile(migration, 'utf8'));
    expect(await sizeOf(1)).toBeNull();
  });
  afterAll(async () => { await database?.end(); });
  beforeEach(async () => {
    await database.query('TRUNCATE messages');
    query.mockReset().mockImplementation(async (sql, values) => {
      if (sql.includes('INSERT INTO messages')) return database.query(sql, values);
      if (sql.includes('COUNT(*) FILTER (WHERE is_read = false)')) return { rows: [{ n: 0 }] };
      if (sql.includes('COALESCE(MAX(uid), 0)')) return { rows: [{ max_uid: 0 }] };
      if (sql.includes('SELECT uid_validity')) return { rows: [{ uid_validity: 1 }] };
      return { rows: [] };
    });
  });

  async function syncSize(size) {
    const client = { getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 1, uidValidity: 1 }, noop: vi.fn(),
      fetch: vi.fn(async function* () { yield { uid: 1, size, flags: new Set(['\\Seen']),
        envelope: { subject: 'Measured', from: [{ address: 'a@example.test' }] } }; }) };
    const manager = { pluginFacade: {}, maybeClassifyNewMessage: vi.fn() };
    await ImapManager.prototype.syncMessages.call(manager, account, client, 'INBOX', 20, false, true);
    expect(client.fetch.mock.calls[0][1].size).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO messages'))).toBe(true);
  }

  it('enforces the same safe range as FETCH normalization and preserves decimal strings', async () => {
    for (const value of [null, '0', '9007199254740991']) {
      await database.query('INSERT INTO messages(account_id, uid, rfc822_size_bytes) VALUES ($1,1,$2)', [account.id, value]);
      expect(await sizeOf(1)).toBe(value);
      await database.query('TRUNCATE messages');
    }
    for (const value of ['-1', '9007199254740992']) {
      await expect(database.query('INSERT INTO messages(account_id, uid, rfc822_size_bytes) VALUES ($1,1,$2)', [account.id, value]))
        .rejects.toMatchObject({ code: '23514' });
    }
  });

  it('normal ingestion replaces measurements but preserves them on omission or invalid size', async () => {
    await syncSize(100);
    expect(await sizeOf(1)).toBe('100');
    await syncSize(undefined);
    expect(await sizeOf(1)).toBe('100');
    await syncSize(-1);
    expect(await sizeOf(1)).toBe('100');
    await syncSize(0);
    expect(await sizeOf(1)).toBe('0');
  });

  it('cache eviction/reinsert does not inherit the old measurement', async () => {
    await syncSize(100);
    await database.query('DELETE FROM messages');
    await syncSize(undefined);
    expect(await sizeOf(1)).toBeNull();
  });

  it.each(['Sent', 'Drafts'])('locally appended %s rows remain unknown without a server measurement', async folder => {
    const save = folder === 'Sent' ? 'upsertSentMessageRecord' : 'upsertDraftMessageRecord';
    const meta = { messageId: null, subject: 'Local', bodyText: 'not server byte length',
      bodyHtml: '<b>not size</b>', size: 999, rfc822SizeBytes: 999, hasAttachments: true };
    await ImapManager.prototype[save].call({}, account, folder, 1, meta);
    expect(await sizeOf(1, folder)).toBeNull();
    await database.query('UPDATE messages SET rfc822_size_bytes = 1234');
    await ImapManager.prototype[save].call({}, account, folder, 1, meta);
    expect(await sizeOf(1, folder)).toBeNull();
  });

  it.each(['Sent', 'Drafts'].flatMap(folder => [null, '<old@test>', '<replacement@test>']
    .map(messageId => ({ folder, messageId }))))('local $folder replacement clears size for incoming ID $messageId without an APPEND epoch', async ({ folder, messageId }) => {
    await database.query(`INSERT INTO messages(account_id, uid, folder, message_id, rfc822_size_bytes)
      VALUES ($1,1,$2,'<old@test>',1234)`, [account.id, folder]);
    const save = folder === 'Sent' ? 'upsertSentMessageRecord' : 'upsertDraftMessageRecord';
    await ImapManager.prototype[save].call({}, account, folder, 1, { messageId, subject: 'Local' });
    expect(await sizeOf(1, folder)).toBeNull();
  });

  it('copies a confirmed physical source, scoped by account, and keeps a racing destination authoritative', async () => {
    await database.query(`INSERT INTO messages(account_id, uid, folder, message_id, rfc822_size_bytes)
      VALUES ($1,1,'INBOX','<duplicate@test>',100),
        ('33333333-3333-4333-8333-333333333333',1,'INBOX','<duplicate@test>',200)`, [account.id]);
    await insertCopiedSibling(account.id, 1, 'INBOX', 'Projects', 10);
    expect(await sizeOf(10, 'Projects')).toBe('100');
    await database.query("UPDATE messages SET rfc822_size_bytes=300 WHERE folder='Projects'");
    await insertCopiedSibling(account.id, 1, 'INBOX', 'Projects', 10);
    expect(await sizeOf(10, 'Projects')).toBe('300');
  });
});
