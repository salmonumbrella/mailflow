// Authored against the accepted 4b contract; execution requires the lead's
// single slot and the dedicated 61dz database. No provider connection is used.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn() }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('./spamPipeline.js', () => ({ classifyAndTagMessage: vi.fn() }));
vi.mock('./mailAccess.js', () => ({ getAccountAddresses: vi.fn(async () => []) }));

import { query, withTransaction } from './db.js';
import { admitArchiveMetadata, runArchiveCoverageBatch } from './archiveCoverage.js';
import { createBackgroundBudget } from './backgroundDownloadBudget.js';
import { ImapManager, insertCopiedSibling, prepareArchiveRecord } from './imapManager.js';

const accountId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const folder = 'Étiquettes/Tous';
const identity = '9007199254740993';
const profile = { labelStore: true, skipFolderPatterns: ['all mail'], skipFolderNames: ['[gmail]'] };
const context = new AsyncLocalStorage();

describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('guarded residue admission with real PostgreSQL sessions', () => {
  let db, peer, schema, created = false;
  const record = (uid = 1, providerMsgid = identity) => ({ uid, providerMsgid, messageId: '<same@example.test>',
    subject: 'Synthetic archive fixture', fromName: 'Sender', fromEmail: 'sender@example.test',
    date: new Date('2026-10-01T00:00:00Z'), normalCopies: [] });
  const admitResult = (client, records = [record()], overrides = {}) => admitArchiveMetadata(client, {
    accountId, folder, uidValidity: '7', records, profile, normalEpochs: { INBOX: '9', Sent: '8' }, ...overrides,
  });
  const admit = async (...args) => (await admitResult(...args)).counts;
  const normalWrite = (client, uid, manual = false) => context.run({ client, manual }, () =>
    ImapManager.prototype.upsertSentMessageRecord.call({}, {
      id: accountId, imap_host: 'imap.gmail.com', email_address: 'owner@example.test',
    }, 'Sent', uid, { providerMsgid: identity, uidValidity: '8', subject: 'Synthetic sent fixture', fromEmail: 'owner@example.test' }));
  const rows = async () => (await db.query(`SELECT account_id,folder,uid::text,provider_msgid,is_archive_residue
    FROM messages ORDER BY account_id,folder,uid`)).rows;
  const waitForBlock = async (observer, waiter) => {
    const until = Date.now() + 2000;
    let blockers;
    do {
      blockers = (await observer.query('SELECT pg_blocking_pids($1) AS pids', [waiter.processID])).rows[0].pids;
      if (blockers.includes(observer.processID)) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < until);
    expect(blockers).toContain(observer.processID);
  };
  beforeAll(async () => {
    if (decodeURIComponent(new URL(process.env.MAILFLOW_TEST_DATABASE_URL).pathname) !== '/mailflow_svtw') {
      throw new Error('Residue tests require the dedicated mailflow_svtw database');
    }
    schema = `residue_admission_${randomUUID().replaceAll('-', '')}`;
    const config = { connectionString: process.env.MAILFLOW_TEST_DATABASE_URL };
    db = new pg.Client(config); await db.connect();
    await db.query(`CREATE SCHEMA ${schema}`); created = true;
    await db.query(`SET search_path TO ${schema}; SET statement_timeout='5s';
      CREATE TABLE email_accounts(id uuid PRIMARY KEY,enabled boolean DEFAULT true);
      CREATE TABLE folders(account_id uuid REFERENCES email_accounts ON DELETE CASCADE,path text,
        uid_validity bigint,special_use text,no_select boolean DEFAULT false,PRIMARY KEY(account_id,path))`);
    const baseline = await readFile(new URL('../../migrations/0001_baseline.sql', import.meta.url), 'utf8');
    await db.query(baseline.match(/CREATE TABLE IF NOT EXISTS messages \([\s\S]*?\n\);/)[0]);
    await db.query(`ALTER TABLE messages ADD COLUMN bcc_addresses jsonb,
      ADD COLUMN is_bulk boolean, ADD COLUMN normalized_subject text, ADD COLUMN spam_score_sa real,
      ADD COLUMN spam_score_ml real, ADD COLUMN spam_verdict text, ADD COLUMN spam_analyzed_at timestamptz,
      ADD COLUMN spam_details jsonb, ADD COLUMN spam_user_override text, ADD COLUMN category text,
      ADD COLUMN list_unsubscribe text, ADD COLUMN list_unsubscribe_post text, ADD COLUMN unsubscribed_at timestamptz,
      ADD COLUMN delivery_addresses jsonb, ADD COLUMN sender_name text, ADD COLUMN sender_email text,
      ADD COLUMN forwarded_from_name text, ADD COLUMN forwarded_from_email text, ADD COLUMN forwarded_via text,
      ADD COLUMN plugin_annotations jsonb`);
    await db.query(await readFile(new URL('../../migrations/0069_gmail_archive_coverage.sql', import.meta.url), 'utf8'));
    await db.query(await readFile(new URL('../../migrations/0076_archive_coverage_sweep_cadence.sql', import.meta.url), 'utf8'));
    const indexes = await readFile(new URL('../../migrations/0070_archive_identity_indexes.sql', import.meta.url), 'utf8');
    for (const statement of indexes.replace(/--[^\n]*/g, '').split(';').map(sql => sql.trim()).filter(Boolean)) await db.query(statement);
    peer = new pg.Client(config); await peer.connect();
    await peer.query(`SET search_path TO ${schema}; SET statement_timeout='5s'`);
    query.mockImplementation((sql, values) => (context.getStore()?.client || db).query(sql, values));
    withTransaction.mockImplementation(async fn => {
      const current = context.getStore() || { client: db };
      if (current.manual) return fn(current.client);
      await current.client.query('BEGIN');
      try { const result = await fn(current.client); await current.client.query('COMMIT'); return result; }
      catch (error) { await current.client.query('ROLLBACK'); throw error; }
    });
  });
  afterAll(async () => {
    if (peer) { await peer.query('ROLLBACK'); await peer.end(); }
    if (db) {
      try { await db.query('ROLLBACK'); if (created) await db.query(`DROP SCHEMA ${schema} CASCADE`); }
      finally { await db.end(); }
    }
  });
  beforeEach(async () => {
    await peer.query('ROLLBACK'); await db.query('ROLLBACK');
    await db.query('TRUNCATE email_accounts CASCADE');
    await db.query('INSERT INTO email_accounts(id) VALUES($1),($2)', [accountId, otherId]);
    await db.query(`INSERT INTO folders(account_id,path,uid_validity,special_use) VALUES
      ($1,'INBOX',9,NULL),($1,'Sent',8,'\\Sent'),($1,$3,7,'\\All'),
      ($2,'INBOX',9,NULL),($2,'Sent',8,'\\Sent'),($2,$3,7,'\\All')`, [accountId, otherId, folder]);
    await db.query(`INSERT INTO archive_coverage(account_id,folder,uid_validity,bootstrap_complete,phase)
      SELECT account_id,path,uid_validity,special_use IS DISTINCT FROM '\\All','scan' FROM folders`);
  });

  it('serializes competing admissions and stores exactly one residue identity', async () => {
    await db.query('BEGIN');
    expect(await admit(db)).toEqual({ stored: 1, suppressed: 0, pending: 0 });
    await peer.query('BEGIN');
    const second = admit(peer, [record(2)]);
    try { await waitForBlock(db, peer); } finally { await db.query('COMMIT'); }
    expect(await second).toEqual({ stored: 1, suppressed: 0, pending: 0 });
    await peer.query('COMMIT');
    expect(await rows()).toEqual([{ account_id: accountId, folder, uid: '2', provider_msgid: identity, is_archive_residue: true }]);
  });

  it('makes an actual normal writer wait for admission, then removes only residue', async () => {
    await db.query('BEGIN'); await admit(db);
    const normal = normalWrite(peer, 21);
    try { await waitForBlock(db, peer); } finally { await db.query('COMMIT'); }
    await normal;
    await normalWrite(peer, 22);
    expect(await rows()).toEqual([21, 22].map(uid => ({ account_id: accountId, folder: 'Sent', uid: String(uid),
      provider_msgid: identity, is_archive_residue: false })));
  });

  it('waits for an uncommitted normal writer before deciding whether to admit', async () => {
    await peer.query('BEGIN'); await normalWrite(peer, 21, true);
    await db.query('BEGIN');
    const residue = admit(db);
    try { await waitForBlock(peer, db); } finally { await peer.query('COMMIT'); }
    expect(await residue).toEqual({ stored: 0, suppressed: 0, pending: 1 });
    await db.query('COMMIT');
    expect(await rows()).toEqual([{ account_id: accountId, folder: 'Sent', uid: '21', provider_msgid: identity, is_archive_residue: false }]);
  });

  it('uses live locator proof to suppress only the matching residue', async () => {
    await db.query('BEGIN'); await admit(db); await db.query('COMMIT');
    await db.query(`INSERT INTO messages(account_id,folder,uid,provider_msgid,message_id)
      VALUES($1,'INBOX',31,$2,'<same@example.test>'),($1,'INBOX',32,$2,'<same@example.test>')`, [accountId, identity]);
    await db.query('BEGIN');
    expect(await admit(db, [{ ...record(), normalCopies: [{ folder: 'INBOX', uid: 31 }] }]))
      .toEqual({ stored: 0, suppressed: 1, pending: 0 });
    await db.query('COMMIT');
    expect((await rows()).map(row => [row.uid, row.is_archive_residue])).toEqual([['31', false], ['32', false]]);
  });

  it('retains residue and remains incomplete when a cached normal copy lacks live proof', async () => {
    await db.query('BEGIN'); await admit(db); await db.query('COMMIT');
    await db.query("INSERT INTO messages(account_id,folder,uid,provider_msgid) VALUES($1,'INBOX',31,$2)", [accountId, identity]);
    await db.query('BEGIN');
    expect(await admit(db)).toEqual({ stored: 0, suppressed: 0, pending: 1 });
    await db.query('COMMIT');
    expect(await rows()).toHaveLength(2);
  });

  it('retains residue and requests reconciliation for absent or changed normal destination epochs', async () => {
    await db.query('BEGIN'); await admit(db); await db.query('COMMIT');
    const manager = Object.create(ImapManager.prototype);
    manager.syncFolderOnDemand = vi.fn(async () => {});
    for (const method of ['upsertSentMessageRecord', 'upsertDraftMessageRecord']) {
      for (const uidValidity of [undefined, '7']) {
        expect(await manager[method]({ id: accountId, imap_host: 'imap.gmail.com' }, 'Sent', 21,
          { providerMsgid: identity, uidValidity, subject: 'Uncertain locator' })).toMatchObject({ pending: true });
        expect(await rows()).toEqual([{ account_id: accountId, folder, uid: '1', provider_msgid: identity, is_archive_residue: true }]);
      }
    }
    expect(manager.syncFolderOnDemand).toHaveBeenCalledTimes(4);
    expect(manager.syncFolderOnDemand).toHaveBeenCalledWith(expect.objectContaining({ id: accountId }), 'Sent');
  });

  it('does not project a replacement COPY source under the captured provider identity lock', async () => {
    const replacement = '9007199254740994';
    await db.query('BEGIN'); await admit(db, [record(2, replacement)]); await db.query('COMMIT');
    await db.query("INSERT INTO messages(account_id,folder,uid,provider_msgid) VALUES($1,'INBOX',31,$2)", [accountId, identity]);
    await peer.query('BEGIN');
    await peer.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([accountId, identity])]);
    const copy = insertCopiedSibling(accountId, 31, 'INBOX', 'Sent', 41, {
      providerMsgid: identity, sourceUidValidity: '9', destinationUidValidity: '8', labelStore: true,
    });
    try {
      await waitForBlock(peer, db);
      await peer.query("UPDATE messages SET provider_msgid=$2 WHERE account_id=$1 AND folder='INBOX' AND uid=31", [accountId, replacement]);
    } finally { await peer.query('COMMIT'); }
    expect(await copy).toBeNull();
    expect((await rows()).filter(row => row.folder === 'Sent')).toEqual([]);
    expect((await rows()).find(row => row.is_archive_residue)?.provider_msgid).toBe(replacement);
  });

  it.each(['unresolved', 'bootstrap', 'epoch', 'disabled', 'paused'])('refuses %s state without admitting records', async kind => {
    if (kind === 'unresolved') await db.query("INSERT INTO messages(account_id,folder,uid) VALUES($1,'INBOX',31)", [accountId]);
    if (kind === 'bootstrap') await db.query("UPDATE archive_coverage SET bootstrap_complete=false WHERE account_id=$1 AND folder='INBOX'", [accountId]);
    if (kind === 'epoch') await db.query("UPDATE folders SET uid_validity=10 WHERE account_id=$1 AND path='INBOX'", [accountId]);
    if (kind === 'disabled') await db.query('UPDATE email_accounts SET enabled=false WHERE id=$1', [accountId]);
    if (kind === 'paused') await db.query("UPDATE archive_coverage SET phase='paused' WHERE account_id=$1 AND folder=$2", [accountId, folder]);
    await db.query('BEGIN');
    expect(await admit(db)).toEqual({ stored: 0, suppressed: 0, pending: 1 });
    await db.query('COMMIT');
    expect((await rows()).filter(row => row.is_archive_residue)).toEqual([]);
  });

  it('never substitutes RFC Message-ID for account-qualified exact provider identity', async () => {
    await db.query('BEGIN');
    await admit(db, [record(1), record(2, '9007199254740992')]);
    await admit(db, [record(1)], { accountId: otherId });
    await db.query('COMMIT');
    expect((await rows()).map(row => [row.account_id, row.provider_msgid]))
      .toEqual([[accountId, identity], [accountId, '9007199254740992'], [otherId, identity]]);
  });

  function provider(messages = [1, 2, 3]) {
    const commands = [];
    const client = { capabilities: new Set(['X-GM-EXT-1']), mailbox: null, commands,
      async getMailboxLock(path, options) {
        expect(options).toEqual({ readOnly: true });
        commands.push(['EXAMINE', path]);
        this.mailbox = { path, uidValidity: path === folder ? 7n : path === 'INBOX' ? 9n : 8n,
          uidNext: BigInt(Math.max(0, ...messages) + 1) };
        return { release: () => {} };
      },
      async search(search, options) {
        expect(options).toEqual({ uid: true });
        const [low, high] = search.uid.split(':').map(Number);
        commands.push(['SEARCH', low, high]);
        return messages.filter(uid => uid >= low && uid <= high);
      },
      async *fetch(range, fields, options) {
        expect(options).toEqual({ uid: true });
        expect(fields.bodyParts).toBeUndefined();
        expect(fields.source).toBeUndefined();
        const requested = range.split(',').map(Number);
        expect(requested.length).toBeLessThanOrEqual(500);
        commands.push(['FETCH', this.mailbox.path, requested, fields]);
        for (const uid of requested) {
          if (this.mailbox.path !== folder || !messages.includes(uid)) continue;
          yield { uid, size: 100, emailId: String(9007199254740992n + BigInt(uid)),
            envelope: { messageId: `<fixture-${uid}@example.test>`, subject: `Archive ${uid}` },
            internalDate: new Date('2026-10-01T00:00:00Z'), flags: new Set(), headers: Buffer.alloc(0) };
        }
      },
    };
    for (const name of ['messageMove', 'messageCopy', 'messageDelete', 'messageFlagsAdd', 'messageFlagsRemove', 'append', 'send']) {
      client[name] = vi.fn(() => { throw new Error(`Catch-up must not issue ${name}`); });
    }
    return client;
  }
  const scanResult = (client, options = {}) => runArchiveCoverageBatch({ id: accountId, imap_host: 'imap.gmail.test' }, {
    client, profile, reserveBudget: async () => ({ allowed: true }), ...options,
  });
  const scan = async (...args) => (await scanResult(...args)).counts;

  function maintenanceProvider({ condstore = true, messages = [1, 2, 3], advanceModseq = true,
    normalCopies = new Map([[21, identity]]) } = {}) {
    const client = provider(messages);
    const examine = client.getMailboxLock;
    const fetch = client.fetch;
    let inboxCopy = true, modseq = 20n;
    client.enabled = new Set(condstore ? ['CONDSTORE'] : []);
    if (condstore) client.capabilities.add('CONDSTORE');
    client.getMailboxLock = async function (...args) {
      const lock = await examine.call(this, ...args);
      if (condstore && this.mailbox.path === folder) this.mailbox.highestModseq = modseq;
      return lock;
    };
    client.fetch = async function* (range, fields, options) {
      if (this.mailbox.path === 'INBOX') {
        expect(options).toEqual({ uid: true });
        const requested = range.split(',').map(Number);
        this.commands.push(['FETCH', 'INBOX', requested, fields]);
        if (inboxCopy) for (const uid of requested) {
          if (normalCopies.has(uid)) yield { uid, emailId: normalCopies.get(uid) };
        }
        return;
      }
      yield* fetch.call(this, range, fields, options);
    };
    return { client, setModseq: value => { modseq = value; }, archiveExisting: () => {
      inboxCopy = false;
      if (advanceModseq) modseq++;
    } };
  }

  function maintenanceClock(limits = {}) {
    const clock = { time: Date.parse('2026-10-21T12:00:00Z') };
    const budget = createBackgroundBudget({ queryFn: (sql, values) => db.query(sql, values), limits });
    const approved = [];
    const reserveBudget = vi.fn(async (account, host, debit) => {
      const result = await budget.reserve(account, host, debit, clock.time);
      if (result.allowed) approved.push(debit);
      return result;
    });
    return { budget, clock, approved, options: { reserveBudget, now: () => clock.time } };
  }
  const seedRepresented = uids => db.query(`INSERT INTO messages(account_id,folder,uid,provider_msgid,is_archive_residue)
    SELECT $1,$2,x.uid,x.identity,true FROM unnest($3::bigint[],$4::text[]) AS x(uid,identity)`,
  [accountId, folder, uids, uids.map(uid => String(9007199254740992n + BigInt(uid)))]);
  const seedSweep = ({ high = 3, cursor = high, modseq = '20', checked = '2026-10-21T10:00:00Z' } = {}) =>
    db.query(`UPDATE archive_coverage SET phase='sweep',scan_cursor=0,scan_high_uid=$3,
      sweep_cursor=$4,label_modseq=$5,sweep_checked_at=$6 WHERE account_id=$1 AND folder=$2`,
    [accountId, folder, high, cursor, modseq, checked]);

  it.each([true, false])('does not re-read settled metadata or spend host message tokens on an unchanged tick (CONDSTORE=%s)', async condstore => {
    const { client } = maintenanceProvider({ condstore });
    let instant = Date.parse('2026-10-21T12:00:00Z');
    const budget = createBackgroundBudget({ queryFn: (sql, values) => db.query(sql, values) });
    const reserveBudget = vi.fn((...args) => budget.reserve(...args, instant));
    const options = { reserveBudget, now: () => instant };
    expect(await scan(client, options)).toEqual({ stored: 3, suppressed: 0, pending: 0 });
    const bytes = async () => BigInt((await db.query(
      'SELECT bytes FROM background_download_debits WHERE account_id=$1', [accountId])).rows[0].bytes);
    const charged = await bytes();
    const commands = client.commands.length;
    const reservations = reserveBudget.mock.calls.length;
    instant += 1000;
    await scan(client, options);
    expect(reserveBudget.mock.calls.slice(reservations).every(([, , debit]) => debit.messages === 0)).toBe(true);
    expect(client.commands.slice(commands)).toEqual([['EXAMINE', folder]]);
    // One All Mail probe plus the shared singleton's protocol overhead.
    expect(await bytes() - charged).toBe(2048n);
    expect(await budget.reserve(otherId, 'imap.gmail.test', { messages: 117, bytes: 1 }, instant))
      .toEqual({ allowed: true, deferAt: null });
    expect(await rows()).toHaveLength(3);
  });

  it.each(['changed', 'unchanged', 'absent', 'unusable'])('discovers an existing UID archived elsewhere without UIDNEXT growth (MODSEQ=%s)', async mode => {
    const { client, archiveExisting, setModseq } = maintenanceProvider({ condstore: mode !== 'absent', advanceModseq: mode === 'changed' });
    if (mode === 'unusable') setModseq(null);
    const { clock, options } = maintenanceClock();
    await db.query('INSERT INTO messages(account_id,folder,uid,provider_msgid) VALUES($1,$2,21,$3)', [accountId, 'INBOX', identity]);
    expect(await scan(client, options)).toEqual({ stored: 2, suppressed: 1, pending: 0 });
    expect((await rows()).filter(row => row.provider_msgid === identity))
      .toEqual([{ account_id: accountId, folder: 'INBOX', uid: '21', provider_msgid: identity, is_archive_residue: false }]);
    const checkpoint = (await db.query('SELECT uid_validity,scan_high_uid FROM archive_coverage WHERE account_id=$1 AND folder=$2', [accountId, folder])).rows[0];
    archiveExisting();
    // Existing reconcileDeletes has confirmed removal of the cached normal copy.
    // This seam does not infer deletion from a missing FETCH response.
    await db.query('DELETE FROM messages WHERE account_id=$1 AND folder=$2 AND uid=21 AND NOT is_archive_residue', [accountId, 'INBOX']);
    clock.time += (mode === 'changed' ? 6 : 61) * 60000;
    expect(await scan(client, options)).toEqual({ stored: 3, suppressed: 0, pending: 0 });
    expect((await rows()).filter(row => row.provider_msgid === identity))
      .toEqual([{ account_id: accountId, folder, uid: '1', provider_msgid: identity, is_archive_residue: true }]);
    expect((await db.query('SELECT uid_validity,scan_high_uid FROM archive_coverage WHERE account_id=$1 AND folder=$2', [accountId, folder])).rows[0])
      .toEqual(checkpoint);
    for (const name of ['messageMove', 'messageCopy', 'messageDelete', 'messageFlagsAdd', 'messageFlagsRemove', 'append', 'send']) {
      expect(client[name]).not.toHaveBeenCalled();
    }
  });

  it('scans an arrival immediately during a paced sweep without losing either cursor', async () => {
    const { client } = maintenanceProvider({ messages: [1, 2, 3, 4, 5] });
    const { clock, options } = maintenanceClock();
    await seedRepresented([1, 2, 3]);
    await seedSweep({ cursor: 2, checked: new Date(clock.time).toISOString() });
    expect(await scan(client, options)).toEqual({ stored: 2, suppressed: 0, pending: 0 });
    expect(client.commands.find(command => command[0] === 'FETCH' && command[3].envelope)[2]).toEqual([5, 4]);
    expect((await db.query('SELECT scan_cursor,sweep_cursor,scan_high_uid,label_modseq,sweep_checked_at FROM archive_coverage WHERE account_id=$1 AND folder=$2', [accountId, folder])).rows[0])
      .toEqual({ scan_cursor: '0', sweep_cursor: '2', scan_high_uid: '5', label_modseq: '20', sweep_checked_at: new Date(clock.time) });
  });

  it('keeps a BigInt pass snapshot across mid-pass changes and starts the next pass only after five minutes', async () => {
    const { client, setModseq } = maintenanceProvider({ messages: [1, 63, 125] });
    const { clock, options } = maintenanceClock();
    setModseq(9007199254740993n);
    await seedRepresented([1, 63, 125]);
    await seedSweep({ high: 125, modseq: '9007199254740993' });
    const state = async () => (await db.query('SELECT label_modseq,sweep_cursor FROM archive_coverage WHERE account_id=$1 AND folder=$2', [accountId, folder])).rows[0];
    await scan(client, options);
    // The real default 120-message budget shrinks the first 125-UID window to62.
    expect(await state()).toEqual({ label_modseq: '9007199254740993', sweep_cursor: '63' });
    setModseq('9007199254740994');
    clock.time += 6 * 60000;
    await scan(client, options);
    expect(await state()).toEqual({ label_modseq: '9007199254740993', sweep_cursor: '0' });
    const before = client.commands.length;
    clock.time += 1000;
    await scan(client, options);
    expect(client.commands.slice(before)).toEqual([['EXAMINE', folder]]);
    clock.time += 6 * 60000;
    await scan(client, options);
    expect(await state()).toEqual({ label_modseq: '9007199254740994', sweep_cursor: '63' });
  });

  it('uses the persisted sweep timestamp after restart rather than refetching settled history', async () => {
    const { clock, options } = maintenanceClock();
    await scan(maintenanceProvider().client, options);
    expect((await db.query('SELECT sweep_checked_at FROM archive_coverage WHERE account_id=$1 AND folder=$2', [accountId, folder])).rows[0].sweep_checked_at)
      .toEqual(new Date(clock.time));
    const restarted = maintenanceProvider().client;
    clock.time += 1000;
    await scan(restarted, options);
    expect(restarted.commands).toEqual([['EXAMINE', folder]]);
    expect(await rows()).toHaveLength(3);
  });

  it('clears All Mail maintenance on UIDVALIDITY reset before a denied catch-up read', async () => {
    const { client } = maintenanceProvider();
    const { options } = maintenanceClock({ messages: 0 });
    await seedSweep({ cursor: 2 });
    await seedRepresented([1, 2, 3]);
    await db.query('INSERT INTO messages(account_id,folder,uid,provider_msgid) VALUES($1,$2,21,$3)', [accountId, 'INBOX', identity]);
    const examine = client.getMailboxLock;
    client.getMailboxLock = async function (...args) {
      const lock = await examine.call(this, ...args);
      if (this.mailbox.path === folder) this.mailbox.uidValidity = 8n;
      return lock;
    };
    expect((await scan(client, options)).pending).toBeTruthy();
    expect((await db.query('SELECT uid_validity,label_modseq,sweep_cursor,sweep_checked_at FROM archive_coverage WHERE account_id=$1 AND folder=$2', [accountId, folder])).rows[0])
      .toEqual({ uid_validity: '8', label_modseq: null, sweep_cursor: null, sweep_checked_at: null });
    expect((await rows()).map(row => [row.folder, row.uid])).toEqual([['INBOX', '21']]);
    expect(client.commands.some(command => command[0] === 'FETCH')).toBe(false);
  });

  it('fetches full metadata only for unrepresented identities in an ID-only maintenance window with exact debits', async () => {
    const { client } = maintenanceProvider();
    const { approved, options } = maintenanceClock();
    await seedSweep();
    await seedRepresented([3]);
    await db.query('INSERT INTO messages(account_id,folder,uid,provider_msgid) VALUES($1,$2,21,$3)', [accountId, 'INBOX', identity]);
    expect(await scan(client, options)).toEqual({ stored: 2, suppressed: 1, pending: 0 });
    const archiveFetches = client.commands.filter(command => command[0] === 'FETCH' && command[1] === folder);
    expect(archiveFetches.some(command => !command[3].size && !command[3].envelope && command[2].length === 3)).toBe(true);
    expect(archiveFetches.filter(command => command[3].size).map(command => command[2])).toEqual([[2]]);
    expect(archiveFetches.filter(command => command[3].envelope).map(command => command[2])).toEqual([[2]]);
    expect(approved).toContainEqual({ messages: 0, bytes: 1024 + 4 * 100 + 4096 });
    const bytes = BigInt((await db.query('SELECT bytes FROM background_download_debits WHERE account_id=$1', [accountId])).rows[0].bytes);
    expect(bytes).toBe(approved.reduce((sum, debit) => sum + BigInt(debit.bytes + 1024), 0n));
    const copies = (await rows()).map(row => [row.folder, row.uid]);
    expect(copies).toHaveLength(3);
    expect(copies).toEqual(expect.arrayContaining([[folder, '2'], [folder, '3'], ['INBOX', '21']]));
  });

  it('keeps an ID-only cached normal identity pending when its live locator is missing', async () => {
    const { client, archiveExisting } = maintenanceProvider();
    const { options } = maintenanceClock();
    await seedSweep();
    await seedRepresented([2, 3]);
    await db.query('INSERT INTO messages(account_id,folder,uid,provider_msgid) VALUES($1,$2,21,$3)', [accountId, 'INBOX', identity]);
    archiveExisting(); // No confirmed normal-cache removal: missing FETCH is not deletion proof.
    expect((await scan(client, options)).pending).toBe(1);
    expect((await db.query('SELECT sweep_cursor,sweep_checked_at FROM archive_coverage WHERE account_id=$1 AND folder=$2', [accountId, folder])).rows[0])
      .toEqual({ sweep_cursor: '3', sweep_checked_at: new Date('2026-10-21T10:00:00Z') });
    expect((await rows()).filter(row => row.provider_msgid === identity))
      .toEqual([{ account_id: accountId, folder: 'INBOX', uid: '21', provider_msgid: identity, is_archive_residue: false }]);
    expect(client.commands.some(command => command[0] === 'FETCH' && command[3].envelope)).toBe(false);
  });

  it.each([
    { label: 'default 120-message cap with 63 identities', count: 63, refusals: 0, window: 63, cursor: '0' },
    { label: 'adaptive one-message floor after seven refusals', count: 3, refusals: 7, window: 1, cursor: '2' },
  ])('accounts normal-copy UID proof only as bytes and advances at $label', async ({ count, refusals, window, cursor }) => {
    const messages = Array.from({ length: count }, (_, index) => index + 1);
    const normalCopies = new Map(messages.map(uid => [uid + 100, String(9007199254740992n + BigInt(uid))]));
    const { client } = maintenanceProvider({ messages, normalCopies });
    const { budget, clock, approved, options } = maintenanceClock();
    await db.query(`INSERT INTO messages(account_id,folder,uid,provider_msgid)
      SELECT $1,'INBOX',x.uid,x.identity FROM unnest($2::bigint[],$3::text[]) AS x(uid,identity)`,
    [accountId, [...normalCopies.keys()], [...normalCopies.values()]]);
    await seedSweep({ high: count });
    for (let n = 0; n < refusals; n++) budget.refuse('imap.gmail.test', clock.time);
    if (refusals) clock.time += 60000; // End the actual refusal cooldown, retaining its reduced rate.

    expect(await scan(client, options)).toEqual({ stored: 0, suppressed: window, pending: 0 });
    expect((await db.query('SELECT scan_cursor,sweep_cursor,sweep_checked_at FROM archive_coverage WHERE account_id=$1 AND folder=$2', [accountId, folder])).rows[0])
      .toEqual({ scan_cursor: '0', sweep_cursor: cursor, sweep_checked_at: new Date(clock.time) });
    expect(client.commands.filter(command => command[0] === 'SEARCH').map(command => command.slice(1)))
      .toEqual([[count - window + 1, count]]);
    const fetches = client.commands.filter(command => command[0] === 'FETCH');
    expect(fetches).toHaveLength(2);
    expect(fetches.every(command => Object.keys(command[3]).join(',') === 'uid' && command[3].uid === true)).toBe(true);
    expect(fetches.find(command => command[1] === 'INBOX')[2].slice().sort((a, b) => a - b))
      .toEqual(messages.slice(-window).map(uid => uid + 100));
    // Five EXAMINEs; the source window alone consumes logical message tokens.
    // The normal UID proof covers the same identities and reserves framing bytes only.
    const probe = { messages: 0, bytes: 1024 };
    expect(approved).toEqual([probe, { messages: window, bytes: 1024 + 256 * window }, probe, probe,
      { messages: 0, bytes: 1024 + 256 * window }, probe, probe]);
    expect(BigInt((await db.query('SELECT bytes FROM background_download_debits WHERE account_id=$1', [accountId])).rows[0].bytes))
      .toBe(BigInt(5 * 2048 + 2 * (2048 + 256 * window)));
    expect((await rows()).every(row => row.folder === 'INBOX' && !row.is_archive_residue)).toBe(true);
    expect(await rows()).toHaveLength(count);
    if (refusals) {
      expect(await budget.reserve(otherId, 'imap.gmail.test', { messages: 1, bytes: 0 }, clock.time))
        .toMatchObject({ allowed: false });
    } else {
      expect(await budget.reserve(otherId, 'imap.gmail.test', { messages: 120 - window, bytes: 0 }, clock.time))
        .toEqual({ allowed: true, deferAt: null });
    }
  });

  it('ingests newest first, commits progress, and never issues a provider mutation', async () => {
    const client = provider();
    expect(await scan(client)).toEqual({ stored: 3, suppressed: 0, pending: 0 });
    expect((await rows()).map(row => row.uid)).toEqual(['1', '2', '3']);
    const metadata = client.commands.find(command => command[0] === 'FETCH' && command[3].envelope);
    expect(metadata[2]).toEqual([3, 2, 1]);
    const coverage = (await db.query('SELECT scan_cursor,scan_high_uid FROM archive_coverage WHERE account_id=$1 AND folder=$2', [accountId, folder])).rows[0];
    expect(coverage).toEqual({ scan_cursor: '0', scan_high_uid: '3' });
    for (const name of ['messageMove', 'messageCopy', 'messageDelete', 'messageFlagsAdd', 'messageFlagsRemove', 'append', 'send']) {
      expect(client[name]).not.toHaveBeenCalled();
    }
  });

  it('sanitizes NUL provider text through production preparation and commits the whole batch', async () => {
    const client = provider();
    const fetch = client.fetch;
    client.fetch = async function* (...args) {
      for await (const raw of fetch.call(this, ...args)) {
        if (args[1].envelope && raw.uid === 1) {
          raw.envelope = { ...raw.envelope, messageId: '<encoded-subject@example.test>', subject: '\0',
            from: [{ name: 'Sender', address: 'sender@example.test' }],
            to: [{ name: 'Recipient', address: 'owner@example.test' }] };
          raw.headers = Buffer.from('Subject: =?UTF-8?Q?=00?=\r\n');
        }
        if (args[1].envelope && raw.uid === 2) raw.envelope = {
          ...raw.envelope, messageId: '<nul\0@example.test>', subject: 'Archive\0 text',
          from: [{ name: 'Syn\0thetic', address: 'sender@example.test' }],
          to: [{ name: 'Reci\0pient', address: 'owner@example.test' }],
        };
        yield raw;
      }
    };
    expect(await scan(client, { prepareRecord: raw => prepareArchiveRecord({ id: accountId,
      imap_host: 'imap.gmail.com', email_address: 'owner@example.test' }, raw, folder) }))
      .toEqual({ stored: 3, suppressed: 0, pending: 0 });
    expect((await db.query('SELECT message_id,subject,from_name,to_addresses FROM messages WHERE uid=2')).rows[0])
      .toMatchObject({ message_id: '<nul@example.test>', subject: 'Archive text', from_name: 'Synthetic',
        to_addresses: [{ name: 'Recipient', email: 'owner@example.test' }] });
    expect((await db.query('SELECT message_id,subject,from_email,thread_id FROM messages WHERE uid=1')).rows[0])
      .toEqual({ message_id: '<encoded-subject@example.test>', subject: '', from_email: 'sender@example.test',
        thread_id: '<encoded-subject@example.test>' });
    expect((await db.query('SELECT scan_cursor FROM archive_coverage WHERE account_id=$1 AND folder=$2', [accountId, folder])).rows[0].scan_cursor).toBe('0');
    expect(await rows()).toHaveLength(3);
  });

  it('bounds requests to 500 and resumes the descending cursor without an age limit', async () => {
    const client = provider(Array.from({ length: 1001 }, (_, index) => index + 1));
    await scan(client);
    expect(client.commands.find(command => command[0] === 'SEARCH').slice(1)).toEqual([502, 1001]);
    await scan(client);
    expect(client.commands.filter(command => command[0] === 'SEARCH')[1].slice(1)).toEqual([2, 501]);
    await scan(client);
    expect(await rows()).toHaveLength(1001);
  });

  it('prioritizes new arrivals after restart and retains the historical resume point', async () => {
    await db.query(`UPDATE archive_coverage SET scan_cursor=2,scan_high_uid=3 WHERE account_id=$1 AND folder=$2`, [accountId, folder]);
    const restarted = provider([1, 2, 3, 4, 5]);
    await scan(restarted);
    expect(restarted.commands.find(command => command[0] === 'SEARCH').slice(1)).toEqual([4, 5]);
    expect((await db.query('SELECT scan_cursor FROM archive_coverage WHERE account_id=$1 AND folder=$2', [accountId, folder])).rows[0].scan_cursor).toBe('2');
    await scan(restarted);
    expect(restarted.commands.filter(command => command[0] === 'SEARCH')[1].slice(1)).toEqual([1, 2]);
  });

  it('retains the checkpoint when FETCH omits a searched UID; retries do not certify deletion', async () => {
    await db.query(`UPDATE archive_coverage SET scan_cursor=3,scan_high_uid=3 WHERE account_id=$1 AND folder=$2`, [accountId, folder]);
    const client = provider();
    const fetch = client.fetch;
    client.fetch = async function* (...args) {
      for await (const raw of fetch.call(this, ...args)) if (raw.uid !== 2) yield raw;
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await scan(client)).pending).toBeTruthy();
      expect((await db.query('SELECT scan_cursor FROM archive_coverage WHERE account_id=$1 AND folder=$2', [accountId, folder])).rows[0].scan_cursor).toBe('3');
    }
    expect(await rows()).toEqual([]);
  });

  it.each(['budget', 'foreground', 'paused', 'disabled'])('stops before provider commands on %s refusal', async kind => {
    if (kind === 'paused') await db.query("UPDATE archive_coverage SET phase='paused' WHERE account_id=$1 AND folder=$2", [accountId, folder]);
    if (kind === 'disabled') await db.query('UPDATE email_accounts SET enabled=false WHERE id=$1', [accountId]);
    const client = provider();
    await scan(client, { reserveBudget: async () => ({ allowed: kind !== 'budget' }), foregroundPending: () => kind === 'foreground' });
    expect(client.commands).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it('reserves EXAMINE, UID/size, full metadata and retry reads against the same budget', async () => {
    const client = provider();
    const reserveBudget = vi.fn(async () => ({ allowed: true }));
    await scan(client, { reserveBudget });
    const charges = reserveBudget.mock.calls.map(([account, host, reservation]) => {
      expect(account).toBe(accountId); expect(host).toBe('imap.gmail.test'); return reservation;
    });
    expect(charges.filter(charge => charge.messages === 0 && charge.bytes === 1024)).toHaveLength(4);
    expect(charges).toContainEqual({ messages: 3, bytes: 1024 + 3 * 256 });
    expect(charges).toContainEqual({ messages: 0, bytes: 1024 + 3 * (4 * 100 + 4096) });
    const before = reserveBudget.mock.calls.length;
    await scan(client, { reserveBudget });
    expect(reserveBudget.mock.calls.length).toBeGreaterThan(before);
  });

  it('does not classify a database parser failure as a provider refusal', async () => {
    const error = new Error('Connection not available');
    await expect(scan(provider(), { prepareRecord: async () => { throw error; } })).rejects.toBe(error);
    expect(error.archiveProviderRead).toBeUndefined();
    expect(await rows()).toEqual([]);
  });
  // Source-only new arrival controls. These use the real transaction client and
  // scanner; no job table/worker exists in this isolated admission fixture.
  it('returns actual inserted IDs only after outer COMMIT makes them visible to the peer', async () => {
    let internalIds;
    const result = await withTransaction(async client => {
      const value = await admitResult(client);
      internalIds = value.admittedIds;
      expect(internalIds).toHaveLength(1);
      expect((await peer.query('SELECT id FROM messages WHERE account_id=$1', [accountId])).rows).toEqual([]);
      return value;
    });
    const committed = (await peer.query('SELECT id,account_id,provider_msgid,is_archive_residue,is_deleted FROM messages')).rows;
    expect(result).toEqual({ counts: { stored: 1, suppressed: 0, pending: 0 }, admittedIds: internalIds });
    expect(committed).toEqual([{ id: result.admittedIds[0], account_id: accountId, provider_msgid: identity,
      is_archive_residue: true, is_deleted: false }]);
  });

  it('refreshes same-provider eligible metadata without another arrival', async () => {
    const inserted = await withTransaction(client => admitResult(client));
    const refreshed = await withTransaction(client => admitResult(client, [{ ...record(), subject: 'Updated synthetic header' }]));
    expect(refreshed).toEqual({ counts: { stored: 1, suppressed: 0, pending: 0 }, admittedIds: [] });
    expect((await db.query('SELECT id,subject FROM messages')).rows)
      .toEqual([{ id: inserted.admittedIds[0], subject: 'Updated synthetic header' }]);
  });

  it.each(['null-provider', 'provider-change', 'normal-to-residue', 'resurrection'])('returns the actual retained ID for a %s eligibility transition', async kind => {
    const previous = kind === 'null-provider' ? null : kind === 'provider-change' ? '9007199254740994' : identity;
    const oldId = randomUUID();
    await db.query(`INSERT INTO messages(id,account_id,folder,uid,provider_msgid,is_archive_residue,is_deleted)
      VALUES($1,$2,$3,1,$4,$5,$6)`, [oldId, accountId, folder, previous, kind !== 'normal-to-residue', kind === 'resurrection']);
    const result = await withTransaction(client => admitResult(client));
    expect(result).toEqual({ counts: { stored: 1, suppressed: 0, pending: 0 }, admittedIds: [oldId] });
    expect((await peer.query('SELECT id,provider_msgid,is_archive_residue,is_deleted FROM messages')).rows)
      .toEqual([{ id: oldId, provider_msgid: identity, is_archive_residue: true, is_deleted: false }]);
  });

  it('emits no arrival for identity-only verification or live-normal suppression', async () => {
    await withTransaction(client => admitResult(client));
    const verified = await withTransaction(client => admitResult(client, [{ ...record(), identityOnly: true }]));
    expect(verified).toEqual({ counts: { stored: 1, suppressed: 0, pending: 0 }, admittedIds: [] });
    await db.query("INSERT INTO messages(account_id,folder,uid,provider_msgid) VALUES($1,'INBOX',31,$2)", [accountId, identity]);
    const suppressed = await withTransaction(client => admitResult(client, [{ ...record(), normalCopies: [{ folder: 'INBOX', uid: 31 }] }]));
    expect(suppressed).toEqual({ counts: { stored: 0, suppressed: 1, pending: 0 }, admittedIds: [] });
    expect((await rows()).map(row => row.folder)).toEqual(['INBOX']);
  });

  it('keeps committed arrivals when another record is pending without advancing its checkpoint', async () => {
    // The cached UID has no live normal-copy proof from this synthetic provider.
    await db.query("INSERT INTO messages(account_id,folder,uid,provider_msgid) VALUES($1,'INBOX',31,'9007199254740994')", [accountId]);
    const result = await scanResult(provider([1, 2]));
    expect(result.counts).toEqual({ stored: 1, suppressed: 0, pending: 1 });
    expect(result.admittedIds).toEqual((await peer.query('SELECT id FROM messages WHERE is_archive_residue')).rows.map(row => row.id));
    expect(result.admittedIds).toHaveLength(1);
    expect((await db.query('SELECT scan_cursor FROM archive_coverage WHERE account_id=$1 AND folder=$2', [accountId, folder])).rows[0].scan_cursor).toBeNull();
  });

  it('returns only the final committed residue ID for repeated provider identity locators in one batch', async () => {
    const result = await withTransaction(client => admitResult(client, [record(1), record(2)]));
    const current = (await peer.query('SELECT id,uid::text FROM messages')).rows;
    expect(result.counts).toEqual({ stored: 2, suppressed: 0, pending: 0 });
    expect(result.admittedIds).toHaveLength(1);
    expect(current).toEqual([{ id: result.admittedIds[0], uid: '2' }]);
  });

  it.each(['statement-rollback', 'deferred-commit-failure'])('does not expose scanner arrivals after %s', async kind => {
    const actualTransaction = withTransaction.getMockImplementation();
    let internalIds = [];
    if (kind === 'deferred-commit-failure') await db.query(`
      CREATE FUNCTION reject_arrival_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'deferred archive arrival commit rejected'; END; $$;
      CREATE CONSTRAINT TRIGGER reject_arrival_commit AFTER INSERT ON messages
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_arrival_commit()`);
    withTransaction.mockImplementation(work => actualTransaction(async client => {
      const value = await work(client);
      if (value?.admittedIds?.length) {
        internalIds = value.admittedIds;
        expect((await peer.query('SELECT id FROM messages')).rows).toEqual([]);
        if (kind === 'statement-rollback') await client.query('SELECT 1/0');
      }
      return value;
    }));
    try {
      await expect(scanResult(provider())).rejects.toThrow(kind === 'statement-rollback'
        ? /division by zero/ : /deferred archive arrival commit rejected/);
      expect(internalIds).toHaveLength(3); // Real RETURNING was not a commit certificate.
      expect(await rows()).toEqual([]);
      expect((await db.query('SELECT scan_cursor FROM archive_coverage WHERE account_id=$1 AND folder=$2', [accountId, folder])).rows[0].scan_cursor).toBeNull();
    } finally {
      withTransaction.mockImplementation(actualTransaction);
      if (kind === 'deferred-commit-failure') await db.query('DROP TRIGGER IF EXISTS reject_arrival_commit ON messages; DROP FUNCTION IF EXISTS reject_arrival_commit()');
    }
  });

  it('normalizes an identity-helper incomplete result to pending counts with no arrivals or checkpoint advance', async () => {
    // Defensive fault injection only: the real same-transaction account FOR
    // SHARE lock makes this second-read refusal unreachable in today's flow.
    const actualQuery = db.query.bind(db);
    let accountReads = 0;
    const queries = vi.spyOn(db, 'query').mockImplementation((sql, values) => {
      if (sql === 'SELECT id FROM email_accounts WHERE id=$1 AND enabled FOR SHARE' && ++accountReads === 2) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      return actualQuery(sql, values);
    });
    try {
      expect(await scanResult(provider())).toEqual({ counts: { stored: 0, suppressed: 0, pending: 3 }, admittedIds: [] });
      expect(accountReads).toBe(2);
      expect(await rows()).toEqual([]);
      expect((await peer.query('SELECT scan_cursor FROM archive_coverage WHERE account_id=$1 AND folder=$2',
        [accountId, folder])).rows[0].scan_cursor).toBeNull();
    } finally { queries.mockRestore(); }
  });

});
