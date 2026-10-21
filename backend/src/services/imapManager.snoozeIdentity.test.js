import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import pg from 'pg';
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn(() => 'pw') }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('../utils/mailUtils.js', async original => ({ ...(await original()), adjustFolderCounts: vi.fn() }));

import { ImapManager, evictPool } from './imapManager.js';
import { ImapFlow } from 'imapflow';
import { query, withTransaction } from './db.js';
import { resolveForConnection } from './hostValidation.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { adjustFolderCounts } from '../utils/mailUtils.js';

// Compile the actual production query with the installed imapflow compiler. An
// array HEADER becomes HEADER 0 / HEADER 1, so the fake must not accept that shape.
const { searchCompiler } = createRequire(import.meta.url)('imapflow/lib/search-compiler.js');
const ACCOUNT = { id: 'snooze-identity', user_id: 'user-1', imap_host: 'imap.example.test', auth_user: 'me', auth_pass: 'enc' };
let manager, folders, record, message, client, uidplus, failFlag, searches, stores, moved, sourceSibling, syncedDestination;
const uids = range => String(range).split(',').map(Number);
function transport() {
  const c = Object.assign(new EventEmitter(), {
    usable: true, connect: async () => {}, close() {}, noop: async () => true,
    capabilities: new Map([['MOVE', true], ...(uidplus ? [['UIDPLUS', true]] : [])]),
    getMailboxLock: async folder => {
      expect(c.locked).not.toBe(true); c.locked = true;
      c.mailbox = { path: folder, uidValidity: 1n };
      return { release() { c.locked = false; } };
    },
    search: async (q, opts) => {
      expect(c.locked).toBe(true); expect(opts).toEqual({ uid: true });
      const attributes = searchCompiler(c, q).map(attr => attr.value);
      searches.push(attributes);
      if (attributes.length !== 3 || attributes[0] !== 'HEADER' || attributes[1] !== 'MESSAGE-ID') return [];
      return [...folders[c.mailbox.path]].filter(([, m]) => m.id?.includes(attributes[2])).map(([uid]) => uid);
    },
    fetch: async function* (range, q, opts) {
      expect(c.locked).toBe(true); expect(opts).toEqual({ uid: true }); expect(q.envelope).toBe(true);
      for (const uid of uids(range)) {
        const m = folders[c.mailbox.path].get(uid);
        if (m) yield { uid, envelope: { messageId: m.id } };
      }
    },
    messageMove: async (range, dest, opts) => {
      expect(opts).toEqual({ uid: true });
      const uid = Number(range), item = folders[c.mailbox.path].get(uid);
      if (!item) return {};
      folders[dest].set(77, item); folders[c.mailbox.path].delete(uid); moved++;
      return uidplus ? { uidMap: new Map([[uid, 77]]) } : {};
    },
    messageFlagsRemove: async (range, flags, opts) => {
      expect(c.locked).toBe(true); expect(opts).toEqual({ uid: true }); expect(flags).toEqual(['\\Seen']);
      // The DB may never expose a stale source UID to a queued follow-up STORE.
      expect(message.uid).toBe(77); expect(message.folder).toBe('INBOX');
      stores.push([c.mailbox.path, range, flags, opts]);
      if (failFlag) return false;
      for (const uid of uids(range)) folders[c.mailbox.path].get(uid)?.flags.delete('\\Seen');
      return true;
    },
  });
  return c;
}
function database(sql, p = []) {
  if (sql.includes('FROM snoozed_messages sm')) return { rows: record && message.cached !== false && message.folder === 'Snoozed' ? [{ ...record, message_row_id: 'message-1', uid: message.uid, is_read: message.is_read }] : [] };
  if (sql.startsWith('SELECT id FROM messages')) return { rows: message.cached !== false && message.folder === p[2] && message.uid === Number(p[1]) ? [{ id: 'message-1' }] : [] };
  if (sql === 'DELETE FROM messages WHERE id = $1') { message.cached = false; return { rows: [], rowCount: 1 }; }
  if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [ACCOUNT] };
  if (sql.startsWith('DELETE FROM messages WHERE account_id')) {
    if (syncedDestination && p[0] === ACCOUNT.id && Number(p[1]) === syncedDestination.uid && p[2] === syncedDestination.folder) syncedDestination = null;
    return { rows: [] };
  }
  if (sql.startsWith('UPDATE messages SET folder')) {
    const destinationUid = sql.includes('uid = $4') ? p[3] : message.uid;
    if (syncedDestination && syncedDestination.uid === destinationUid && syncedDestination.folder === p[0]) {
      throw new Error('duplicate key violates messages account_id_uid_folder');
    }
    const sourceFolder = p[sql.includes('uid = $4') ? 4 : 3];
    const uidPredicate = sql.match(/AND uid = \$(\d+)/);
    for (const target of [message, sourceSibling].filter(Boolean)) {
      if (target.folder !== sourceFolder || (uidPredicate && target.uid !== p[Number(uidPredicate[1]) - 1])) continue;
      target.folder = p[0];
      if (sql.includes('uid = $4')) target.uid = p[3];
      if (sql.includes('is_read = false')) target.is_read = false;
    }
    return { rows: [], rowCount: 1 };
  }
  if (sql.startsWith('DELETE FROM snoozed_messages')) { record = null; return { rows: [] }; }
  return { rows: [] };
}
beforeEach(() => {
  vi.clearAllMocks(); adjustFolderCounts.mockReset(); syncedDestination = null; sourceSibling = null; uidplus = false; failFlag = false; searches = []; stores = []; moved = 0;
  record = { snooze_id: 'snooze-1', account_id: ACCOUNT.id, user_id: ACCOUNT.user_id, message_id_header: '<target@test>', original_folder: 'INBOX', snoozed_folder: 'Snoozed' };
  message = { uid: 11, folder: 'Snoozed', is_read: true };
  folders = { Snoozed: new Map([[11, { id: '<target@test>', flags: new Set(['\\Seen']) }]]), INBOX: new Map([[11, { id: '<other@test>', flags: new Set(['\\Seen']) }]]) };
  client = transport();
  ImapFlow.mockImplementation(function () { return client; });
  query.mockImplementation(async (...args) => database(...args));
  withTransaction.mockImplementation(async fn => {
    const before = [{ ...message }, syncedDestination && { ...syncedDestination }, record && { ...record }];
    try { return await fn({ query }); }
    catch (err) { [message, syncedDestination, record] = before; throw err; }
  });
  resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
  manager = new ImapManager(null); manager.broadcast = vi.fn();
  // Sync is external background work; finder, move, wake and setFlag stay real.
  manager.syncFolderOnDemand = vi.fn(async () => {});
});
afterEach(() => { evictPool(ACCOUNT.id); vi.useRealTimers(); });

