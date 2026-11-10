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
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn(async () => {}) }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: async () => ({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null }), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: async () => ({ allowPrivateHosts: true, allowInsecureTls: true }) }));
vi.mock('./mailAccess.js', () => ({ getAccountAddresses: vi.fn(async () => []) }));
import { ImapFlow } from 'imapflow';
import { runMigrations } from './migrations.js';
import { ImapManager, evictPool, runIdentityCommand } from './imapManager.js';
import { readMailboxIdentity, observeMailboxIdentity, prepareIdentityOperations,
  applyStorageIdentityDecision, writeObservedMessage, getIdentityStatus, completeIdentityOperations } from './messageIdentity.js';
import { withTransaction } from './db.js';
import { observeFolder } from './folderStatus.js';
import { listMessages } from './messageService.js';

const databaseUrl = process.env.MAILFLOW_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('real engine cache and durable identity transactions', () => {
  const dbName = `mailflow_engine_identity_${randomBytes(5).toString('hex')}`;
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
  afterEach(() => { if (account) evictPool(account.id); });
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
    prefetchNewMessageBodies: vi.fn(async () => {}), upsertAutoContacts: vi.fn(async () => {}),
    _applyFlagUpdates: async () => 0, backfillRunning: new Set(), _secondaryConnectBlocked: () => null,
    _noteSecondaryRefusal: vi.fn(), _bgConnSem: { acquire: async () => {}, release() {} }, backfillMessages: vi.fn() });
  const sync = async (folder, epoch, messages, capabilities = []) => {
    await ImapManager.prototype.syncMessages.call(manager(), account, clientFor(folder, epoch, messages, capabilities), folder, 50, false, true);
  };


  it.each(['epoch', 'generation'])('review: old delta flag scan cannot write into a changed %s', async change => {
    await sync('Archive', 10, [raw(1)]);
    await h.pool.query("UPDATE folders SET highest_modseq=10 WHERE account_id=$1 AND path='Archive'", [account.id]);
    const client = clientFor('Archive', 10, [raw(1)], ['CONDSTORE']);
    client.mailbox.highestModseq = 20n;
    let changed = false;
    client.fetch = async function* (_range, query) {
      if (query.envelope) return;
      changed = true;
      if (change === 'generation') {
        const decision = await withTransaction(tx => applyStorageIdentityDecision(tx, {
          accountId: account.id, expectedGeneration: account.storage_generation, decision: 'replace' }));
        account = { ...account, storage_generation: decision.storageGeneration };
      }
      const current = await observe('Archive', 11);
      await writeObservedMessage(current, { uid: 1 }, tx => tx.query(
        "INSERT INTO messages(account_id,folder,uid,subject,is_read,is_starred) VALUES ($1,'Archive',1,'New delivery',false,false) RETURNING *", [account.id]));
      await h.pool.query("UPDATE folders SET highest_modseq=3 WHERE account_id=$1 AND path='Archive'", [account.id]);
      yield { uid: 1, flags: new Set(['\\Seen', '\\Flagged']) };
    };
    const mgr = { ...manager(), _applyFlagUpdates: ImapManager.prototype._applyFlagUpdates };
    const oldAccount = account;
    await ImapManager.prototype.syncMessages.call(mgr, oldAccount, client, 'Archive', 50, false, true).catch(err => {
      if (!['identity_epoch_changed', 'storage_generation_conflict'].includes(err.code)) throw err;
    });
    expect(changed).toBe(true);
    const current = await rowAt('Archive', 1);
    expect(current.uid_validity).toBe('11');
    expect(current.is_read).toBe(false);
    expect(current.is_starred).toBe(false);
    expect((await h.pool.query("SELECT highest_modseq FROM folders WHERE account_id=$1 AND path='Archive'", [account.id])).rows[0].highest_modseq).toBe('3');
  });

  it('review: stale reconciliation must not delete current-epoch cache', async () => {
    await sync('Archive', 10, [raw(1)]);
    await sync('Archive', 11, [raw(2)]);
    const client = clientFor('Archive', 10, []);
    ImapFlow.mockImplementation(function () { return client; });
    const mgr = { ...manager(), _isMoveUidGuarded: () => false };
    await ImapManager.prototype.reconcileDeletes.call(mgr, account);
    expect(await rowAt('Archive', 2)).toMatchObject({ uid_validity: '11' });
  });

  it('review: LIST from replaced account must not prune new-account folders/messages', async () => {
    const oldAccount = account;
    const client = { list: async () => {
      const decision = await withTransaction(tx => applyStorageIdentityDecision(tx, {
        accountId: account.id, expectedGeneration: account.storage_generation, decision: 'replace' }));
      account = { ...account, storage_generation: decision.storageGeneration };
      await sync('New mailbox folder', 10, [raw(1)]);
      return [{ path: 'Old mailbox folder', name: 'Old mailbox folder', delimiter: '/', flags: new Set() }];
    } };
    await ImapManager.prototype.syncFolders.call(manager(), oldAccount, client);
    expect(await rowAt('New mailbox folder', 1)).toBeDefined();
    expect((await h.pool.query("SELECT path FROM folders WHERE account_id=$1 AND path='New mailbox folder'", [account.id])).rows).toHaveLength(1);
  });

  it('review: post-provider validation database failure preserves acknowledged COPY', async () => {
    await sync('Archive', 10, [raw(1)]);
    const context = await observe('Archive');
    const operations = await prepareIdentityOperations(context, 'Copy', [1], 'copy');
    const result = { uidMap: new Map([[1, 9]]), uidValidity: 20n };
    const command = vi.fn(async () => result);
    const validationDatabaseFailure = () => h.pool.query('SELECT 1 / 0');
    await expect(runIdentityCommand(operations, command, validationDatabaseFailure))
      .resolves.toMatchObject({ result, identityPending: true });
    expect(command).toHaveBeenCalledOnce();
  });

  it('review: fresh account object cannot certify FETCH from a prior-generation connection', async () => {
    const oldGeneration = account.storage_generation;
    const decision = await withTransaction(tx => applyStorageIdentityDecision(tx, {
      accountId: account.id, expectedGeneration: oldGeneration, decision: 'replace' }));
    account = { ...account, storage_generation: decision.storageGeneration };
    const client = clientFor('Archive', 10, [raw(1)]);
    client.mailflowStorageGeneration = oldGeneration;
    await ImapManager.prototype.syncMessages.call(manager(), account, client, 'Archive', 50, false, true).catch(err => {
      if (err.code !== 'storage_generation_conflict') throw err;
    });
    expect(await rowAt('Archive', 1)).toBeUndefined();
    expect((await h.pool.query('SELECT count(*) FROM message_entities WHERE storage_generation=$1', [decision.storageGeneration])).rows[0].count).toBe('0');
  });

  it.each(['success', 'error'])('review: old-generation STATUS %s cannot overwrite replacement counters', async outcome => {
    await sync('Archive', 10, [raw(1)]);
    const client = { mailflowStorageGeneration: account.storage_generation, status: async () => {
      const decision = await withTransaction(tx => applyStorageIdentityDecision(tx, {
        accountId: account.id, expectedGeneration: account.storage_generation, decision: 'replace' }));
      account = { ...account, storage_generation: decision.storageGeneration };
      await sync('Archive', 10, [raw(1)]);
      if (outcome === 'error') throw new Error('Old provider unavailable');
      return { messages: 999, unseen: 888, uidNext: 1000, uidValidity: 10n, highestModseq: 123n };
    } };
    await expect(observeFolder(client, account.id, 'Archive')).rejects.toMatchObject({ code: 'storage_generation_conflict' });
    const row = (await h.pool.query("SELECT server_total_count,status_error FROM folders WHERE account_id=$1 AND path='Archive'", [account.id])).rows[0];
    expect(row.server_total_count).toBeNull();
    expect(row.status_error).toBeNull();
  });

  it('review: old snippet batch cannot mark a replacement delivery permanently attempted', async () => {
    await sync('Archive', 10, [raw(1)]);
    const oldAccount = account;
    const client = clientFor('Archive', 10, [raw(1)]);
    client.fetch = async function* () {
      const decision = await withTransaction(tx => applyStorageIdentityDecision(tx, {
        accountId: account.id, expectedGeneration: account.storage_generation, decision: 'replace' }));
      account = { ...account, storage_generation: decision.storageGeneration };
      await sync('Archive', 10, [raw(1)]);
      // The old server did not return its requested UID. A no-op loop keeps this
      // a protocol-shaped async iterable without fabricating a message response.
      for (const message of []) yield message;
    };
    ImapFlow.mockImplementation(function () { return client; });
    const mgr = { ...manager(), snippetIndexerRunning: new Set(), snippetBackoff: new Map(),
      snippetStructureFirst: new Set(), lastUserActivity: new Map() };
    await ImapManager.prototype.startSnippetIndexer.call(mgr, oldAccount);
    expect((await rowAt('Archive', 1)).snippet_attempted_at).toBeNull();
  });

  it('review: MOVE must not return stale destination coordinates after a concurrent destination reset', async () => {
    await sync('Archive', 10, [raw(1)]);
    await observe('Moved', 20);
    const client = clientFor('Archive', 10, [raw(1)], ['MOVE', 'UIDPLUS']);
    client.messageMove = vi.fn(async () => {
      // The successful move response names epoch 20, but another connection has
      // already observed the destination being rebuilt as epoch 21.
      await observe('Moved', 21);
      return { uidMap: new Map([[1, 9]]), uidValidity: 20n };
    });
    ImapFlow.mockImplementation(function () { return client; });
    const destinationUid = await ImapManager.prototype.moveMessage.call({}, account, 1, 'Archive', 'Moved');
    expect(destinationUid).toBeNull();
    expect(client.messageMove).toHaveBeenCalledOnce();
    expect((await h.pool.query('SELECT state,evidence FROM mail_identity_operations')).rows[0]).toMatchObject({
      state: 'unresolved', evidence: { reason: 'destination_epoch_changed' } });
  });

  it('review: APPEND success does not expose a destination UID from a superseded epoch', async () => {
    await observe('Drafts', 20);
    const client = clientFor('Drafts', 20, []);
    client.append = vi.fn(async () => {
      await observe('Drafts', 21);
      return { uid: 9, uidValidity: 20n };
    });
    ImapFlow.mockImplementation(function () { return client; });
    await expect(ImapManager.prototype.appendToFolder.call({}, account, 'Drafts', Buffer.from('Synthetic draft')))
      .resolves.toMatchObject({ uid: null, identityContext: null });
    expect(client.append).toHaveBeenCalledOnce();
  });

  it('review: bulk MOVE retains success but drops stale destination UID mappings', async () => {
    await sync('Archive', 10, [raw(1)]);
    await observe('Moved', 20);
    const client = clientFor('Archive', 10, [raw(1)], ['MOVE', 'UIDPLUS']);
    client.messageMove = vi.fn(async () => {
      await observe('Moved', 21);
      return { uidMap: new Map([[1, 9]]), uidValidity: 20n };
    });
    ImapFlow.mockImplementation(function () { return client; });
    const mgr = { _reconcileMoveBySearch: vi.fn() };
    const result = await ImapManager.prototype.bulkMoveMessages.call(mgr, account, [1], 'Archive', 'Moved');
    expect(result).toMatchObject({ succeeded: [1], failed: [], identityPending: true });
    expect(result.uidMap.size).toBe(0);
    expect(client.messageMove).toHaveBeenCalledOnce();
    expect(mgr._reconcileMoveBySearch).not.toHaveBeenCalled();
  });

  it('review: replacement holds old snoozes without moving or suppressing matching new mail', async () => {
    await sync('Deferred', 10, [raw(1)]);
    const addSnooze = async (generation, due) => (await h.pool.query(`
      INSERT INTO snoozed_messages(user_id,account_id,storage_generation,message_id_header,original_folder,snoozed_folder,snooze_until,entity_id)
      VALUES ($1,$2,$3,'<same@example.test>','INBOX','Deferred',NOW() + $4::interval,
        (SELECT entity_id FROM messages WHERE account_id=$2 AND folder='Deferred' AND uid=1)) RETURNING *`,
    [account.user_id, account.id, generation, due])).rows[0];
    const old = await addSnooze(account.storage_generation, '-10 minutes');
    const mgr = { _wakingSnoozes: new Set(), moveMessage: vi.fn(),
      snoozedRows: ImapManager.prototype.snoozedRows, wakeSnoozed: ImapManager.prototype.wakeSnoozed };
    const [queuedOld] = await mgr.snoozedRows('sm.id=$1', [old.id]);
    expect(queuedOld).toBeDefined();
    const decision = await withTransaction(tx => applyStorageIdentityDecision(tx, {
      accountId: account.id, expectedGeneration: account.storage_generation, decision: 'replace' }));
    account = { ...account, storage_generation: decision.storageGeneration };
    await sync('Deferred', 10, [raw(1)]);

    expect(await mgr.snoozedRows('sm.id=$1', [old.id])).toEqual([]);
    expect(await mgr.wakeSnoozed(queuedOld)).toBe(false);
    await ImapManager.prototype._runSnoozeWakeup.call(mgr);
    expect(mgr.moveMessage).not.toHaveBeenCalled();
    expect((await h.pool.query('SELECT id FROM snoozed_messages WHERE id=$1', [old.id])).rows).toHaveLength(1);
    expect((await getIdentityStatus(account.id)).heldSnoozeCount).toBe('1');
    const hidden = await listMessages({ userId: account.user_id, folder: 'Snoozed' });
    expect(hidden.messages).toEqual([]);
    expect(hidden.total).toBe(0);

    const current = await addSnooze(account.storage_generation, '1 day');
    const live = await mgr.snoozedRows('sm.account_id=$1', [account.id]);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ snooze_id: current.id, storage_generation: account.storage_generation });
    const visible = await listMessages({ userId: account.user_id, folder: 'Snoozed' });
    expect(visible.messages).toHaveLength(1);
    expect(visible.total).toBe(1);
    expect(visible.messages[0].snooze_until).toEqual(current.snooze_until);
    await ImapManager.prototype._runSnoozeWakeup.call(mgr);
    expect(mgr.moveMessage).not.toHaveBeenCalled();
    expect((await h.pool.query('SELECT count(*) FROM snoozed_messages')).rows[0].count).toBe('2');
    expect((await getIdentityStatus(account.id)).heldSnoozeCount).toBe('1');
  });
  const snoozeManager = () => ({ ...manager(), _wakingSnoozes: new Set(),
    _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(), _enqueueFlagPush: vi.fn(),
    setFlag: vi.fn(async () => true), syncFolderOnDemand: vi.fn(async () => {}),
    snoozedRows: ImapManager.prototype.snoozedRows, wakeSnoozed: ImapManager.prototype.wakeSnoozed,
    moveMessage: vi.fn(async (_account, uid, folder, destination, { expectedSource }) => {
      const operations = await prepareIdentityOperations(await observe(folder), destination, [uid], 'move', { expectedSource });
      await completeIdentityOperations(operations, { uidMap: new Map([[Number(uid), 500]]), uidValidity: 20n });
      return 500;
    }),
  });
  const addEntitySnooze = async (row, entity = row.entity_id) => (await h.pool.query(`
    INSERT INTO snoozed_messages(user_id,account_id,storage_generation,entity_id,message_id_header,
      original_folder,snoozed_folder,snooze_until)
    VALUES ($1,$2,$3,$4,$5,'INBOX',$6,NOW()-interval '1 minute') RETURNING *`,
  [account.user_id, account.id, row.storage_generation, entity, row.message_id, row.folder])).rows[0];
  const queuedSnooze = async (mgr, uid = 1) => {
    const record = await addEntitySnooze(await rowAt('Deferred', uid));
    return (await mgr.snoozedRows('sm.id=$1', [record.id]))[0];
  };

  it('snooze: duplicate headers identify independent deliveries and NULL legacy stays held', async () => {
    await sync('Deferred', 10, [raw(1), raw(2)]);
    const mgr = snoozeManager(), first = await queuedSnooze(mgr), second = await queuedSnooze(mgr, 2);
    expect(first.entity_id).not.toBe(second.entity_id);
    await addEntitySnooze(first, null);
    expect(await mgr.snoozedRows('sm.account_id=$1', [account.id])).toHaveLength(2);
    expect((await getIdentityStatus(account.id)).heldSnoozeCount).toBe('1');
    expect(await mgr.wakeSnoozed(first)).toBe(true);
    expect(await rowAt('Deferred', 2)).toMatchObject({ entity_id: second.entity_id });
    expect((await mgr.snoozedRows('sm.account_id=$1', [account.id]))[0].snooze_id).toBe(second.snooze_id);
  });

  it('snooze: entity reference rejects cross-generation and duplicate intents', async () => {
    await sync('Deferred', 10, [raw(1)]);
    const row = await rowAt('Deferred', 1);
    await addEntitySnooze(row);
    await expect(addEntitySnooze(row)).rejects.toMatchObject({ code: '23505' });
    await expect(h.pool.query(`INSERT INTO snoozed_messages(user_id,account_id,storage_generation,entity_id,
      message_id_header,original_folder,snooze_until) VALUES ($1,$2,gen_random_uuid(),$3,'<same@example.test>','INBOX',NOW())`,
    [account.user_id, account.id, row.entity_id])).rejects.toMatchObject({ code: '23503' });
  });

  it('snooze: same-generation epoch reuse never transfers an old wake', async () => {
    await sync('Deferred', 10, [raw(1)]);
    const mgr = snoozeManager(), queued = await queuedSnooze(mgr);
    await sync('Deferred', 11, [raw(1)]);
    expect(await mgr.wakeSnoozed(queued)).toBe(false);
    await ImapManager.prototype._runSnoozeWakeup.call(mgr);
    expect(mgr.moveMessage).not.toHaveBeenCalled();
    expect(await rowAt('Deferred', 1)).not.toMatchObject({ entity_id: queued.entity_id });
    expect((await getIdentityStatus(account.id)).heldSnoozeCount).toBe('1');
    expect((await h.pool.query('SELECT id FROM snoozed_messages')).rows).toHaveLength(1);
  });

  it('snooze: queued work never adopts a new verified projection of the same entity', async () => {
    await sync('Deferred', 10, [raw(1, 'stable-entity')], ['OBJECTID']);
    const mgr = snoozeManager(), queued = await queuedSnooze(mgr);
    await sync('Deferred', 11, [raw(2, 'stable-entity')], ['OBJECTID']);
    const [current] = await mgr.snoozedRows('sm.account_id=$1', [account.id]);
    expect(current).toMatchObject({ entity_id: queued.entity_id, uid: '2', uid_validity: '11' });
    expect(await mgr.wakeSnoozed(queued)).toBe(false);
    expect(mgr.moveMessage).not.toHaveBeenCalled();
  });

  it('snooze: queued sweep observes a postponed deadline but manual wake is allowed', async () => {
    await sync('Deferred', 10, [raw(1)]);
    const mgr = snoozeManager(), queued = await queuedSnooze(mgr);
    await h.pool.query("UPDATE snoozed_messages SET snooze_until=NOW()+interval '1 day'");
    expect(await mgr.wakeSnoozed(queued, { onlyIfDue: true })).toBe(false);
    expect(mgr.moveMessage).not.toHaveBeenCalled();
    expect(await mgr.wakeSnoozed(queued, { markUnread: false })).toBe(true);
    expect(mgr.setFlag).not.toHaveBeenCalled();
  });

  it('snooze: proved MOVE preserves entity and marks only proved destination unread', async () => {
    await sync('INBOX', 20, []);
    await sync('Deferred', 10, [raw(1)]);
    const mgr = snoozeManager(), queued = await queuedSnooze(mgr);
    expect(await mgr.wakeSnoozed(queued)).toBe(true);
    const destination = await rowAt('INBOX', 500);
    expect(destination).toMatchObject({ entity_id: queued.entity_id, uid_validity: '20', is_read: false });
    expect(mgr.moveMessage).toHaveBeenCalledWith(expect.any(Object), queued.uid, 'Deferred', 'INBOX', { expectedSource: queued });
    expect(mgr.setFlag).toHaveBeenCalledWith(expect.any(Object), destination.uid, 'INBOX', '\\Seen', false,
      { expectedSource: expect.objectContaining({ entity_id: queued.entity_id, uid_validity: '20' }) });
    expect((await h.pool.query('SELECT id FROM snoozed_messages')).rows).toHaveLength(0);
    const counts = (await h.pool.query('SELECT path,total_count,unread_count FROM folders ORDER BY path')).rows;
    expect(counts.find(r => r.path === 'Deferred')).toMatchObject({ total_count: 0, unread_count: 0 });
    expect(counts.find(r => r.path === 'INBOX')).toMatchObject({ total_count: 1, unread_count: 1 });
  });

  it('snooze: destination sync first does not count an already unread message twice', async () => {
    await sync('Deferred', 10, [raw(1)]);
    const mgr = snoozeManager(), queued = await queuedSnooze(mgr);
    mgr.moveMessage.mockImplementation(async (_account, uid, folder, destination, { expectedSource }) => {
      const operations = await prepareIdentityOperations(await observe(folder), destination, [uid], 'move', { expectedSource });
      await sync(destination, 20, [{ ...raw(500), flags: new Set() }]);
      await completeIdentityOperations(operations, { uidMap: new Map([[Number(uid), 500]]), uidValidity: 20n });
      return 500;
    });
    expect(await mgr.wakeSnoozed(queued)).toBe(true);
    expect(await rowAt('INBOX', 500)).toMatchObject({ entity_id: queued.entity_id, is_read: false });
    expect((await h.pool.query("SELECT total_count,unread_count FROM folders WHERE path='INBOX'")).rows[0])
      .toEqual({ total_count: 1, unread_count: 1 });
  });

  it('snooze: acknowledged unmapped MOVE stays pending and never guesses unread or replays', async () => {
    await sync('Deferred', 10, [raw(1)]);
    const mgr = snoozeManager(), queued = await queuedSnooze(mgr);
    mgr.moveMessage.mockImplementation(async () => {
      const operations = await prepareIdentityOperations(await observe('Deferred'), 'INBOX', [1], 'move');
      await completeIdentityOperations(operations, true);
      return null;
    });
    expect(await mgr.wakeSnoozed(queued)).toBe(true);
    expect(mgr.setFlag).not.toHaveBeenCalled();
    expect(await rowAt('INBOX', 1)).toBeUndefined();
    expect((await h.pool.query('SELECT wake_state FROM snoozed_messages')).rows[0].wake_state).toBe('pending');
    await ImapManager.prototype._runSnoozeWakeup.call(mgr);
    expect(await mgr.wakeSnoozed(queued)).toBe(false);
    expect(mgr.moveMessage).toHaveBeenCalledOnce();
  });

  it.each(['cache', 'delete', 'flag', 'unknown'])('snooze: %s failure holds the claimed intent without MOVE replay', async failure => {
    await sync('Deferred', 10, [raw(1)]);
    const mgr = snoozeManager(), queued = await queuedSnooze(mgr);
    if (failure === 'unknown') mgr.moveMessage.mockRejectedValue(new Error('Connection lost after send'));
    if (failure === 'flag') mgr.setFlag.mockRejectedValue(new Error('STORE unavailable'));
    if (['cache', 'delete'].includes(failure)) {
      const table = failure === 'cache' ? 'messages' : 'snoozed_messages';
      const event = failure === 'cache' ? 'UPDATE' : 'DELETE';
      await h.pool.query(`CREATE FUNCTION reject_snooze_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Injected bookkeeping failure'; END $$;
        CREATE TRIGGER reject_snooze_write BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_snooze_write()`);
    }
    try {
      expect(await mgr.wakeSnoozed(queued)).toBe(failure !== 'unknown');
      expect((await h.pool.query('SELECT wake_state FROM snoozed_messages')).rows[0].wake_state).toBe('waking');
      await ImapManager.prototype._runSnoozeWakeup.call(mgr);
      expect(await mgr.wakeSnoozed(queued)).toBe(false);
      expect(mgr.moveMessage).toHaveBeenCalledOnce();
    } finally {
      if (['cache', 'delete'].includes(failure)) await h.pool.query('DROP FUNCTION reject_snooze_write() CASCADE');
    }
  });

});
