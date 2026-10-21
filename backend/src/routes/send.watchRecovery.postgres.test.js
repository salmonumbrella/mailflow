import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import express from 'express';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setImmediate as realImmediate } from 'node:timers';

// Proposal only: no execution is recorded by this file's existence. Install at
// backend/src/routes/send.watchRecovery.postgres.test.js AFTER accepted I1 and
// the separately reviewed I2 successor. C01-C20 retain controls 52d9fa41 as
// provenance; review F1-F5 revise the liveness expectations. C20 is a LIMITATION.
// Seeded Sent metadata isolates recovery; SMTP/APPEND/full browser behavior are
// separate acceptance obligations in send.watch.test.js, not proved here.
const boundary = vi.hoisted(() => ({ manager: null, sql: null, transaction: null, redis: new Map() }));
vi.mock('../services/db.js', () => ({
  query: vi.fn((...args) => boundary.sql(...args)),
  pool: { query: (...args) => boundary.sql(...args) },
  withTransaction: fn => boundary.transaction(fn),
}));
vi.mock('../index.js', () => ({ get imapManager() { return boundary.manager; } }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => {
  req.session = { userId: req.headers['x-test-user'] || 'owner' }; next();
} }));
vi.mock('../services/redis.js', () => ({ redisClient: {
  get: async key => boundary.redis.get(key) ?? null,
  set: async (key, value, options) => {
    if (options?.NX && boundary.redis.has(key)) return null;
    boundary.redis.set(key, value); return 'OK';
  },
  del: async key => Number(boundary.redis.delete(key)),
} }));
vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
// Synthetic authentication and DNS are transport boundaries, never real credentials.
vi.mock('../services/encryption.js', async original => ({ ...await original(),
  decrypt: value => value, encrypt: value => value, isEncrypted: () => false,
}));
vi.mock('../services/hostValidation.js', async original => ({ ...await original(),
  resolveForConnection: async () => ({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null }),
  createPinnedLookup: () => {},
}));

import { ImapFlow } from 'imapflow';
import { ImapManager } from '../services/imapManager.js';
import { applyLabel } from '../services/labels.js';
import { countCompletion } from '../services/countCompletion.js';
import { invalidateConnectionPolicyCache } from '../services/connectionPolicy.js';
import { invalidateGlobalCategorizationCache } from '../services/categorizer.js';
import { setMailEngine } from '../plugins/mailEngine.js';
import { pluginRegistry } from '../plugins/registry.js';
import { gtdPlugin } from '../plugins/gtd/index.js';
import { invalidateGtdConfigCache } from '../plugins/gtd/gtdConfig.js';
import { invalidateActivationCache } from '../plugins/activation.js';
import { invalidateOwnerAddressesCache } from '../plugins/gtd/gtdTransitions.js';
import gtdRoutes from '../plugins/gtd/routes.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SENT = 'Outbox/Sent';
const WATCH = 'Labels/待機';
const SOURCE_UID = 2147483659;
const MID = '<sent-watch@synthetic.test>';
const SOURCE_PINS = {
  '../services/imapManager.js': '5c2911aa37bb1d97617276875c5368f5b21b7eeb3429d652c220702335bdf2cc',
  '../services/labels.js': '5f18aefb6d0b5ca6a8e7d748c58519de945d675ea4a468a1ae2cc3324595649e',
  '../plugins/gtd/routes.js': 'b67b4aa990d5223343c8f91b9ca67f1d510fd656d1df463ba9734753f0d8f04c',
  '../plugins/gtd/gtdWatchClassification.js': '1f1d869f7167d71892a0b694145a3e7812fb66507493da99fd915f205b8a9675',
};