describe('real Message-ID finder and imapflow protocol compilation', () => {
  it('emits HEADER MESSAGE-ID, fetches exact UID and rejects substring-only matches', async () => {
    folders.INBOX.set(50, { id: '<prefix-target@test>' });
    expect(await manager.findUidByMessageId(ACCOUNT, 'INBOX', '<target@test>')).toBe(null);
    expect(searches).toEqual([['HEADER', 'MESSAGE-ID', 'target@test']]);
    folders.INBOX.set(77, { id: '<target@test>' });
    expect(await manager.findUidByMessageId(ACCOUNT, 'INBOX', 'target@test')).toBe(77);
  });
  it('refuses multiple exact identities, including bracket-normalized duplicates', async () => {
    folders.INBOX.set(70, { id: '<target@test>' }); folders.INBOX.set(77, { id: 'target@test' });
    expect(await manager.findUidByMessageId(ACCOUNT, 'INBOX', '<target@test>')).toBe(null);
  });
  it.each([null, undefined, '', '<>', ' <> ', 'bad\r\nid'])('never searches a missing or degenerate identity %j', async id => {
    expect(await manager.findUidByMessageId(ACCOUNT, 'INBOX', id)).toBe(null);
    expect(searches).toEqual([]);
  });
});

describe('real snooze move, lookup, setFlag and DB completion', () => {
  for (const withUidplus of [false, true]) {
    it(`marks only the verified destination UID unread with UIDPLUS=${withUidplus}`, async () => {
      uidplus = withUidplus; client = transport();
      expect(await manager.wakeSnoozed(record)).toBe(true);
      expect(stores).toEqual([['INBOX', '77', ['\\Seen'], { uid: true }]]);
      expect(folders.INBOX.get(77).flags.has('\\Seen')).toBe(false);
      expect(folders.INBOX.get(11).flags.has('\\Seen')).toBe(true);
      expect(message).toEqual({ folder: 'INBOX', uid: 77, is_read: false });
      expect(record).toBe(null); expect(moved).toBe(1);
      expect(record).toBe(null);
    });
    it(`finishes DB wake after confirmed move plus flag failure with UIDPLUS=${withUidplus}`, async () => {
      uidplus = withUidplus; client = transport(); failFlag = true;
      expect(await manager.wakeSnoozed(record)).toBe(true);
      expect(moved).toBe(1); expect(record).toBe(null);
      expect(message).toEqual({ folder: 'INBOX', uid: 77, is_read: false });
      expect(manager.broadcast).toHaveBeenCalledWith({ type: 'snooze_wakeup', accountId: ACCOUNT.id }, ACCOUNT.user_id);
      expect(manager.syncFolderOnDemand).toHaveBeenCalledWith(ACCOUNT, 'INBOX');
      expect(manager._pendingFlagPush.size).toBe(0);
    });
    it(`manual wake preserves read state without any lookup/STORE with UIDPLUS=${withUidplus}`, async () => {
      uidplus = withUidplus; client = transport();
      expect(await manager.wakeSnoozed(record, { markUnread: false })).toBe(true);
      expect(stores).toEqual([]); expect(searches).toEqual([]);
      expect(message.is_read).toBe(true); expect(record).toBe(null);
      expect(folders.INBOX.get(77).flags.has('\\Seen')).toBe(true);
      expect(record).toBe(null);
    });
    for (const id of [null, '<>', '<reused@test>']) {
      it(`does not guess or queue unread for ambiguous identity ${id}, UIDPLUS=${withUidplus}`, async () => {
        uidplus = withUidplus; client = transport(); record.message_id_header = id;
        folders.Snoozed.get(11).id = id; folders.INBOX.set(66, { id, flags: new Set(['\\Seen']) });
        expect(await manager.wakeSnoozed(record)).toBe(true);
        expect(stores).toEqual([]); expect(record).toBe(null); expect(moved).toBe(1);
        expect(folders.INBOX.get(66).flags.has('\\Seen')).toBe(true);
        expect(manager._pendingFlagPush.size).toBe(0);
        expect(manager.syncFolderOnDemand).toHaveBeenCalledWith(ACCOUNT, 'INBOX');
      });
    }
  }
  it('a timed-out persistent identity FETCH cannot later STORE after pooled fallback', async () => {
    vi.useFakeTimers();
    message = { folder: 'INBOX', uid: 77, is_read: false };
    folders.INBOX.set(77, { id: '<target@test>', flags: new Set(['\\Seen']) });
    const persistent = transport(), fetch = persistent.fetch;
    let release, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    persistent.fetch = async function* (...args) { entered(); await gate; yield* fetch(...args); };
    manager.connections.set(ACCOUNT.id, persistent);
    const operation = manager.setFlag(ACCOUNT, 77, 'INBOX', '\\Seen', false, { expectMessageId: '<target@test>' });
    await ready;
    await vi.advanceTimersByTimeAsync(5001);
    await operation;
    expect(stores).toHaveLength(1);
    release(); await vi.advanceTimersByTimeAsync(1);
    expect(stores).toHaveLength(1);
  });

  it('repoints only the moved source UID when another source row reuses its header', async () => {
    uidplus = true; client = transport();
    sourceSibling = { uid: 12, folder: 'Snoozed' };
    expect(await manager.wakeSnoozed(record)).toBe(true);
    expect(sourceSibling.folder).toBe('Snoozed');
    expect(message.folder).toBe('INBOX');
  });

  it.each([false, true])('binds the moved row when sync already inserted its destination, UIDPLUS=%s', async withUidplus => {
    uidplus = withUidplus; client = transport();
    syncedDestination = { uid: 77, folder: 'INBOX' };
    expect(await manager.wakeSnoozed(record)).toBe(true);
    expect(message).toEqual({ folder: 'INBOX', uid: 77, is_read: false });
    expect(record).toBe(null);
    expect(syncedDestination).toBe(null);
    expect(stores).toHaveLength(1);
  });

  for (const markUnread of [false, true]) {
    it(`finishes an unknown-destination move when the stale source UID collides in destination cache, markUnread=${markUnread}`, async () => {
      record.message_id_header = '<reused@test>';
      folders.Snoozed.get(11).id = '<reused@test>';
      folders.INBOX.set(66, { id: '<reused@test>', flags: new Set(['\\Seen']) });
      syncedDestination = { uid: 11, folder: 'INBOX' }; // a different message legitimately owns UID11
      const move = client.messageMove;
      client.messageMove = async (...args) => {
        expect(manager._isMoveUidGuarded(ACCOUNT.id, 'Snoozed', 11)).toBe(true);
        return move(...args);
      };
      expect(await manager.wakeSnoozed(record, { markUnread })).toBe(true);
      expect(moved).toBe(1);
      expect(record).toBe(null);
      expect(syncedDestination).toEqual({ uid: 11, folder: 'INBOX' });
      expect(stores).toEqual([]);
      expect(manager._pendingFlagPush.size).toBe(0);
      expect(manager._isMoveUidGuarded(ACCOUNT.id, 'Snoozed', 11)).toBe(false);
    });
  }

  for (const id of ['<@>', '<x@>', '<@x>', '<garbage>']) for (const withUidplus of [false, true]) {
    it(`never STOREs for one unique malformed moved ID ${id}, UIDPLUS=${withUidplus}`, async () => {
      uidplus = withUidplus; client = transport(); record.message_id_header = id;
      folders.Snoozed.get(11).id = id;
      expect(await manager.wakeSnoozed(record)).toBe(true);
      expect(stores).toEqual([]); expect(record).toBe(null);
      expect(manager.syncFolderOnDemand).toHaveBeenCalled();
      expect(manager._pendingFlagPush.size).toBe(0);
    });
  }

});

