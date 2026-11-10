import 'express-async-errors';
import { randomBytes } from 'crypto';
import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
const h = vi.hoisted(() => ({ pool: null, userId: null, afterRead: null }));
vi.mock('../services/db.js', () => ({
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
describe.skipIf(!databaseUrl)('destructive route identity fences', () => {
  const dbName = `mailflow_destruct_routes_${randomBytes(5).toString('hex')}`;
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
    h.userId = owner; h.afterRead = null;
    epoch = 10;
    client = Object.assign(new EventEmitter(), {
      capabilities: new Set(['UIDPLUS', 'MOVE']), connect: async () => {}, close() {}, logout: async () => {}, noop: async () => true,
      getMailboxLock: async folder => { client.mailbox = { path: folder, uidValidity: BigInt(epoch) }; return { release() {} }; },
      messageMove: vi.fn(async () => ({ uidMap: new Map([[1, 9]]), uidValidity: 10n })),
      messageCopy: vi.fn(async () => ({ uidMap: new Map([[1, 9]]), uidValidity: 20n })),
      messageDelete: vi.fn(async () => true), messageFlagsAdd: vi.fn(async () => true),
      fetch: async function* () { yield { uid: 1, envelope: { messageId: '<same@example.test>' } }; },
    });
    Object.assign(imapManager, {
      pluginFacade: {}, copyMessage: ImapManager.prototype.copyMessage,
      moveMessage: ImapManager.prototype.moveMessage, bulkMoveMessages: ImapManager.prototype.bulkMoveMessages,
      permanentDeleteMessage: ImapManager.prototype.permanentDeleteMessage,
      bulkPermanentDelete: ImapManager.prototype.bulkPermanentDelete,
      ensureFolder: vi.fn(async () => ({ path: 'Snoozed' })),
      _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(), syncFolderOnDemand: vi.fn(async () => {}),
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

  const setup = async action => {
    const folder = action.includes('expunge') ? 'Trash' : 'INBOX';
    const source = await put(folder);
    await put('Todo'); await put('Archive'); await put('Junk');
    if (folder !== 'Trash') await put('Trash');
    await h.pool.query('UPDATE email_accounts SET folder_mappings=$2 WHERE id=$1',
      [account.id, { trash: 'Trash', archive: 'Archive', spam: 'Junk' }]);
    return source;
  };
  const act = (action, source) => {
    if (action === 'copy') return request('POST', `/messages/${source.id}/copy`, { folder: 'Todo' });
    if (action.startsWith('bulk-')) return request('POST', `/messages/${action === 'bulk-expunge' ? 'bulk-delete' : action}`,
      { ids: [source.id], folder: 'Todo' });
    if (action === 'spam') return request('POST', `/messages/${source.id}/spam`, {});
    if (action === 'snooze') return request('POST', `/messages/${source.id}/snooze`, { until: new Date(Date.now() + 3600000).toISOString() });
    return request('DELETE', `/messages/${source.id}`, {});
  };
  const actions = ['copy', 'bulk-move', 'trash', 'expunge', 'bulk-delete', 'bulk-expunge', 'bulk-archive', 'spam', 'snooze'];
  it.each(actions.flatMap(action => ['generation','epoch'].map(change => [action,change])))('%s refuses a captured source after %s replacement', async (action, change) => {
    const source = await setup(action);
    h.afterRead = async () => { await reset(change, source.folder); };
    const result = await act(action, source);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(client.messageCopy).not.toHaveBeenCalled();
    expect(client.messageMove).not.toHaveBeenCalled();
    expect(client.messageDelete).not.toHaveBeenCalled();
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });
  it.each(['copy','bulk-move','trash','expunge','bulk-delete','bulk-expunge','bulk-archive','spam','snooze'])('%s works for an unchanged verified source', async action => {
    const source = await setup(action);
    client.messageCopy.mockImplementation(async () => ({ uidMap: new Map([[1,9]]), uidValidity: 10n }));
    const result = await act(action, source);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.ok).toBe(true);
    if (action === 'copy') expect(client.messageCopy).toHaveBeenCalledTimes(1);
    else if (action.includes('expunge')) expect(client.messageDelete).toHaveBeenCalledTimes(1);
    else expect(client.messageMove).toHaveBeenCalledTimes(1);
  });
  it.each(['trash','bulk-move','bulk-delete','bulk-archive','spam'].flatMap(action => ['generation','epoch','destination-epoch'].map(change => [action,change])))('%s preserves replacement cache and counts after acknowledged provider %s race', async (action, change) => {
    const source = await setup(action);
    const target = action === 'trash' || action === 'bulk-delete' ? 'Trash' : action === 'bulk-archive' ? 'Archive' : action === 'spam' ? 'Junk' : 'Todo';
    let replacement;
    client.messageMove.mockImplementation(async () => {
      if (change === 'destination-epoch') {
        epoch++;
        replacement = await put(target);
      } else replacement = await reset(change, source.folder);
      await h.pool.query('UPDATE folders SET total_count=77, unread_count=33 WHERE account_id=$1', [account.id]);
      return { uidMap: new Map([[1,1]]), uidValidity: 10n };
    });
    const result = await act(action, source);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(client.messageMove).toHaveBeenCalledTimes(1);
    expect((await h.pool.query('SELECT id, entity_id FROM messages WHERE id=$1', [replacement.id])).rows)
      .toEqual([{ id: replacement.id, entity_id: replacement.entity_id }]);
    const counts = (await h.pool.query('SELECT total_count, unread_count FROM folders WHERE account_id=$1 AND path=$2', [account.id, change === 'destination-epoch' ? target : source.folder])).rows;
    expect(counts.every(row => Number(row.total_count) === 77 && Number(row.unread_count) === 33)).toBe(true);
  });
  it('acknowledged move stays successful if cache persistence fails', async () => {
    const source = await setup('trash');
    await h.pool.query(`CREATE FUNCTION fail_move_cache() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.folder<>NEW.folder THEN RAISE EXCEPTION 'synthetic cache failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_move_cache_failure BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION fail_move_cache()`);
    try {
      const result = await act('trash', source);
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ ok: true, identityPending: true });
      expect(client.messageMove).toHaveBeenCalledTimes(1);
      expect((await h.pool.query('SELECT folder FROM messages WHERE id=$1', [source.id])).rows[0].folder).toBe('INBOX');
    } finally { await h.pool.query('DROP TRIGGER test_move_cache_failure ON messages; DROP FUNCTION fail_move_cache()'); }
  });
  it.each(actions)('%s refuses unverified cached coordinates', async action => {
    const source = await setup(action);
    await h.pool.query('UPDATE messages SET entity_id=NULL, storage_generation=NULL, uid_validity=NULL WHERE id=$1', [source.id]);
    const result = await act(action, source);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(client.messageMove).not.toHaveBeenCalled();
    expect(client.messageCopy).not.toHaveBeenCalled();
    expect(client.messageDelete).not.toHaveBeenCalled();
  });
  it.each(['expunge','bulk-expunge'].flatMap(action => ['generation','epoch'].map(change => [action,change])))('%s preserves replacement cache and counts after deletion acknowledges during %s reset', async (action, change) => {
    const source = await setup(action);
    let replacement;
    client.messageDelete.mockImplementation(async () => {
      replacement = await reset(change, 'Trash');
      await h.pool.query('UPDATE folders SET total_count=77, unread_count=33 WHERE account_id=$1', [account.id]);
      return true;
    });
    const result = await act(action, source);
    expect(result.status).toBe(200);
    expect(client.messageDelete).toHaveBeenCalledTimes(1);
    expect((await h.pool.query('SELECT entity_id FROM messages WHERE id=$1', [replacement.id])).rows[0].entity_id).toBe(replacement.entity_id);
    expect((await h.pool.query("SELECT total_count, unread_count FROM folders WHERE account_id=$1 AND path='Trash'", [account.id])).rows[0])
      .toMatchObject({ total_count: 77, unread_count: 33 });
  });
  it('a no-map acknowledged bulk MOVE stays pending and requests sync without retry or guessed UID', async () => {
    const source = await setup('bulk-move');
    client.messageMove.mockResolvedValue({});
    const result = await act('bulk-move', source);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ moved: [], pending: [source.id], identityPending: true });
    expect(client.messageMove).toHaveBeenCalledTimes(1);
    expect(imapManager.syncFolderOnDemand).toHaveBeenCalledWith(expect.objectContaining({ id: account.id }), 'Todo');
    expect((await h.pool.query('SELECT folder FROM messages WHERE id=$1', [source.id])).rows[0].folder).toBe('INBOX');
  });
  it('a no-map acknowledged single MOVE drops only its confirmed source and requests sync', async () => {
    const source = await setup('trash');
    client.messageMove.mockResolvedValue({});
    const result = await act('trash', source);
    expect(result.status).toBe(200);
    expect(client.messageMove).toHaveBeenCalledTimes(1);
    expect((await h.pool.query('SELECT id FROM messages WHERE id=$1', [source.id])).rows).toEqual([]);
    expect((await h.pool.query("SELECT uid FROM messages WHERE account_id=$1 AND folder='Trash'", [account.id])).rows).toEqual([{ uid: '1' }]);
    expect(imapManager.syncFolderOnDemand).toHaveBeenCalledWith(expect.objectContaining({ id: account.id }), 'Trash');
  });

  it.each(['trash','bulk-move','bulk-delete','bulk-archive','spam'].flatMap(action => [[action,false,true],[action,true,false]]))(
    '%s reconciles sync-first destination unread counts (source read=%s, destination read=%s)', async (action, sourceRead, destinationRead) => {
      const source = await setup(action);
      await h.pool.query('UPDATE messages SET is_read=$2 WHERE id=$1', [source.id,sourceRead]);
      const target = action === 'trash' || action === 'bulk-delete' ? 'Trash' : action === 'bulk-archive' ? 'Archive' : action === 'spam' ? 'Junk' : 'Todo';
      client.messageMove.mockImplementation(async () => {
        const context = await readMailboxIdentity(account,target);
        await writeObservedMessage(context,{uid:9},tx => tx.query(`INSERT INTO messages(account_id,folder,uid,is_read)
          VALUES ($1,$2,9,$3) RETURNING *`,[account.id,target,destinationRead]));
        await h.pool.query('UPDATE folders SET total_count=10, unread_count=5 WHERE account_id=$1',[account.id]);
        return {uidMap:new Map([[1,9]]),uidValidity:10n};
      });
      const result = await act(action,source);
      expect(result.status).toBe(200);
      expect(client.messageMove).toHaveBeenCalledTimes(1);
      expect((await h.pool.query('SELECT total_count, unread_count FROM folders WHERE account_id=$1 AND path=$2',[account.id,target])).rows[0])
        .toEqual({total_count:10,unread_count:5+Number(!sourceRead)-Number(!destinationRead)});
      expect((await h.pool.query("SELECT total_count, unread_count FROM folders WHERE account_id=$1 AND path='INBOX'",[account.id])).rows[0])
        .toEqual({total_count:9,unread_count:5-Number(!sourceRead)});
      expect((await h.pool.query('SELECT is_read FROM messages WHERE account_id=$1 AND folder=$2 AND uid=9',[account.id,target])).rows)
        .toEqual([{is_read:sourceRead}]);
    });

});
