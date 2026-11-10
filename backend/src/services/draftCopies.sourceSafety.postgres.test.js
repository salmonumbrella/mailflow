import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

const h = vi.hoisted(() => ({ pool: null, beforeQuery: null, providerDelete: vi.fn(), broadcast: vi.fn() }));
vi.mock('./db.js', () => ({
  pool: { connect: (...args) => h.pool.connect(...args) },
  query: async (...args) => {
    if (h.beforeQuery) await h.beforeQuery(...args);
    return h.pool.query(...args);
  },
  withTransaction: async run => {
    const client = await h.pool.connect();
    try { await client.query('BEGIN'); const value = await run(client); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  },
}));
vi.mock('../index.js', () => ({ imapManager: { permanentDeleteMessage: h.providerDelete,
  broadcast: h.broadcast, scheduleCountRefresh: vi.fn() } }));
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
import { findReplacedDraft, deleteSentDraft } from './draftCopies.js';

const databaseUrl = process.env.MAILFLOW_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('independent physical draft cleanup safety on PostgreSQL', () => {
  const dbName = `mailflow_draft_review_${randomBytes(5).toString('hex')}`;
  let admin, owner, stranger, account, otherAccount, original, source, client, release;
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
  const makeAccount = async name => (await h.pool.query(`INSERT INTO email_accounts
    (user_id,name,email_address,imap_host,auth_user,auth_pass,folder_mappings)
    VALUES ($1,$2,$3,'imap.example.test','synthetic','synthetic','{"drafts":"Drafts"}') RETURNING *`,
  [owner, name, `${name}@example.test`])).rows[0];
  const write = async ({ acct = account, uid = 7, epoch = 10, subject = 'Original draft' } = {}) => {
    const context = await identity.observeMailboxIdentity(await identity.readMailboxIdentity(acct, 'Drafts'),
      { mailbox: { path: 'Drafts', uidValidity: BigInt(epoch) }, capabilities: new Set(['UIDPLUS']) });
    await identity.writeObservedMessage(context, { uid }, tx => tx.query(`INSERT INTO messages
      (account_id,folder,uid,message_id,subject,from_email,date)
      VALUES ($1,'Drafts',$2,'<same-header@example.test>',$3,'me@example.test','2026-11-01T00:00:00Z') RETURNING *`,
    [acct.id, uid, subject]));
    return (await h.pool.query('SELECT * FROM messages WHERE account_id=$1 AND folder=\'Drafts\' AND uid=$2', [acct.id, uid])).rows[0];
  };
  const wire = row => ({ messageId: row.id, accountId: row.account_id, storageGeneration: row.storage_generation,
    entityId: row.entity_id, folder: row.folder, uidValidity: String(row.uid_validity), uid: String(row.uid) });
  const input = (proof = source) => ({ existingUid: 7, existingFolder: 'Drafts', existingAccountId: account.id, existingSource: proof });
  const sent = (proof = source) => ({ uid: 7, folder: 'Drafts', accountId: account.id, source: proof });
  const lookup = (proof = source, from = account) => findReplacedDraft(owner, from, 'Drafts', input(proof));
  const rows = async () => (await h.pool.query('SELECT * FROM messages ORDER BY uid')).rows;
  const assertNoProviderMutation = () => {
    expect(client.messageDelete).not.toHaveBeenCalled(); expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    expect(client.mailboxClose).not.toHaveBeenCalled();
  };
  beforeEach(async () => {
    h.beforeQuery = null; h.broadcast.mockClear(); h.providerDelete.mockReset();
    await h.pool.query('TRUNCATE users CASCADE');
    owner = (await h.pool.query("INSERT INTO users(username) VALUES ('draft-owner') RETURNING id")).rows[0].id;
    stranger = (await h.pool.query("INSERT INTO users(username) VALUES ('draft-stranger') RETURNING id")).rows[0].id;
    account = await makeAccount('holder'); otherAccount = await makeAccount('new-from');
    original = await write(); source = wire(original); release = vi.fn();
    client = Object.assign(new EventEmitter(), {
      mailbox: { path: 'Drafts', uidValidity: 10n }, capabilities: new Set(['UIDPLUS']),
      connect: vi.fn(async () => {}), close() {}, logout: async () => {}, noop: vi.fn(async () => true),
      getMailboxLock: vi.fn(async () => ({ release })),
      fetch: vi.fn(async function* () { yield { uid: 7, envelope: { messageId: '<same-header@example.test>',
        subject: 'Original draft', from: [{ address: 'me@example.test' }] }, internalDate: new Date('2026-11-01T00:00:00Z') }; }),
      messageDelete: vi.fn(async () => true), messageFlagsAdd: vi.fn(async () => true), messageFlagsRemove: vi.fn(async () => true), mailboxClose: vi.fn(async () => true),
      search: vi.fn(async () => []),
    });
    ImapFlow.mockReset().mockImplementation(function () { return client; });
    h.providerDelete.mockImplementation((...args) => ImapManager.prototype.permanentDeleteMessage.call({}, ...args));
  });
  afterEach(() => { vi.restoreAllMocks(); h.beforeQuery = null; if (account) evictPool(account.id); if (otherAccount) evictPool(otherAccount.id); });

  it('deletes a positively verified original only, retaining a same-header sibling', async () => {
    const sibling = await write({ uid: 8 });
    expect(await deleteSentDraft(owner, account, sent())).toBe(true);
    expect(client.messageDelete).toHaveBeenCalledExactlyOnceWith('7', { uid: true });
    expect(await rows()).toMatchObject([{ id: sibling.id, uid: '8' }]);
  });

  it('keeps cleanup with the old holder when From changes to another owned account', async () => {
    const other = await write({ acct: otherAccount });
    expect(await deleteSentDraft(owner, otherAccount, sent())).toBe(true);
    expect(h.providerDelete.mock.calls[0][0].id).toBe(account.id);
    expect(await rows()).toMatchObject([{ id: other.id, account_id: otherAccount.id }]);
  });

  it.each(['missing', 'partial', 'array', 'rfc-id', 'extra', 'uid-number', 'noncanonical-epoch'])('does not upgrade %s proof from the current locator', async invalid => {
    const proof = invalid === 'missing' ? null : invalid === 'partial' ? { messageId: original.id }
      : invalid === 'array' ? [] : invalid === 'rfc-id' ? { ...source, messageId: original.message_id }
        : invalid === 'extra' ? { ...source, extra: true } : invalid === 'uid-number' ? { ...source, uid: 7 }
          : { ...source, uidValidity: '010' };
    expect(await lookup(proof)).toBeNull();
    expect(await deleteSentDraft(owner, account, sent(proof))).toBe(false);
    expect(h.providerDelete).not.toHaveBeenCalled(); expect(client.fetch).not.toHaveBeenCalled(); assertNoProviderMutation();
    expect(await rows()).toMatchObject([{ id: original.id }]);
  });

  it.each(['owner', 'disabled', 'generation', 'epoch', 'soft-deleted', 'missing-location', 'entity', 'row', 'account'])('refuses stale %s state before a provider connection', async change => {
    if (change === 'owner') await h.pool.query('UPDATE email_accounts SET user_id=$1 WHERE id=$2', [stranger, account.id]);
    if (change === 'disabled') await h.pool.query('UPDATE email_accounts SET enabled=false WHERE id=$1', [account.id]);
    if (change === 'generation') await h.pool.query('UPDATE email_accounts SET storage_generation=$1 WHERE id=$2', [randomUUID(), account.id]);
    if (change === 'epoch') await h.pool.query('UPDATE mailbox_identity_epochs SET uid_validity=11 WHERE account_id=$1', [account.id]);
    if (change === 'soft-deleted') await h.pool.query('UPDATE messages SET is_deleted=true WHERE id=$1', [original.id]);
    if (change === 'missing-location') await h.pool.query("UPDATE entity_locations SET status='missing' WHERE entity_id=$1", [original.entity_id]);
    if (change === 'entity') {
      const sibling = await write({ uid: 8 });
      await h.pool.query('UPDATE messages SET entity_id=NULL,storage_generation=NULL,uid_validity=NULL WHERE id=$1', [original.id]);
      await h.pool.query('UPDATE entity_locations SET entity_id=$1 WHERE uid=7 AND account_id=$2', [sibling.entity_id, account.id]);
      await h.pool.query('UPDATE messages SET entity_id=$1,storage_generation=$2,uid_validity=10 WHERE id=$3', [sibling.entity_id, account.storage_generation, original.id]);
    }
    if (change === 'row') await h.pool.query('DELETE FROM messages WHERE id=$1', [original.id]);
    if (change === 'account') await h.pool.query('DELETE FROM email_accounts WHERE id=$1', [account.id]);
    expect(await lookup()).toBeNull();
    await deleteSentDraft(owner, account, sent());
    expect(h.providerDelete).not.toHaveBeenCalled(); expect(client.fetch).not.toHaveBeenCalled(); assertNoProviderMutation();
  });

  it.each([false, true])('never adopts a same-header replacement after synced reset (same UUID: %s)', async sameId => {
    const replacement = await write({ epoch: 11, subject: 'Replacement draft' });
    if (sameId) await h.pool.query('UPDATE messages SET id=$1 WHERE id=$2', [original.id, replacement.id]);
    client.mailbox.uidValidity = 11n;
    expect(await lookup()).toBeNull();
    await deleteSentDraft(owner, account, sent());
    expect(h.providerDelete).not.toHaveBeenCalled(); expect(client.fetch).not.toHaveBeenCalled(); assertNoProviderMutation();
    expect(await rows()).toMatchObject([{ uid_validity: '11', subject: 'Replacement draft' }]);
  });

  it.each(['uid', 'folder', 'account'])('rejects inconsistent legacy %s instead of changing the proof target', async field => {
    const value = input();
    if (field === 'uid') value.existingUid = 8;
    if (field === 'folder') value.existingFolder = 'INBOX';
    if (field === 'account') value.existingAccountId = otherAccount.id;
    expect(await findReplacedDraft(owner, account, 'Drafts', value)).toBeNull();
    expect(client.fetch).not.toHaveBeenCalled(); assertNoProviderMutation();
  });

  it.each(['owner', 'disabled', 'epoch'])('rechecks %s changed while obtaining the mailbox lock', async change => {
    client.getMailboxLock.mockImplementation(async () => {
      if (change === 'owner') await h.pool.query('UPDATE email_accounts SET user_id=$1 WHERE id=$2', [stranger, account.id]);
      if (change === 'disabled') await h.pool.query('UPDATE email_accounts SET enabled=false WHERE id=$1', [account.id]);
      if (change === 'epoch') client.mailbox.uidValidity = 11n;
      return { release };
    });
    expect(await deleteSentDraft(owner, account, sent())).toBe(false);
    assertNoProviderMutation(); expect(client.fetch).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
  });

  it.each(['owner', 'disabled', 'generation', 'epoch'])('rechecks late %s after provider envelope read', async change => {
    const fetch = client.fetch.getMockImplementation();
    client.fetch.mockImplementation(async function* (...args) {
      yield* fetch(...args);
      if (change === 'owner') await h.pool.query('UPDATE email_accounts SET user_id=$1 WHERE id=$2', [stranger, account.id]);
      if (change === 'disabled') await h.pool.query('UPDATE email_accounts SET enabled=false WHERE id=$1', [account.id]);
      if (change === 'generation') await h.pool.query('UPDATE email_accounts SET storage_generation=$1 WHERE id=$2', [randomUUID(), account.id]);
      if (change === 'epoch') client.mailbox.uidValidity = 11n;
    });
    expect(await deleteSentDraft(owner, account, sent())).toBe(false);
    assertNoProviderMutation(); expect(client.fetch).toHaveBeenCalledOnce();
    expect(await rows()).toHaveLength(1);
  });

  it.each([[1, 'path'], [2, 'path'], [3, 'path'], [1, 'epoch'], [2, 'epoch'], [3, 'epoch'],
    [1, 'session'], [2, 'session'], [3, 'session']])('rejects selected %s fence drift (%s) after the final awaited source check', async (fence, change) => {
    const realCheck = identity.assertExpectedSource;
    let calls = 0;
    vi.spyOn(identity, 'assertExpectedSource').mockImplementation(async (...args) => {
      const result = await realCheck(...args);
      if (client.getMailboxLock.mock.calls.length && ++calls === fence) {
        if (change === 'path') client.mailbox.path = 'INBOX';
        if (change === 'epoch') client.mailbox.uidValidity = 11n;
        if (change === 'session') client.mailflowStorageGeneration = randomUUID();
      }
      return result;
    });
    expect(await deleteSentDraft(owner, account, sent())).toBe(false);
    expect(calls).toBeGreaterThanOrEqual(fence); assertNoProviderMutation();
    if (fence === 1) expect(client.fetch).not.toHaveBeenCalled();
    expect(await rows()).toMatchObject([{ id: original.id }]);
  });

  it.each([false, true])('preserves the newer database row arriving after provider acknowledgment (same UUID: %s)', async sameId => {
    client.messageDelete.mockImplementation(async () => {
      const replacement = await write({ epoch: 11, subject: 'New copy after acknowledgment' });
      if (sameId) await h.pool.query('UPDATE messages SET id=$1 WHERE id=$2', [original.id, replacement.id]);
      return true;
    });
    await deleteSentDraft(owner, account, sent());
    expect(client.messageDelete).toHaveBeenCalledExactlyOnceWith('7', { uid: true });
    expect(await rows()).toMatchObject([{ uid_validity: '11', subject: 'New copy after acknowledgment' }]);
  });

  it('does not retry an unknown provider result or delete the local original', async () => {
    client.messageDelete.mockRejectedValue(new Error('connection dropped after write'));
    expect(await deleteSentDraft(owner, account, sent())).toBe(false);
    expect(client.messageDelete).toHaveBeenCalledOnce(); expect(await rows()).toMatchObject([{ id: original.id }]);
  });

  it.each(['owner', 'disabled', 'epoch', 'path', 'session'])('does not EXPUNGE when %s changes while the original STORE is awaited', async change => {
    client.messageFlagsAdd.mockImplementation(async () => {
      if (change === 'owner') await h.pool.query('UPDATE email_accounts SET user_id=$1 WHERE id=$2', [stranger, account.id]);
      if (change === 'disabled') await h.pool.query('UPDATE email_accounts SET enabled=false WHERE id=$1', [account.id]);
      if (change === 'epoch') client.mailbox.uidValidity = 11n;
      if (change === 'path') client.mailbox.path = 'INBOX';
      if (change === 'session') client.mailflowStorageGeneration = randomUUID();
      return true;
    });
    expect(await deleteSentDraft(owner, account, sent())).toBe(false);
    expect(client.messageFlagsAdd).toHaveBeenCalledExactlyOnceWith('7', ['\\Deleted'], { uid: true });
    expect(client.messageDelete).not.toHaveBeenCalled();
    expect(await rows()).toMatchObject([{ id: original.id }]);
  });

  it('preserves unrelated deleted flags during verified non-UIDPLUS cleanup', async () => {
    client.capabilities = new Set();
    client.search.mockImplementation(async query => query.deleted ? [7, 8] : [7]);
    expect(await deleteSentDraft(owner, account, sent())).toBe(true);
    expect(client.messageFlagsRemove).toHaveBeenCalledExactlyOnceWith('8', ['\\Deleted'], { uid: true });
    expect(client.messageDelete).toHaveBeenCalledExactlyOnceWith('7', { uid: true });
    expect(client.messageFlagsAdd.mock.calls).toEqual([['7', ['\\Deleted'], { uid: true }], ['8', ['\\Deleted'], { uid: true }]]);
  });

  it('does not STORE, EXPUNGE or restore other flags in a changed non-UIDPLUS mailbox', async () => {
    client.capabilities = new Set();
    client.search.mockImplementation(async query => query.deleted ? [7, 8] : [7]);
    client.messageFlagsRemove.mockImplementation(async () => { client.mailbox.uidValidity = 11n; return true; });
    expect(await deleteSentDraft(owner, account, sent())).toBe(false);
    expect(client.messageFlagsRemove).toHaveBeenCalledExactlyOnceWith('8', ['\\Deleted'], { uid: true });
    assertNoProviderMutation(); expect(await rows()).toMatchObject([{ id: original.id }]);
  });

  it('keeps acknowledged deletion successful when the exact local cleanup transaction fails', async () => {
    vi.spyOn(identity, 'withMailboxIdentity').mockRejectedValue(new Error('Synthetic cache write unavailable'));
    expect(await deleteSentDraft(owner, account, sent())).toBe(true);
    expect(client.messageDelete).toHaveBeenCalledExactlyOnceWith('7', { uid: true });
    expect(await rows()).toMatchObject([{ id: original.id }]);
  });

  it('returns the APPEND-bound row receipt, not a later locator lookup, and permits its next cleanup', async () => {
    client.append = vi.fn(async () => ({ uid: 9, uidValidity: 10n }));
    const appended = await ImapManager.prototype.appendToFolder.call({}, account, 'Drafts', Buffer.from('Synthetic new draft'));
    const persisted = await ImapManager.prototype.upsertDraftMessageRecord.call({}, account, 'Drafts', appended.uid, {
      identityContext: appended.identityContext, messageId: '<new@example.test>', subject: 'New draft', bodyText: 'New content',
    });
    expect(persisted).toMatchObject({ account_id: account.id, uid: '9', folder: 'Drafts',
      storage_generation: account.storage_generation, uid_validity: '10', entity_id: expect.any(String), id: expect.any(String) });
    expect(persisted.id).not.toBe(original.id); expect(persisted.entity_id).not.toBe(original.entity_id);
    expect((await h.pool.query("SELECT state,destination_entity_id,destination_locator FROM mail_identity_operations WHERE operation_type='append'")).rows)
      .toEqual([{ state: 'bound', destination_entity_id: persisted.entity_id,
        destination_locator: { folder: 'Drafts', uidValidity: '10', uid: '9' } }]);
    const actual = (await h.pool.query('SELECT * FROM messages WHERE id=$1', [persisted.id])).rows[0];
    expect(wire(persisted)).toEqual(wire(actual));
    client.fetch.mockImplementation(async function* () { yield { uid: 9, envelope: { messageId: '<new@example.test>' } }; });
    expect(await deleteSentDraft(owner, account, { uid: 9, folder: 'Drafts', accountId: account.id, source: wire(persisted) })).toBe(true);
    expect(client.messageDelete).toHaveBeenCalledExactlyOnceWith('9', { uid: true });
    expect(client.append).toHaveBeenCalledOnce(); expect(await rows()).toMatchObject([{ id: original.id }]);
  });

  it.each(['missing-uid', 'missing-epoch', 'reset-during-append'])('cannot turn %s acknowledgment into a usable new draft receipt', async outcome => {
    client.append = vi.fn(async () => {
      if (outcome === 'missing-uid') return { uidValidity: 10n };
      if (outcome === 'missing-epoch') return { uid: 9 };
      await write({ epoch: 11, uid: 9, subject: 'New epoch copy' });
      return { uid: 9, uidValidity: 10n };
    });
    const appended = await ImapManager.prototype.appendToFolder.call({}, account, 'Drafts', Buffer.from('Synthetic draft'));
    expect(appended.identityContext).toBeNull();
    const persisted = appended.uid == null ? null : await ImapManager.prototype.upsertDraftMessageRecord.call({}, account, 'Drafts', appended.uid, {
      identityContext: appended.identityContext, messageId: '<new@example.test>', subject: 'Unverified draft',
    });
    expect(persisted).toBeNull(); expect(client.append).toHaveBeenCalledOnce(); assertNoProviderMutation();
    if (outcome === 'reset-during-append') expect(await rows()).toMatchObject([{ uid_validity: '11', subject: 'New epoch copy' }]);
  });

  it.each(['epoch', 'generation', 'owner'])('rejects APPEND receipt persistence after delayed %s drift without changing the replacement', async change => {
    client.append = vi.fn(async () => ({ uid: 9, uidValidity: 10n }));
    const appended = await ImapManager.prototype.appendToFolder.call({}, account, 'Drafts', Buffer.from('Synthetic draft'));
    const proof = { ...appended.identityContext, expectedOwnerId: owner };
    if (change === 'epoch') await write({ epoch: 11, uid: 9, subject: 'New epoch copy' });
    if (change === 'generation') await h.pool.query('UPDATE email_accounts SET storage_generation=$1 WHERE id=$2', [randomUUID(), account.id]);
    if (change === 'owner') await h.pool.query('UPDATE email_accounts SET user_id=$1 WHERE id=$2', [stranger, account.id]);
    const before = await rows();
    await expect(ImapManager.prototype.upsertDraftMessageRecord.call({}, account, 'Drafts', appended.uid, {
      identityContext: proof, messageId: '<new@example.test>', subject: 'Do not write this old APPEND',
    })).rejects.toMatchObject({ code: expect.stringMatching(/identity_|storage_generation/) });
    expect(await rows()).toEqual(before); expect(client.append).toHaveBeenCalledOnce(); assertNoProviderMutation();
  });

  it('does not retry an uncertain APPEND or grant a receipt from an existing local row', async () => {
    client.append = vi.fn(async () => { throw new Error('socket closed after APPEND write'); });
    await expect(ImapManager.prototype.appendToFolder.call({}, account, 'Drafts', Buffer.from('Synthetic draft')))
      .rejects.toThrow('socket closed after APPEND write');
    expect(client.append).toHaveBeenCalledOnce(); expect(await rows()).toMatchObject([{ id: original.id }]);
    expect((await h.pool.query("SELECT state FROM mail_identity_operations WHERE operation_type='append'")).rows)
      .toEqual([{ state: 'outcome_unknown' }]);
    assertNoProviderMutation();
  });
});
