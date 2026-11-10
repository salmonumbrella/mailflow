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
import { applyLabel, removeLabel, removeExactLabelCopy } from './labels.js';
import { createPluginMailFacade } from '../plugins/mailEngineFacade.js';


const databaseUrl = process.env.MAILFLOW_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('delayed label callers retain their source identity', () => {
  const dbName = `mailflow_labels_identity_${randomBytes(5).toString('hex')}`;
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
  const manager = () => ({ pluginFacade: {}, syncFolderOnDemand: vi.fn(async () => {}),
    permanentDeleteMessage: ImapManager.prototype.permanentDeleteMessage });

  it.each(['epoch', 'generation'])('COPY rejects a reused source UID after a %s change during ensureFolder', async change => {
    const source = await put();
    let replacement;
    const mgr = { ...manager(),
      ensureFolder: async () => { replacement = await reset(change, 'INBOX'); },
      copyMessage: ImapManager.prototype.copyMessage };
    await expect(applyLabel(mgr, account, source, 'Todo', { forceCopy: true })).rejects.toMatchObject({
      code: change === 'generation' ? 'storage_generation_conflict' : 'identity_source_changed' });
    expect(client.messageCopy).not.toHaveBeenCalled();
    expect((await h.pool.query('SELECT id FROM messages')).rows).toEqual([{ id: replacement.id }]);
  });

  it.each(['label', 'inverse'])('a stale source cannot resolve a replacement mailbox copy through the %s lookup', async mode => {
    const source = await put('INBOX');
    const replacement = await reset('generation', 'Todo');
    const mgr = { ...manager(), removeMessageCopy: vi.fn() };
    const result = mode === 'label' ? await removeLabel(mgr, source, 'Todo')
      : await removeExactLabelCopy(mgr, source, 'Todo', 1);
    expect(result).toEqual({ removed: false });
    expect(mgr.removeMessageCopy).not.toHaveBeenCalled();
    expect((await h.pool.query('SELECT id FROM messages')).rows).toEqual([{ id: replacement.id }]);
  });

  it.each(['epoch', 'generation'])('removeLabel rejects a %s reset after resolving the copy', async change => {
    const source = await put('Todo');
    let replacement;
    const mgr = { ...manager(), removeMessageCopy: async (...args) => {
      replacement = await reset(change, 'Todo');
      return ImapManager.prototype.removeMessageCopy.apply(mgr, args);
    } };
    await expect(removeLabel(mgr, source, 'Todo')).rejects.toMatchObject({
      code: change === 'generation' ? 'storage_generation_conflict' : 'identity_source_changed' });
    expect(client.messageDelete).not.toHaveBeenCalled();
    expect((await h.pool.query('SELECT id FROM messages')).rows).toEqual([{ id: replacement.id }]);
  });

  it.each(['epoch', 'generation'])('exact inverse rejects a %s reset after matching the destination UID', async change => {
    const source = await put('Todo');
    let replacement;
    const mgr = { ...manager(), removeMessageCopy: async (...args) => {
      replacement = await reset(change, 'Todo');
      return ImapManager.prototype.removeMessageCopy.apply(mgr, args);
    } };
    await expect(removeExactLabelCopy(mgr, source, 'Todo', 1)).rejects.toMatchObject({
      code: change === 'generation' ? 'storage_generation_conflict' : 'identity_source_changed' });
    expect(client.messageDelete).not.toHaveBeenCalled();
    expect((await h.pool.query('SELECT id FROM messages')).rows).toEqual([{ id: replacement.id }]);
  });

  it.each(['epoch', 'generation'])('remove rechecks its proof after FETCH races with a %s reset', async change => {
    const source = await put('Todo');
    let replacement;
    client.fetch = async function* () {
      replacement = await reset(change, 'Todo');
      yield { uid: 1, envelope: { messageId: '<same@example.test>' } };
    };
    const mgr = { ...manager(), removeMessageCopy: ImapManager.prototype.removeMessageCopy };
    await expect(removeLabel(mgr, source, 'Todo')).rejects.toMatchObject({
      code: change === 'generation' ? 'storage_generation_conflict' : 'identity_epoch_changed' });
    expect(client.messageDelete).not.toHaveBeenCalled();
    expect((await h.pool.query('SELECT id FROM messages')).rows).toEqual([{ id: replacement.id }]);
  });

  it('the plugin facade forwards the original account and source proof rather than resolving a latest account', async () => {
    const source = await put('Todo');
    const oldAccount = account;
    await reset('generation', 'Todo');
    const mgr = { ...manager(), removeMessageCopy: ImapManager.prototype.removeMessageCopy };
    await expect(createPluginMailFacade(mgr).removeMessageCopy(oldAccount, 1, 'Todo', { expectedSource: source }))
      .rejects.toMatchObject({ code: 'storage_generation_conflict' });
    expect(client.messageDelete).not.toHaveBeenCalled();
  });

  it.each(['epoch', 'generation'])('acknowledged deletion stays successful when cache persistence races a %s reset', async change => {
    const source = await put('Todo');
    let replacement;
    client.messageDelete.mockImplementation(async () => {
      replacement = await reset(change, 'Todo');
      return true;
    });
    const mgr = { ...manager(), removeMessageCopy: ImapManager.prototype.removeMessageCopy };
    await expect(removeLabel(mgr, source, 'Todo')).resolves.toEqual({ removed: true });
    expect(client.messageDelete).toHaveBeenCalledOnce();
    expect((await h.pool.query('SELECT id FROM messages')).rows).toEqual([{ id: replacement.id }]);
  });

  it('still copies an unchanged verified source and binds its destination', async () => {
    const source = await put();
    const mgr = { ...manager(), ensureFolder: vi.fn(async () => {}), copyMessage: ImapManager.prototype.copyMessage };
    await expect(applyLabel(mgr, account, source, 'Todo', { forceCopy: true })).resolves.toEqual({ applied: true, uid: 9 });
    expect(client.messageCopy).toHaveBeenCalledOnce();
    expect((await h.pool.query("SELECT uid,uid_validity FROM messages WHERE folder='Todo'")).rows).toEqual([{ uid: '9', uid_validity: '20' }]);
  });
});
