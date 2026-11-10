import { randomBytes } from 'crypto';
import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
const h = vi.hoisted(() => ({ pool: null, failCounts: false }));
vi.mock('./db.js', () => ({
  pool: { connect: (...args) => h.pool.connect(...args) },
  query: (...args) => h.pool.query(...args),
  withTransaction: async fn => {
    const client = await h.pool.connect();
    const tx = { query: (...args) => h.failCounts && args[0].includes('WITH prev AS')
      ? client.query('SELECT 1 / 0') : client.query(...args) };
    try { await client.query('BEGIN'); const result = await fn(tx); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  },
}));
vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: value => value }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: async () => ({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null }), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: async () => ({ allowPrivateHosts: true, allowInsecureTls: true }) }));
vi.mock('./mailAccess.js', () => ({ getAccountAddresses: vi.fn(async () => []) }));
import { ImapFlow } from 'imapflow';
import { runMigrations } from './migrations.js';
import { ImapManager, evictPool } from './imapManager.js';
import { readMailboxIdentity, observeMailboxIdentity, writeObservedMessage } from './messageIdentity.js';
import { archiveInboxCopy } from './archiveInbox.js';
import { createEmptyModel, updateIncremental } from './spamModel.js';
import { getModelForUser } from './spamModelStore.js';
import { clearCarries } from './movedRowCarry.js';
vi.mock('./spamModelStore.js', () => ({ getModelForUser: vi.fn() }));

const databaseUrl = process.env.MAILFLOW_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('independent review: archive retains provider acknowledgment', () => {
  const dbName = `mailflow_archive_ack_review_${randomBytes(5).toString('hex')}`;
  let admin, account, client, providerMove;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl }); await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(databaseUrl); url.pathname = `/${dbName}`;
    h.pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
    await runMigrations();
  }, 60_000);
  afterAll(async () => { await h.pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin?.end(); });
  beforeEach(async () => {
    h.failCounts = false;
    clearCarries();
    await h.pool.query('TRUNCATE users CASCADE');
    const owner = (await h.pool.query("INSERT INTO users(username) VALUES ('async-owner') RETURNING id")).rows[0].id;
    account = (await h.pool.query(`INSERT INTO email_accounts(user_id,name,email_address,imap_host,auth_user,auth_pass,antispam_enabled,folder_mappings)
      VALUES ($1,'Async','me@example.test','imap.example.test','synthetic','synthetic',true,'{"spam":"Junk","archive":"Junk"}') RETURNING *`, [owner])).rows[0];
    let model = createEmptyModel();
    for (let i = 0; i < 200; i++) model = updateIncremental(model,
      i % 2 ? ['meeting', 'agenda', 'notes', 'review', 'document', 'thanks'] : ['cheap', 'viagra', 'click', 'buy', 'offer', 'free'], {}, i % 2 ? 'ham' : 'spam');
    getModelForUser.mockReset().mockResolvedValue(model);
    providerMove = vi.fn(async () => ({ uidMap: new Map([[1, 9]]), uidValidity: 20n }));
    client = Object.assign(new EventEmitter(), {
      mailbox: { path: 'INBOX', uidValidity: 10n }, capabilities: new Set(['UIDPLUS', 'MOVE']),
      connect: async () => {}, close() {}, logout: async () => {}, noop: async () => true,
      getMailboxLock: async () => ({ release() {} }), messageMove: providerMove,
    });
    ImapFlow.mockImplementation(function () { return client; });
    await observe('Junk', 20);
  });
  afterEach(() => { h.failCounts = false; if (account) evictPool(account.id); });
  const observe = async (folder, epoch) => observeMailboxIdentity(await readMailboxIdentity(account, folder),
    { mailbox: { path: folder, uidValidity: BigInt(epoch) }, capabilities: new Set() });
  const seed = async (folder = 'INBOX', epoch = 10, uid = 1, subject = 'CHEAP VIAGRA!!! WIN $$$') => {
    const context = await observe(folder, epoch);
    return (await writeObservedMessage(context, { uid }, tx => tx.query(`
      INSERT INTO messages(account_id,folder,uid,subject,body_text,from_email,attachments,message_id,date,is_read)
      VALUES ($1,$2,$3,$4,'Click here. Buy now. Limited time offer, act now!','spammer@spoof.biz',
        '[{"filename":"invoice.exe"}]','<same@example.test>','2026-11-01T00:00:00Z',false) RETURNING *`,
    [account.id, folder, uid, subject]))).rows[0];
  };
  const rowAt = async (folder, uid) => (await h.pool.query('SELECT * FROM messages WHERE account_id=$1 AND folder=$2 AND uid=$3', [account.id, folder, uid])).rows[0];
  const facade = ({ beforeMove, afterMove } = {}) => ({
    moveMessage: vi.fn(async (...args) => {
      await beforeMove?.();
      const uid = await ImapManager.prototype.moveMessage.call({}, ...args);
      await afterMove?.();
      return uid;
    }),
    syncFolderOnDemand: vi.fn(async () => {}), broadcast: vi.fn(), _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(),
  });

  it('archive acknowledges success when durable journal completion fails after MOVE', async () => {
    const source = await seed();
    await h.pool.query(`CREATE FUNCTION fail_journal_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'synthetic journal completion outage'; END $$;
      CREATE TRIGGER test_journal_failure BEFORE UPDATE ON mail_identity_operations FOR EACH ROW EXECUTE FUNCTION fail_journal_completion()`);
    try {
      const result = await archiveInboxCopy(facade(), account, source);
      expect(providerMove).toHaveBeenCalledOnce();
      expect(await rowAt('INBOX', 1)).toMatchObject({ id: source.id });
      expect((await h.pool.query('SELECT state FROM mail_identity_operations')).rows).toEqual([{ state: 'prepared' }]);
      expect(result).toMatchObject({ archived: true, identityPending: true, uidKnown: false });
    } finally {
      await h.pool.query('DROP TRIGGER test_journal_failure ON mail_identity_operations; DROP FUNCTION fail_journal_completion()');
    }
  });
});
