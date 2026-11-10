import 'express-async-errors';
import { randomBytes } from 'crypto';
import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
const h = vi.hoisted(() => ({ pool: null, userId: null, afterRead: null, afterQuery: null }));
vi.mock('../services/db.js', () => ({
  pool: { connect: (...args) => h.pool.connect(...args) },
  query: async (...args) => {
    const result = await h.pool.query(...args);
    if (h.afterQuery && args[0].includes(' FROM messages WHERE account_id = $1 AND folder = $2')) {
      const hook = h.afterQuery; h.afterQuery = null; await hook();
    }
    return result;
  },
  withTransaction: async fn => {
    const client = await h.pool.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  },
}));
vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('../services/encryption.js', () => ({ decrypt: value => value }));
vi.mock('../services/aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('../services/pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('../services/hostValidation.js', () => ({ resolveForConnection: async () => ({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null }), createPinnedLookup: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: async () => ({ allowPrivateHosts: true, allowInsecureTls: true }) }));
vi.mock('../services/mailAccess.js', () => ({ getAccountAddresses: vi.fn(async () => []) }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: h.userId }; next(); } }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { hasActiveAsync: async () => true, collectHook: async () => [['Todo']], runHook: async () => [] } }));
vi.mock('../services/ownership.js', async original => {
  const actual = await original();
  const wrap = name => async (...args) => {
    const result = await actual[name](...args);
    const hook = h.afterRead;
    h.afterRead = null;
    await hook?.();
    return result;
  };
  return { ...actual, findOwnedMessage: wrap('findOwnedMessage'), findOwnedMessages: wrap('findOwnedMessages'), findOwnedAccount: wrap('findOwnedAccount') };
});
import { ImapFlow } from 'imapflow';
import { runMigrations } from '../services/migrations.js';
import { ImapManager, evictPool } from '../services/imapManager.js';
import { readMailboxIdentity, observeMailboxIdentity,
  applyStorageIdentityDecision, writeObservedMessage } from '../services/messageIdentity.js';
import { withTransaction } from '../services/db.js';
import express from 'express';
import routes from './mail.js';
import { imapManager } from '../index.js';


