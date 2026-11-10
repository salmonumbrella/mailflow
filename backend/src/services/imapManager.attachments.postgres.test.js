import { randomBytes } from 'crypto';
import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
const h = vi.hoisted(() => ({ pool: null }));
vi.mock('./db.js', () => ({
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
import { readMailboxIdentity, observeMailboxIdentity } from './messageIdentity.js';

import * as identityService from './messageIdentity.js';

const databaseUrl = process.env.MAILFLOW_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('attachment reads keep the original durable source', () => {
  const dbName = `mailflow_attachment_identity_${randomBytes(5).toString('hex')}`;
  let admin, account;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl }); await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(databaseUrl); url.pathname = `/${dbName}`;
    h.pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
    await runMigrations();
  }, 60_000);
  afterAll(async () => { await h.pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin?.end(); });
  beforeEach(async () => {
    await h.pool.query('TRUNCATE users CASCADE');
    const owner = (await h.pool.query("INSERT INTO users(username) VALUES ('engine-owner') RETURNING id")).rows[0].id;
    account = (await h.pool.query(`INSERT INTO email_accounts(user_id,name,email_address,imap_host,auth_user,auth_pass)
      VALUES ($1,'Engine','me@example.test','imap.example.test','synthetic','synthetic') RETURNING *`, [owner])).rows[0];
  });
  afterEach(() => { vi.restoreAllMocks(); if (account) evictPool(account.id); });
  const rowAt = async (folder, uid) => (await h.pool.query('SELECT * FROM messages WHERE account_id=$1 AND folder=$2 AND uid=$3', [account.id, folder, uid])).rows[0];
  const observe = async (folder, epoch = 10, capabilities = []) => observeMailboxIdentity(await readMailboxIdentity(account, folder),
    { mailbox: { path: folder, uidValidity: BigInt(epoch) }, capabilities: new Set(capabilities) });
  const raw = (uid, emailId = undefined, size = 123) => ({ uid, emailId, size, flags: new Set(['\\Seen']),
    internalDate: new Date('2026-11-01T00:00:00Z'), envelope: { messageId: '<same@example.test>', subject: 'Same content',
      from: [{ address: 'sender@example.test' }], to: [{ address: 'me@example.test' }] } });
  const clientFor = (folder, epoch, messages, capabilities = []) => Object.assign(new EventEmitter(), {
    mailbox: { path: folder, uidValidity: BigInt(epoch), exists: messages.length }, capabilities: new Set(capabilities),
    connect: async () => {}, close() {}, logout: async () => {}, noop: async () => true,
    getMailboxLock: async () => ({ release() {} }), search: async () => messages.map(message => message.uid),
    fetch: async function* () { for (const message of messages) yield message; },
  });
  const manager = () => ({ pluginFacade: {}, maybeClassifyNewMessage: vi.fn(), broadcast: vi.fn(),
    _applyFlagUpdates: async () => 0, backfillRunning: new Set(), _secondaryConnectBlocked: () => null,
    _noteSecondaryRefusal: vi.fn(), _bgConnSem: { acquire: async () => {}, release() {} }, backfillMessages: vi.fn() });
  const sync = async (folder, epoch, messages, capabilities = []) => {
    await ImapManager.prototype.syncMessages.call(manager(), account, clientFor(folder, epoch, messages, capabilities), folder, 50, false, true);
  };

  const attachmentMessage = (uid = 1) => ({ ...raw(uid), bodyStructure: {
    type: 'multipart/mixed', childNodes: [
      { part: '1', type: 'text/plain', encoding: '7bit' },
      { part: '2', type: 'application/pdf', encoding: 'base64', disposition: 'attachment', dispositionParameters: { filename: 'original.pdf' } },
    ],
  }, bodyParts: new Map([['2', Buffer.from(Buffer.from('%PDF-original').toString('base64'))]]) });
  const prepare = async () => {
    await sync('INBOX', 10, [attachmentMessage()]);
    const source = await rowAt('INBOX', 1);
    const client = clientFor('INBOX', 10, [attachmentMessage()]);
    const release = vi.fn();
    client.getMailboxLock = vi.fn(async () => ({ release }));
    client.fetch = vi.fn(async function* () { yield attachmentMessage(); });
    client.noop = vi.fn(async () => true);
    ImapFlow.mockImplementation(function () { return client; });
    return { source, client, release };
  };
  const variants = [
    ['single', (source, options = {}) => ImapManager.prototype.fetchAttachment.call({}, account, 1, 'INBOX', '2', { expectedSource: source, ...options })],
    ['multiple', (source, options = {}) => ImapManager.prototype.fetchMultipleAttachments.call({}, account, 1, 'INBOX', [{ part: '2', encoding: 'base64' }], { expectedSource: source, ...options })],
  ];
  describe.each(variants)('%s attachment read', (_name, read) => {
    it('returns the exact decoded bytes and releases the mailbox lock', async () => {
      const { source, client, release } = await prepare();
      const result = await read(source);
      expect(Buffer.isBuffer(result) ? result : result.get('2')).toEqual(Buffer.from('%PDF-original'));
      expect(client.fetch).toHaveBeenCalledOnce();
      expect(client.noop).toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    });

    it.each(['epoch', 'generation', 'deleted', 'disabled', 'owner', 'row', 'moved', 'entity'])('rejects %s drift while waiting for the mailbox lock before fetching bytes', async drift => {
      const { source, client, release } = await prepare();
      client.getMailboxLock.mockImplementation(async () => {
        if (drift === 'epoch') client.mailbox.uidValidity = 11n;
        if (drift === 'generation') await h.pool.query('UPDATE email_accounts SET storage_generation=gen_random_uuid() WHERE id=$1', [account.id]);
        if (drift === 'deleted') await h.pool.query('UPDATE messages SET is_deleted=true WHERE id=$1', [source.id]);
        if (drift === 'disabled') await h.pool.query('UPDATE email_accounts SET enabled=false WHERE id=$1', [account.id]);
        if (drift === 'owner') {
          const other = (await h.pool.query("INSERT INTO users(username) VALUES ('other-owner') RETURNING id")).rows[0].id;
          await h.pool.query('UPDATE email_accounts SET user_id=$1 WHERE id=$2', [other, account.id]);
        }
        if (drift === 'row') await h.pool.query('DELETE FROM messages WHERE id=$1', [source.id]);
        if (drift === 'moved') await h.pool.query("UPDATE messages SET folder='Moved' WHERE id=$1", [source.id]);
        if (drift === 'entity') {
          await h.pool.query('DELETE FROM messages WHERE id=$1', [source.id]);
          await h.pool.query('DELETE FROM entity_locations WHERE entity_id=$1', [source.entity_id]);
          await sync('INBOX', 10, [attachmentMessage()]);
          const replacement = await rowAt('INBOX', 1);
          expect(replacement.entity_id).not.toBe(source.entity_id);
          await h.pool.query('UPDATE messages SET id=$1 WHERE id=$2', [source.id, replacement.id]);
        }
        return { release };
      });
      await expect(read(source)).rejects.toMatchObject({ code: expect.stringMatching(/identity_|storage_generation/) });
      expect(client.fetch).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    });

    it.each(['epoch', 'generation', 'deleted', 'disabled', 'owner', 'row'])('discards fetched bytes after late %s drift', async drift => {
      const { source, client, release } = await prepare();
      client.fetch.mockImplementation(async function* () {
        yield attachmentMessage();
        if (drift === 'epoch') client.mailbox.uidValidity = 11n;
        if (drift === 'generation') await h.pool.query('UPDATE email_accounts SET storage_generation=gen_random_uuid() WHERE id=$1', [account.id]);
        if (drift === 'deleted') await h.pool.query('UPDATE messages SET is_deleted=true WHERE id=$1', [source.id]);
        if (drift === 'disabled') await h.pool.query('UPDATE email_accounts SET enabled=false WHERE id=$1', [account.id]);
        if (drift === 'row') await h.pool.query('DELETE FROM messages WHERE id=$1', [source.id]);
        if (drift === 'owner') {
          const other = (await h.pool.query("INSERT INTO users(username) VALUES ('late-owner') RETURNING id")).rows[0].id;
          await h.pool.query('UPDATE email_accounts SET user_id=$1 WHERE id=$2', [other, account.id]);
        }
      });
      await expect(read(source)).rejects.toMatchObject({ code: expect.stringMatching(/identity_|storage_generation/) });
      expect(client.fetch).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    });

    it.each([3, 4])('rejects mailbox drift during awaited source fence %s', async fence => {
      const { source, client, release } = await prepare();
      const original = identityService.assertExpectedSource;
      let calls = 0;
      vi.spyOn(identityService, 'assertExpectedSource').mockImplementation(async (...args) => {
        const result = await original(...args);
        if (++calls === fence - 1) client.mailbox.uidValidity = 11n;
        return result;
      });
      await expect(read(source)).rejects.toMatchObject({ code: 'identity_epoch_changed' });
      expect(client.fetch).toHaveBeenCalledTimes(fence === 3 ? 0 : 1);
      expect(release).toHaveBeenCalledOnce();
    });

    it.each([
      ['bare root', '1', { type: 'application/pdf', disposition: 'attachment', encoding: 'base64' }, Buffer.from('JVBERi1yb290'), Buffer.from('%PDF-root')],
      ['attached message', '2', { type: 'message/rfc822', part: '2', disposition: 'attachment', childNodes: [{ part: '2.1', type: 'text/plain' }] }, Buffer.from('Subject: original\r\n\r\nMessage'), Buffer.from('Subject: original\r\n\r\nMessage')],
      ['quoted printable', '2', { type: 'application/octet-stream', part: '2', disposition: 'attachment', encoding: 'quoted-printable' }, Buffer.from('hello=20world=00'), Buffer.from('hello world\0')],
    ])('preserves %s part addressing and MIME decoding', async (_kind, part, structure, encoded, decoded) => {
      const { source, client, release } = await prepare();
      client.fetch.mockImplementation(async function* () { yield { uid: 1, bodyStructure: structure, bodyParts: new Map([[part, encoded]]) }; });
      const result = _name === 'single'
        ? await ImapManager.prototype.fetchAttachment.call({}, account, 1, 'INBOX', part, { expectedSource: source })
        : await ImapManager.prototype.fetchMultipleAttachments.call({}, account, 1, 'INBOX', [{ part, encoding: 'base64' }], { expectedSource: source });
      expect(Buffer.isBuffer(result) ? result : result.get(part)).toEqual(decoded);
      expect(release).toHaveBeenCalledOnce();
    });

    it('returns a live Trash attachment without treating its folder as deletion', async () => {
      await sync('Trash', 10, [attachmentMessage()]);
      const source = await rowAt('Trash', 1);
      const client = clientFor('Trash', 10, [attachmentMessage()]);
      ImapFlow.mockImplementation(function () { return client; });
      const result = _name === 'single'
        ? await ImapManager.prototype.fetchAttachment.call({}, account, 1, 'Trash', '2', { expectedSource: source })
        : await ImapManager.prototype.fetchMultipleAttachments.call({}, account, 1, 'Trash', [{ part: '2' }], { expectedSource: source });
      expect(Buffer.isBuffer(result) ? result : result.get('2')).toEqual(Buffer.from('%PDF-original'));
    });

    it('rejects a UID returned for a different message', async () => {
      const { source, client, release } = await prepare();
      client.fetch.mockImplementation(async function* () { yield attachmentMessage(2); });
      await expect(read(source)).rejects.toMatchObject({ code: 'identity_source_changed' });
      expect(release).toHaveBeenCalledOnce();
    });

    it('does not trust bytes for a part absent from the live structure', async () => {
      const { source, client, release } = await prepare();
      client.fetch.mockImplementation(async function* () { yield { ...attachmentMessage(), bodyStructure: { part: '1', type: 'text/plain' } }; });
      await expect(read(source)).rejects.toMatchObject({ code: 'identity_attachment_changed' });
      expect(release).toHaveBeenCalledOnce();
    });

    it('rejects an old captured source after UID reuse before opening a connection', async () => {
      const { source, client } = await prepare();
      await observe('INBOX', 11);
      await sync('INBOX', 11, [attachmentMessage()]);
      await expect(read(source)).rejects.toMatchObject({ code: 'identity_source_changed' });
      expect(client.getMailboxLock).not.toHaveBeenCalled();
      expect(client.fetch).not.toHaveBeenCalled();
    });

    it('rejects an unverified legacy row without fetching', async () => {
      const { source, client } = await prepare();
      await h.pool.query('UPDATE messages SET entity_id=NULL,uid_validity=NULL,storage_generation=NULL WHERE id=$1', [source.id]);
      await expect(read(await rowAt('INBOX', 1))).rejects.toMatchObject({ code: 'identity_source_changed' });
      expect(client.fetch).not.toHaveBeenCalled();
    });

    it('rejects a connection left over from an old account generation', async () => {
      const { source, client } = await prepare();
      client.connect = async () => { client.mailflowStorageGeneration = 'old-generation'; };
      await expect(read(source)).rejects.toMatchObject({ code: 'storage_generation_conflict' });
      expect(client.fetch).not.toHaveBeenCalled();
    });

    it('freezes the supplied row before an asynchronous capture can mutate it', async () => {
      const { source, client, release } = await prepare();
      const result = read(source);
      source.uid = 2;
      await expect(result).resolves.toBeDefined();
      expect(client.fetch.mock.calls[0][0]).toBe('1');
      expect(release).toHaveBeenCalledOnce();
    });
  });
});
