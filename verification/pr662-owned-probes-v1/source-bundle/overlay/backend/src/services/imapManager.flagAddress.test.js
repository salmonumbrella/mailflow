import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn(() => 'test-password') }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn(async () => {}) }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
import { ImapManager, evictPool } from './imapManager.js';
import { ImapFlow } from 'imapflow';
import { query } from './db.js';
import { resolveForConnection } from './hostValidation.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { applyInboxRules } from './inboxRules.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let versionSerial = 0n;
let seq = 0, manager, account, client, rows, server, wire, uidPlus;
const key = (folder, uid) => `${folder}:${uid}`;
function addRow(id, folder, uid, header = '<mail@example.test>') {
  const row = { id, account_id: account.id, folder, uid, message_id: header,
    flag_address_valid: true, flag_uid_validity: '1', address_xmin: '1', is_read: false, is_starred: false,
    read_changed_at: null, star_changed_at: null, read_intent_version: '0', star_intent_version: '0', is_deleted: false };
  rows.set(id, row);
  server.set(key(folder, uid), { uid, envelope: { messageId: header }, flags: new Set() });
  return row;
}
function metadata(uid = 17) {
  return { uid, envelope: {}, flags: new Set(), bodyStructure: { type: 'text/plain', part: '1' },
    internalDate: new Date('2026-10-01'), headers: Buffer.from('From: Sender <sender@example.test>\r\nTo: Reader <reader@example.test>\r\nSubject: Live copy\r\n\r\n') };
}
beforeEach(() => {
  vi.useFakeTimers();
  rows = new Map(); server = new Map(); wire = []; uidPlus = true;
  account = { id: `address-${++seq}`, user_id: 'user', enabled: true, imap_host: 'imap.mail.yahoo.com',
    imap_port: 993, imap_tls: true, auth_user: 'test', auth_pass: 'encrypted' };
  client = Object.assign(new EventEmitter(), { usable: true,
    capabilities: new Set(['MOVE']),
    mailbox: { path: 'INBOX', uidValidity: 1n, exists: 10 },
    connect: vi.fn(async () => {}), close: vi.fn(), logout: vi.fn(async () => {}), noop: vi.fn(async () => true),
    getMailboxLock: vi.fn(async function (folder) {
      this.mailbox = { path: folder, uidValidity: 1n, exists: 10 };
      return { release: vi.fn() };
    }),
    status: vi.fn(async () => ({ uidNext: 100 })),
    messageFlagsAdd: vi.fn(async function (range, flags, options) {
      wire.push(['add', this.mailbox.path, range, flags, options]);
      for (const uid of String(range).split(',')) {
        const message = server.get(key(this.mailbox.path, uid));
        if (message) for (const flag of flags) message.flags.add(flag);
      }
      return true;
    }),
    messageFlagsRemove: vi.fn(async function (range, flags, options) {
      wire.push(['remove', this.mailbox.path, range, flags, options]);
      for (const uid of String(range).split(',')) {
        const message = server.get(key(this.mailbox.path, uid));
        if (message) for (const flag of flags) message.flags.delete(flag);
      }
      return true;
    }),
    messageMove: vi.fn(async function (range, destination) {
      const uid = Number(Array.isArray(range) ? range[0] : range);
      const message = server.get(key(this.mailbox.path, uid));
      wire.push(['move', this.mailbox.path, uid, destination]);
      server.delete(key(this.mailbox.path, uid));
      if (message) server.set(key(destination, 100), { ...message, uid: 100 });
      return uidPlus ? { uidMap: new Map([[uid, 100]]), uidValidity: 1n } : {};
    }),
    search: vi.fn(async function (search) { return [...server.entries()]
      .filter(([k, message]) => k.startsWith(`${this.mailbox.path}:`)
        && (!search.header || message.envelope.messageId?.includes(search.header['Message-ID'])))
      .map(([, message]) => message.uid); }),
    fetch: vi.fn(async function* (range) {
      for (const uid of String(range).split(',')) {
        const message = server.get(key(this.mailbox.path, uid));
        if (message) yield message;
      }
    }),
  });
  query.mockReset().mockImplementation(async (sql, args = []) => {
    if (sql.includes('nextval(')) return { rows: [{ version: String(++versionSerial) }], rowCount: 1 };
    if (sql.includes('FROM email_accounts')) return { rows: [account] };
    if (sql.includes('SELECT uid_validity, highest_modseq')) return { rows: [{ uid_validity: '1', highest_modseq: null }] };
    if (sql.includes('COALESCE(MAX(uid), 0)')) return { rows: [{ max_uid: 0 }] };
    if (sql.includes('COUNT(*) FILTER')) return { rows: [{ n: 0 }] };
    if (sql.includes('DELETE FROM messages WHERE id = $1')) { rows.delete(args[0]); return { rowCount: 1, rows: [] }; }
    if (sql.includes('SELECT id, uid, xmin::text')) {
      return { rows: [...rows.values()].filter(row => row.account_id === args[0]
        && row.folder === args[1] && !row.flag_address_valid).map(row => ({ ...row })) };
    }
    if (sql.includes('SET flag_uid_validity = $4')) {
      for (const row of rows.values()) if (row.account_id === args[0] && row.folder === args[1]
        && row.uid === Number(args[2]) && row.flag_address_valid) row.flag_uid_validity = args[3];
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO messages')) {
      if (sql.includes('WITH retired AS')) {
        const stale = rows.get(args[34]);
        if (!stale || stale.address_xmin !== args[35] || stale.flag_address_valid) return { rows: [], rowCount: 0 };
        rows.delete(stale.id);
      }
      let row = [...rows.values()].find(r => r.account_id === args[0] && r.uid === Number(args[1]) && r.folder === args[2]);
      if (!row) {
        row = { id: 'live-row', account_id: args[0], uid: Number(args[1]), folder: args[2],
          message_id: args[3], flag_address_valid: args.length >= 34 ? args[33] : true,
          flag_uid_validity: args[32] == null ? null : String(args[32]), address_xmin: '1', is_read: false, is_starred: false,
          read_changed_at: null, star_changed_at: null, read_intent_version: '0', star_intent_version: '0', is_deleted: false };
        rows.set(row.id, row);
      }
      return { rows: [{ id: row.id, is_new: true }] };
    }
    if (sql.startsWith('UPDATE messages SET flag_uid_validity = $2')) {
      const row=rows.get(args[0]);
      if(!row || row.address_xmin!==args[2])return{rows:[],rowCount:0};
      row.flag_uid_validity=args[1];row.address_xmin=String(BigInt(row.address_xmin)+1n);
      return{rows:[{address_xmin:row.address_xmin}],rowCount:1};
    }
    if (sql.startsWith('UPDATE messages SET flag_address_valid = true')) {
      const row=rows.get(args[0]);
      if (!row || row.address_xmin!==args[2] || row.folder!==args[3] || Number(row.uid)!==Number(args[4])) return {rows:[],rowCount:0};
      row.flag_address_valid=true;row.flag_uid_validity=args[1];row.address_xmin=String(BigInt(row.address_xmin)+1n);
      return {rows:[{id:row.id,address_xmin:row.address_xmin}],rowCount:1};
    }
    if (sql.includes('UPDATE messages') && sql.includes('intent_version')) {
      const star=sql.includes('star_intent_version'),versionCol=star?'star_intent_version':'read_intent_version',markerCol=star?'star_changed_at':'read_changed_at';
      const clear=sql.includes('THEN NULL ELSE'),reassert=sql.includes('SET is_read = $1')||sql.includes('SET is_starred = $1');
      const row=rows.get(args[reassert?1:0]),version=args[clear?1:reassert?3:2],marker=args[clear?2:reassert?2:1];
      if (!row) return {rows:[],rowCount:0};
      if (clear) {
        if (BigInt(row[versionCol])>BigInt(version) || (args.length>3 && (row.message_id!==args[3]
          || String(row.flag_uid_validity)!==String(args[4]) || row.account_id!==args[5] || row.folder!==args[6] || Number(row.uid)!==Number(args[7])))) return {rows:[],rowCount:0};
        if(row[markerCol]===marker)row[markerCol]=null;
      } else {
        if (BigInt(row[versionCol])>BigInt(version) || (String(row[versionCol])===String(version)&&row[markerCol]!==marker)
          || (reassert&&sql.includes('AND xmin::text = $5')&&row.address_xmin!==args[4])) return {rows:[],rowCount:0};
        row[markerCol]=marker;if(reassert)row[star?'is_starred':'is_read']=args[0];
      }
      row[versionCol]=String(version);row.address_xmin=String(BigInt(row.address_xmin)+1n);
      return {rows:clear?[]:[{id:row.id,address_xmin:row.address_xmin}],rowCount:1};
    }
    if (sql.includes('SELECT uid, folder')) return { rows: rows.has(args[0]) ? [{ ...rows.get(args[0]) }] : [] };
    if (sql.includes('FROM messages') && sql.includes('account_id = $1')) {
      const found = [...rows.values()].filter(r => r.account_id === args[0]
        && (sql.includes('uid = ANY') ? r.folder === args[1] && args[2].map(Number).includes(r.uid)
          : r.folder === args[1] && r.uid === Number(args[2])));
      return { rows: found.map(r => ({ ...r })) };
    }
    if (sql.includes('SET flag_address_valid = false')) {
      for (const r of rows.values()) if (r.account_id === args[0] && r.folder === args[1]
        && args[2].map(Number).includes(r.uid)) { r.flag_address_valid = false; r.address_xmin = String(BigInt(r.address_xmin) + 1n); }
    }
    return { rows: [], rowCount: 1 };
  });
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
  resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
  ImapFlow.mockReset().mockImplementation(function () {
    return Object.assign(new EventEmitter(), client, { mailbox: { ...client.mailbox } });
  });
  manager = new ImapManager({ clients: new Set() });
  vi.clearAllTimers();
  manager.connections.set(account.id, client);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(manager, 'syncFolderOnDemand').mockResolvedValue();
});
afterEach(() => { evictPool(account.id); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

// Each connection owns its schema, actual migration/sequence, and cleanup.
async function withFlagDatabase(run) {
  const db = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
  await db.connect();
  const schema=`flag_address_${randomUUID().replaceAll('-','')}`;
  const normal=query.getMockImplementation();
  try {
    await db.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}";
      CREATE TABLE email_accounts(id text,enabled boolean);
      CREATE TABLE messages(id text PRIMARY KEY,account_id text,uid bigint,folder text,message_id text,
        is_deleted boolean DEFAULT false,is_read boolean DEFAULT false,is_starred boolean DEFAULT false,
        read_changed_at timestamptz,star_changed_at timestamptz,body_html text)`);
    await db.query(await readFile(new URL('../../migrations/0079_message_flag_addresses.sql',import.meta.url),'utf8'));
    await db.query('INSERT INTO email_accounts VALUES($1,true)',[account.id]);
    for (const row of rows.values()) await db.query(`INSERT INTO messages(id,account_id,uid,folder,message_id,flag_address_valid,flag_uid_validity)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[row.id,row.account_id,row.uid,row.folder,row.message_id,row.flag_address_valid,row.flag_uid_validity]);
    query.mockImplementation((sql,args)=> /messages|email_accounts|nextval/.test(sql) ? db.query(sql,args):normal(sql,args));
    await run(db);
  } finally { query.mockImplementation(normal); await db.query(`DROP SCHEMA "${schema}" CASCADE`); await db.end(); }
}

