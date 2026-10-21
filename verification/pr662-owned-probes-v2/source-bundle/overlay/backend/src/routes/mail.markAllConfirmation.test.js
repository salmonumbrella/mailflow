import { EventEmitter } from 'node:events';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); } }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('../services/encryption.js', () => ({ decrypt: vi.fn(() => 'pw') }));
vi.mock('../services/hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('../services/aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('../services/pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('../index.js', async () => {
  const { ImapManager } = await import('../services/imapManager.js');
  return { imapManager: new ImapManager(null) };
});
import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { evictPool } from '../services/imapManager.js';
import { ImapFlow } from 'imapflow';
import { pluginRegistry } from '../plugins/registry.js';
import { resolveForConnection } from '../services/hostValidation.js';
import { getConnectionPolicy } from '../services/connectionPolicy.js';
const A = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const account = { id: A, user_id: 'user-1', imap_host: '127.0.0.1', imap_port: 993,
  imap_tls: true, auth_user: 'test', auth_pass: 'enc' };
let server, base, client, events;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/mail', mailRoutes);
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/mail`;
});
afterAll(async () => {
  for (const key of ['_healthCheckTimer', '_snippetSchedulerTimer', '_stalenessCheckTimer', '_flagPushReconcilerTimer']) clearInterval(imapManager[key]);
  await new Promise(r => server.close(r));
});
beforeEach(() => {
  events = [];
  client = Object.assign(new EventEmitter(), { usable: true, connect: async () => {}, close: () => {}, noop: async () => true,
    getMailboxLock: async folder => { client.mailbox = { path: folder, exists: 1, uidValidity: 7n }; return { release() {} }; },
    search: vi.fn(async () => [1]),
    messageFlagsAdd: vi.fn(async () => { events.push('store'); return true; }),
  });
  ImapFlow.mockImplementation(function () { return client; });
  resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'] });
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
  query.mockReset().mockImplementation(async sql => {
    if (sql.includes('nextval(')) return { rows: [{ version: '1' }], rowCount: 1 };
    if (sql.includes('FROM email_accounts')) return { rows: [account] };
    if (sql.startsWith('UPDATE')) events.push('commit');
    return { rows: [], rowCount: 0 };
  });
  vi.spyOn(pluginRegistry, 'runHook').mockImplementation(async (name, context) => { events.push(['hook', name, context]); });
  vi.spyOn(imapManager, 'broadcast').mockImplementation(() => {});
  vi.spyOn(imapManager, 'scheduleCountRefresh').mockImplementation(() => {});
});
afterEach(async () => { await evictPool(A); vi.restoreAllMocks(); });
const markAll = () => fetch(`${base}/mark-all-read`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: A, folder: 'INBOX' }) });
describe('mark-all route confirmation and mutation completion', () => {
  it('waits for the actual UID STORE before reporting completion', async () => {
    const entered = deferred(), release = deferred();
    client.messageFlagsAdd.mockImplementation(async () => { entered.resolve(); await release.promise; return true; });
    let responded = false;
    const response = markAll().then(r => { responded = true; return r; });
    await entered.promise;
    await new Promise(r => setTimeout(r, 30));
    const premature = responded; release.resolve(); await response;
    expect(premature).toBe(false);
  });
  it('awaits the folder-wide hook exactly once after the final database write', async () => {
    const response = await markAll(); expect(response.status).toBe(200);
    const hooks = events.filter(e => Array.isArray(e));
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toEqual(['hook', 'onMailMutation', expect.objectContaining({ accountId: A,
      messageIds: [], actedFolders: ['INBOX'], folderWide: true })]);
    expect(events.lastIndexOf('commit')).toBeLessThan(events.indexOf(hooks[0]));
  });
});

describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('mark-all actual Postgres confirmation', () => {
  let database, seen;
  beforeEach(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`CREATE TEMP SEQUENCE message_flag_intent_version_seq;
      CREATE TEMP TABLE email_accounts(id text PRIMARY KEY,user_id text,imap_host text,imap_port integer,
        imap_tls boolean,auth_user text,auth_pass text);
      CREATE TEMP TABLE messages(id text PRIMARY KEY,account_id text,uid bigint,folder text,message_id text,
        is_read boolean DEFAULT false,is_deleted boolean DEFAULT false,read_changed_at timestamptz,
        read_intent_version bigint DEFAULT 0,flag_address_valid boolean DEFAULT true,flag_uid_validity bigint DEFAULT 7);
      CREATE TEMP TABLE folders(account_id text,path text,unread_count integer);
    `);
    await database.query('INSERT INTO email_accounts VALUES($1,$2,$3,$4,$5,$6,$7)', Object.values(account));
    await database.query("INSERT INTO messages(id,account_id,uid,folder,message_id) VALUES('row-1',$1,1,'INBOX','<one@test>')", [A]);
    await database.query("INSERT INTO folders VALUES($1,'INBOX',1)", [A]);
    for (const map of ['_flagIntents', '_pendingFlagPush', '_flagAddressActions', '_flagOpChains']) imapManager[map].clear();
    imapManager._flagVersionChain = Promise.resolve();
    query.mockImplementation(async (sql, params) => {
      const result = await database.query(sql, params);
      if (sql.startsWith('UPDATE')) events.push('commit');
      return result;
    });
    seen = false;
    client.search.mockImplementation(async () => seen ? [] : [1]);
    client.messageFlagsAdd.mockImplementation(async (uid, flags, opts) => {
      expect([uid, flags, opts]).toEqual(['1', ['\\Seen'], { uid: true }]); seen = true; return true;
    });
    client.fetch = async function* () { yield { uid: 1, flags: new Set(seen ? ['\\Seen'] : []), envelope: { messageId: '<one@test>' } }; };
    const push = Object.assign(new EventEmitter(), { usable: true, noop: async () => true, mailbox: { path: 'INBOX', uidValidity: 7n },
      getMailboxLock: async () => ({ release() {} }), messageFlagsAdd: client.messageFlagsAdd,
      messageFlagsRemove: async (uid, flags, opts) => {
        expect([flags, opts]).toEqual([['\\Seen'], { uid: true }]);
        expect(uid).toMatch(/^[1-9][0-9]*$/); seen = false; return true;
      },
    });
    imapManager.connections.set(A, push);
  });
  afterEach(async () => { imapManager.connections.delete(A); await database?.end(); });
  const state = async () => (await database.query(`SELECT m.is_read,m.read_changed_at,m.read_intent_version::text,
    f.unread_count FROM messages m JOIN folders f ON f.account_id=m.account_id AND f.path=m.folder WHERE m.id='row-1'`)).rows[0];
  it.each(['SEARCH', 'CAS'])('preserves a newer actual unread confirmation during %s', async stage => {
    const entered = deferred(), release = deferred();
    if (stage === 'SEARCH') client.search.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return [1]; });
    else query.mockImplementation(async (sql, params) => {
      if (sql.includes('SET is_read = $1') && params[0] === true) {
        entered.resolve(); await release.promise;
      }
      return database.query(sql, params);
    });
    const response = markAll(); await entered.promise;
    try { expect(await imapManager.setFlag(account, 1, 'INBOX', '\\Seen', false)).toBe(true); }
    finally { release.resolve(); }
    expect((await response).status).toBe(502);
    expect(await state()).toMatchObject({ is_read: false, read_changed_at: null, unread_count: 1 });
    expect(seen).toBe(false); expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    expect(events.filter(e => Array.isArray(e))).toHaveLength(1);
  });
  it('retires an older queued unread after live already-Seen proof and awaits final hook', async () => {
    const old = imapManager._admitFlagIntent(A, 'row-1', '\\Seen', false);
    imapManager._enqueueFlagPush(A, 'row-1', '\\Seen', false, old);
    await imapManager._pendingFlagPush.get(A).get(old.key).markerReady;
    seen = true;
    const entered = deferred(), release = deferred();
    pluginRegistry.runHook.mockImplementation(async () => { entered.resolve(); await release.promise; });
    let responded = false; const response = markAll().then(r => { responded = true; return r; });
    await entered.promise;
    try {
      expect(await state()).toMatchObject({ is_read: true, read_changed_at: null, unread_count: 0 });
      expect(responded).toBe(false); expect(imapManager._pendingFlagPush.get(A)?.size || 0).toBe(0);
    } finally { release.resolve(); }
    expect((await response).status).toBe(200);
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });
  it('keeps refused identities unread and counts the admitted pending failure truthfully', async () => {
    await database.query('UPDATE messages SET flag_address_valid=false');
    const response = await markAll(); expect(response.status).toBe(502);
    expect(await state()).toMatchObject({ is_read: false, unread_count: 1 });
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    expect(imapManager._pendingFlagPush.get(A)?.size).toBe(1);
    expect(imapManager._pendingFlagPush.get(A).values().next().value.attempts).toBe(0);
  });
  it('finishes a large already-read folder and fences an older request admitted only afterward', async () => {
    await database.query('UPDATE messages SET is_read=true');
    await database.query(`INSERT INTO messages(id,account_id,uid,folder,message_id,is_read)
      SELECT 'row-'||n,$1,n,'INBOX','<copy'||n||'@test>',true FROM generate_series(2,10001) n`, [A]);
    seen = true;
    const oldAction = imapManager._newFlagAction(); await oldAction.version;
    const response = await markAll(); expect(response.status).toBe(200);
    const late = imapManager._admitFlagIntent(A, 'row-9000', '\\Seen', false, oldAction);
    expect(await imapManager.setFlag(account, 9000, 'INBOX', '\\Seen', false, { intent: late })).toBe(false);
    expect((await database.query("SELECT is_read,read_changed_at FROM messages WHERE id='row-9000'")).rows[0])
      .toEqual({ is_read: true, read_changed_at: null });
    expect((await state()).unread_count).toBe(0);
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });
  it('reports capacity refusal without optimistically changing the unadmitted rows or count', async () => {
    await database.query(`INSERT INTO messages(id,account_id,uid,folder,message_id)
      SELECT 'row-'||n,$1,n,'INBOX','<copy'||n||'@test>' FROM generate_series(2,10001) n`, [A]);
    const response = await markAll(); expect(response.status).toBe(502);
    expect(await state()).toMatchObject({ is_read: false, read_changed_at: null, unread_count: 10001 });
    expect(imapManager._pendingFlagPush.get(A)?.size || 0).toBe(0);
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });
});
