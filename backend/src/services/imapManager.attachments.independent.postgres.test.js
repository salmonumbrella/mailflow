import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

const h = vi.hoisted(() => ({ pool: null }));
vi.mock('./db.js', () => ({
  pool: { connect: (...args) => h.pool.connect(...args) },
  query: (...args) => h.pool.query(...args),
  withTransaction: async run => {
    const client = await h.pool.connect();
    try { await client.query('BEGIN'); const value = await run(client); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  },
}));
vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: value => value }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: async () => ({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null }), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: async () => ({ allowPrivateHosts: true, allowInsecureTls: true }) }));
vi.mock('./mailAccess.js', () => ({ getAccountAddresses: vi.fn(async () => []) }));
import { ImapFlow } from 'imapflow';
import { runMigrations } from './migrations.js';
import { ImapManager, evictPool } from './imapManager.js';
import * as identity from './messageIdentity.js';

const databaseUrl = process.env.MAILFLOW_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('independent real-identity attachment interruption boundaries', () => {
  const dbName = `mailflow_attachment_review_${randomBytes(5).toString('hex')}`;
  let admin, account, source, client, release;
  const message = () => ({ uid: 7, bodyStructure: { type: 'multipart/mixed', childNodes: [
    { part: '1', type: 'text/plain', encoding: '7bit' },
    { part: '2', type: 'application/pdf', encoding: 'base64', disposition: 'attachment', dispositionParameters: { filename: 'real.pdf' } },
  ] }, bodyParts: new Map([['2', Buffer.from(Buffer.from('original bytes').toString('base64'))]]) });

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl }); await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(databaseUrl); url.pathname = `/${dbName}`;
    h.pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
    await runMigrations();
  }, 60_000);
  afterAll(async () => {
    await h.pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin?.end();
  });
  beforeEach(async () => {
    await h.pool.query('TRUNCATE users CASCADE');
    const owner = (await h.pool.query("INSERT INTO users(username) VALUES ('independent-owner') RETURNING id")).rows[0].id;
    account = (await h.pool.query(`INSERT INTO email_accounts(user_id,name,email_address,imap_host,auth_user,auth_pass)
      VALUES ($1,'Review','review@example.test','imap.example.test','synthetic','synthetic') RETURNING *`, [owner])).rows[0];
    const context = await identity.observeMailboxIdentity(await identity.readMailboxIdentity(account, 'INBOX'), {
      mailbox: { path: 'INBOX', uidValidity: 10n }, capabilities: new Set(),
    });
    await identity.writeObservedMessage(context, { uid: 7 }, tx => tx.query(`INSERT INTO messages(account_id,folder,uid,subject,attachments)
      VALUES ($1,'INBOX',7,'Original',$2) RETURNING *`, [account.id, JSON.stringify([{ part: '2', filename: 'real.pdf' }])]));
    source = (await h.pool.query('SELECT * FROM messages WHERE account_id=$1', [account.id])).rows[0];
    release = vi.fn();
    client = Object.assign(new EventEmitter(), {
      mailbox: { path: 'INBOX', uidValidity: 10n }, capabilities: new Set(),
      connect: async () => {}, close() {}, logout: async () => {},
      noop: vi.fn(async () => true), getMailboxLock: vi.fn(async () => ({ release })),
      fetch: vi.fn(async function* () { yield message(); }),
    });
    ImapFlow.mockReset().mockImplementation(function () { return client; });
  });
  afterEach(() => { vi.restoreAllMocks(); if (account) evictPool(account.id); });
  const variants = [
    ['single', () => ImapManager.prototype.fetchAttachment.call({}, account, 7, 'INBOX', '2', { expectedSource: source })],
    ['multiple', () => ImapManager.prototype.fetchMultipleAttachments.call({}, account, 7, 'INBOX', [{ part: '2', encoding: 'base64' }], { expectedSource: source })],
  ];
  describe.each(variants)('%s read', (kind, read) => {
    it('returns only the requested part, never a provider-supplied extra part', async () => {
      client.fetch.mockImplementation(async function* () {
        const returned = message(); returned.bodyParts.set('99', Buffer.from('UNREQUESTED SECRET')); yield returned;
      });
      const result = await read();
      expect(kind === 'single' ? result : result.get('2')).toEqual(Buffer.from('original bytes'));
      if (kind === 'multiple') expect([...result.keys()]).toEqual(['2']);
      expect(client.fetch).toHaveBeenCalledWith('7', { uid: true, bodyStructure: true, bodyParts: ['2'] }, { uid: true });
      expect(release).toHaveBeenCalledOnce();
    });

    it('rejects a duplicate returned UID instead of overwriting already buffered bytes', async () => {
      client.fetch.mockImplementation(async function* () { yield message(); yield message(); });
      await expect(read()).rejects.toMatchObject({ code: 'identity_source_changed' });
      expect(release).toHaveBeenCalledOnce();
    });

    it('does not return a partial buffer after the provider stream fails', async () => {
      client.fetch.mockImplementation(async function* () { yield message(); throw new Error('synthetic stream interrupted'); });
      await expect(read()).rejects.toThrow('synthetic stream interrupted');
      expect(release).toHaveBeenCalledOnce();
    });

    it('releases the lock and reads no bytes when selected-session refresh fails', async () => {
      client.noop.mockResolvedValue(false);
      await expect(read()).rejects.toThrow('refresh');
      expect(client.fetch).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
    });

    it.each(['owner', 'disabled', 'path'])('rejects late %s drift after valid bytes were buffered', async drift => {
      client.fetch.mockImplementation(async function* () {
        yield message();
        if (drift === 'owner') {
          const other = (await h.pool.query("INSERT INTO users(username) VALUES ('new-owner') RETURNING id")).rows[0].id;
          await h.pool.query('UPDATE email_accounts SET user_id=$1 WHERE id=$2', [other, account.id]);
        } else if (drift === 'disabled') await h.pool.query('UPDATE email_accounts SET enabled=false WHERE id=$1', [account.id]);
        else client.mailbox.path = 'Other';
      });
      await expect(read()).rejects.toMatchObject({ code: expect.stringMatching(/^identity_/) });
      expect(client.fetch).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
    });

    it.each([[2, 'path'], [3, 'path'], [2, 'session'], [3, 'session']])('rechecks immediate selected identity after awaited source fence %s (%s)', async (fence, drift) => {
      const original = identity.assertExpectedSource;
      let calls = 0;
      vi.spyOn(identity, 'assertExpectedSource').mockImplementation(async (...args) => {
        const result = await original(...args);
        if (++calls === fence) {
          if (drift === 'path') client.mailbox.path = 'Other';
          else client.mailflowStorageGeneration = 'changed-session';
        }
        return result;
      });
      await expect(read()).rejects.toMatchObject({ code: drift === 'path' ? 'identity_mailbox_changed' : 'storage_generation_conflict' });
      expect(client.fetch).toHaveBeenCalledTimes(fence === 2 ? 0 : 1);
      expect(release).toHaveBeenCalledOnce();
    });
  });
});