describe.skipIf(!process.env.MAILFLOW_SENT_WATCH_DATABASE_URL)('Fastmail Watch COPY recovery PostgreSQL C01-C20', () => {
  let database, server, base, queue = Promise.resolve(), manager, account, source;
  let provider, witnesses, unexpectedSql, faults, beforeSending, snapshotBarrier, hooks, pendingSync;
  const managers = [];

  // One real connection: transactions take the same queue exclusively, with
  // genuine BEGIN/COMMIT/ROLLBACK. Queries return actual pg results, never rows
  // manufactured by SQL-string mocks. C15 schedules two independent managers,
  // not two OS processes or a proof of thread-wide cross-process exclusion.
  function exclusive(work) {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  }
  async function sqlOnClient(sql, values = []) {
    const receiptWrite = sql.includes('UPDATE messages m SET plugin_annotations=jsonb_set(');
    const receipt = receiptWrite && values[4] != null ? JSON.parse(values[4]) : null;
    const cacheInsert = sql.includes('INSERT INTO messages') && values[2] === WATCH;
    const kind = cacheInsert ? 'cache-insert' : receiptWrite ? `receipt-${receipt?.state || 'clear'}` : null;
    if (kind === 'receipt-sending' && beforeSending) {
      const action = beforeSending; beforeSending = null;
      await action(database);
    }
    const fault = faults.get(kind);
    const inject = async () => {
      fault.remaining--;
      witnesses.push({ type: 'fault', kind, mode: fault.mode });
      if (fault.mode === 'after') throw Object.assign(new Error(`Lost SQL acknowledgement: ${kind}`), { code: 'TEST_ACK_LOST' });
      // A real PostgreSQL exception at the query boundary, not a fabricated 0-row
      // result. A swallowed sync error must still leave a consumed fault witness.
      await database.query('SELECT pg_temp.fail_watch_query($1)', [kind]);
    };
    try {
      if (fault?.remaining > 0 && fault.mode === 'before') await inject();
      const result = await database.query(sql, values);
      witnesses.push({ type: 'sql', kind, sql, values, rowCount: result.rowCount });
      if (fault?.remaining > 0 && fault.mode === 'after') await inject();
      return result;
    } catch (error) {
      if (error.code !== 'TEST_ACK_LOST' && !(error.code === 'P0001' && error.message.startsWith('watch-test-fault:'))) {
        unexpectedSql.push({ sql, code: error.code, message: error.message });
      }
      throw error;
    }
  }
  async function appSql(sql, values) {
    const result = await exclusive(() => sqlOnClient(sql, values));
    // The barrier is OUTSIDE the connection queue. Both reads really finish
    // before either consumer can CAS; no fabricated snapshot or deadlocked client.
    if (snapshotBarrier && sql.includes('SELECT m.id,m.message_id,m.provider_msgid,')) {
      await snapshotBarrier();
    }
    return result;
  }
  const db = (sql, values) => exclusive(() => database.query(sql, values));
  const fault = (kind, mode = 'before') => faults.set(kind, { mode, remaining: 1 });
  const copies = () => provider.commands.filter(event => event.command === 'COPY');
  const deletions = () => provider.commands.filter(event => ['DELETE', 'MOVE', 'STORE'].includes(event.command));
  const boxKey = (id, folder) => JSON.stringify([id, folder]);
  function box(id, folder) {
    const key = boxKey(id, folder);
    if (!provider.boxes.has(key)) provider.boxes.set(key, []);
    return provider.boxes.get(key);
  }
  const epoch = (id, folder) => provider.epochs.get(boxKey(id, folder)) ?? 1;
  function item(uid, messageId = MID) {
    return { uid, visible: true, flags: new Set(['\\Seen']),
      envelope: { messageId, subject: 'Waiting for a synthetic reply', date: new Date('2026-10-20T12:00:00Z'),
        from: [{ address: 'owner@synthetic.test' }], to: [{ address: 'recipient@synthetic.test' }] },
      source: `Message-ID: ${messageId}\r\nSubject: Waiting for a synthetic reply\r\n\r\nWaiting.` };
  }

  class FakeImap extends EventEmitter {
    constructor(config) {
      super(); this.accountId = config.auth.user.startsWith('second') ? B : A;
      this.usable = true; this.capabilities = new Map([['UIDPLUS', true]]);
      this.enabled = new Set(); this.namespace = { delimiter: '/', prefix: '' };
    }
    async connect() {}
    async noop() {}
    async logout() { this.close(); }
    close() { this.usable = false; }
    async mailboxCreate(parts) { const path = parts.join('/'); box(this.accountId, path); return { path, created: false }; }
    async getMailboxLock(folder) {
      this.folder = folder;
      const rows = box(this.accountId, folder).filter(row => row.visible);
      this.mailbox = { path: folder, exists: rows.length, uidValidity: BigInt(epoch(this.accountId, folder)),
        uidNext: Math.max(0, ...rows.map(row => row.uid)) + 1, highestModseq: null };
      provider.commands.push({ command: 'SELECT', accountId: this.accountId, folder, epoch: String(this.mailbox.uidValidity) });
      return { release() {} };
    }
    async search(criteria, options) {
      // imapflow 1.7.8 search-compiler enumerates Object.keys(header).
      // An array is NOT shorthand: it asks for headers named "0" and "1".
      // Model that actual contract so a vacuous array gate cannot pass C11/C20.
      const headerTerms = Object.entries(criteria.header || {});
      provider.commands.push({ command: 'SEARCH', accountId: this.accountId, folder: this.folder, criteria, options, headerTerms });
      if (provider.searchFailure) throw new Error('synthetic SEARCH refusal');
      if (provider.searchOverride !== undefined) return provider.searchOverride;
      return box(this.accountId, this.folder).filter(row => row.visible &&
        headerTerms.every(([name, needle]) => name.toLowerCase() === 'message-id' &&
          String(row.envelope.messageId).includes(String(needle)))).map(row => row.uid);
    }
    async *fetch(range, fields, options = {}) {
      provider.commands.push({ command: 'FETCH', accountId: this.accountId, folder: this.folder, range: String(range), options });
      if (provider.beforeFetch) {
        const action = provider.beforeFetch; provider.beforeFetch = null;
        await action(this.folder);
      }
      const rows = box(this.accountId, this.folder).filter(row => row.visible);
      const maximum = options.uid ? Math.max(0, ...rows.map(row => row.uid)) : rows.length;
      const selected = String(range).split(',').flatMap(part => {
        const [lo, hi = lo] = part.split(':');
        const lower = lo === '*' ? maximum : Number(lo), upper = hi === '*' ? maximum : Number(hi);
        return rows.filter((row, index) => {
          const n = options.uid ? row.uid : index + 1;
          return n >= Math.min(lower, upper) && n <= Math.max(lower, upper);
        });
      });
      for (const row of selected) {
        const output = { uid: row.uid, flags: new Set(row.flags), ...(fields.envelope ? {
          envelope: row.envelope, internalDate: row.envelope.date,
          headers: Buffer.from(row.source.split('\r\n\r\n')[0] + '\r\n'),
          bodyStructure: { type: 'text/plain' }, size: row.source.length,
        } : {}) };
        if (this.folder === WATCH && options.uid && provider.badFetch === 'wrong-uid') output.uid++;
        yield output;
        if (this.folder === WATCH && options.uid && provider.badFetch === 'duplicate') yield { ...output };
      }
    }
    async messageCopy(uid, destination, options) {
      if (options?.uid !== true || Object.keys(options).length !== 1) provider.assertions.push('COPY must use exact UID addressing');
      const original = box(this.accountId, this.folder).find(row => row.uid === Number(uid) && row.visible);
      if (!original) throw new Error('synthetic missing COPY source');
      // Provider boundary reads REAL committed metadata before the side effect.
      // Never throw expect() into production's catch blocks: assert witnesses later.
      const journal = (await db(`SELECT plugin_annotations->'_mailflow_label_copy'->$4 AS receipt
        FROM messages WHERE account_id=$1 AND folder=$2 AND uid=$3`,
      [this.accountId, this.folder, Number(uid), destination])).rows[0]?.receipt;
      const copiedUid = provider.nextUid++;
      const copied = { ...original, uid: copiedUid, flags: new Set(original.flags), visible: !provider.hideCopy };
      box(this.accountId, destination).push(copied);
      provider.commands.push({ command: 'COPY', accountId: this.accountId, from: this.folder, destination,
        sourceUid: Number(uid), copiedUid, receiptBefore: journal,
        handlers: countCompletion.user('owner').handlers, pending: countCompletion.pending(this.accountId) });
      if (provider.afterCopy) await provider.afterCopy();
      if (provider.loseCopyAck) throw new Error('synthetic transport lost after server COPY');
      if (provider.ack === 'no-uid') return {};
      if (provider.ack === 'bad-map') return { uidMap: new Map([[Number(uid), String(copiedUid)]]), uidValidity: epoch(this.accountId, destination) };
      return { uidMap: new Map([[Number(uid), copiedUid]]),
        ...(provider.ack === 'no-epoch' ? {} : { uidValidity: epoch(this.accountId, destination) }) };
    }
    async messageFlagsAdd(range, flags, options) {
      provider.commands.push({ command: 'STORE', folder: this.folder, range: String(range), flags, options }); return true;
    }
    async messageFlagsRemove(range, flags, options) {
      provider.commands.push({ command: 'STORE', folder: this.folder, range: String(range), flags, options }); return true;
    }
    async messageDelete(range, options) {
      const uids = String(range).split(',').map(Number);
      provider.commands.push({ command: 'DELETE', folder: this.folder, uids, options });
      provider.boxes.set(boxKey(this.accountId, this.folder), box(this.accountId, this.folder).filter(row => !uids.includes(row.uid)));
      return true;
    }
    async messageMove() { provider.commands.push({ command: 'MOVE' }); return true; }
  }

  function newManager() {
    const next = new ImapManager({ clients: new Set() });
    for (const key of ['_folderStatusTimer', '_healthCheckTimer', '_snippetSchedulerTimer',
      '_stalenessCheckTimer', '_flagPushReconcilerTimer']) clearInterval(next[key]);
    next.broadcast = (event, userId) => witnesses.push({ type: 'broadcast', event, userId });
    const sync = next.syncFolderOnDemand.bind(next);
    next.syncFolderOnDemand = (...args) => {
      const promise = sync(...args); pendingSync.add(promise);
      promise.then(() => pendingSync.delete(promise), () => pendingSync.delete(promise));
      return promise;
    };
    // Search indexing stays closed through its real lifecycle. No worker is
    // resumed; setImmediate prefetch work is held by fake timers, not run.
    managers.push(next); manager = next; boundary.manager = next; setMailEngine(next);
    return next;
  }
  async function drainSync() {
    // afterLabelCopy intentionally detaches its transition continuation. Drain
    // real sync AND the subsequent SQL turns before resetting temporary rows.
    // No production scheduler/fake-timer prefetch is advanced here.
    for (let turn = 0; turn < 20; turn++) {
      const previousQueue = queue;
      await Promise.all([...pendingSync]); await queue;
      await new Promise(resolve => realImmediate(resolve));
      if (!pendingSync.size && queue === previousQueue) return;
    }
    throw new Error('Deferred Watch work did not settle within 20 event-loop turns');
  }
  async function rows(folder = WATCH, id = A) {
    return (await db('SELECT * FROM messages WHERE account_id=$1 AND folder=$2 AND NOT is_deleted ORDER BY uid', [id, folder])).rows;
  }
  async function receipt(id = source.id) {
    return (await db("SELECT plugin_annotations->'_mailflow_label_copy'->$2 AS receipt FROM messages WHERE id=$1", [id, WATCH])).rows[0]?.receipt;
  }
  async function classify(id = source.id, headers = {}, state = 'watch') {
    const response = await fetch(`${base}/api/gtd/classify`, { method: 'POST',
      headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ messageId: id, state }) });
    const result = { status: response.status, body: await response.json() };
    await drainSync(); return result;
  }
  async function unknown(result, count) {
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ code: 'label-copy-unconfirmed', retryable: true });
    expect(result.body).not.toHaveProperty('applied');
    expect(result.body).not.toHaveProperty('notApplied');
    expect(copies()).toHaveLength(count); expect(deletions()).toEqual([]);
  }
  async function seedSource({ id = A, folder = SENT, uid = SOURCE_UID, messageId = MID, annotations = {} } = {}) {
    const result = await db(`INSERT INTO messages(account_id,folder,uid,message_id,thread_id,date,subject,
      from_email,to_addresses,is_read,flags,plugin_annotations)
      VALUES($1,$2,$3,$4,$4,'2026-10-20T12:00:00Z','Waiting for a synthetic reply',
      'owner@synthetic.test','[{"address":"recipient@synthetic.test"}]',true,'["\\\\Seen"]',$5) RETURNING *`,
    [id, folder, uid, messageId, JSON.stringify(annotations)]);
    box(id, folder).push(item(uid, messageId)); return result.rows[0];
  }
  async function resetFixture() {
    await drainSync();
    for (const old of managers.splice(0)) { await old.disconnectAccount(A, { strict: true }); await old.disconnectAccount(B, { strict: true }); }
    // Variant loops must not erase an earlier schema or transport contract
    // failure by resetting their witness arrays for the next fixture.
    expect(unexpectedSql).toEqual([]);
    if (provider) expect(provider.assertions).toEqual([]);
    expect([...faults.values()].every(value => value.remaining === 0)).toBe(true);
    await db('TRUNCATE users,email_accounts,account_aliases,plugin_account_config,system_settings,folders,messages,search_index_accounts,search_index_jobs');
    witnesses = []; hooks = []; unexpectedSql = []; faults = new Map(); beforeSending = null; snapshotBarrier = null;
    provider = { boxes: new Map(), epochs: new Map(), commands: [], assertions: [], nextUid: 3000000001,
      ack: 'known', hideCopy: false, loseCopyAck: false, searchFailure: false, searchOverride: undefined,
      badFetch: null, afterCopy: null, beforeFetch: null };
    boundary.redis.clear(); countCompletion.users.clear();
    await db(`INSERT INTO users VALUES ('owner','{"enabledPlugins":["gtd"]}'),('foreign','{}');
      INSERT INTO system_settings VALUES ('allow_private_hosts','true'),('allow_insecure_tls','true');`);
    for (const [id, login] of [[A, 'owner@synthetic.test'], [B, 'second@synthetic.test']]) {
      await db(`INSERT INTO email_accounts(id,user_id,name,email_address,imap_host,imap_port,imap_tls,auth_user,auth_pass,folder_mappings)
        VALUES($1,'owner','Synthetic',$2,'imap.fastmail.com',993,true,$2,'synthetic',$3)`, [id, login, JSON.stringify({ sent: SENT })]);
      await db("INSERT INTO plugin_account_config VALUES('gtd',$1,$2)", [id, JSON.stringify({ enabled: true, folders: { watch: WATCH } })]);
      for (const path of [SENT, WATCH, 'INBOX', 'Todo', 'Ordinary']) {
        await db('INSERT INTO folders(account_id,path,name,special_use) VALUES($1,$2,$2,$3)', [id, path, path === SENT ? '\\Sent' : null]);
      }
      invalidateGtdConfigCache(id); invalidateOwnerAddressesCache(id);
    }
    invalidateConnectionPolicyCache(); invalidateActivationCache('owner'); invalidateGlobalCategorizationCache('owner');
    source = await seedSource(); account = (await db('SELECT * FROM email_accounts WHERE id=$1', [A])).rows[0];
    newManager();
  }

  beforeAll(async () => {
    for (const [path, hash] of Object.entries(SOURCE_PINS)) {
      expect(createHash('sha256').update(await readFile(new URL(path, import.meta.url))).digest('hex'), path).toBe(hash);
    }
    const url = process.env.MAILFLOW_SENT_WATCH_DATABASE_URL;
    // One dedicated task connection, no fallback to .env or DATABASE_URL.
    database = new pg.Client({ connectionString: url }); await database.connect();
    expect((await database.query('SELECT current_database() AS name')).rows[0].name).toBe('mailflow_7pv6');
    await database.query('SET search_path TO pg_temp');
    await database.query("SET statement_timeout TO '5s'");
    await database.query(`
      CREATE TEMP TABLE users(id text PRIMARY KEY,preferences jsonb);
      CREATE FUNCTION pg_temp.fail_watch_query(reason text) RETURNS void LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'watch-test-fault:%',reason USING ERRCODE='P0001'; END $$;
      CREATE TEMP TABLE email_accounts(id uuid PRIMARY KEY,user_id text,enabled boolean DEFAULT true,
        include_in_unified_inbox boolean DEFAULT true,name text,email_address text,color text,folder_mappings jsonb,
        sort_order int DEFAULT 0,created_at timestamptz DEFAULT now(),imap_host text,imap_port int,imap_tls boolean,
        auth_user text,auth_pass text,smtp_host text,oauth_provider text,protocol text DEFAULT 'imap',last_sync timestamptz);
      CREATE TEMP TABLE account_aliases(account_id uuid,email text);
      CREATE TEMP TABLE plugin_account_config(plugin_id text,account_id uuid,config jsonb);
      CREATE TEMP TABLE system_settings(key text,value text);
      CREATE TEMP TABLE folders(account_id uuid,path text,name text,delimiter text DEFAULT '/',special_use text,
        flags jsonb DEFAULT '[]',no_select boolean DEFAULT false,total_count int DEFAULT 0,unread_count int DEFAULT 0,
        uid_validity bigint DEFAULT 1,highest_modseq bigint,updated_at timestamptz,PRIMARY KEY(account_id,path));
      CREATE TEMP TABLE messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid,uid bigint,folder text,
        message_id text,subject text,from_name text,from_email text,to_addresses jsonb,cc_addresses jsonb,bcc_addresses jsonb,
        reply_to jsonb,in_reply_to text,date timestamptz,snippet text,is_read boolean DEFAULT false,
        is_starred boolean DEFAULT false,is_deleted boolean DEFAULT false,has_attachments boolean,flags jsonb,
        body_html text,body_text text,attachments jsonb,thread_references text,thread_id text,
        thread_key text GENERATED ALWAYS AS(COALESCE(thread_id,id::text)) STORED,is_bulk boolean,
        read_changed_at timestamptz,star_changed_at timestamptz,spam_score_sa real,spam_score_ml real,spam_verdict text,
        spam_analyzed_at timestamptz,spam_details jsonb,spam_user_override text,category text,list_unsubscribe text,
        list_unsubscribe_post text,unsubscribed_at timestamptz,delivery_addresses jsonb,sender_name text,sender_email text,
        forwarded_from_name text,forwarded_from_email text,forwarded_via text,plugin_annotations jsonb DEFAULT '{}',
        provider_msgid text,is_archive_residue boolean DEFAULT false,synced_at timestamptz,snippet_attempted_at timestamptz,
        UNIQUE(account_id,uid,folder));
      CREATE TEMP TABLE search_index_accounts(account_id uuid PRIMARY KEY,run_epoch bigint DEFAULT 0,paused boolean DEFAULT false);
      CREATE TEMP TABLE search_index_jobs(account_id uuid,state text,lease_token uuid,lease_expires_at timestamptz);
    `);
    const migration = await readFile(new URL('../../migrations/0002_subject_threading.sql', import.meta.url), 'utf8');
    const subjectColumn = migration.match(/ALTER TABLE messages ADD COLUMN IF NOT EXISTS normalized_subject[\s\S]*?STORED;/)?.[0];
    if (!subjectColumn) throw new Error('Subject migration changed; review temporary schema');
    await database.query(subjectColumn);
    boundary.sql = appSql;
    boundary.transaction = fn => exclusive(async () => {
      await database.query('BEGIN');
      try { const result = await fn({ query: sqlOnClient }); await database.query('COMMIT'); return result; }
      catch (error) { await database.query('ROLLBACK'); throw error; }
    });
    ImapFlow.mockImplementation(function(config) { return new FakeImap(config); });
    if (!pluginRegistry.has('gtd')) pluginRegistry.register(gtdPlugin);
    const runHook = pluginRegistry.runHook.bind(pluginRegistry);
    vi.spyOn(pluginRegistry, 'runHook').mockImplementation(async (name, context) => {
      if (name === 'afterLabelCopy') {
        const cached = await rows(context.toFolder, context.account.id);
        const recorded = await db("SELECT plugin_annotations->'_mailflow_label_copy'->$4 AS receipt FROM messages WHERE account_id=$1 AND folder=$2 AND uid=$3",
          [context.account.id, context.fromFolder, context.srcUid, context.toFolder]);
        hooks.push({ uid: context.newUid, cachedUids: cached.map(row => Number(row.uid)), receipt: recorded.rows[0]?.receipt });
      }
      return runHook(name, context);
    });
    const app = express(); app.use(express.json()); app.use('/api/gtd', gtdRoutes);
    app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate'] });
    pendingSync = new Set(); witnesses = []; unexpectedSql = []; faults = new Map(); hooks = [];
    await resetFixture();
  });
  afterEach(async () => {
    try {
      await drainSync();
      for (const old of managers.splice(0)) { await old.disconnectAccount(A, { strict: true }); await old.disconnectAccount(B, { strict: true }); }
      expect(unexpectedSql).toEqual([]); // catches schema drift even when production swallows SQL errors
      expect(provider.assertions).toEqual([]);
      expect([...faults.values()].every(value => value.remaining === 0)).toBe(true);
      expect(countCompletion.user('owner').handlers).toBe(0);
      expect(countCompletion.pending(A)).toBe(0);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    if (server) await new Promise(resolve => server.close(resolve));
    await queue; await database?.end();
  });

  it('C01 persists intent before COPY, syncs exact UID, then exposes Watch through the real route', async () => {
    const result = await classify();
    expect(result).toMatchObject({ status: 200, body: { applied: true, folder: WATCH } });
    expect(copies()).toHaveLength(1);
    expect(copies()[0]).toMatchObject({ from: SENT, sourceUid: SOURCE_UID, destination: WATCH,
      receiptBefore: { state: 'sending', sourceId: source.id, sourceEpoch: '1', destinationEpoch: '1' } });
    expect(witnesses.some(event => event.kind === 'receipt-sending' && event.rowCount === 1)).toBe(true);
    expect(await receipt()).toMatchObject({ state: 'complete', destinationUid: copies()[0].copiedUid });
    expect((await rows()).map(row => Number(row.uid))).toEqual([copies()[0].copiedUid]);
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({ uid: copies()[0].copiedUid, cachedUids: [copies()[0].copiedUid], receipt: { state: 'complete' } });
    // Give the synthetic waiting head a gist so listing does not request an
    // unrelated AI capability; this is real metadata SQL, not a mocked list.
    await db("UPDATE messages SET plugin_annotations=jsonb_set(plugin_annotations,'{gtd}','{\"gist\":\"Synthetic waiting\"}') WHERE account_id=$1 AND folder=$2", [A, WATCH]);
    const response = await fetch(`${base}/api/gtd/sections?accountId=${A}`);
    expect(response.status).toBe(200); expect((await response.json()).sections.watch.total).toBe(1);
    expect((await rows(SENT))).toHaveLength(1); expect(deletions()).toEqual([]);
  });

  it('C02 a real destination cache-write failure retains known COPYUID and immediate retry never recopies', async () => {
    fault('cache-insert'); await unknown(await classify(), 1);
    expect(witnesses.filter(event => event.type === 'fault')).toEqual([{ type: 'fault', kind: 'cache-insert', mode: 'before' }]);
    expect(await receipt()).toMatchObject({ state: 'copied', destinationUid: copies()[0].copiedUid });
    expect(await rows()).toEqual([]); expect(hooks).toEqual([]);
    expect(await classify()).toMatchObject({ status: 200, body: { applied: false, undoToken: null } });
    expect(copies()).toHaveLength(1); expect(await rows()).toHaveLength(1);
    expect(await receipt()).toMatchObject({ state: 'complete' }); expect(deletions()).toEqual([]);
    // F1: the real route must preserve an exact recovered UID even though
    // applied:false, then remove Todo without issuing a preservation COPY.
    await resetFixture();
    await db('DELETE FROM messages WHERE id=$1', [source.id]); box(A, SENT).splice(0);
    source = await seedSource({ folder: 'INBOX' }); const todo = await seedSource({ folder: 'Todo', uid: 701 });
    fault('cache-insert'); await unknown(await classify(), 1);
    expect(await classify()).toMatchObject({ status: 200, body: { applied: false, switched: true, sourceRemoved: false } });
    expect(copies()).toHaveLength(1); expect(await rows('Todo')).toEqual([]); expect(box(A, 'Todo')).toEqual([]);
    expect(provider.commands.filter(event => event.command === 'DELETE')).toEqual([
      { command: 'DELETE', folder: 'Todo', uids: [Number(todo.uid)], options: { uid: true } },
    ]);
    expect(await rows('INBOX')).toHaveLength(1); expect(await rows()).toHaveLength(1);
  });

  it('C03 post-COPY receipt SQL failure versus lost SQL acknowledgement keep their actual durable outcomes', async () => {
    for (const mode of ['before', 'after']) {
      if (mode === 'after') await resetFixture();
      fault('receipt-copied', mode); await unknown(await classify(), 1);
      expect(witnesses.filter(event => event.type === 'fault')).toHaveLength(1);
      expect((await receipt()).state).toBe(mode === 'before' ? 'sending' : 'copied');
      // The first case may later acquire similar cached rows; these still cannot
      // supply the lost operation locator. Only a committed mapping can recover.
      if (mode === 'before') { await manager.syncFolderOnDemand(account, WATCH); await unknown(await classify(), 1); }
      else expect(await classify()).toMatchObject({ status: 200, body: { applied: false } });
      expect(copies()).toHaveLength(1); expect(deletions()).toEqual([]);
    }
  });

  it('C04 failed pre-COPY CAS, changed source epoch and malformed namespace produce no provider COPY', async () => {
    for (const variant of ['occupied-key', 'source-epoch', 'malformed-namespace', 'malformed-root']) {
      if (variant !== 'occupied-key') await resetFixture();
      beforeSending = async client => {
        if (variant === 'source-epoch') await client.query('UPDATE folders SET uid_validity=2 WHERE account_id=$1 AND path=$2', [A, SENT]);
        else {
          const annotations = variant === 'occupied-key' ? { _mailflow_label_copy: { [WATCH]: { operation: 'competing-intent' } } }
            : variant === 'malformed-root' ? [] : { _mailflow_label_copy: [] };
          await client.query('UPDATE messages SET plugin_annotations=$2 WHERE id=$1', [source.id, JSON.stringify(annotations)]);
        }
      };
      await unknown(await classify(), 0);
      expect(witnesses.some(event => event.kind === 'receipt-sending' && event.rowCount === 0)).toBe(true);
    }
  });

  it('C05 lost transport acknowledgement after provider side effect stays pending across immediate retry', async () => {
    provider.loseCopyAck = true; await unknown(await classify(), 1);
    expect(box(A, WATCH)).toHaveLength(1); expect((await receipt()).state).toBe('sending');
    provider.loseCopyAck = false; await unknown(await classify(), 1);
    expect((await receipt()).state).toBe('sending'); expect(deletions()).toEqual([]);
  });

  it('C06 absent COPYUID, missing UIDVALIDITY and malformed maps cannot become success through similar synced mail', async () => {
    for (const ack of ['no-uid', 'no-epoch', 'bad-map']) {
      if (ack !== 'no-uid') await resetFixture();
      provider.ack = ack; await unknown(await classify(), 1);
      expect((await receipt()).state).toBe('sending'); expect(hooks.some(event => event.uid === null)).toBe(true);
      await manager.syncFolderOnDemand(account, WATCH); expect(await rows()).toHaveLength(1);
      await unknown(await classify(), 1); expect((await receipt()).state).toBe('sending');
    }
  });

  it('C07 source or destination epoch changes invalidate known UID recovery without reusing the locator', async () => {
    fault('cache-insert'); await unknown(await classify(), 1);
    provider.epochs.set(boxKey(A, SENT), 2); await unknown(await classify(), 1);
    expect((await receipt()).state).toBe('copied');
    // F4 revises old C07 for known completed commands, not unknown sending.
    for (const state of ['copied', 'complete']) for (const target of ['empty', 'existing']) {
      await resetFixture();
      if (state === 'copied') { fault('cache-insert'); await unknown(await classify(), 1); }
      else expect((await classify()).status).toBe(200);
      const original = await receipt();
      provider.epochs.set(boxKey(A, WATCH), 2); box(A, WATCH).splice(0);
      if (target === 'existing') box(A, WATCH).push(item(888));
      const result = await classify();
      expect(result).toMatchObject({ status: 200, body: { applied: target === 'empty' } });
      expect(copies()).toHaveLength(target === 'empty' ? 2 : 1);
      expect((await db('SELECT uid_validity FROM folders WHERE account_id=$1 AND path=$2', [A, WATCH])).rows[0].uid_validity).toBe('2');
      if (target === 'empty') expect((await receipt()).operation).not.toBe(original.operation);
      expect(await rows()).toHaveLength(1); expect(deletions()).toEqual([]);
    }
    await resetFixture(); provider.loseCopyAck = true; await unknown(await classify(), 1);
    provider.epochs.set(boxKey(A, WATCH), 2); provider.loseCopyAck = false;
    await unknown(await classify(), 1); expect((await receipt()).state).toBe('sending');
  });

  it('C08 different destination identity, wrong UID or repeated FETCH result are never accepted as COPY proof', async () => {
    for (const variant of ['different-message', 'wrong-uid', 'duplicate']) {
      if (variant !== 'different-message') await resetFixture();
      fault('cache-insert'); await unknown(await classify(), 1);
      if (variant === 'different-message') box(A, WATCH)[0].envelope = { ...box(A, WATCH)[0].envelope, messageId: '<other@synthetic.test>' };
      else provider.badFetch = variant;
      await unknown(await classify(), 1); expect((await receipt()).state).toBe('copied'); expect(deletions()).toEqual([]);
    }
  });

  it('C09 receipt copied to another account/source/UID/folder cannot authorize that physical source; foreign user is rejected', async () => {
    provider.loseCopyAck = true; await unknown(await classify(), 1);
    const pending = await receipt(); provider.loseCopyAck = false;
    const otherAccount = await seedSource({ id: B, annotations: { _mailflow_label_copy: {
      [WATCH]: { ...pending, state: 'copied', destinationUid: copies()[0].copiedUid },
    } } });
    await unknown(await classify(otherAccount.id), 1);
    for (const patch of [{ accountId: B },
      { sourceFolder: 'INBOX' }, { sourceUid: SOURCE_UID + 1 }, { sourceEpoch: '2' }]) {
      await db('UPDATE messages SET plugin_annotations=$2 WHERE id=$1', [source.id,
        JSON.stringify({ _mailflow_label_copy: { [WATCH]: { ...pending, state: 'copied', destinationUid: copies()[0].copiedUid, ...patch } } })]);
      await unknown(await classify(), 1);
    }
    const foreign = await classify(source.id, { 'x-test-user': 'foreign' }); expect(foreign.status).toBe(404);
    expect(copies().filter(event => event.accountId === B)).toEqual([]); expect(await rows(WATCH, B)).toEqual([]);
  });

  it('C10 pre-existing cache label needs exact live proof: verified no-op, ambiguity or stale identity holds (F5)', async () => {
    await seedSource({ folder: WATCH, uid: 700 });
    expect(await classify()).toMatchObject({ status: 200, body: { applied: false, undoToken: null } });
    expect(await receipt()).toBeNull(); expect(copies()).toEqual([]);
    expect(await rows()).toHaveLength(1); expect(hooks).toEqual([]);
    box(A, WATCH)[0].envelope = { ...box(A, WATCH)[0].envelope, messageId: '<other@synthetic.test>' };
    await unknown(await classify(), 0);
    box(A, WATCH)[0].envelope = { ...box(A, WATCH)[0].envelope, messageId: MID };
    await seedSource({ folder: WATCH, uid: 701 }); await unknown(await classify(), 0);
  });

  it('C11 substring SEARCH hit, non-array result or refusal is an absence-gate hold, never last-hit selection', async () => {
    for (const variant of ['substring', 'non-array', 'failure']) {
      if (variant !== 'substring') await resetFixture();
      if (variant === 'substring') box(A, WATCH).push(item(700, '<prefix-sent-watch@synthetic.test-suffix>'));
      if (variant === 'non-array') provider.searchOverride = false;
      if (variant === 'failure') provider.searchFailure = true;
      await unknown(await classify(), 0); expect(await receipt()).toBeNull();
      expect(provider.commands.filter(event => event.command === 'SEARCH')).toEqual([
        expect.objectContaining({ criteria: { header: { 'Message-ID': 'sent-watch@synthetic.test' } },
          options: { uid: true }, headerTerms: [['Message-ID', 'sent-watch@synthetic.test']] }),
      ]);
    }
  });

  it('C12 missing, malformed, control-containing or mismatched source Message-ID cannot start an intent', async () => {
    for (const messageId of [null, '', 'headerless', '<@synthetic.test>', '<missing@>', '<two@@synthetic.test>', '<bad\r\n@synthetic.test>']) {
      await db('UPDATE messages SET message_id=$2 WHERE id=$1', [source.id, messageId]);
      await unknown(await classify(), 0); expect(await receipt()).toBeNull();
    }
    await db('UPDATE messages SET message_id=$2 WHERE id=$1', [source.id, MID]);
    await expect(manager.copyMessage(A, source.uid, SENT, WATCH, {
      copyIntent: { sourceId: source.id, messageId: '<mismatch@synthetic.test>' },
    })).rejects.toMatchObject({ code: 'label-copy-unconfirmed', status: 409 });
    expect(copies()).toEqual([]); expect(provider.commands.filter(event => event.command === 'SEARCH')).toEqual([]);
  });

  it('C13 failed exact source read clears only its own pre-command receipt and never writes provider mail', async () => {
    box(A, SENT)[0].visible = false;
    await unknown(await classify(), 0);
    expect(witnesses.filter(event => event.kind === 'receipt-sending' && event.rowCount === 1)).toHaveLength(1);
    expect(witnesses.filter(event => event.kind === 'receipt-clear' && event.rowCount === 1)).toHaveLength(1);
    expect(await receipt()).toBeNull(); expect(deletions()).toEqual([]);
    // CAS cleanup cannot erase another operation that replaced our own metadata.
    box(A, SENT)[0].visible = true;
    provider.beforeFetch = async folder => {
      if (folder !== SENT) provider.assertions.push('source verification must precede cleanup race');
      await db('UPDATE messages SET plugin_annotations=$2 WHERE id=$1', [source.id,
        JSON.stringify({ _mailflow_label_copy: { [WATCH]: { operation: 'new-owner' } } })]);
      box(A, SENT)[0].visible = false;
    };
    await unknown(await classify(), 0); expect(await receipt()).toEqual({ operation: 'new-owner' });
    expect(witnesses.filter(event => event.kind === 'receipt-clear' && event.rowCount === 0)).toHaveLength(1);
  });

  it('C14 fresh manager after cache failure reads the durable locator and reconciles with no additional COPY', async () => {
    fault('cache-insert'); await unknown(await classify(), 1);
    const before = await receipt(), old = manager;
    await old.disconnectAccount(A, { strict: true });
    const restarted = newManager(); expect(restarted).not.toBe(old);
    expect(await classify()).toMatchObject({ status: 200, body: { applied: false } });
    expect(copies()).toHaveLength(1); expect(await receipt()).toMatchObject({ operation: before.operation, state: 'complete' });
    expect(await rows()).toHaveLength(1); expect(deletions()).toEqual([]);
  });

  it('C15 independent managers racing real source-receipt CAS admit exactly one COPY and preserve loser conflict', async () => {
    let arrivals = 0, release;
    const ready = new Promise(resolve => { release = resolve; });
    snapshotBarrier = async () => { if (++arrivals === 2) release(); await ready; };
    const first = manager, second = newManager();
    const attempts = [first, second].map(engine => applyLabel(engine, account, source, WATCH, { recoverableCopy: true }));
    for (const attempt of attempts) attempt.catch(() => release());
    const results = await Promise.allSettled(attempts);
    snapshotBarrier = null; await drainSync();
    expect(arrivals).toBe(2); expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected').reason).toMatchObject({ status: 409, code: 'label-copy-unconfirmed' });
    expect(witnesses.filter(event => event.kind === 'receipt-sending').map(event => event.rowCount).sort()).toEqual([0, 1]);
    expect(copies()).toHaveLength(1); expect(await rows()).toHaveLength(1); expect(deletions()).toEqual([]);
    await resetFixture();
    let commandStarted, releaseCommand;
    const started = new Promise(resolve => { commandStarted = resolve; });
    const held = new Promise(resolve => { releaseCommand = resolve; });
    provider.afterCopy = async () => { commandStarted(); await held; };
    const firstSession = classify(source.id, { 'x-test-session': 'one' });
    try {
      await Promise.race([started, firstSession.then(result => {
        throw new Error(`COPY barrier was not reached: HTTP ${result.status}`);
      })]);
      const secondSession = await classify(source.id, { 'x-test-session': 'two' });
      expect(secondSession.status).toBe(409);
      expect(secondSession.body.error).toMatch(/already in progress/); expect(copies()).toHaveLength(1);
    } finally { releaseCommand(); await firstSession; }
    expect(await firstSession).toMatchObject({ status: 200, body: { applied: true } });
    expect(await classify()).toMatchObject({ status: 200, body: { applied: false } });
    expect(copies()).toHaveLength(1); // I1 released after the initiating handler
  });

  it('C16 only a completed receipt with its known UID provably absent can retire before a new explicit COPY', async () => {
    expect((await classify()).status).toBe(200); const completed = await receipt();
    box(A, WATCH).splice(0); await db('DELETE FROM messages WHERE account_id=$1 AND folder=$2', [A, WATCH]);
    const result = await classify(); expect(result).toMatchObject({ status: 200, body: { applied: true } });
    expect(copies()).toHaveLength(2); expect((await receipt()).operation).not.toBe(completed.operation);
    expect(witnesses.some(event => event.kind === 'receipt-clear' && event.rowCount === 1)).toBe(true);
    expect(await rows()).toHaveLength(1); expect(deletions()).toEqual([]);
  });

  it('C17 already-there, ordinary, other-state and Gmail calls retain the original label path without receipts', async () => {
    const already = await seedSource({ folder: WATCH, uid: 700 });
    expect(await applyLabel(manager, account, already, WATCH, { recoverableCopy: true })).toEqual({ applied: false, uid: already.uid, reason: 'already-there' });
    expect(await applyLabel(manager, account, source, 'Ordinary')).toMatchObject({ applied: true });
    expect(await receipt()).toBeNull(); expect(copies()).toHaveLength(1); expect(copies()[0].receiptBefore).toBeNull();
    // Other GTD state exercises the real POST seam without recoverable opt-in.
    await db('DELETE FROM messages WHERE account_id=$1 AND folder=$2', [A, WATCH]); box(A, WATCH).splice(0);
    expect(await classify(source.id, {}, 'todo')).toMatchObject({ status: 200, body: { applied: true } });
    expect(await receipt()).toBeNull();
    // F3: a normal COPY really clones the core receipt. Both a still-present
    // target (verified no-op) and Watch -> Todo -> Watch (CAS replacement after
    // exact absence) must work without deleting the selected source too early.
    for (const keepWatch of [true, false]) {
      await resetFixture(); expect((await classify()).status).toBe(200);
      const original = await receipt();
      if (keepWatch) await applyLabel(manager, account, source, 'Todo');
      else expect((await classify(source.id, {}, 'todo')).status).toBe(200);
      const [todo] = await rows('Todo');
      expect(todo.plugin_annotations._mailflow_label_copy[WATCH].sourceId).toBe(source.id);
      expect(todo.plugin_annotations._mailflow_label_copy[WATCH].operation).toBe(original.operation);
      const result = await classify(todo.id);
      expect(result).toMatchObject({ status: 200, body: { applied: !keepWatch, sourceRemoved: true, switched: true } });
      expect(copies()).toHaveLength(keepWatch ? 2 : 3);
      expect(await rows('Todo')).toEqual([]); expect(await rows()).toHaveLength(1); expect(await rows(SENT)).toHaveLength(1);
    }
    await resetFixture(); provider.loseCopyAck = true; await unknown(await classify(), 1);
    provider.loseCopyAck = false;
    await applyLabel(manager, account, source, 'Todo');
    const [pendingClone] = await rows('Todo');
    expect(pendingClone.plugin_annotations._mailflow_label_copy[WATCH].state).toBe('sending');
    await unknown(await classify(pendingClone.id), 2);
    expect(await rows('Todo')).toHaveLength(1); expect(deletions()).toEqual([]);
    await resetFixture();
    await db("UPDATE email_accounts SET imap_host='imap.gmail.com' WHERE id=$1", [A]);
    await db("UPDATE messages SET provider_msgid='gmail-opaque-123' WHERE id=$1", [source.id]);
    account = (await db('SELECT * FROM email_accounts WHERE id=$1', [A])).rows[0];
    source = (await db('SELECT * FROM messages WHERE id=$1', [source.id])).rows[0];
    expect(manager.isLabelStore(account)).toBe(true);
    expect(await applyLabel(manager, account, source, WATCH, { recoverableCopy: true })).toMatchObject({ applied: true });
    expect(copies()).toHaveLength(1); expect(copies()[0].receiptBefore).toBeNull(); expect(await receipt()).toBeNull();
    expect((await rows())[0].provider_msgid).toBe('gmail-opaque-123'); expect(deletions()).toEqual([]);
  });

  it('C18 forceCopy Watch state-switch retry cannot bypass pending intent or remove the old state', async () => {
    const todo = await seedSource({ folder: 'Todo', uid: 701 });
    provider.loseCopyAck = true; await unknown(await classify(), 1);
    provider.loseCopyAck = false;
    await expect(applyLabel(manager, account, source, WATCH, { forceCopy: true, recoverableCopy: true }))
      .rejects.toMatchObject({ code: 'label-copy-unconfirmed', status: 409 });
    await unknown(await classify(), 1);
    expect((await rows('Todo')).map(row => row.id)).toEqual([todo.id]); expect(deletions()).toEqual([]);
  });

  it('C19 real count admission/tracking lifetime and error propagation stay explicit, including uncertain outcomes', async () => {
    const invalid = await classify(source.id, { 'X-Count-Op': 'invalid' });
    expect(invalid).toMatchObject({ status: 400, body: { code: 'count-op-invalid' } }); expect(copies()).toEqual([]);
    provider.loseCopyAck = true;
    const op = `${countCompletion.lease().token}:99999999-9999-4999-8999-999999999999`;
    await unknown(await classify(source.id, { 'X-Count-Op': op }), 1);
    expect(copies()[0]).toMatchObject({ handlers: 1, pending: 1 });
    expect(countCompletion.user('owner').handlers).toBe(0); expect(countCompletion.pending(A)).toBe(0);
    expect(await classify(source.id, { 'X-Count-Op': op })).toMatchObject({ status: 409, body: { code: 'count-op-replayed' } });
    expect(copies()).toHaveLength(1);
    await resetFixture();
    beforeSending = async client => {
      await client.query('SELECT 1');
      witnesses.push({ type: 'existing-count-control', at: 'pre-COPY-CAS' });
      throw Object.assign(new Error('synthetic existing count control'), { code: 'count-provider-held', status: 409 });
    };
    // The outer copy block preserves count- errors, while the existing classify
    // handler converts this path to its generic 500. Pin the actual behavior.
    const countError = await classify(); expect(countError.status).toBe(500);
    expect(countError.body).toEqual({ error: 'Failed to apply GTD label' });
    expect(copies()).toEqual([]); expect(await receipt()).toBeNull();
    expect(witnesses.filter(event => event.type === 'existing-count-control')).toHaveLength(1);
    await resetFixture();
    provider.afterCopy = () => { throw Object.assign(new Error('synthetic existing count control'), { code: 'count-provider-held', status: 409 }); };
    // The attempted-COPY catch has an unknown outcome, even if the transport
    // exception carries a count- code. Do not claim notApplied or cancellation.
    const held = await classify(); expect(held.status).toBe(409);
    expect(held.body).toMatchObject({ code: 'label-copy-unconfirmed' });
    expect(held.body).not.toHaveProperty('notApplied'); expect(copies()).toHaveLength(1);
    expect((await receipt()).state).toBe('sending');
  });

  it('C20 LIMITATION: source-row purge loses journal; visible candidates hold but a hidden delayed prior COPY can duplicate', async () => {
    provider.loseCopyAck = true; provider.hideCopy = true;
    await unknown(await classify(), 1); const purgedId = source.id;
    expect((await receipt()).state).toBe('sending'); expect(box(A, WATCH)).toHaveLength(1);
    await db('DELETE FROM messages WHERE id=$1', [purgedId]);
    // Recreate metadata for the SAME physical source, but without the journal.
    box(A, SENT).splice(0); source = await seedSource(); expect(source.id).not.toBe(purgedId);
    expect(await receipt()).toBeNull();
    provider.loseCopyAck = false; provider.hideCopy = false;
    expect(await classify()).toMatchObject({ status: 200, body: { applied: true } });
    expect(copies()).toHaveLength(2); expect(box(A, WATCH)).toHaveLength(2);
    expect(copies()[1].receiptBefore.sourceId).toBe(source.id);
    // This expected duplication is a known lifecycle boundary, NOT a passed
    // no-duplicate guarantee. The first copy arriving later remains real mail.
    box(A, WATCH)[0].visible = true;
    expect(box(A, WATCH).filter(row => row.visible)).toHaveLength(2);
    await db('DELETE FROM messages WHERE id=$1', [source.id]); box(A, SENT).splice(0); source = await seedSource();
    await db('DELETE FROM messages WHERE account_id=$1 AND folder=$2', [A, WATCH]);
    await unknown(await classify(), 2); // now the visible provider candidate blocks
    expect(provider.commands.filter(event => event.command === 'SEARCH').at(-1).criteria)
      .toEqual({ header: { 'Message-ID': 'sent-watch@synthetic.test' } });
    expect(deletions()).toEqual([]);
  });
});
