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
import { ImapManager } from './imapManager.js';

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
  const admit = (client, records = [record()], overrides = {}) => admitArchiveMetadata(client, {
    accountId, folder, uidValidity: '7', records, profile, normalEpochs: { INBOX: '9', Sent: '8' }, ...overrides,
  });
  const normalWrite = (client, uid, manual = false) => context.run({ client, manual }, () =>
    ImapManager.prototype.upsertSentMessageRecord.call({}, {
      id: accountId, imap_host: 'imap.gmail.com', email_address: 'owner@example.test',
    }, 'Sent', uid, { providerMsgid: identity, subject: 'Synthetic sent fixture', fromEmail: 'owner@example.test' }));
  const rows = async () => (await db.query(`SELECT account_id,folder,uid::text,provider_msgid,is_archive_residue
    FROM messages ORDER BY account_id,folder,uid`)).rows;
  const waitForBlock = async (observer, waiter) => {
    const until = Date.now() + 2000;
    let blockers = [];
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
    await db.query('ALTER TABLE messages ADD COLUMN bcc_addresses jsonb');
    await db.query(await readFile(new URL('../../migrations/0069_gmail_archive_coverage.sql', import.meta.url), 'utf8'));
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
  const scan = (client, options = {}) => runArchiveCoverageBatch({ id: accountId, imap_host: 'imap.gmail.test' }, {
    client, profile, reserveBudget: async () => ({ allowed: true }), ...options,
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
});