describe('production move and flag address safety', () => {
  it.skipIf(!process.env.MAILFLOW_PREUPGRADE_BACKEND || !process.env.MAILFLOW_TEST_DATABASE_URL)
    .each([false, true])('refuses an unrelated legacy source UID after real preupgrade MOVE and migration (NULL override=%s)', async unknown => {
      const legacy = process.env.MAILFLOW_PREUPGRADE_BACKEND;
      vi.doMock(`${legacy}/src/services/db.js`, () => ({ query }));
      vi.doMock(`${legacy}/src/services/encryption.js`, () => ({ decrypt: () => 'test-password' }));
      vi.doMock(`${legacy}/src/services/hostValidation.js`, () => ({ resolveForConnection, createPinnedLookup: vi.fn() }));
      vi.doMock(`${legacy}/src/services/connectionPolicy.js`, () => ({ getConnectionPolicy }));
      vi.doMock(`${legacy}/src/services/aiProvider.js`, () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
      vi.doMock(`${legacy}/src/services/pushNotifications.js`, () => ({ sendPushToUser: vi.fn() }));
      vi.doMock(`${legacy}/src/routes/oauth.js`, () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
      const { ImapManager: LegacyManager, evictPool: evictLegacy } = await import(/* @vite-ignore */ `${legacy}/src/services/imapManager.js`);
      const database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
      await database.connect();
      const schema = `flag_upgrade_${randomUUID().replaceAll('-', '')}`;
      try {
        await database.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}";
          CREATE TABLE folders(account_id text,path text,uid_validity bigint);
          CREATE TABLE messages(id uuid PRIMARY KEY,account_id text,uid bigint,folder text,message_id text,
            is_deleted boolean DEFAULT false,is_read boolean DEFAULT false,is_starred boolean DEFAULT false,
            read_changed_at timestamptz,star_changed_at timestamptz)`);
        const source = addRow('11111111-1111-4111-8111-111111111111', 'INBOX', 17, '<moved@example.test>');
        addRow('unrelated', 'Trash', 17, '<other@example.test>');
        await database.query("INSERT INTO messages(id,account_id,uid,folder,message_id) VALUES ($1,$2,17,'INBOX',$3)", [source.id,account.id,source.message_id]);
        await database.query("INSERT INTO folders VALUES ($1,'Trash',1)", [account.id]);
        uidPlus = false;
        const previous = new LegacyManager({ clients: new Set() }); vi.clearAllTimers();
        expect(await previous.moveMessageGetNewUid(account, 17, 'INBOX', 'Trash')).toBeNull();
        // The preupgrade single-move route retains srcUid when MOVE has no mapping.
        await database.query("UPDATE messages SET folder='Trash' WHERE id=$1", [source.id]);
        expect(server.get(key('Trash',17)).envelope.messageId).toBe('<other@example.test>');
        await database.query(await readFile(new URL('../../migrations/0079_message_flag_addresses.sql', import.meta.url), 'utf8'));
        if (unknown) await database.query('UPDATE messages SET flag_uid_validity=NULL');
        const normal = query.getMockImplementation();
        query.mockImplementation((sql,args) => /(?:FROM|UPDATE) messages|nextval\(/.test(sql) ? database.query(sql,args) : normal(sql,args));
        const failure = await manager.setFlag(account,17,'Trash','\\Flagged',true).then(() => null, err => err);
        expect(server.get(key('Trash',17)).flags.size).toBe(0);
        expect(failure).toMatchObject({ unsafeFlagAddress: true });
        expect(client.messageFlagsAdd).not.toHaveBeenCalled();
        evictLegacy(account.id);
      } finally {
        evictLegacy(account.id);
        await database.query(`DROP SCHEMA "${schema}" CASCADE`); await database.end();
      }
    });

  it.each(['mark_read','star'])('preserves a real %s rule on an epoch-bound live row', async type => {
    const row = addRow('source', 'INBOX', 17);
    const normal = query.getMockImplementation();
    query.mockImplementation((sql, args) => sql.includes('FROM inbox_rules') ? { rows: [{
      id: 'rule', enabled: true, condition_logic: 'AND',
      conditions: [{ field: 'from', operator: 'contains', value: 'sender@' }], actions: [{ type }],
    }] } : normal(sql, args));
    await applyInboxRules([{ ...row, fromEmail: 'sender@example.test' }], account, manager);
    await manager._flagOpChains.get(account.id);
    expect(server.get(key('INBOX', 17)).flags.has(type === 'star' ? '\\Flagged' : '\\Seen')).toBe(true);
    expect(client.fetch).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.includes(`SET ${type === 'star' ? 'star' : 'read'}_changed_at = CASE`))).toBe(true);
  });

  it('flags a newly appended draft through live same-session proof before its first sync', async () => {
    server.set(key('Drafts', 77), { uid: 77, envelope: { messageId: '<draft@example.test>' }, flags: new Set(['\\Seen']) });
    await manager.upsertDraftMessageRecord(account, 'Drafts', 77, { messageId: '<draft@example.test>' });
    await manager.setFlag(account, 77, 'Drafts', '\\Seen', false);
    expect(server.get(key('Drafts', 77)).flags.has('\\Seen')).toBe(false);
    expect(client.search).toHaveBeenCalledWith({ header: { 'Message-ID': 'draft@example.test' } }, { uid: true });
  });

  it.each(['imap.gmail.com','imap.mail.yahoo.com','outlook.office365.com','imap.zoho.com'])('uses healthy IDLE without extra FETCH/login for %s', async host => {
    account.imap_host = host;
    const row = addRow('source', 'INBOX', 17, null);
    manager._secondaryCooldown.set(account.id, { until: Date.now() + 60000, failures: 3 });
    manager._enqueueFlagPush(account.id, row.id, '\\Seen', true);
    await manager._reconcileFlagPushes();
    expect(client.messageFlagsAdd).toHaveBeenCalledWith('17', ['\\Seen'], { uid: true });
    expect(client.fetch).not.toHaveBeenCalled();
    expect(ImapFlow).not.toHaveBeenCalled();
  });

  it.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL).each([false, true])('runs live recovery SQL in PostgreSQL (MOVE during FETCH=%s)', async moveDuringFetch => {
    const database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    try {
      const textColumns = ['message_id','subject','from_name','from_email','in_reply_to','snippet',
        'body_html','body_text','thread_references','thread_id','category','list_unsubscribe','list_unsubscribe_post',
        'sender_name','sender_email','forwarded_from_name','forwarded_from_email','forwarded_via'];
      const jsonColumns = ['to_addresses','cc_addresses','reply_to','flags','attachments','delivery_addresses'];
      await database.query(`CREATE TEMP TABLE messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id text, uid bigint, folder text, date timestamptz,
        is_read boolean, is_starred boolean, has_attachments boolean, is_bulk boolean,
        flag_address_valid boolean DEFAULT true, flag_uid_validity bigint,
        read_changed_at timestamptz, star_changed_at timestamptz,
        read_intent_version bigint DEFAULT 0,star_intent_version bigint DEFAULT 0,
        ${textColumns.map(c => `${c} text`).join(',')},${jsonColumns.map(c => `${c} jsonb`).join(',')},
        UNIQUE(account_id,uid,folder))`);
      const source = addRow('11111111-1111-4111-8111-111111111111', 'INBOX', 17, null);
      await database.query(`INSERT INTO messages(id,account_id,uid,folder,flag_address_valid,body_html)
        VALUES ($1,$2,17,'INBOX',false,'old cached body')`, [source.id, account.id]);
      const normalQuery = query.getMockImplementation();
      query.mockImplementation((sql, args) => sql.includes('INSERT INTO messages') || sql.includes('xmin::text')
        || sql.includes('SELECT id, uid FROM messages') || sql.includes('UPDATE messages SET flag_address_valid = false')
        || sql.includes('DELETE FROM messages WHERE id = $1') ? database.query(sql, args) : normalQuery(sql, args));
      const fetched = deferred(), resume = deferred();
      client.fetch.mockImplementation(async function* () {
        fetched.resolve(); await resume.promise; yield metadata();
      });
      const sync = manager.syncMessages(account, client, 'INBOX', 20, false, true);
      await fetched.promise;
      if (moveDuringFetch) {
        await manager.moveMessage(account, 17, 'INBOX', 'Archive');
        await query('DELETE FROM messages WHERE id = $1', [source.id]);
      }
      resume.resolve(); await sync;
      expect(console.error).not.toHaveBeenCalled();
      const live = (await database.query('SELECT id,body_html,flag_address_valid,flag_uid_validity FROM messages')).rows;
      if (moveDuringFetch) expect(live).toEqual([]);
      else {
        expect(live).toHaveLength(1);
        expect(live[0].id).not.toBe(source.id);
        expect(live[0]).toMatchObject({ body_html: null, flag_address_valid: true, flag_uid_validity: '1' });
      }
    } finally { await database.end(); }
  });

  it('requires live same-session identity proof when a legacy address has no epoch', async () => {
    const legacy = addRow('legacy', 'INBOX', 17);
    legacy.flag_uid_validity = null;
    await manager.setFlag(account, 17, 'INBOX', '\\Seen', true);
    expect(client.search).toHaveBeenCalledWith({ header: { 'Message-ID': 'mail@example.test' } }, { uid: true });
    expect(client.fetch).toHaveBeenCalledWith('17', { uid: true, envelope: true }, { uid: true });
    expect(ImapFlow).not.toHaveBeenCalled();
  });

  it('rejects legacy proof when the live UID identity is absent', async () => {
    const legacy = addRow('legacy', 'INBOX', 17);
    legacy.flag_uid_validity = null;
    server.delete(key('INBOX', 17));
    await expect(manager.setFlag(account, 17, 'INBOX', '\\Seen', true)).rejects.toMatchObject({ unsafeFlagAddress: true });
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it('does not recover an invalid address without a selected UIDVALIDITY', async () => {
    const invalid = addRow('invalid', 'INBOX', 17, null);
    invalid.flag_address_valid = false;
    client.getMailboxLock.mockImplementation(async function () { this.mailbox = { path: 'INBOX', exists: 1 }; return { release() {} }; });
    client.fetch.mockImplementation(async function* () { yield metadata(); });
    await manager.syncMessages(account, client, 'INBOX', 20, false, true);
    expect(rows.get(invalid.id).flag_address_valid).toBe(false);
    await expect(manager.setFlag(account, 17, 'INBOX', '\\Seen', true)).rejects.toMatchObject({ unsafeFlagAddress: true });
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it('rejects invalid-row recovery when an actual MOVE changes its xmin during FETCH', async () => {
    const source = addRow('source', 'INBOX', 17, null);
    source.flag_address_valid = false;
    const fetched = deferred(), resume = deferred();
    client.fetch.mockImplementationOnce(async function* () { fetched.resolve(); await resume.promise; yield metadata(); });
    const sync = manager.syncMessages(account, client, 'INBOX', 20, false, true);
    await fetched.promise;
    await manager.moveMessage(account, 17, 'INBOX', 'Archive');
    await query('DELETE FROM messages WHERE id = $1', [source.id]);
    resume.resolve(); await sync;
    expect(rows.has('live-row')).toBe(false);
    expect(server.has(key('INBOX', 17))).toBe(false);
    expect(server.has(key('Archive', 100))).toBe(true);
  });

  it('binds a stale source upsert to its old live epoch and refuses a reused UID in a new epoch', async () => {
    const source = addRow('source', 'INBOX', 17, null);
    const fetched = deferred(), resume = deferred();
    client.fetch.mockImplementationOnce(async function* () { fetched.resolve(); await resume.promise; yield metadata(); });
    const sync = manager.syncMessages(account, client, 'INBOX', 20, false, true);
    await fetched.promise;
    await manager.moveMessage(account, 17, 'INBOX', 'Archive');
    await query('DELETE FROM messages WHERE id = $1', [source.id]);
    resume.resolve(); await sync;
    expect(rows.get('live-row')).toMatchObject({ flag_uid_validity: '1', flag_address_valid: true });
    expect(server.has(key('INBOX', 17))).toBe(false); // unchanged epoch: ghost cache, no unrelated target
    const unrelated = { ...metadata(), flags: new Set() };
    server.set(key('INBOX', 17), unrelated);
    client.getMailboxLock.mockImplementation(async function () { this.mailbox = { path: 'INBOX', exists: 1, uidValidity: 2n }; return { release() {} }; });
    await expect(manager.setFlag(account, 17, 'INBOX', '\\Seen', true)).rejects.toMatchObject({ unsafeFlagAddress: true });
    expect(unrelated.flags.size).toBe(0);
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it.each([null, '<reused@example.test>'])('retires an invalid row only through real live FETCH, including identity %s', async header => {
    const invalid = addRow('invalid-before-restart', 'INBOX', 17, header);
    invalid.flag_address_valid = false;
    invalid.body_html = '<p>old cached body</p>';
    manager._enqueueFlagPush(account.id, invalid.id, '\\Seen', false);
    const message = server.get(key('INBOX', 17));
    Object.assign(message, { flags: new Set(), bodyStructure: { type: 'text/plain', part: '1' },
      internalDate: new Date('2026-10-01'), headers: Buffer.from(
        `From: Sender <sender@example.test>\r\nTo: Reader <reader@example.test>\r\nSubject: Live copy\r\n${header ? `Message-ID: ${header}\r\n` : ''}\r\n`) });
    client.fetch.mockImplementation(async function* () { yield message; });
    await manager.syncMessages(account, client, 'INBOX', 20, false, true);
    expect(rows.has(invalid.id)).toBe(false);
    expect(rows.get('live-row')).toMatchObject({ uid: 17, flag_address_valid: true, flag_uid_validity: '1' });
    expect(rows.get('live-row').body_html).not.toBe(invalid.body_html);
    expect(client.fetch).toHaveBeenCalled();
    await manager._reconcileFlagPushes();
    expect(client.messageFlagsRemove).not.toHaveBeenCalled();
    await manager.setFlag(account, 17, 'INBOX', '\\Seen', true);
    expect(client.messageFlagsAdd).toHaveBeenCalledWith('17', ['\\Seen'], { uid: true });
  });

  it.each([null, '<>', '<reused@example.test>'])('invalidates noUIDPLUS source identity %s without adopting an older destination', async header => {
    uidPlus = false;
    const moved = addRow('moved', 'INBOX', 17, header);
    addRow('older', 'Trash', 17, header);
    manager._enqueueFlagPush(account.id, moved.id, '\\Seen', true);
    await manager.moveMessage(account, 17, 'INBOX', 'Trash');
    // Actual delete/archive routes retain source UID when MOVE has no mapping.
    moved.folder = 'Trash';
    rows.delete('older');
    await expect(manager.setFlag(account, 17, 'Trash', '\\Flagged', true)).rejects.toMatchObject({ unsafeFlagAddress: true });
    await manager._reconcileFlagPushes();
    expect(server.get(key('Trash', 17)).flags.size).toBe(0);
    expect(server.get(key('Trash', 100)).flags.size).toBe(0);
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 30 * 60_000);
    await manager._reconcileFlagPushes();
    expect(manager._pendingFlagPush.has(account.id)).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });

  it.each([true, false])('serializes a move admitted during an outstanding STORE (UIDPLUS=%s)', async mapped => {
    uidPlus = mapped;
    const source = addRow('source', 'INBOX', 17);
    manager._enqueueFlagPush(account.id, source.id, '\\Seen', true);
    const started = deferred(), release = deferred();
    const store = client.messageFlagsAdd.getMockImplementation();
    client.messageFlagsAdd.mockImplementation(async function (...args) {
      started.resolve(); await release.promise; return store.apply(this, args);
    });
    const replay = manager._reconcileFlagPushes();
    await started.promise;
    const move = manager.moveMessage(account, 17, 'INBOX', 'Archive');
    await vi.advanceTimersByTimeAsync(0);
    expect(client.messageMove).not.toHaveBeenCalled();
    release.resolve();
    await replay; await move;
    expect(server.get(key('Archive', 100)).flags.has('\\Seen')).toBe(true);
    expect(wire.map(op => op[0])).toEqual(['add', 'move']);
  });

  it.each([true, false])('preserves a failed delayed STORE through a move only with proof (UIDPLUS=%s)', async mapped => {
    uidPlus = mapped;
    const source = addRow('source', 'INBOX', 17);
    manager._enqueueFlagPush(account.id, source.id, '\\Seen', true);
    const started = deferred(), release = deferred();
    const store = client.messageFlagsAdd.getMockImplementation();
    client.messageFlagsAdd.mockImplementation(async () => { started.resolve(); await release.promise; throw new Error('STORE failed'); });
    const replay = manager._reconcileFlagPushes();
    await started.promise;
    const move = manager.moveMessage(account, 17, 'INBOX', 'Archive');
    await vi.advanceTimersByTimeAsync(0);
    expect(client.messageMove).not.toHaveBeenCalled();
    release.resolve(); await vi.advanceTimersByTimeAsync(1000); await replay; await move;
    Object.assign(source, { folder: 'Archive', uid: mapped ? 100 : 17 });
    client.messageFlagsAdd.mockImplementation(store);
    await manager._reconcileFlagPushes();
    expect(server.get(key('Archive', 100)).flags.has('\\Seen')).toBe(mapped);
    if (!mapped) {
      expect(manager._pendingFlagPush.get(account.id).size).toBe(1);
      vi.setSystemTime(Date.now() + 30 * 60000);
      await manager._reconcileFlagPushes();
      expect(manager._pendingFlagPush.has(account.id)).toBe(false);
      expect(console.warn).toHaveBeenCalled();
    }
  });

  it('carries a failed intent only through a proven UIDPLUS destination after row rotation', async () => {
    const source = addRow('source', 'INBOX', 17);
    manager._enqueueFlagPush(account.id, source.id, '\\Seen', true);
    await manager.moveMessage(account, 17, 'INBOX', 'Trash');
    rows.delete('source');
    rows.set('replacement', { ...source, id: 'replacement', folder: 'Trash', uid: 100, flag_address_valid: true });
    await manager._reconcileFlagPushes();
    expect(server.get(key('Trash', 100)).flags.has('\\Seen')).toBe(true);
    expect(client.messageFlagsAdd).toHaveBeenCalledWith('100', ['\\Seen'], { uid: true });
  });

  it('keeps a proven moved retry until destination ingestion arrives', async () => {
    const source = addRow('source', 'INBOX', 17);
    manager._enqueueFlagPush(account.id, source.id, '\\Seen', true);
    await manager.moveMessage(account, 17, 'INBOX', 'Trash');
    rows.delete(source.id);
    await manager._reconcileFlagPushes();
    expect(manager._pendingFlagPush.get(account.id)?.size).toBe(1);
    rows.set('replacement', { ...source, id: 'replacement', folder: 'Trash', uid: 100, flag_address_valid: true });
    await manager._reconcileFlagPushes();
    expect(server.get(key('Trash', 100)).flags.has('\\Seen')).toBe(true);
  });

  it('uses an actual UIDPLUS proof for the route-retargeted row without guessed adoption', async () => {
    const source = addRow('source', 'INBOX', 17);
    manager._enqueueFlagPush(account.id, source.id, '\\Seen', true);
    await manager.moveMessageGetNewUid(account, 17, 'INBOX', 'Trash');
    Object.assign(source, { folder: 'Trash', uid: 100 });
    expect(source.flag_address_valid).toBe(false);
    await manager._reconcileFlagPushes();
    expect(server.get(key('Trash', 100)).flags.has('\\Seen')).toBe(true);
  });

  it('never lets an old mapped retry overwrite newer confirmed intent at the proven destination', async () => {
    const source = addRow('source', 'INBOX', 17);
    manager._enqueueFlagPush(account.id, source.id, '\\Seen', true);
    await manager.moveMessage(account, 17, 'INBOX', 'Trash');
    rows.delete('source');
    rows.set('replacement', { ...source, id: 'replacement', folder: 'Trash', uid: 100, flag_address_valid: true });
    await manager.setFlag(account, 100, 'Trash', '\\Seen', false);
    await manager._reconcileFlagPushes();
    expect(server.get(key('Trash', 100)).flags.has('\\Seen')).toBe(false);
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it('preserves a proven older retry when a newer address expectation is refused', async () => {
    const source = addRow('source', 'INBOX', 17);
    manager._enqueueFlagPush(account.id, source.id, '\\Seen', true);
    await manager.moveMessage(account, 17, 'INBOX', 'Trash');
    rows.delete('source');
    rows.set('replacement', { ...source, id: 'replacement', folder: 'Trash', uid: 100, flag_address_valid: true });
    await expect(manager.setFlag(account, 100, 'Trash', '\\Seen', false,
      { expectMessageId: '<absent@example.test>' })).rejects.toMatchObject({ unsafeFlagAddress: true });
    await manager._reconcileFlagPushes();
    expect(server.get(key('Trash', 100)).flags.has('\\Seen')).toBe(true);
    expect(client.messageFlagsAdd).toHaveBeenCalledWith('100', ['\\Seen'], { uid: true });
  });

  it('invalidates only bulk source addresses, leaving legitimate destination/srcUid rows usable', async () => {
    uidPlus = false;
    const source = addRow('source', 'INBOX', 17, null);
    const unrelated = addRow('unrelated', 'Archive', 17, null);
    // A noUIDPLUS UIDNEXT count is not a per-message identity proof.
    await manager.bulkMoveMessages(account, [17], 'INBOX', 'Archive');
    rows.delete(source.id); // bulk route deletes moved source rows
    expect(unrelated.flag_address_valid).toBe(true);
    await manager.setFlag(account, 17, 'Archive', '\\Flagged', true);
    expect(server.get(key('Archive', 17)).flags.has('\\Flagged')).toBe(true);
  });

  it('refuses a new UIDVALIDITY epoch before STORE on the selected session', async () => {
    const source = addRow('source', 'INBOX', 17);
    source.flag_uid_validity = '99';
    await expect(manager.setFlag(account, 17, 'INBOX', '\\Seen', true)).rejects.toMatchObject({ unsafeFlagAddress: true });
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    expect(ImapFlow).not.toHaveBeenCalled();
  });

  it('verifies an explicit expectation on the STORE session and rejects reused IDs', async () => {
    addRow('source', 'INBOX', 17, '<same@example.test>');
    addRow('unrelated', 'INBOX', 18, '<same@example.test>');
    await expect(manager.setFlag(account, 17, 'INBOX', '\\Seen', true, { expectMessageId: '<same@example.test>' }))
      .rejects.toMatchObject({ unsafeFlagAddress: true });
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    expect(client.search).toHaveBeenCalledWith({ header: { 'Message-ID': 'same@example.test' } }, { uid: true });
    expect(ImapFlow).not.toHaveBeenCalled();
  });

  it('checks an explicit unique expectation without acquiring another session', async () => {
    addRow('source', 'INBOX', 17);
    await manager.setFlag(account, 17, 'INBOX', '\\Seen', true, { expectMessageId: '<mail@example.test>' });
    expect(client.fetch).toHaveBeenCalledWith('17', { uid: true, envelope: true }, { uid: true });
    expect(client.messageFlagsAdd).toHaveBeenCalledWith('17', ['\\Seen'], { uid: true });
    expect(ImapFlow).not.toHaveBeenCalled();
  });
});

describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('physical flag authority in actual PostgreSQL',()=>{
  const flags=['\\Seen','\\Flagged'];
  for (const flag of flags) {
    const value=flag==='\\Seen'?'is_read':'is_starred';
    const marker=flag==='\\Seen'?'read_changed_at':'star_changed_at';
    const version=flag==='\\Seen'?'read_intent_version':'star_intent_version';
    async function mapped(db) {
      const intent=manager._enqueueFlagPush(account.id,'source',flag,true);
      await manager._protectFlagMarker(manager._pendingFlagPush.get(account.id).get(`source:${flag}`));
      await manager.moveMessage(account,17,'INBOX','Trash');
      await db.query('DELETE FROM messages WHERE id=$1',['source']);
      await db.query(`INSERT INTO messages(id,account_id,uid,folder,message_id,flag_uid_validity,body_html)
        VALUES('replacement',$1,100,'Trash','<mail@example.test>',1,'destination body')`,[account.id]);
      return intent;
    }
    it.each([false,true])(`preserves ${flag} retry while provisional/refused expectations wait (nested=%s)`,async nested=>{
      addRow('source','INBOX',17);
      await withFlagDatabase(async db=>{
        const intent=await mapped(db), waiting=deferred(), release=deferred();
        let newer, last;
        if (nested) {
          manager._flagOpChains.set(account.id,release.promise);
          newer=manager.setFlag(account,100,'Trash',flag,false,{ expectMessageId:'<wrong-b@example.test>' });
          last=manager.setFlag(account,100,'Trash',flag,false,{ expectMessageId:'<wrong-c@example.test>' }).catch(e=>e);
        } else {
          const search=client.search.getMockImplementation();
          client.search.mockImplementation(async function(...args){waiting.resolve();await release.promise;return search.apply(this,args);});
          newer=manager.setFlag(account,100,'Trash',flag,false,{ expectMessageId:'<wrong-b@example.test>' }).catch(e=>e);
          await waiting.promise;
        }
        try {
          await manager._reconcileFlagPushes();
          expect(manager._pendingFlagPush.get(account.id)?.get(`source:${flag}`)?.intent).toBe(intent);
          expect(manager._isFlagIntentCurrent(intent)).toBe(true);
          expect((await db.query(`SELECT ${value} AS value,${marker} AS marker,${version} AS version FROM messages`)).rows[0])
            .toEqual({value:false,marker:null,version:'0'});
        } finally { release.resolve(); await newer; if(last)await last; }
        await manager._reconcileFlagPushes();
        expect(server.get(key('Trash',100)).flags.has(flag)).toBe(true);
        expect((await db.query(`SELECT ${value} AS value,${marker} AS marker,${version} AS version FROM messages`)).rows[0])
          .toEqual({value:true,marker:null,version:await intent.version});
      });
    });
    it(`preserves newer confirmed ${flag} authority at a proven destination`,async()=>{
      addRow('source','INBOX',17);
      await withFlagDatabase(async db=>{
        await mapped(db);
        await manager.setFlag(account,100,'Trash',flag,false,{expectMessageId:'<mail@example.test>'});
        const confirmed=(await db.query('SELECT * FROM messages')).rows;
        await manager._reconcileFlagPushes();
        expect(server.get(key('Trash',100)).flags.has(flag)).toBe(false);
        expect((await db.query('SELECT * FROM messages')).rows).toEqual(confirmed);
        expect(manager._pendingFlagPush.has(account.id)).toBe(false);
      });
    });
    it(`never mutates a fresh epoch replacement before refusing mapped ${flag}`,async()=>{
      addRow('source','INBOX',17);
      await withFlagDatabase(async db=>{
        await mapped(db);
        await db.query(`UPDATE messages SET message_id='<unrelated@example.test>',flag_uid_validity=2`);
        client.getMailboxLock.mockImplementation(async function(folder){this.mailbox={path:folder,exists:1,uidValidity:2n};return{release(){}};});
        const before=(await db.query('SELECT * FROM messages')).rows;
        await manager._reconcileFlagPushes();
        expect((await db.query('SELECT * FROM messages')).rows).toEqual(before);
        expect(client.messageFlagsAdd).not.toHaveBeenCalled();
        vi.setSystemTime(Date.now()+30*60000);await manager._reconcileFlagPushes();
        expect((await db.query('SELECT * FROM messages')).rows).toEqual(before);
      });
    });
    it.each([false,true])(`never carries stale legacy source identity through real UIDPLUS MOVE for ${flag} (invalid=%s)`,async invalid=>{
      const stale=addRow('source','INBOX',17,'<stale@example.test>');
      stale.flag_uid_validity=null;stale.flag_address_valid=!invalid;
      server.set(key('INBOX',17),{uid:17,envelope:{messageId:'<unrelated@example.test>'},flags:new Set()});
      await withFlagDatabase(async db=>{
        manager._enqueueFlagPush(account.id,'source',flag,true);
        await manager._protectFlagMarker(manager._pendingFlagPush.get(account.id).get(`source:${flag}`));
        await manager.moveMessage(account,17,'INBOX','Trash');
        await db.query('DELETE FROM messages');
        await db.query(`INSERT INTO messages(id,account_id,uid,folder,message_id,flag_uid_validity,body_html)
          VALUES('unrelated',$1,100,'Trash','<unrelated@example.test>',1,'unrelated body')`,[account.id]);
        const before=(await db.query('SELECT * FROM messages')).rows;
        await manager._reconcileFlagPushes();
        expect(server.get(key('Trash',100)).flags.has(flag)).toBe(false);
        expect((await db.query('SELECT * FROM messages')).rows).toEqual(before);
      });
    });
  }
});

it.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL).each([false,true])('restores an invalid moved row only with matching same-session expectation (cache conflict=%s)',async conflict=>{
  addRow('source','INBOX',17);server.get(key('INBOX',17)).flags.add('\\Seen');
  await withFlagDatabase(async db=>{
    await manager.moveMessage(account,17,'INBOX','Trash');
    await db.query(`UPDATE messages SET folder='Trash',uid=100,is_read=true,message_id=$1`,[conflict?'<other@example.test>':'<mail@example.test>']);
    const before=(await db.query('SELECT * FROM messages')).rows;
    if(conflict){
      await expect(manager.setFlag(account,100,'Trash','\\Seen',false,{expectMessageId:'<mail@example.test>'})).rejects.toMatchObject({unsafeFlagAddress:true});
      expect((await db.query('SELECT * FROM messages')).rows).toEqual(before);
      expect(server.get(key('Trash',100)).flags.has('\\Seen')).toBe(true);
    } else {
      expect(await manager.setFlag(account,100,'Trash','\\Seen',false,{expectMessageId:'<mail@example.test>'})).toBe(true);
      expect((await db.query('SELECT flag_address_valid,flag_uid_validity,is_read,read_changed_at FROM messages')).rows[0])
        .toEqual({flag_address_valid:true,flag_uid_validity:'1',is_read:false,read_changed_at:null});
      expect(server.get(key('Trash',100)).flags.has('\\Seen')).toBe(false);
    }
  });
});

it.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL).each(['fetch','address-query','stamp'].flatMap(stage=>['\\Seen','\\Flagged'].map(flag=>({stage,flag}))))('keeps $flag live proof bound to its starting epoch across $stage',async({stage,flag})=>{
  const cached=addRow('source','INBOX',17);cached.flag_address_valid=false;cached.flag_uid_validity=null;
  await withFlagDatabase(async db=>{
    const flip=()=>{
      client.mailbox={...client.mailbox,uidValidity:2n};
      server.set(key('INBOX',17),{uid:17,envelope:{messageId:'<unrelated-new-epoch@example.test>'},flags:new Set([flag])});
    };
    if(stage==='fetch'){
      const fetch=client.fetch.getMockImplementation();
      client.fetch.mockImplementation(async function*(...args){yield*fetch.apply(this,args);flip();});
    } else {
      const normal=query.getMockImplementation();let once=false;
      query.mockImplementation(async(sql,args)=>{
        const target=stage==='address-query'?sql.startsWith('SELECT id, message_id, flag_address_valid')
          :sql.includes(`SET ${flag==='\\Seen'?'is_read':'is_starred'} = $1`);
        const result=await normal(sql,args);
        if(target&&!once){once=true;flip();}
        return result;
      });
    }
    const result=await manager.setFlag(account,17,'INBOX',flag,false,{expectMessageId:'<mail@example.test>'}).catch(error=>error);
    expect(result).toMatchObject({unsafeFlagAddress:true});
    expect(server.get(key('INBOX',17)).flags.has(flag)).toBe(true);
    expect(client.messageFlagsRemove).not.toHaveBeenCalled();
    expect((await db.query('SELECT flag_uid_validity FROM messages')).rows[0].flag_uid_validity).not.toBe('2');
  });
});


it.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL).each(['rows','proof','invalidation','move-result'].flatMap(stage=>['\\Seen','\\Flagged'].map(flag=>({stage,flag}))))('binds $flag MOVE authority through $stage to the source epoch',async({stage,flag})=>{
  const cached=addRow('source','INBOX',17);cached.flag_uid_validity=null;
  await withFlagDatabase(async db=>{
    const intent=manager._enqueueFlagPush(account.id,'source',flag,true);
    await manager._protectFlagMarker(manager._pendingFlagPush.get(account.id).get(`source:${flag}`));
    let selected;
    client.getMailboxLock.mockImplementation(async function(folder){selected=this;this.mailbox={path:folder,exists:1,uidValidity:1n};return{release(){}};});
    const flip=()=>{selected.mailbox={...selected.mailbox,uidValidity:2n};server.set(key('INBOX',17),{uid:17,envelope:{messageId:'<epoch-two@example.test>'},flags:new Set()});};
    if(stage==='proof'){
      const fetch=client.fetch.getMockImplementation();client.fetch.mockImplementation(async function*(...args){yield*fetch.apply(this,args);flip();});
    } else if(stage==='move-result'){
      const move=client.messageMove.getMockImplementation();client.messageMove.mockImplementation(async function(...args){flip();return move.apply(this,args);});
    } else {
      const normal=query.getMockImplementation();let once=false;
      query.mockImplementation(async(sql,args)=>{
        const result=await normal(sql,args);
        if(!once && (stage==='rows'?sql.startsWith('SELECT id, uid, message_id'):sql.startsWith('UPDATE messages SET flag_address_valid = false'))){once=true;flip();}
        return result;
      });
    }
    await manager.moveMessage(account,17,'INBOX','Trash').catch(()=>{});
    const op=manager._pendingFlagPush.get(account.id)?.get(`source:${flag}`);
    expect(op?.intent).toBe(intent);expect(op?.address).toBeUndefined();
    if(stage!=='move-result')expect(wire.filter(([kind])=>kind==='move')).toEqual([]);
    await db.query('DELETE FROM messages');await db.query("INSERT INTO messages(id,account_id,uid,folder,message_id,flag_uid_validity,body_html) VALUES('other',$1,100,'Trash','<epoch-two@example.test>',1,'body B')",[account.id]);
    const before=(await db.query('SELECT * FROM messages')).rows;
    await manager._reconcileFlagPushes();
    expect((await db.query('SELECT * FROM messages')).rows).toEqual(before);
    expect(server.get(key('Trash',100))?.flags.has(flag)||false).toBe(false);
  });
});

it.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL).each(['\\Seen','\\Flagged'])('preserves the entire same-UUID replacement during held replay %s SQL and expiry',async flag=>{
  addRow('source','INBOX',17);
  await withFlagDatabase(async db=>{
    manager._enqueueFlagPush(account.id,'source',flag,true);
    await manager._protectFlagMarker(manager._pendingFlagPush.get(account.id).get(`source:${flag}`));
    const waiting=deferred(),release=deferred();const normal=query.getMockImplementation();let once=false;
    query.mockImplementation(async(sql,args)=>{
      if(!once&&sql.includes(`SET ${flag==='\\Seen'?'is_read':'is_starred'} = $1`)){once=true;waiting.resolve();await release.promise;}
      return normal(sql,args);
    });
    const replay=manager._reconcileFlagPushes();await waiting.promise;
    client.mailbox={...client.mailbox,uidValidity:2n};server.set(key('INBOX',17),{uid:17,envelope:{messageId:'<replacement@example.test>'},flags:new Set()});
    await db.query("UPDATE messages SET message_id='<replacement@example.test>',flag_uid_validity=2,is_read=false,is_starred=false,read_changed_at=NULL,star_changed_at=NULL,read_intent_version=0,star_intent_version=0,body_html='body B' WHERE id='source'");
    const before=(await db.query('SELECT * FROM messages')).rows;
    release.resolve();await replay;
    expect.soft((await db.query('SELECT * FROM messages')).rows).toEqual(before);
    expect.soft(wire.filter(([kind])=>kind==='add'||kind==='remove')).toEqual([]);
    client.getMailboxLock.mockImplementation(async function(folder){this.mailbox={path:folder,exists:1,uidValidity:2n};return{release(){}};});
    await manager._reconcileFlagPushes();
    expect.soft((await db.query('SELECT * FROM messages')).rows).toEqual(before);
    expect.soft(server.get(key('INBOX',17)).flags.has(flag)).toBe(false);
    vi.setSystemTime(Date.now()+31*60000);await manager._reconcileFlagPushes();
    expect((await db.query('SELECT * FROM messages')).rows).toEqual(before);
  });
});


it.each(['sync','backfill'])('never binds an old %s FETCH payload to the selected successor epoch',async mode=>{
  const stale=addRow('source','INBOX',17);stale.flag_address_valid=false;
  client.fetch.mockImplementation(async function*(){const payload=metadata();this.mailbox={...this.mailbox,uidValidity:2n};yield payload;});
  if(mode==='sync') await manager.syncMessages(account,client,'INBOX',20,false,true);
  else {const pending=manager.backfillMessages(account,'INBOX');await vi.runAllTimersAsync();await pending;}
  const recovered=[...rows.values()].find(row=>row.uid===17);
  expect(recovered?.flag_uid_validity).not.toBe('2');
  client.getMailboxLock.mockImplementation(async function(folder){this.mailbox={path:folder,exists:1,uidValidity:2n};return{release(){}};});
  await expect(manager.setFlag(account,17,'INBOX','\\Seen',true)).rejects.toMatchObject({unsafeFlagAddress:true});
  expect(wire.filter(([kind])=>kind==='add')).toEqual([]);
});


// Authored during host resource STOP; unexecuted until recovery + explicit shared lease.
it.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL).each(['epoch','path'].flatMap(drift=>['\\Seen','\\Flagged'].map(flag=>({drift,flag}))))('does not confirm $flag when selection drifts during the actual STORE response ($drift)',async({drift,flag})=>{
  addRow('source','INBOX',17);
  await withFlagDatabase(async db=>{
    let captured;
    const original=client.messageFlagsAdd.getMockImplementation();
    client.messageFlagsAdd.mockImplementation(async function(...args){
      captured=manager._flagIntents.get(account.id)?.get(`source:${flag}`);
      const result=await original.apply(this,args);
      this.mailbox={...this.mailbox,...(drift==='epoch'?{uidValidity:2n}:{path:'Other'})};
      return result;
    });
    const result=await manager.setFlag(account,17,'INBOX',flag,true).catch(error=>error);
    expect(result).not.toBe(true);expect(manager._settledFlagIntents.has(captured)).toBe(false);
    expect((await db.query(`SELECT ${flag==='\\Seen'?'read':'star'}_changed_at AS marker FROM messages`)).rows[0].marker).not.toBeNull();
  });
});

it.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL).each(['\\Seen','\\Flagged'])('does not let invalidated old-epoch address proof cancel a legitimate moved %s retry',async flag=>{
  const a=addRow('a','Trash',17,'<a@example.test>'),b=addRow('b','INBOX',44,'<b@example.test>');b.flag_uid_validity='2';
  await withFlagDatabase(async db=>{
    const bIntent=manager._enqueueFlagPush(account.id,'b',flag,true);
    await manager._protectFlagMarker(manager._pendingFlagPush.get(account.id).get(`b:${flag}`));
    await db.query("UPDATE messages SET body_html='body B' WHERE id='b'");
    const epochs={INBOX:2n,Trash:1n};let selected;
    client.getMailboxLock.mockImplementation(async function(folder){this.mailbox={path:folder,exists:1,uidValidity:epochs[folder]};if(folder==='Trash')selected=this;return{release(){}};});
    const waiting=deferred(),release=deferred(),normal=query.getMockImplementation();let once=false;
    query.mockImplementation(async(sql,args)=>{
      if(!once&&sql.includes(`SET ${flag==='\\Seen'?'is_read':'is_starred'} = $1`)&&args[1]===a.id){once=true;waiting.resolve();await release.promise;}
      return normal(sql,args);
    });
    const newer=manager.setFlag(account,17,'Trash',flag,true,{expectMessageId:a.message_id}).catch(error=>error);
    await waiting.promise;epochs.Trash=2n;selected.mailbox={...selected.mailbox,uidValidity:2n};
    server.delete(key('Trash',17));await db.query("DELETE FROM messages WHERE id='a'");
    release.resolve();expect(await newer).not.toBe(true);
    client.messageMove.mockImplementation(async function(){const mail=server.get(key('INBOX',44));server.delete(key('INBOX',44));server.set(key('Trash',17),{...mail,uid:17});return{uidMap:new Map([[44,17]]),uidValidity:2n};});
    await manager.moveMessage(account,44,'INBOX','Trash');
    await db.query("UPDATE messages SET folder='Trash',uid=17,flag_uid_validity=2 WHERE id='b'");
    await manager._reconcileFlagPushes();
    expect(server.get(key('Trash',17)).flags.has(flag)).toBe(true);
    const row=(await db.query(`SELECT body_html,${flag==='\\Seen'?'is_read':'is_starred'} AS value,${flag==='\\Seen'?'read':'star'}_changed_at AS marker,${flag==='\\Seen'?'read':'star'}_intent_version AS version FROM messages WHERE id='b'`)).rows[0];
    expect(row).toEqual({body_html:'body B',value:true,marker:null,version:await bIntent.version});
    expect(manager._pendingFlagPush.get(account.id)?.size||0).toBe(0);
  });
});