const databaseUrl = process.env.MAILFLOW_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('ordinary flag routes verify captured identity and preserve successful writes', () => {
  const dbName = `mailflow_route_flags_${randomBytes(5).toString('hex')}`;
  let admin, account, epoch, client, server, base;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl }); await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(databaseUrl); url.pathname = `/${dbName}`;
    h.pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
    await runMigrations();
    const app = express(); app.use(express.json()); app.use('/mail', routes);
    app.use((error, _req, res, next) => { void next; res.status(error.status || 500).json({ error: error.message }); });
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}/mail`;
  }, 60_000);
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); await h.pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin?.end(); });
  beforeEach(async () => {
    await h.pool.query('TRUNCATE users CASCADE');
    const owner = (await h.pool.query("INSERT INTO users(username) VALUES ('label-owner') RETURNING id")).rows[0].id;
    account = (await h.pool.query(`INSERT INTO email_accounts(user_id,name,email_address,imap_host,auth_user,auth_pass)
      VALUES ($1,'Labels','me@example.test','imap.example.test','synthetic','synthetic') RETURNING *`, [owner])).rows[0];
    h.userId = owner; h.afterRead = null; h.afterQuery = null;
    epoch = 10;
    client = Object.assign(new EventEmitter(), {
      capabilities: new Set(['UIDPLUS']), connect: async () => {}, close() {}, logout: async () => {}, noop: async () => true,
      getMailboxLock: async folder => { client.mailbox = { path: folder, uidValidity: BigInt(epoch) }; return { release() {} }; },
      messageCopy: vi.fn(async () => ({ uidMap: new Map([[1, 9]]), uidValidity: 20n })),
      messageDelete: vi.fn(async () => true), messageFlagsAdd: vi.fn(async () => true),
      fetch: async function* () { yield { uid: 1, envelope: { messageId: '<same@example.test>' } }; },
    });
    Object.assign(imapManager, {
      _flagOpChains: new Map(), connections: new Map([[account.id, client]]),
      setFlag: ImapManager.prototype.setFlag, _setFlagInner: ImapManager.prototype._setFlagInner,
      _secondaryConnectBlocked: () => false, _resolveFlagPush: vi.fn(), _enqueueFlagPush: vi.fn(),
      broadcast: vi.fn(), isLabelStore: () => true, markAllReadImap: vi.fn(async () => {}), scheduleCountRefresh: vi.fn(),
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

  const request = async (method, path, data) => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  };
  const replaceCopies = async change => {
    await reset(change, 'INBOX'); await put('Todo');
    client.mailbox = { path: 'INBOX', uidValidity: BigInt(epoch) };
    await h.pool.query('UPDATE folders SET total_count=9,unread_count=8 WHERE account_id=$1', [account.id]);
  };


  const requestFlag = (action, source) => action === 'mark-all'
    ? request('POST', '/mark-all-read', { accountId: account.id, folder: 'INBOX' })
    : action.startsWith('bulk-')
      ? request('POST', `/messages/${action}`, { ids: [source.id], [action === 'bulk-star' ? 'starred' : 'read']: true })
      : request('PATCH', `/messages/${source.id}/${action}`, { [action === 'star' ? 'starred' : 'read']: true });
  const settle = async () => {
    for (let n = 0; n < 50; n++) await new Promise(resolve => setTimeout(resolve, 2));
  };

  for (const action of ['read', 'star', 'bulk-read', 'bulk-star', 'mark-all']) {
    it(`${action} preserves verified normal writes and exact folder counts`, async () => {
      const source = await put('INBOX');
      await h.pool.query('UPDATE folders SET total_count=9,unread_count=8 WHERE account_id=$1', [account.id]);
      const result = await requestFlag(action, source);
      expect(result.status).toBe(200);
      await settle();
      expect(client.messageFlagsAdd).toHaveBeenCalledTimes(1);
      expect(client.messageFlagsAdd).toHaveBeenCalledWith('1', [action.includes('star') ? '\\Flagged' : '\\Seen'], { uid: true });
      const current = (await h.pool.query('SELECT is_read,is_starred FROM messages WHERE id=$1', [source.id])).rows[0];
      expect(current).toEqual(action.includes('star') ? { is_read: false, is_starred: true } : { is_read: true, is_starred: false });
      expect((await h.pool.query('SELECT unread_count FROM folders WHERE account_id=$1', [account.id])).rows[0].unread_count).toBe(action.includes('star') ? 8 : 7);
      expect(imapManager._enqueueFlagPush).not.toHaveBeenCalled();
    });

    it(`${action} rejects unverified source rows without acknowledging a local mutation`, async () => {
      const source = (await h.pool.query(`INSERT INTO messages(account_id,folder,uid,message_id)
        VALUES ($1,'INBOX',1,'<legacy@example.test>') RETURNING *`, [account.id])).rows[0];
      const result = await requestFlag(action, source);
      expect(result.status).toBe(409);
      await settle();
      expect(client.messageFlagsAdd).not.toHaveBeenCalled();
      expect(imapManager._enqueueFlagPush).not.toHaveBeenCalled();
      expect((await h.pool.query('SELECT is_read,is_starred FROM messages WHERE id=$1', [source.id])).rows[0]).toEqual({ is_read: false, is_starred: false });
    });

    it(`${action} refuses reused UIDs after the request source snapshot`, async () => {
      const source = await put('INBOX');
      if (action === 'mark-all') h.afterQuery = () => replaceCopies('epoch');
      else h.afterRead = () => replaceCopies('epoch');
      const result = await requestFlag(action, source);
      expect(result.status).toBe(409);
      await settle();
      expect(client.messageFlagsAdd).not.toHaveBeenCalled();
      expect(imapManager._enqueueFlagPush).not.toHaveBeenCalled();
      const rows = (await h.pool.query('SELECT is_read,is_starred FROM messages WHERE account_id=$1', [account.id])).rows;
      expect(rows.every(row => !row.is_read && !row.is_starred)).toBe(true);
      expect((await h.pool.query("SELECT unread_count FROM folders WHERE account_id=$1 AND path='INBOX'", [account.id])).rows[0].unread_count).toBe(8);
    });
  }

  it('bulk-star refuses a replacement generation without retrying', async () => {
    const source = await put('INBOX'); h.afterRead = () => replaceCopies('generation');
    expect((await requestFlag('bulk-star', source)).status).toBe(409);
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    expect(imapManager._enqueueFlagPush).not.toHaveBeenCalled();
  });

  it('a transport failure queues the exact original source proof', async () => {
    const source = await put('INBOX');
    client.messageFlagsAdd.mockRejectedValue(new Error('synthetic STORE unavailable'));
    expect((await requestFlag('read', source)).status).toBe(200);
    expect(imapManager._enqueueFlagPush).toHaveBeenCalledWith(account.id, source.id, '\\Seen', true,
      { expectedSource: expect.objectContaining({ id: source.id, entity_id: source.entity_id,
        storage_generation: source.storage_generation, uid_validity: source.uid_validity, uid: source.uid, folder: source.folder }) });
  });
  for (const action of ['delete', 'empty', 'rename']) {
    it(`folder ${action} keeps provider success but never mutates a replacement cache`, async () => {
      await put('Todo');
      const method = action === 'empty' ? 'emptyFolder' : action === 'rename' ? 'renameFolder' : 'deleteFolder';
      const identityContext = await readMailboxIdentity(account, 'Todo');
      imapManager[method] = vi.fn(async () => { await replaceCopies('generation'); return { identityContext }; });
      const result = await request('POST', `/folders/${action}`, { accountId: account.id,
        ...(action === 'rename' ? { oldPath: 'Todo', newName: 'Later' } : { path: 'Todo' }) });
      expect(result.status).toBe(action === 'empty' ? 202 : 200);
      expect(result.body.ok).toBe(true);
      if (action !== 'empty') expect(result.body.identityPending).toBe(true);
      await settle();
      if (action === 'empty') expect(imapManager.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'folder_emptied', ok: true, identityPending: true }), h.userId);
      const rows = (await h.pool.query('SELECT folder,is_read FROM messages WHERE account_id=$1 ORDER BY folder', [account.id])).rows;
      expect(rows).toEqual([{ folder: 'INBOX', is_read: false }, { folder: 'Todo', is_read: false }]);
      expect((await h.pool.query("SELECT unread_count FROM folders WHERE account_id=$1 AND path='Todo'", [account.id])).rows[0]?.unread_count).toBe(8);
      expect(imapManager[method]).toHaveBeenCalledTimes(1);
    });
  }

  for (const action of ['delete', 'empty', 'rename']) {
    it(`folder ${action} does not mutate a reused epoch after provider success`, async () => {
      await put('Todo');
      const identityContext = await readMailboxIdentity(account, 'Todo');
      const method = action === 'empty' ? 'emptyFolder' : action === 'rename' ? 'renameFolder' : 'deleteFolder';
      imapManager[method] = vi.fn(async () => {
        await replaceCopies('epoch');
        return { identityContext };
      });
      const result = await request('POST', `/folders/${action}`, { accountId: account.id,
        ...(action === 'rename' ? { oldPath: 'Todo', newName: 'Later' } : { path: 'Todo' }) });
      expect(result.status).toBe(action === 'empty' ? 202 : 200); await settle();
      expect((await h.pool.query("SELECT is_read FROM messages WHERE account_id=$1 AND folder='Todo'", [account.id])).rows).toEqual([{ is_read: false }]);
      expect((await h.pool.query("SELECT unread_count FROM folders WHERE account_id=$1 AND path='Todo'", [account.id])).rows[0].unread_count).toBe(8);
      if (action === 'empty') expect(imapManager.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'folder_emptied', ok: true, identityPending: true }), h.userId);
      else expect(result.body).toMatchObject({ ok: true, identityPending: true });
    });
  }
  it('an acknowledged empty without provider identity proof leaves cache recovery pending', async () => {
    await put('Todo');
    imapManager.emptyFolder = vi.fn(async () => undefined);
    expect((await request('POST', '/folders/empty', { accountId: account.id, path: 'Todo' })).status).toBe(202);
    await settle();
    expect((await h.pool.query("SELECT id FROM messages WHERE account_id=$1 AND folder='Todo'", [account.id])).rows).toHaveLength(1);
    expect(imapManager.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'folder_emptied', ok: true, identityPending: true }), h.userId);
  });

});
