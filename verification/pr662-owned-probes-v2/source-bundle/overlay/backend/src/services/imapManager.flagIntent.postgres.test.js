// Run with MAILFLOW_TEST_DATABASE_URL; JSON restore additionally needs a disposable
// MAILFLOW_FLAG_BACKUP_TEST_DATABASE_URL named mailflow_flag_test_*. See backend/TESTING.md.
import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { EventEmitter } from 'node:events';
vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(async () => ({ host: '127.0.0.1', addresses: ['127.0.0.1'] })), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn(async () => ({ allowPrivateHosts: true, allowInsecureTls: true })) }));
import { readFile } from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: value => value?.startsWith('enc:') ? value.slice(4) : value,
  encrypt: value => `enc:${value}`, isEncrypted: value => value?.startsWith('enc:') }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn(async () => {}) }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
import { query } from './db.js';
import { ImapManager, evictPool } from './imapManager.js';
import { ImapFlow } from 'imapflow';
import { writeBackup, restoreBackup } from './backup.js';
import { markCopySeen } from './labels.js';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const MESSAGE = '22222222-2222-4222-8222-222222222222';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('flag intent ownership in PostgreSQL', () => {
  let database, manager, client;
  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`CREATE TEMP SEQUENCE message_flag_intent_version_seq;
      CREATE TEMP TABLE email_accounts (id uuid PRIMARY KEY, enabled boolean DEFAULT true);
      CREATE TEMP TABLE messages (id uuid PRIMARY KEY, account_id uuid, uid bigint, folder text,
        message_id text, is_deleted boolean DEFAULT false, is_read boolean DEFAULT false,
        is_starred boolean DEFAULT false, read_changed_at timestamptz, star_changed_at timestamptz,
        flag_address_valid boolean DEFAULT true, flag_uid_validity bigint DEFAULT 1,
        read_intent_version bigint DEFAULT 0, star_intent_version bigint DEFAULT 0)`);
    await database.query('INSERT INTO email_accounts(id) VALUES ($1)', [ACCOUNT]);
  });
  afterAll(async () => { await database?.end(); });
  afterEach(() => { evictPool(ACCOUNT); vi.useRealTimers(); });
  beforeEach(async () => {
    await database.query('UPDATE email_accounts SET enabled=true');
    await database.query('TRUNCATE messages');
    await database.query("INSERT INTO messages(id,account_id,uid,folder,message_id) VALUES ($1,$2,17,'INBOX','<copy@example.test>')", [MESSAGE, ACCOUNT]);
    query.mockReset().mockImplementation((sql, args) => database.query(sql, args));
    vi.useFakeTimers();
    manager = new ImapManager({ clients: new Set() });
    vi.clearAllTimers(); vi.useRealTimers();
    client = { usable: true, mailbox: { path: 'INBOX', exists: 1, uidValidity: 1n },
      noop: vi.fn(async () => true), getMailboxLock: vi.fn(async () => ({ release() {} })),
      messageFlagsAdd: vi.fn(async () => true), messageFlagsRemove: vi.fn(async () => true) };
    manager.connections.set(ACCOUNT, client);
    ImapFlow.mockImplementation(function () { return Object.assign(new EventEmitter(), client,
      { mailbox: { ...client.mailbox }, connect: vi.fn(async () => {}), close: vi.fn(), logout: vi.fn(async () => {}) }); });
  });

  for (const flag of ['\\Seen', '\\Flagged']) {
    const field = flag === '\\Seen' ? 'is_read' : 'is_starred';
    const marker = flag === '\\Seen' ? 'read_changed_at' : 'star_changed_at';
    const state = async () => (await database.query(`SELECT ${field} AS value, ${marker} AS marker FROM messages`)).rows[0];
    it.each(['disabled','resolved'])(`clears the FIRST issued ${flag} protection after %s retirement`, async terminal => {
      const waiting = deferred(), release = deferred();
      let paused = false;
      query.mockImplementation(async (sql,args) => {
        if (!paused && sql.includes(`SET ${marker} = $2`)) {
          paused = true; waiting.resolve(); await release.promise;
        }
        return database.query(sql,args);
      });
      const intent = manager._enqueueFlagPush(ACCOUNT,MESSAGE,flag,true);
      const initial = manager._pendingFlagPush.get(ACCOUNT).get(`${MESSAGE}:${flag}`).markerReady;
      await waiting.promise;
      if (terminal === 'disabled') await database.query('UPDATE email_accounts SET enabled=false');
      const retirement = terminal === 'disabled' ? manager._reconcileFlagPushes()
        : manager._resolveFlagPush(ACCOUNT,MESSAGE,flag,intent);
      await vi.waitFor(() => expect(manager._pendingFlagPush.get(ACCOUNT)?.size || 0).toBe(0));
      release.resolve(); await initial; await retirement;
      expect((await state()).marker).toBeNull();
      expect(manager._pendingFlagPush.has(ACCOUNT)).toBe(false);
      expect(manager._isFlagIntentCurrent(intent)).toBe(false);
      if (terminal === 'disabled') expect(manager._flagIntents.has(ACCOUNT)).toBe(false);
      await database.query('UPDATE email_accounts SET enabled=true');
      await manager._applyFlagUpdates({ id: ACCOUNT },'INBOX',[{ uid:17,isRead:flag === '\\Seen',isStarred:flag === '\\Flagged' }]);
      expect((await state()).value).toBe(true);
    });
    it(`keeps a terminal same-version ${flag} marker NULL after detached SQL resumes`, async () => {
      vi.useFakeTimers();
      const waiting = deferred(), release = deferred(), completed = deferred();
      let stamps = 0;
      query.mockImplementation(async (sql, args) => {
        const pause = sql.includes(`SET ${field} = $1`) && ++stamps === 1;
        if (pause) { waiting.resolve(); await release.promise; }
        const result = await database.query(sql, args);
        if (pause) completed.resolve();
        return result;
      });
      try {
        manager._enqueueFlagPush(ACCOUNT, MESSAGE, flag, true);
        const replay = manager._reconcileFlagPushes();
        await waiting.promise;
        await vi.advanceTimersByTimeAsync(5001); await replay;
        expect((await state()).marker).toBeNull();
        release.resolve(); await completed.promise; await vi.advanceTimersByTimeAsync(0);
        expect(await state()).toEqual({ value: true, marker: null });
      } finally { release.resolve(); vi.useRealTimers(); }
    });
    it(`keeps newer confirmed DB value and NULL marker after old ${flag} reassertion resumes`, async () => {
      manager._enqueueFlagPush(ACCOUNT, MESSAGE, flag, true);
      const waiting = deferred(), release = deferred();
      let paused = false;
      query.mockImplementation(async (sql, args) => {
        if (!paused && sql.includes(`SET ${field} = $1`) && args[0] === true) {
          paused = true; waiting.resolve(); await release.promise;
        }
        return database.query(sql, args);
      });
      const replay = manager._reconcileFlagPushes();
      await waiting.promise;
      const newer = manager._admitFlagIntent(ACCOUNT, MESSAGE, flag, false);
      await manager._stampFlagIntent({ messageId: MESSAGE, flag, value: false, intent: newer }, true);
      await manager.setFlag({ id: ACCOUNT }, 17, 'INBOX', flag, false, { intent: newer });
      await manager._resolveFlagPush(ACCOUNT, MESSAGE, flag, newer);
      expect(await state()).toEqual({ value: false, marker: null });
      release.resolve(); await replay;
      expect(client.messageFlagsAdd).not.toHaveBeenCalled();
      expect(await state()).toEqual({ value: false, marker: null });
    });

    it(`does not reinstall an enqueue-only ${flag} marker after a newer confirmation`, async () => {
      const waiting = deferred(), release = deferred();
      let paused = false;
      query.mockImplementation(async (sql, args) => {
        if (!paused && sql.includes(`SET ${marker} = $2`)) {
          paused = true; waiting.resolve(); await release.promise;
        }
        return database.query(sql, args);
      });
      manager._enqueueFlagPush(ACCOUNT, MESSAGE, flag, true);
      const oldMarker = manager._pendingFlagPush.get(ACCOUNT).get(`${MESSAGE}:${flag}`).markerReady;
      await waiting.promise;
      const newer = manager._admitFlagIntent(ACCOUNT, MESSAGE, flag, false);
      await manager.setFlag({ id: ACCOUNT }, 17, 'INBOX', flag, false, { intent: newer });
      await manager._resolveFlagPush(ACCOUNT, MESSAGE, flag, newer);
      expect(await state()).toEqual({ value: false, marker: null });
      release.resolve(); await oldMarker;
      expect(await state()).toEqual({ value: false, marker: null });
    });
  }

  it('lets a server pull update a confirmed legacy label action immediately', async () => {
    await markCopySeen(manager, { id: ACCOUNT }, { id: MESSAGE, uid: 17, folder: 'INBOX', is_read: false });
    expect((await database.query('SELECT read_changed_at FROM messages')).rows[0].read_changed_at).toBeNull();
    await manager._applyFlagUpdates({ id: ACCOUNT }, 'INBOX', [{ uid: 17, isRead: false, isStarred: false }]);
    expect((await database.query('SELECT is_read FROM messages')).rows[0].is_read).toBe(false);
  });

  it('does not clear a newer legacy marker while its version allocation is pending', async () => {
    const intent = manager._enqueueFlagPush(ACCOUNT, MESSAGE, '\\Seen', true);
    await manager._protectFlagMarker(manager._pendingFlagPush.get(ACCOUNT).get(`${MESSAGE}:\\Seen`));
    await database.query('UPDATE messages SET read_changed_at = NOW()');
    await manager._clearFlagMarker(MESSAGE, '\\Seen', intent);
    expect((await database.query('SELECT read_changed_at FROM messages')).rows[0].read_changed_at).not.toBeNull();
  });

  it('keeps nextval and CAS values lossless above the JavaScript safe integer range', async () => {
    await database.query('ALTER SEQUENCE message_flag_intent_version_seq RESTART WITH 9007199254740993');
    const intent = manager._admitFlagIntent(ACCOUNT, MESSAGE, '\\Seen', true);
    expect(await intent.version).toBe('9007199254740993');
    await manager._stampFlagIntent({ messageId: MESSAGE, flag: '\\Seen', value: true, intent }, true);
    expect((await database.query('SELECT read_intent_version::text AS version FROM messages')).rows[0].version)
      .toBe('9007199254740993');
    expect(await manager._newFlagAction().version).toBe('9007199254740994');
  });

  it.skipIf(!process.env.MAILFLOW_FLAG_BACKUP_TEST_DATABASE_URL)('allocates the next intent above JSON-restored bigint versions', async () => {
    const own = new pg.Client({ connectionString: process.env.MAILFLOW_FLAG_BACKUP_TEST_DATABASE_URL });
    await own.connect();
    try {
      expect((await own.query('SELECT current_database() AS name')).rows[0].name).toMatch(/^mailflow_flag_test_/);
      await own.query(`CREATE TABLE IF NOT EXISTS email_accounts(id uuid PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS folders(account_id uuid, path text, uid_validity bigint);
        CREATE TABLE IF NOT EXISTS messages(id uuid PRIMARY KEY, account_id uuid, uid bigint, folder text);
        CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY);
        INSERT INTO schema_migrations VALUES ('0079_message_flag_addresses') ON CONFLICT DO NOTHING;
        TRUNCATE messages,folders,email_accounts`);
      await own.query(await readFile(new URL('../../migrations/0079_message_flag_addresses.sql', import.meta.url), 'utf8'));
      await own.query('INSERT INTO messages(id,account_id,uid,folder,read_intent_version,star_intent_version) VALUES ($1,$2,17,$3,9007199254740993,9007199254740995)', [MESSAGE, ACCOUNT, 'INBOX']);
      await own.query('ALTER SEQUENCE message_flag_intent_version_seq RESTART WITH 2');
      const out = new PassThrough(), chunks = [];
      out.on('data', chunk => chunks.push(chunk));
      await writeBackup(own, { scope: 'full', appVersion: '4.0.3', out });
      await own.query('TRUNCATE messages');
      await restoreBackup(own, Readable.from([Buffer.concat(chunks)]));
      expect((await own.query('SELECT read_intent_version,star_intent_version FROM messages')).rows[0])
        .toEqual({ read_intent_version: '9007199254740993', star_intent_version: '9007199254740995' });
      query.mockImplementation((sql, args) => own.query(sql, args));
      expect(await manager._newFlagAction().version).toBe('9007199254740996');
    } finally { await own.end(); }
  });
  it.each(['\\Seen','\\Flagged'])('retires an unversioned %s intent visibly and lets a fresh request recover',async flag=>{
    let failed=false;
    query.mockImplementation((sql,args)=>{
      if(!failed && sql.includes('nextval(')){failed=true;return Promise.reject(new Error('temporary allocation failure'));}
      return database.query(sql,args);
    });
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try {
      const intent=manager._enqueueFlagPush(ACCOUNT,MESSAGE,flag,true);
      await manager._pendingFlagPush.get(ACCOUNT).get(`${MESSAGE}:${flag}`).markerReady;
      expect(manager._pendingFlagPush.get(ACCOUNT)?.size||0).toBe(0);
      expect(manager._isFlagIntentCurrent(intent)).toBe(false);
      expect(warn.mock.calls.some(([text])=>text.includes('version'))).toBe(true);
      const fresh=manager._admitFlagIntent(ACCOUNT,MESSAGE,flag,false);
      expect(fresh.version).toBeInstanceOf(Promise);
      expect(await manager.setFlag({id:ACCOUNT},17,'INBOX',flag,false,{intent:fresh})).toBe(true);
      await manager._resolveFlagPush(ACCOUNT,MESSAGE,flag,fresh);
      expect(client.messageFlagsRemove).toHaveBeenCalledWith('17',[flag],{uid:true});
    } finally {warn.mockRestore();}
  });

});
