import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn() }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('./spamPipeline.js', () => ({ classifyAndTagMessage: vi.fn() }));
vi.mock('./mailAccess.js', () => ({ getAccountAddresses: vi.fn(async () => []) }));
import { query } from './db.js';
import { RELOCATE_INSERT_COLS, RELOCATE_SELECT_COLS } from '../routes/mail.js';
import { ImapManager, insertCopiedSibling } from './imapManager.js';

// #585: the row for a message you sent kept To and Cc but never the Bcc, so the reading pane had
// none to show although the Sent copy on the server carries the header. Uses only connection-local
// temporary tables in an explicitly supplied database.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('Sent row Bcc (upsertSentMessageRecord)', () => {
  let database;
  const schema = `identity_${process.pid}`;
  const migration = readFileSync(new URL('../../migrations/0069_gmail_archive_coverage.sql', import.meta.url), 'utf8');
  const account = { id: '22222222-2222-4222-8222-222222222222', email_address: 'me@example.com' };
  const upsert = (uid, meta) => ImapManager.prototype.upsertSentMessageRecord.call({}, account, 'Sent', uid, {
    messageId: `<m${uid}@example.com>`, subject: 'Hello', fromName: 'Me', fromEmail: 'me@example.com',
    to: [{ name: 'To', email: 'to@example.com' }], ...meta,
  });
  const bccOf = async uid => (await database.query('SELECT bcc_addresses FROM messages WHERE uid = $1', [uid])).rows[0].bcc_addresses;

  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};
      CREATE TABLE email_accounts(id uuid PRIMARY KEY)`);
    await database.query(`CREATE TEMP TABLE folders(account_id uuid, path text, total_count integer DEFAULT 0, unread_count integer DEFAULT 0);
      CREATE TEMP TABLE messages (id serial, account_id uuid, uid bigint, folder text,
      message_id text, subject text, from_name text, from_email text, to_addresses jsonb, cc_addresses jsonb,
      bcc_addresses jsonb, date timestamptz, snippet text, is_read boolean, is_starred boolean,
      has_attachments boolean, flags jsonb, thread_id text, thread_key text, in_reply_to text,
      thread_references text, normalized_subject text, is_bulk boolean, is_deleted boolean DEFAULT false,
      reply_to jsonb, attachments jsonb, body_html text, body_text text, read_changed_at timestamptz,
      star_changed_at timestamptz, spam_score_sa real, spam_score_ml real, spam_verdict text,
      spam_analyzed_at timestamptz, spam_details jsonb, spam_user_override text, category text,
      list_unsubscribe text, list_unsubscribe_post text, unsubscribed_at timestamptz,
      delivery_addresses jsonb, sender_name text, sender_email text, forwarded_from_name text,
      forwarded_from_email text, forwarded_via text, plugin_annotations jsonb,
      UNIQUE (account_id, uid, folder))`);
    await database.query(migration);
    query.mockImplementation((sql, values) => database.query(sql, values));
  });
  afterAll(async () => { if (database) { await database.query(`DROP SCHEMA ${schema} CASCADE`); await database.end(); } });
  beforeEach(async () => { await database.query('TRUNCATE messages'); });

  it('replays the additive migration without rewriting cached messages', async () => {
    await database.query(`INSERT INTO messages(uid,folder,message_id,subject) VALUES(1,'INBOX','<legacy@example.test>','Legacy cached mail')`);
    await database.query(migration);
    expect((await database.query('SELECT message_id,subject,provider_msgid,is_archive_residue FROM messages')).rows).toEqual([
      { message_id: '<legacy@example.test>', subject: 'Legacy cached mail', provider_msgid: null, is_archive_residue: false },
    ]);
  });

  for (const method of ['upsertSentMessageRecord', 'upsertDraftMessageRecord']) {
    it(`${method} leaves an unverified replacement UID identity unknown`, async () => {
      const manager = Object.create(ImapManager.prototype);
      const account = { id: '33333333-3333-4333-8333-333333333333', imap_host: 'imap.gmail.com' };
      for (const messageId of ['<replacement@example.test>', '<same@example.test>']) {
        await manager[method](account, 'Saved', 70, { messageId: '<same@example.test>', providerMsgid: 'old-provider-id' });
        await manager[method](account, 'Saved', 70, { messageId });
        expect((await database.query('SELECT provider_msgid FROM messages WHERE uid=70')).rows[0].provider_msgid).toBeNull();
      }
    });
  }

  it('preserves provider identity through Sent/Draft upserts, COPY and relocation', async () => {
    const account = { id: '33333333-3333-4333-8333-333333333333', imap_host: 'imap.gmail.com' };
    const manager = Object.create(ImapManager.prototype);
    const meta = { providerMsgid: '9007199254740993', messageId: '<identity@example.test>' };
    await manager.upsertSentMessageRecord(account, 'Sent', 40, meta);
    await manager.upsertSentMessageRecord(account, 'Sent', 40, { providerMsgid: meta.providerMsgid });
    await manager.upsertDraftMessageRecord(account, 'Drafts', 41, meta);
    await manager.upsertDraftMessageRecord(account, 'Drafts', 41, { providerMsgid: meta.providerMsgid });
    await insertCopiedSibling(account.id, 40, 'Sent', 'Work', 50);
    // Exercise the same shared relocation projection used by move/archive/trash.
    await database.query(`WITH d AS (DELETE FROM messages WHERE account_id=$1 AND uid=$2 AND folder=$3 RETURNING *),
      u AS (SELECT 60::bigint AS new_uid)
      INSERT INTO messages (${RELOCATE_INSERT_COLS}) SELECT ${RELOCATE_SELECT_COLS} FROM d CROSS JOIN u`,
    [account.id, 50, 'Work', 'Filed']);
    expect((await database.query('SELECT folder,uid,provider_msgid FROM messages ORDER BY uid')).rows).toEqual([
      { folder: 'Sent', uid: '40', provider_msgid: '9007199254740993' },
      { folder: 'Drafts', uid: '41', provider_msgid: '9007199254740993' },
      { folder: 'Filed', uid: '60', provider_msgid: '9007199254740993' },
    ]);
    await manager.upsertSentMessageRecord({ ...account, imap_host: 'imap.other.test' }, 'Sent', 42, meta);
    expect((await database.query('SELECT provider_msgid FROM messages WHERE uid=42')).rows[0].provider_msgid).toBeNull();
  });

  it('stores the Bcc of a message sent with one', async () => {
    await upsert(1, { bcc: [{ name: 'Hidden', email: 'hidden@example.com' }] });
    expect(await bccOf(1)).toEqual([{ name: 'Hidden', email: 'hidden@example.com' }]);
  });

  it('stores nothing for a message sent without one', async () => {
    await upsert(2, {});
    expect(await bccOf(2)).toBeNull();
  });

  it('keeps a stored Bcc when the row is written again without one', async () => {
    await upsert(3, { bcc: [{ name: '', email: 'hidden@example.com' }] });
    await upsert(3, {});
    expect(await bccOf(3)).toEqual([{ name: '', email: 'hidden@example.com' }]);
  });
});
