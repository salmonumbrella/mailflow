import { randomBytes } from 'crypto';
import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
const h = vi.hoisted(() => ({ pool: null }));
vi.mock('./db.js', () => ({
  pool: { connect: (...args) => h.pool.connect(...args) },
  query: (...args) => h.pool.query(...args),
  withTransaction: async fn => {
    const client = await h.pool.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
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
import { readMailboxIdentity, observeMailboxIdentity,
  applyStorageIdentityDecision, writeObservedMessage } from './messageIdentity.js';
import { withTransaction } from './db.js';
import { markThreadRead, markCopySeen, removeLabel } from './labels.js';


const databaseUrl = process.env.MAILFLOW_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('independent review: GTD read mutations retain original identity', () => {
  const dbName = `mailflow_gtd_read_review_${randomBytes(5).toString('hex')}`;
  let admin, account, epoch, client;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl }); await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(databaseUrl); url.pathname = `/${dbName}`;
    h.pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
    await runMigrations();
  }, 60_000);
  afterAll(async () => { await h.pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin?.end(); });
  beforeEach(async () => {
    await h.pool.query('TRUNCATE users CASCADE');
    const owner = (await h.pool.query("INSERT INTO users(username) VALUES ('label-owner') RETURNING id")).rows[0].id;
    account = (await h.pool.query(`INSERT INTO email_accounts(user_id,name,email_address,imap_host,auth_user,auth_pass)
      VALUES ($1,'Labels','me@example.test','imap.example.test','synthetic','synthetic') RETURNING *`, [owner])).rows[0];
    epoch = 10;
    client = Object.assign(new EventEmitter(), {
      capabilities: new Set(['UIDPLUS']), connect: async () => {}, close() {}, logout: async () => {}, noop: async () => true,
      getMailboxLock: async folder => { client.mailbox = { path: folder, uidValidity: BigInt(epoch) }; return { release() {} }; },
      messageCopy: vi.fn(async () => ({ uidMap: new Map([[1, 9]]), uidValidity: 20n })),
      messageDelete: vi.fn(async () => true), messageFlagsAdd: vi.fn(async () => true),
      fetch: async function* () { yield { uid: 1, envelope: { messageId: '<same@example.test>' } }; },
    });
    ImapFlow.mockImplementation(function () { return client; });
  });
  afterEach(() => { if (account) evictPool(account.id); });
  const put = async (folder = 'INBOX') => {
    const context = await observeMailboxIdentity(await readMailboxIdentity(account, folder),
      { mailbox: { path: folder, uidValidity: BigInt(epoch) }, capabilities: new Set() });
    const saved = await writeObservedMessage(context, { uid: 1 }, tx => tx.query(
      `INSERT INTO messages(account_id,folder,uid,message_id,subject) VALUES ($1,$2,1,'<same@example.test>','Same subject') RETURNING *`,
      [account.id, folder]));
    return saved.rows[0];
  };
  const reset = async (change, folder) => {
    if (change === 'generation') {
      const decision = await withTransaction(tx => applyStorageIdentityDecision(tx, {
        accountId: account.id, expectedGeneration: account.storage_generation, decision: 'replace' }));
      account = { ...account, storage_generation: decision.storageGeneration };
    } else epoch++;
    return put(folder);
  };

  it.each(['generation', 'epoch'])('a stale Done request cannot mark replacement siblings read after %s reset', async change => {
    const source = await put('INBOX');
    const capturedAccount = account;
    const replacement = await reset(change, 'INBOX');
    const mgr = { isLabelStore: () => true, setFlag: vi.fn(async () => {}) };
    await markThreadRead(mgr, capturedAccount, source);
    expect((await h.pool.query('SELECT is_read FROM messages WHERE id=$1', [replacement.id])).rows[0].is_read).toBe(false);
    expect(mgr.setFlag).not.toHaveBeenCalled();
  });

  it('a stale copy cannot STORE Seen into a reused UID after UIDVALIDITY reset', async () => {
    const source = await put('INBOX');
    await reset('epoch', 'INBOX');
    const mgr = {
      _flagOpChains: new Map(), connections: new Map([[account.id, client]]),
      setFlag: ImapManager.prototype.setFlag,
      _setFlagInner: ImapManager.prototype._setFlagInner,
      _secondaryConnectBlocked: () => false,
    };
    await markCopySeen(mgr, account, source);
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it('a queued Seen action revalidates the source after its predecessor finishes', async () => {
    const source = await put('INBOX');
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    const mgr = {
      _flagOpChains: new Map([[account.id, blocked]]), connections: new Map([[account.id, client]]),
      setFlag: ImapManager.prototype.setFlag,
      _setFlagInner: ImapManager.prototype._setFlagInner,
      _secondaryConnectBlocked: () => false,
    };
    const pending = markCopySeen(mgr, account, source);
    await reset('epoch', 'INBOX');
    release();
    await pending;
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });


  it('a live label source mismatch is not reported as a successful removal', async () => {
    const source = await put('Todo');
    client.fetch = async function* () {
      yield { uid: 1, envelope: { messageId: '<different@example.test>' } };
    };
    const mgr = { pluginFacade: {}, removeMessageCopy: ImapManager.prototype.removeMessageCopy,
      permanentDeleteMessage: ImapManager.prototype.permanentDeleteMessage };
    const result = await removeLabel(mgr, source, 'Todo').catch(error => ({ removed: false, error }));
    expect(client.messageDelete).not.toHaveBeenCalled();
    expect(result.removed).toBe(false);
    expect((await h.pool.query('SELECT id FROM messages WHERE id=$1', [source.id])).rows).toHaveLength(1);
  });

});
