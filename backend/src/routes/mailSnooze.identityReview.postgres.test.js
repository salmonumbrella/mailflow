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
  writeObservedMessage } from '../services/messageIdentity.js';
import express from 'express';
import routes, { gatherSnoozeConversation } from './mail.js';
import { imapManager } from '../index.js';


const databaseUrl = process.env.MAILFLOW_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('independent review: durable snooze route boundaries', () => {
  const dbName = `mailflow_snooze_review_${randomBytes(5).toString('hex')}`;
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
      _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(), syncFolderOnDemand: vi.fn(async () => {}),
      _flagOpChains: new Map(), connections: new Map([[account.id, client]]),
      setFlag: ImapManager.prototype.setFlag, _setFlagInner: ImapManager.prototype._setFlagInner,
      _secondaryConnectBlocked: () => false, _resolveFlagPush: vi.fn(), _enqueueFlagPush: vi.fn(),
      ensureFolder: vi.fn(async () => ({ path: 'Snoozed' })),
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
  const request = async (method, path, data) => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  };
  it('does not expand a clicked snooze to an independent same-header delivery without reply links', async () => {
    const first = await put();
    const context = await observeMailboxIdentity(await readMailboxIdentity(account, 'INBOX'),
      { mailbox: { path: 'INBOX', uidValidity: 10n }, capabilities: new Set() });
    const second = (await writeObservedMessage(context, { uid: 2 }, tx => tx.query(
      `INSERT INTO messages(account_id,folder,uid,message_id,subject) VALUES ($1,'INBOX',2,'<same@example.test>','Same subject') RETURNING *`,
      [account.id]))).rows[0];
    await h.pool.query("UPDATE messages SET thread_id='duplicate-header-thread' WHERE account_id=$1", [account.id]);
    expect(second.entity_id).not.toBe(first.entity_id);
    const chain = await gatherSnoozeConversation({ ...first, thread_id: 'duplicate-header-thread' });
    expect(chain.map(row => row.id)).toEqual([first.id]);
  });
  const putExtra = async (folder, uid, header, refs = null) => {
    const context = await observeMailboxIdentity(await readMailboxIdentity(account, folder),
      { mailbox: { path: folder, uidValidity: 10n }, capabilities: new Set() });
    return (await writeObservedMessage(context, { uid }, tx => tx.query(
      `INSERT INTO messages(account_id,folder,uid,message_id,thread_id,in_reply_to) VALUES ($1,$2,$3,$4,'review-thread',$5) RETURNING *`,
      [account.id, folder, uid, header, refs]))).rows[0];
  };
  it('POST snooze sends only one MOVE for independently delivered identical headers', async () => {
    const first = await putExtra('INBOX', 1, '<same@example.test>');
    const second = await putExtra('INBOX', 2, '<same@example.test>');
    const response = await request('POST', `/messages/${first.id}/snooze`, { until: new Date(Date.now()+3600000).toISOString() });
    expect(response.status).toBe(200);
    expect(client.messageMove).toHaveBeenCalledTimes(1);
    expect((await h.pool.query('SELECT folder FROM messages WHERE id=$1', [second.id])).rows[0].folder).toBe('INBOX');
    const records = (await h.pool.query('SELECT entity_id FROM snoozed_messages')).rows;
    expect(records.map(r => r.entity_id)).toEqual([first.entity_id]);
    expect((await h.pool.query('SELECT metadata_version FROM message_entities WHERE id=$1', [first.entity_id])).rows[0].metadata_version).toBe('1');
  });
  it('keeps explicit reply chains connected through Sent without moving that connector', async () => {
    const first = await putExtra('INBOX', 1, '<first@example.test>');
    await putExtra('Sent', 7, '<sent@example.test>', '<first@example.test>');
    const sibling = await putExtra('INBOX', 2, '<reply@example.test>', '<sent@example.test>');
    await putExtra('INBOX', 3, '<unrelated@example.test>');
    const chain = await gatherSnoozeConversation(first);
    expect(chain.map(row => row.id).sort()).toEqual([first.id, sibling.id].sort());
  });

  it('holds an initial uncertain snooze instead of replaying MOVE on a second request', async () => {
    const source = await putExtra('INBOX', 1, '<only@example.test>');
    client.messageMove.mockRejectedValue(new Error('Transport lost after sending MOVE'));
    const body = { until: new Date(Date.now()+3600000).toISOString() };
    expect((await request('POST', `/messages/${source.id}/snooze`, body)).status).toBe(500);
    expect((await request('POST', `/messages/${source.id}/snooze`, body)).status).toBe(400);
    expect(client.messageMove).toHaveBeenCalledTimes(1);
    expect((await h.pool.query('SELECT entity_id,wake_state FROM snoozed_messages')).rows)
      .toEqual([{ entity_id: source.entity_id, wake_state: 'snoozing' }]);
  });
  it('refuses snooze after the source epoch changes while ensureFolder is pending', async () => {
    const source = await putExtra('INBOX', 1, '<only@example.test>');
    imapManager.ensureFolder.mockImplementation(async () => {
      await observeMailboxIdentity(await readMailboxIdentity(account, 'INBOX'),
        { mailbox: { path: 'INBOX', uidValidity: 11n }, capabilities: new Set() });
      return { path: 'Snoozed' };
    });
    const response = await request('POST', `/messages/${source.id}/snooze`, { until: new Date(Date.now()+3600000).toISOString() });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(client.messageMove).not.toHaveBeenCalled();
    expect((await h.pool.query('SELECT id FROM snoozed_messages')).rows).toHaveLength(0);
  });
  it('does not permit another user to snooze, postpone, or wake the owned message', async () => {
    const source = await putExtra('INBOX', 1, '<only@example.test>');
    h.userId = (await h.pool.query("INSERT INTO users(username) VALUES ('stranger') RETURNING id")).rows[0].id;
    const body = { until: new Date(Date.now()+3600000).toISOString() };
    for (const [method, action] of [['POST','snooze'],['PATCH','snooze'],['POST','unsnooze']]) {
      expect((await request(method, `/messages/${source.id}/${action}`, body)).status).toBe(404);
    }
    expect(client.messageMove).not.toHaveBeenCalled();
  });

  it('rolls back the whole PATCH if a sibling wake claim wins after live rows were read', async () => {
    const first = await putExtra('Snoozed', 1, '<first@example.test>');
    const sibling = await putExtra('Snoozed', 2, '<reply@example.test>', '<first@example.test>');
    const oldUntil = new Date(Date.now()+3600000).toISOString();
    for (const row of [first, sibling]) await h.pool.query(
      `INSERT INTO snoozed_messages(user_id,account_id,storage_generation,entity_id,message_id_header,original_folder,snoozed_folder,snooze_until)
      VALUES ($1,$2,$3,$4,$5,'INBOX','Snoozed',$6)`,
      [account.user_id,account.id,account.storage_generation,row.entity_id,row.message_id,oldUntil]);
    imapManager.snoozedRows = async (...args) => {
      const rows = await ImapManager.prototype.snoozedRows.call(imapManager, ...args);
      await h.pool.query("UPDATE snoozed_messages SET wake_state='waking' WHERE entity_id=$1", [sibling.entity_id]);
      return rows;
    };
    const response = await request('PATCH', `/messages/${first.id}/snooze`, { until: new Date(Date.now()+7200000).toISOString() });
    expect(response.status).toBe(409);
    const records = (await h.pool.query('SELECT snooze_until FROM snoozed_messages')).rows;
    expect(records.map(row => row.snooze_until.toISOString())).toEqual([oldUntil, oldUntil]);
    const versions = (await h.pool.query('SELECT metadata_version FROM message_entities WHERE id=ANY($1::uuid[])', [[first.entity_id,sibling.entity_id]])).rows;
    expect(versions.map(row => row.metadata_version)).toEqual(['0','0']);
    expect(client.messageMove).not.toHaveBeenCalled();
  });

  it('does not guess which independent duplicate-header delivery an explicit reply references', async () => {
    const first = await putExtra('INBOX', 1, '<duplicate@example.test>');
    await putExtra('INBOX', 2, '<duplicate@example.test>');
    const reply = await putExtra('INBOX', 3, '<reply@example.test>', '<duplicate@example.test>');
    expect((await gatherSnoozeConversation(first)).map(row => row.id)).toEqual([first.id]);
    expect((await gatherSnoozeConversation(reply)).map(row => row.id)).toEqual([reply.id]);
  });

});