// Only an explicitly supplied isolated test database is used. The two connections
// share a uniquely named schema so a genuine concurrent INSERT can commit.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('PostgreSQL snooze cache reconciliation', () => {
  let db, sync, schema, interleave;
  beforeAll(async () => {
    schema = `snooze_wake_${process.pid}_${Date.now()}`;
    db = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    sync = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await db.connect(); await sync.connect();
    await db.query(`CREATE SCHEMA ${schema}`);
    for (const c of [db, sync]) await c.query(`SET search_path TO ${schema}`);
    await db.query(`CREATE TABLE email_accounts (id text PRIMARY KEY, user_id text, imap_host text, auth_user text, auth_pass text);
      CREATE TABLE messages (id text PRIMARY KEY, account_id text, uid bigint, folder text, message_id text,
        is_read boolean, is_deleted boolean DEFAULT false, read_changed_at timestamptz, UNIQUE(account_id,uid,folder));
      CREATE TABLE snoozed_messages (id text PRIMARY KEY, user_id text, account_id text, message_id_header text,
        original_folder text, snoozed_folder text, snooze_until timestamptz);
      CREATE TABLE folders (account_id text, path text, total_count int, unread_count int, PRIMARY KEY(account_id,path));`);
  });
  afterAll(async () => {
    if (db) { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.end(); }
    await sync?.end();
  });
  const destination = async (read = true, uid = 77) => {
    await sync.query(`INSERT INTO messages VALUES ('synced', $1,$2,'INBOX','<target@test>',$3,false,NULL)`, [ACCOUNT.id, uid, read]);
    await sync.query(`UPDATE folders SET total_count=1, unread_count=$1 WHERE path='INBOX'`, [read ? 0 : 1]);
  };
  beforeEach(async () => {
    interleave = null;
    await db.query(`DROP TRIGGER IF EXISTS suppress_source_update ON messages;
      DROP TRIGGER IF EXISTS reject_source_update ON messages;
      DROP FUNCTION IF EXISTS suppress_source_update(); DROP FUNCTION IF EXISTS reject_source_update();
      TRUNCATE messages,snoozed_messages,email_accounts,folders`);
    await db.query('INSERT INTO email_accounts VALUES ($1,$2,$3,$4,$5)', Object.values(ACCOUNT));
    await db.query(`INSERT INTO messages VALUES ('source',$1,11,'Snoozed','<target@test>',true,false,NULL)`, [ACCOUNT.id]);
    await db.query(`INSERT INTO snoozed_messages VALUES ('snooze-1',$1,$2,'<target@test>','INBOX','Snoozed',NOW())`, [ACCOUNT.user_id, ACCOUNT.id]);
    await db.query(`INSERT INTO folders VALUES ($1,'Snoozed',1,0),($1,'INBOX',0,0)`, [ACCOUNT.id]);
    const execute = async (sql, p) => {
      const result = await db.query(sql, p);
      if (interleave && sql.startsWith('DELETE FROM messages WHERE account_id')) {
        const hook = interleave; interleave = null; await hook();
      }
      return result;
    };
    query.mockImplementation(execute);
    const actualUtils = await vi.importActual('../utils/mailUtils.js');
    adjustFolderCounts.mockImplementation(actualUtils.adjustFolderCounts);
    withTransaction.mockImplementation(async fn => {
      await db.query('BEGIN');
      try { const result = await fn({ query: execute }); await db.query('COMMIT'); return result; }
      catch (err) { await db.query('ROLLBACK'); throw err; }
    });
    uidplus = true; client = transport();
    // The real DB is asserted below; bypass only the fake DB's metadata check.
    client.messageFlagsRemove = async (range, flags, opts) => {
      expect(client.locked).toBe(true); expect(opts).toEqual({ uid: true });
      expect(flags).toEqual(['\\Seen']); stores.push([client.mailbox.path, range, flags, opts]);
      for (const uid of uids(range)) folders[client.mailbox.path].get(uid)?.flags.delete('\\Seen');
      return true;
    };
  });
  const counts = async () => (await db.query("SELECT total_count,unread_count FROM folders WHERE path='INBOX'")).rows[0];
  for (const read of [false, true]) for (const sourceRead of [false, true]) for (const markUnread of [false, true]) {
    it(`does not double-count a synced destination read=${read}, sourceRead=${sourceRead}, automatic=${markUnread}`, async () => {
      await db.query("UPDATE messages SET is_read=$1 WHERE id='source'", [sourceRead]);
      await destination(read);
      expect(await manager.wakeSnoozed(record, { markUnread })).toBe(true);
      expect(await counts()).toEqual({ total_count: 1, unread_count: markUnread || !sourceRead ? 1 : 0 });
      expect((await db.query('SELECT count(*)::int AS n FROM messages')).rows[0].n).toBe(1);
    });
  }
  it('counts soft-deleted unread rows consistently with sync and reconciliation', async () => {
    await db.query("INSERT INTO messages VALUES ('soft-deleted',$1,88,'INBOX','<deleted@test>',false,true,NULL)", [ACCOUNT.id]);
    expect(await manager.wakeSnoozed(record)).toBe(true);
    expect(await counts()).toEqual({ total_count: 1, unread_count: 2 });
  });
  for (const sourceChange of ['removed', 'repointed']) {
    it.each([false, true])(`marks the known verified destination unread when sync ${sourceChange} the source after MOVE, UIDPLUS=%s`, async hasUidplus => {
      uidplus = hasUidplus; if (!hasUidplus) client.capabilities.delete('UIDPLUS');
      const move = client.messageMove;
      client.messageMove = async (...args) => {
        const result = await move(...args);
        if (sourceChange === 'removed') { await db.query("DELETE FROM messages WHERE id='source'"); await destination(); }
        else await db.query("UPDATE messages SET folder='INBOX',uid=77 WHERE id='source'");
        return result;
      };
      expect(await manager.wakeSnoozed(record)).toBe(true);
      expect(stores).toEqual([['INBOX', '77', ['\\Seen'], { uid: true }]]);
      expect(folders.INBOX.get(77).flags.has('\\Seen')).toBe(false);
      expect((await db.query('SELECT count(*)::int AS n FROM snoozed_messages')).rows[0].n).toBe(0);
      expect(manager.syncFolderOnDemand).toHaveBeenCalledWith(ACCOUNT, 'INBOX');
      expect(moved).toBe(1); expect(manager._pendingFlagPush.size).toBe(0);
    });
  }
  for (const identity of ['absent', 'reused']) {
    it.each([false, true])(`refuses ${identity} expected identity after sync removes the source, UIDPLUS=%s`, async hasUidplus => {
      uidplus = hasUidplus; if (!hasUidplus) client.capabilities.delete('UIDPLUS');
      const move = client.messageMove;
      client.messageMove = async (...args) => {
        const result = await move(...args);
        await db.query("DELETE FROM messages WHERE id='source'"); await destination();
        if (identity === 'absent') {
          folders.INBOX.get(77).id = '<different@test>';
          await db.query("UPDATE messages SET message_id='<different@test>' WHERE uid=77");
        } else folders.INBOX.set(66, { id: '<target@test>', flags: new Set(['\\Seen']) });
        return result;
      };
      expect(await manager.wakeSnoozed(record)).toBe(true);
      expect(stores).toEqual([]);
      expect(folders.INBOX.get(77).flags.has('\\Seen')).toBe(true);
      expect(searches).toContainEqual(['HEADER', 'MESSAGE-ID', 'target@test']);
      expect(manager.syncFolderOnDemand).toHaveBeenCalledWith(ACCOUNT, 'INBOX');
      expect(moved).toBe(1); expect(manager._pendingFlagPush.size).toBe(0);
    });
  }
  it('survives a committed sync INSERT between destination DELETE and source UPDATE', async () => {
    interleave = () => destination();
    expect(await manager.wakeSnoozed(record)).toBe(true);
    expect((await db.query("SELECT uid::int,folder FROM messages")).rows).toEqual([{ uid: 77, folder: 'INBOX' }]);
    expect((await db.query('SELECT count(*)::int AS n FROM snoozed_messages')).rows[0].n).toBe(0);
  });
  it('does not delete the useful destination if the source UPDATE affects zero rows', async () => {
    await destination();
    await db.query(`CREATE FUNCTION suppress_source_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER suppress_source_update BEFORE UPDATE ON messages FOR EACH ROW
        WHEN (OLD.id = 'source') EXECUTE FUNCTION suppress_source_update()`);
    expect(await manager.wakeSnoozed(record)).toBe(true);
    expect((await db.query("SELECT uid::int,folder FROM messages WHERE uid=77")).rows).toEqual([{ uid: 77, folder: 'INBOX' }]);
    expect(manager.syncFolderOnDemand).toHaveBeenCalled();
    await db.query('DROP TRIGGER suppress_source_update ON messages; DROP FUNCTION suppress_source_update()');
  });
  for (const markUnread of [false, true]) {
    it(`keeps the unrelated cached sourceUID and retires an unknown wake, automatic=${markUnread}`, async () => {
      uidplus = false; client = transport();
      // Automatic lookup is genuinely ambiguous; manual wake skips lookup.
      folders.INBOX.set(66, { id: '<target@test>', flags: new Set(['\\Seen']) });
      await destination(true, 11);
      expect(await manager.wakeSnoozed(record, { markUnread })).toBe(true);
      expect((await db.query("SELECT id,uid::int,folder FROM messages")).rows).toEqual([{ id: 'synced', uid: 11, folder: 'INBOX' }]);
      expect((await db.query('SELECT count(*)::int AS n FROM snoozed_messages')).rows[0].n).toBe(0);
      expect(manager._pendingMoveUids.size).toBe(0);
      expect(stores).toEqual([]);
      expect(manager.syncFolderOnDemand).toHaveBeenCalled();
    });
  }
  it('rolls back an actual PostgreSQL UPDATE error and recovers the committed server move', async () => {
    await destination();
    await db.query(`CREATE FUNCTION reject_source_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test source update refused'; END $$;
      CREATE TRIGGER reject_source_update BEFORE UPDATE ON messages FOR EACH ROW
        WHEN (OLD.id = 'source') EXECUTE FUNCTION reject_source_update()`);
    expect(await manager.wakeSnoozed(record)).toBe(true);
    expect((await db.query("SELECT uid::int FROM messages WHERE id='synced'")).rows).toEqual([{ uid: 77 }]);
    expect((await db.query('SELECT count(*)::int AS n FROM snoozed_messages')).rows[0].n).toBe(0);
    expect(stores).toEqual([['INBOX', '77', ['\\Seen'], { uid: true }]]);
    expect(folders.INBOX.get(77).flags.has('\\Seen')).toBe(false);
    expect(manager._pendingMoveUids.size).toBe(0);
    expect(manager.syncFolderOnDemand).toHaveBeenCalledWith(ACCOUNT, 'Snoozed');
    expect(manager.syncFolderOnDemand).toHaveBeenCalledWith(ACCOUNT, 'INBOX');
  });

  it('preserves the destination when the source is soft-deleted during MOVE', async () => {
    await destination();
    const move = client.messageMove;
    client.messageMove = async (...args) => {
      const result = await move(...args);
      await db.query("UPDATE messages SET is_deleted=true WHERE id='source'");
      return result;
    };
    expect(await manager.wakeSnoozed(record)).toBe(true);
    expect((await db.query("SELECT uid::int FROM messages WHERE id='synced'")).rows).toEqual([{ uid: 77 }]);
    expect(stores).toEqual([['INBOX', '77', ['\\Seen'], { uid: true }]]);
    expect(folders.INBOX.get(77).flags.has('\\Seen')).toBe(false);
    expect(manager.syncFolderOnDemand).toHaveBeenCalled();
  });

});
