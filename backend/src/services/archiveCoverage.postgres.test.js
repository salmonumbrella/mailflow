import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import pg from 'pg';
vi.mock('./db.js', () => ({ query: vi.fn() }));
import { query } from './db.js';
import { bootstrapGmailIdentity, getGmailArchiveFolder, isIdentityBootstrapComplete } from './archiveCoverage.js';
import { createBackgroundBudget } from './backgroundDownloadBudget.js';

const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const profile = { labelStore: true, skipFolderPatterns: ['all mail', '[gmail]/starred', '[gmail]/important'], skipFolderNames: ['[gmail]'] };
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('Gmail identity bootstrap PostgreSQL', () => {
  let db, peer;
  const schema = `archive_identity_${process.pid}`;
  beforeAll(async () => {
    db = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await db.connect();
    await db.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};
      CREATE TABLE email_accounts(id uuid PRIMARY KEY, enabled boolean DEFAULT true);
      CREATE TABLE folders(account_id uuid REFERENCES email_accounts ON DELETE CASCADE, path text,
        special_use text, no_select boolean DEFAULT false, uid_validity bigint, PRIMARY KEY(account_id,path));
      CREATE TABLE messages(account_id uuid REFERENCES email_accounts ON DELETE CASCADE, folder text,
        uid bigint, message_id text, UNIQUE(account_id,folder,uid));`);
    await db.query(readFileSync(new URL('../../migrations/0069_gmail_archive_coverage.sql', import.meta.url), 'utf8'));
    peer = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await peer.connect();
    await peer.query(`SET search_path TO ${schema}`);
    query.mockImplementation((sql, args) => db.query(sql, args));
  });
  afterAll(async () => { await peer?.end(); if (db) { await db.query(`DROP SCHEMA ${schema} CASCADE`); await db.end(); } });
  beforeEach(async () => {
    await db.query('TRUNCATE email_accounts CASCADE');
    await db.query('INSERT INTO email_accounts(id) VALUES ($1),($2)', [a, b]);
    await db.query(`INSERT INTO folders(account_id,path,uid_validity,special_use) VALUES
      ($1,'INBOX',9,NULL),($1,'Étiquettes/Tous',7,'\\All'),($1,'Work',8,NULL),($2,'INBOX',9,NULL)`, [a, b]);
    await db.query(`INSERT INTO messages(account_id,folder,uid,message_id) VALUES
      ($1,'INBOX',1,'<same@example.test>'),($1,'INBOX',2,'<same@example.test>'),
      ($1,'Work',3,'<same@example.test>'),($2,'INBOX',1,'<same@example.test>')`, [a, b]);
  });
  function client(records = [{ uid: 1, emailId: '9007199254740993' }, { uid: 2, emailId: '9007199254740995' }]) {
    return {
      capabilities: new Set(['X-GM-EXT-1']), mailbox: { uidValidity: 9n }, commands: [],
      async getMailboxLock(path, options) {
        this.commands.push(['EXAMINE', path, options]);
        if (!options.readOnly) throw new Error('bootstrap must EXAMINE');
        return { release: () => this.commands.push(['release']) };
      },
      async *fetch(range, fields, options) {
        this.commands.push(['FETCH', range, fields, options]);
        for (const record of records) yield record;
      },
    };
  }
  const account = { id: a, imap_host: 'imap.gmail.test' };
  const opts = { ...profile, reserveBudget: async () => ({ allowed: true }) };
  it('uses the localized special-use role, never OBJECTID on a non-label store', async () => {
    expect(await getGmailArchiveFolder(account, client(), true)).toBe('Étiquettes/Tous');
    const all = client();
    await bootstrapGmailIdentity(account, all, 'Étiquettes/Tous', opts);
    expect(all.commands).toEqual([]);
    const other = client(); other.capabilities = new Set(['OBJECTID']);
    expect(await getGmailArchiveFolder(account, other, false)).toBeNull();
    await bootstrapGmailIdentity(account, other, 'INBOX', opts);
    expect(other.commands).toEqual([]);
    expect(await isIdentityBootstrapComplete(a, profile)).toBe(false);
  });
  it('preserves exact provider IDs independently of RFC ID, account and folder', async () => {
    const imap = client();
    await bootstrapGmailIdentity(account, imap, 'INBOX', opts);
    const { rows } = await db.query('SELECT account_id,folder,uid,provider_msgid FROM messages ORDER BY account_id,folder,uid');
    expect(rows.map(r => r.provider_msgid)).toEqual(['9007199254740993', '9007199254740995', null, null]);
    const coverage = (await db.query('SELECT * FROM archive_coverage')).rows[0];
    expect(coverage.bootstrap_complete).toBe(true);
    expect(coverage.phase).not.toBe('complete');
    expect(await isIdentityBootstrapComplete(a, profile)).toBe(false); // Work is still unresolved.
    expect(imap.commands[0]).toEqual(['EXAMINE', 'INBOX', { readOnly: true }]);
    expect(imap.commands[1]).toEqual(['FETCH', '1,2', { uid: true }, { uid: true }]);
  });
  it('does not claim completion for missing FETCH identities or budget refusal', async () => {
    const imap = client([{ uid: 1 }]);
    await bootstrapGmailIdentity(account, imap, 'INBOX', opts);
    expect((await db.query('SELECT bootstrap_complete FROM archive_coverage')).rows[0].bootstrap_complete).toBe(false);
    const refused = client();
    await bootstrapGmailIdentity(account, refused, 'INBOX', { ...opts, reserveBudget: async () => ({ allowed: false, deferAt: 60000 }) });
    expect(refused.commands).toEqual([]);
  });
  it('reserves selection metadata before EXAMINE and skips completed bootstrap reads', async () => {
    const imap = client();
    const reserveBudget = vi.fn(async () => ({ allowed: true }));
    await bootstrapGmailIdentity(account, imap, 'INBOX', { ...opts, reserveBudget });
    expect(reserveBudget.mock.calls[0][2]).toEqual({ messages: 2, bytes: 1024 });
    const commands = [...imap.commands];
    await bootstrapGmailIdentity(account, imap, 'INBOX', { ...opts, reserveBudget });
    expect(imap.commands).toEqual(commands);
  });
  it('invalidates only the rolled-over folder identity before rebootstrap', async () => {
    await db.query("UPDATE messages SET provider_msgid='work-known' WHERE account_id=$1 AND folder='Work'", [a]);
    await bootstrapGmailIdentity(account, client(), 'INBOX', opts);
    await db.query("UPDATE folders SET uid_validity=10 WHERE account_id=$1 AND path='INBOX'", [a]);
    const imap = client([{ uid: 1, emailId: 'replacement' }]); imap.mailbox.uidValidity = 10n;
    await bootstrapGmailIdentity(account, imap, 'INBOX', { ...opts, batchSize: 1 });
    expect((await db.query("SELECT provider_msgid FROM messages WHERE account_id=$1 AND folder='INBOX' ORDER BY uid", [a])).rows)
      .toEqual([{ provider_msgid: 'replacement' }, { provider_msgid: null }]);
    expect((await db.query("SELECT uid_validity FROM folders WHERE account_id=$1 AND path='Work'", [a])).rows[0].uid_validity).toBe('8');
    expect((await db.query("SELECT provider_msgid FROM messages WHERE account_id=$1 AND folder='Work'", [a])).rows[0].provider_msgid).toBe('work-known');
    expect(await isIdentityBootstrapComplete(a, profile)).toBe(false);
  });
  it('reports transport failures without treating database failures as provider refusal', async () => {
    const onReadError = vi.fn();
    const refused = client();
    refused.getMailboxLock = async () => { throw new Error('Connection not available'); };
    await expect(bootstrapGmailIdentity(account, refused, 'INBOX', { ...opts, onReadError })).rejects.toThrow('Connection not available');
    expect(onReadError).toHaveBeenCalledOnce();
    expect((await db.query('SELECT bootstrap_complete,last_error FROM archive_coverage')).rows)
      .toEqual([{ bootstrap_complete: false, last_error: 'Identity bootstrap read failed' }]);
    onReadError.mockClear();
    const imap = client(); imap.fetch = async function* () { yield await Promise.reject(new Error('Connection not available')); };
    await expect(bootstrapGmailIdentity(account, imap, 'INBOX', { ...opts, onReadError })).rejects.toThrow('Connection not available');
    expect(onReadError).toHaveBeenCalledOnce();
    onReadError.mockClear();
    query.mockImplementationOnce(() => { throw new Error('database unavailable'); });
    await expect(bootstrapGmailIdentity(account, client(), 'INBOX', { ...opts, onReadError })).rejects.toThrow('database unavailable');
    expect(onReadError).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'foreground', 'database failure'])('never retains a stale identity after rollover %s', async interruption => {
    await bootstrapGmailIdentity(account, client(), 'INBOX', opts);
    await db.query("UPDATE folders SET uid_validity=10 WHERE account_id=$1 AND path='INBOX'", [a]);
    const controller = new AbortController();
    let foreground = false;
    query.mockImplementation(async (sql, args) => {
      if (interruption === 'database failure' && sql.includes('UPDATE messages m SET provider_msgid=NULL')) {
        throw new Error('invalidation unavailable');
      }
      const result = await db.query(sql, args);
      if (interruption === 'cancel' && sql.includes('INSERT INTO archive_coverage')) controller.abort();
      if (interruption === 'foreground' && sql.includes('INSERT INTO archive_coverage')) foreground = true;
      return result;
    });
    const interrupted = client([]); interrupted.mailbox.uidValidity = 10n;
    const pending = bootstrapGmailIdentity(account, interrupted, 'INBOX', { ...opts, signal: controller.signal, foregroundPending: () => foreground });
    if (interruption === 'database failure') await expect(pending).rejects.toThrow('invalidation unavailable');
    else await pending;
    query.mockImplementation((sql, args) => db.query(sql, args));
    const retry = client([]); retry.mailbox.uidValidity = 10n;
    await bootstrapGmailIdentity(account, retry, 'INBOX', opts);
    expect((await db.query("SELECT provider_msgid FROM messages WHERE account_id=$1 AND folder='INBOX'", [a])).rows)
      .toEqual([{ provider_msgid: null }, { provider_msgid: null }]);
    expect((await db.query('SELECT bootstrap_complete FROM archive_coverage')).rows[0].bootstrap_complete).toBe(false);
  });

  it('completes normally synced folders while skipping the same Gmail views as backfill', async () => {
    await db.query(`INSERT INTO folders(account_id,path,uid_validity) VALUES ($1,'[Gmail]/Starred',1),($1,'[Gmail]/Important',1)`, [a]);
    await bootstrapGmailIdentity(account, client(), 'INBOX', opts);
    const work = client([{ uid: 3, emailId: 'work-id' }]); work.mailbox.uidValidity = 8n;
    await bootstrapGmailIdentity(account, work, 'Work', opts);
    expect(await isIdentityBootstrapComplete(a, profile)).toBe(true);
    const skipped = client();
    await bootstrapGmailIdentity(account, skipped, '[Gmail]/Starred', opts);
    expect(skipped.commands).toEqual([]);
    await db.query(`INSERT INTO folders(account_id,path,uid_validity) VALUES ($1,'New label',11)`, [a]);
    expect(await isIdentityBootstrapComplete(a, profile)).toBe(false);
  });
  it.each(['abort', 'foreground'])('rechecks %s after waiting for the budget', async reason => {
    const controller = new AbortController(); let foreground = false;
    const imap = client();
    await bootstrapGmailIdentity(account, imap, 'INBOX', { ...opts, signal: controller.signal,
      foregroundPending: () => foreground,
      reserveBudget: async () => {
        if (reason === 'abort') controller.abort(); else foreground = true;
        return { allowed: true };
      },
    });
    expect(imap.commands).toEqual([]);
    expect(await isIdentityBootstrapComplete(a, profile)).toBe(false);
  });

  it('preserves same-epoch scan and label checkpoints while resolving an identity', async () => {
    await db.query(`INSERT INTO archive_coverage(account_id,folder,uid_validity,scan_cursor,label_modseq,sweep_cursor)
      VALUES($1,'INBOX',9,41,42,43)`, [a]);
    await bootstrapGmailIdentity(account, client(), 'INBOX', opts);
    expect((await db.query('SELECT scan_cursor,label_modseq,sweep_cursor FROM archive_coverage')).rows)
      .toEqual([{ scan_cursor: '41', label_modseq: '42', sweep_cursor: '43' }]);
  });

  it('bounds batches and yields before FETCH when foreground work appears', async () => {
    const imap = client([{ uid: 2, emailId: 'unsolicited' }, { uid: 1, emailId: '101' }]);
    await bootstrapGmailIdentity(account, imap, 'INBOX', { ...opts, batchSize: 1 });
    expect((await db.query("SELECT provider_msgid FROM messages WHERE account_id=$1 AND folder='INBOX' AND uid=2", [a])).rows[0].provider_msgid).toBeNull();
    expect(imap.commands[1][1]).toBe('1');
    let checks = 0;
    const next = client();
    await bootstrapGmailIdentity(account, next, 'INBOX', { ...opts, foregroundPending: () => ++checks > 1 });
    expect(next.commands.filter(c => c[0] === 'FETCH')).toHaveLength(0);
    expect(await isIdentityBootstrapComplete(a, profile)).toBe(false);
  });
  it('discards stale epochs without touching unrelated folders and cascades account deletion', async () => {
    const imap = client();
    imap.fetch = async function* () {
      await db.query("UPDATE folders SET uid_validity=10 WHERE account_id=$1 AND path='INBOX'", [a]);
      yield { uid: 1, emailId: 'wrong' };
    };
    await bootstrapGmailIdentity(account, imap, 'INBOX', opts);
    expect((await db.query('SELECT provider_msgid FROM messages')).rows.every(r => r.provider_msgid === null)).toBe(true);
    expect(await isIdentityBootstrapComplete(a, profile)).toBe(false);
    await db.query('DELETE FROM email_accounts WHERE id=$1', [a]);
    expect((await db.query('SELECT * FROM archive_coverage')).rows).toEqual([]);
    expect((await db.query('SELECT account_id FROM messages')).rows).toEqual([{ account_id: b }]);
  });
  it('makes bounded progress with tiny quotas, then honors durable exhaustion after restart', async () => {
    const options = { queryFn: (sql, args) => db.query(sql, args), limits: { messages: 1, bytes: 770, dailyBytes: 800, overhead: 2 } };
    let limiter = createBackgroundBudget(options);
    let imap = client([{ uid: 1, emailId: '101' }]);
    await bootstrapGmailIdentity(account, imap, 'INBOX', { ...opts, reserveBudget: (...args) => limiter.reserve(...args, 0) });
    expect(imap.commands.filter(c => c[0] === 'FETCH').map(c => c[1])).toEqual(['1']);
    limiter = createBackgroundBudget(options);
    imap = client([{ uid: 2, emailId: '102' }]);
    await bootstrapGmailIdentity(account, imap, 'INBOX', { ...opts, reserveBudget: (...args) => limiter.reserve(...args, 60000) });
    expect(imap.commands.filter(c => c[0] === 'FETCH')).toEqual([]);
    expect(await isIdentityBootstrapComplete(a, profile)).toBe(false);
  });

  it('atomically enforces durable daily quota across independent limiter instances', async () => {
    let next = 0;
    const options = { queryFn: (sql, args) => (++next % 2 ? db : peer).query(sql, args), limits: { dailyBytes: 10, overhead: 2 } };
    const results = await Promise.all([createBackgroundBudget(options), createBackgroundBudget(options)]
      .map(budget => budget.reserve(a, 'imap.test', { messages: 1, bytes: 4 }, 0)));
    expect(results.filter(r => r.allowed)).toHaveLength(1);
    expect((await db.query('SELECT bytes FROM background_download_debits')).rows).toEqual([{ bytes: '6' }]);
    expect((await createBackgroundBudget(options).reserve(b, 'imap.test', { messages: 1, bytes: 4 }, 0)).allowed).toBe(true);
    await db.query('DELETE FROM email_accounts WHERE id=$1', [a]);
    expect((await db.query('SELECT account_id,bytes FROM background_download_debits')).rows).toEqual([{ account_id: b, bytes: '6' }]);
  });
});
