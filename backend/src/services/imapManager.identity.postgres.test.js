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
import { ImapManager, evictPool, insertCopiedSibling, runIdentityCommand, assertOperationIdentity } from './imapManager.js';
import { readMailboxIdentity, observeMailboxIdentity, prepareAppendIdentityOperation, prepareIdentityOperations,
  completeIdentityOperations, applyStorageIdentityDecision } from './messageIdentity.js';
import { withTransaction } from './db.js';
import * as identityService from './messageIdentity.js';
import { pluginRegistry } from '../plugins/registry.js';

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
    _applyFlagUpdates: async () => 0, backfillRunning: new Set(), _secondaryConnectBlocked: () => null,
    _noteSecondaryRefusal: vi.fn(), _bgConnSem: { acquire: async () => {}, release() {} }, backfillMessages: vi.fn() });
  const sync = async (folder, epoch, messages, capabilities = []) => {
    await ImapManager.prototype.syncMessages.call(manager(), account, clientFor(folder, epoch, messages, capabilities), folder, 50, false, true);
  };

  it('journals real APPEND before the provider command and passes exact epoch proof to the draft upsert', async () => {
    const client = clientFor('Drafts', 10, []);
    client.append = vi.fn(async () => {
      const pending = (await h.pool.query('SELECT * FROM mail_identity_operations')).rows;
      expect(pending).toHaveLength(1); expect(pending[0].state).toBe('prepared');
      expect(pending[0].operation_type).toBe('append');
      return { uid: 5, uidValidity: 10n };
    });
    ImapFlow.mockImplementation(function () { return client; });
    const result = await ImapManager.prototype.appendToFolder.call({}, account, 'Drafts', Buffer.from('Synthetic draft'));
    expect(result).toMatchObject({ uid: 5, folder: 'Drafts', identityContext: { uidValidity: '10' } });
    await ImapManager.prototype.upsertDraftMessageRecord.call({}, account, 'Drafts', result.uid,
      { subject: 'Saved', identityContext: result.identityContext });
    expect((await rowAt('Drafts', 5)).entity_id).toBeTruthy(); expect(client.append).toHaveBeenCalledOnce();
    expect((await h.pool.query('SELECT state FROM mail_identity_operations')).rows[0].state).toBe('bound');
  });

  it('keeps an APPEND without UIDVALIDITY unresolved instead of guessing the destination epoch', async () => {
    await observe('Drafts', 10);
    const client = clientFor('Drafts', 10, []);
    client.append = vi.fn(async () => ({ uid: 5 }));
    ImapFlow.mockImplementation(function () { return client; });
    const result = await ImapManager.prototype.appendToFolder.call({}, account, 'Drafts', Buffer.from('Synthetic draft'));
    expect(result.identityContext).toBeNull(); expect(result.uid).toBeNull();
    expect((await h.pool.query('SELECT state FROM mail_identity_operations')).rows[0].state).toBe('unresolved');
    expect(client.append).toHaveBeenCalledOnce();
  });

  it('binds actual engine MOVE proof without changing the existing destination UID contract', async () => {
    await sync('INBOX', 10, [raw(1)]); const before = await rowAt('INBOX', 1);
    const client = clientFor('INBOX', 10, [raw(1)], ['MOVE', 'UIDPLUS']);
    client.messageMove = vi.fn(async () => ({ uidMap: new Map([[1, 9]]), uidValidity: 20n }));
    ImapFlow.mockImplementation(function () { return client; });
    expect(await ImapManager.prototype.moveMessage.call({}, account, 1, 'INBOX', 'Moved')).toBe(9);
    const operation = (await h.pool.query('SELECT * FROM mail_identity_operations')).rows[0];
    expect(operation.state).toBe('bound'); expect(operation.destination_entity_id).toBe(before.entity_id);
    expect(client.messageMove).toHaveBeenCalledOnce();
  });

  it('binds exact negotiated stable IDs across folders while retaining authoritative size semantics', async () => {
    await sync('INBOX', 10, [raw(1, '900719925474099312345', 0)], ['X-GM-EXT-1']);
    await sync('Projection', 20, [raw(8, '900719925474099312345', 987)], ['X-GM-EXT-1']);
    const first = await rowAt('INBOX', 1), second = await rowAt('Projection', 8);
    expect(first.entity_id).toBeTruthy(); expect(second.entity_id).toBe(first.entity_id);
    expect(first.rfc822_size_bytes).toBe('0'); expect(second.rfc822_size_bytes).toBe('987');
    expect(first.uid_validity).toBe('10'); expect(second.uid_validity).toBe('20');
  });

  it('refetches unverified existing cache instead of certifying old bodies or merging Message-ID duplicates', async () => {
    await h.pool.query(`INSERT INTO messages(account_id,folder,uid,message_id,body_text,rfc822_size_bytes)
      VALUES ($1,'INBOX',1,'<same@example.test>','Unverified old body',999)`, [account.id]);
    await sync('INBOX', 10, [{ ...raw(1), size: undefined }, raw(2, undefined, 100)]);
    const first = await rowAt('INBOX', 1), second = await rowAt('INBOX', 2);
    expect(first.entity_id).toBeTruthy(); expect(second.entity_id).not.toBe(first.entity_id);
    expect(first.body_text).toBeNull();
    expect(first.rfc822_size_bytes).toBeNull();
  });

  it('binds direct Sent and draft rows only with exact APPEND proof and rejects stale callbacks', async () => {
    for (const [folder, method] of [['Sent', 'upsertSentMessageRecord'], ['Drafts', 'upsertDraftMessageRecord']]) {
      const op = await prepareAppendIdentityOperation(await readMailboxIdentity(account, folder));
      const [done] = await completeIdentityOperations([op], { uid: 5, uidValidity: 10n });
      await ImapManager.prototype[method].call({}, account, folder, 5,
        { subject: 'Saved', identityContext: done.destinationContext, rfc822SizeBytes: 888 });
      const saved = await rowAt(folder, 5);
      expect(saved.entity_id).toBe(done.entityId); expect(saved.rfc822_size_bytes).toBeNull();
      await observe(folder, 11);
      await expect(ImapManager.prototype[method].call({}, account, folder, 5,
        { subject: 'Late old save', identityContext: done.destinationContext })).rejects.toMatchObject({ code: 'identity_epoch_changed' });
      expect(await rowAt(folder, 5)).toBeUndefined();
    }
  });

  it('does not overwrite a bound row when an APPEND/search fallback has no verified epoch', async () => {
    await sync('Drafts', 10, [raw(5)]);
    const before = await rowAt('Drafts', 5);
    await ImapManager.prototype.upsertDraftMessageRecord.call({}, account, 'Drafts', 5,
      { messageId: '<same@example.test>', subject: 'Unverified replacement' });
    const after = await rowAt('Drafts', 5);
    expect(after.subject).toBe(before.subject); expect(after.entity_id).toBe(before.entity_id);
  });

  it('copies content/size from a verified source while keeping generic COPY entity independent', async () => {
    await sync('INBOX', 10, [raw(1, undefined, 456)]);
    const context = await observe('INBOX');
    const ops = await prepareIdentityOperations(context, 'Copy', [1], 'copy');
    const [done] = await completeIdentityOperations(ops, { uidMap: new Map([[1, 9]]), uidValidity: 20n });
    await insertCopiedSibling(account.id, 1, 'INBOX', 'Copy', 9, done.destinationContext, done);
    expect((await rowAt('Copy', 9)).entity_id).not.toBe((await rowAt('INBOX', 1)).entity_id);
    expect((await rowAt('Copy', 9)).rfc822_size_bytes).toBe('456');
  });

  it('rejects a delayed COPY cache fallback after the account storage generation changes', async () => {
    const oldGeneration = account.storage_generation;
    await withTransaction(tx => applyStorageIdentityDecision(tx, {
      accountId: account.id, expectedGeneration: oldGeneration, decision: 'replace' }));
    await h.pool.query("INSERT INTO messages(account_id,folder,uid,subject) VALUES ($1,'INBOX',1,'New mailbox delivery')", [account.id]);
    await expect(insertCopiedSibling(account.id, 1, 'INBOX', 'Copy', 9, null, null, oldGeneration))
      .rejects.toMatchObject({ code: 'storage_generation_conflict' });
    expect(await rowAt('Copy', 9)).toBeUndefined();
  });

  it('refuses to certify content copied out of an unverified source cache', async () => {
    await h.pool.query("INSERT INTO messages(account_id,folder,uid,body_text) VALUES ($1,'INBOX',1,'Unverified')", [account.id]);
    const context = await observe('INBOX');
    const ops = await prepareIdentityOperations(context, 'Copy', [1], 'copy');
    const [done] = await completeIdentityOperations(ops, { uidMap: new Map([[1, 9]]), uidValidity: 20n });
    expect(await insertCopiedSibling(account.id, 1, 'INBOX', 'Copy', 9, done.destinationContext, done)).toBeNull();
    expect(await rowAt('Copy', 9)).toBeUndefined();
  });

  it('stops an old backfill when another connection advances the durable mailbox epoch mid-FETCH', async () => {
    const client = clientFor('INBOX', 10, [raw(1)]);
    client.fetch = async function* () { await observe('INBOX', 11); yield raw(1); };
    ImapFlow.mockImplementation(function () { return client; });
    await ImapManager.prototype.backfillMessages.call(manager(), account, 'INBOX');
    expect(await rowAt('INBOX', 1)).toBeUndefined();
    expect((await h.pool.query("SELECT uid_validity FROM mailbox_identity_epochs WHERE account_id=$1 AND folder_path='INBOX'", [account.id])).rows[0].uid_validity).toBe('11');
  });

  it.each(['epoch', 'namespace', 'generation'])('journals uncertainty if source %s changes while the provider command is in flight', async change => {
    await sync('INBOX', 10, [raw(1)]);
    const context = await observe('INBOX');
    const client = clientFor('INBOX', 10, [raw(1)]);
    const operations = await prepareIdentityOperations(context, 'Moved', [1]);
    await expect(runIdentityCommand(operations, async () => {
      if (change === 'epoch') client.mailbox.uidValidity = 11n;
      if (change === 'namespace') client.capabilities.add('OBJECTID');
      if (change === 'generation') await withTransaction(tx => applyStorageIdentityDecision(tx, {
        accountId: account.id, expectedGeneration: account.storage_generation, decision: 'replace' }));
      return { uidMap: new Map([[1, 9]]), uidValidity: 20n };
    }, () => assertOperationIdentity(context, client))).resolves.toMatchObject({ identityPending: true, identityUnsafe: true, operations: [] });
    expect((await h.pool.query('SELECT state FROM mail_identity_operations WHERE id=$1', [operations[0].id])).rows[0].state).toBe(change === 'generation' ? 'unresolved' : 'outcome_unknown');
    expect((await h.pool.query("SELECT count(*) FROM entity_locations WHERE folder_path='Moved'")).rows[0].count).toBe('0');
  });
  const flagManager = client => ({
    _flagOpChains:new Map(), connections:new Map(client ? [[account.id,client]] : []),
    setFlag:ImapManager.prototype.setFlag,_setFlagInner:ImapManager.prototype._setFlagInner,
    _secondaryConnectBlocked:()=>false,
  });
  it.each(['persistent','pooled'])('revalidates a %s flag target after SELECT awaits a new epoch',async path=>{
    const folder=path==='persistent'?'INBOX':'Archive';
    await sync(folder,10,[raw(1)]);
    const source=await rowAt(folder,1), capturedAccount={...account};
    const client=clientFor(folder,10,[]);
    client.messageFlagsAdd=vi.fn(async()=>true);
    client.getMailboxLock=async()=>{
      await sync(folder,11,[raw(1)]);
      client.mailbox.uidValidity=11n;
      return {release(){}};
    };
    ImapFlow.mockImplementation(function(){return client;});
    const mgr=flagManager(path==='persistent'?client:null);
    await expect(mgr.setFlag(capturedAccount,1,folder,'\\Seen',true,{expectedSource:source})).rejects.toMatchObject({code:'identity_epoch_changed'});
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });
  it.each(['persistent','pooled'])('rejects a %s queued flag after account replacement',async path=>{
    const folder=path==='persistent'?'INBOX':'Archive';await sync(folder,10,[raw(1)]);
    const source=await rowAt(folder,1), capturedAccount={...account};
    const client=clientFor(folder,10,[]);client.messageFlagsAdd=vi.fn(async()=>true);
    ImapFlow.mockImplementation(function(){return client;});
    const mgr=flagManager(path==='persistent'?client:null);
    let release;mgr._flagOpChains.set(account.id,new Promise(resolve=>{release=resolve;}));
    const pending=mgr.setFlag(capturedAccount,1,folder,'\\Seen',true,{expectedSource:source});
    const outcome=pending.then(()=>({ok:true}),error=>({error}));
    const changed=await withTransaction(tx=>applyStorageIdentityDecision(tx,{accountId:account.id,expectedGeneration:account.storage_generation,decision:'replace'}));
    account={...account,storage_generation:changed.storageGeneration};await sync(folder,10,[raw(1)]);release();
    expect((await outcome).error).toMatchObject({code:'storage_generation_conflict'});
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });
  it('captures a UID-only flag target before waiting for its predecessor',async()=>{
    await sync('INBOX',10,[raw(1)]);
    const client=clientFor('INBOX',10,[]);client.messageFlagsAdd=vi.fn(async()=>true);
    const mgr=flagManager(client);let release;
    mgr._flagOpChains.set(account.id,new Promise(resolve=>{release=resolve;}));
    let captureFinished;
    const captured=new Promise(resolve=>{captureFinished=resolve;});
    const realCapture=identityService.captureMessageSource;
    const spy=vi.spyOn(identityService,'captureMessageSource').mockImplementation(async(...args)=>{
      const proof=await realCapture(...args);captureFinished();return proof;
    });
    try {
      const pending=mgr.setFlag(account,1,'INBOX','\\Seen',true);
      const outcome=pending.then(()=>({ok:true}),error=>({error}));
      await captured; // Capture has finished even though the provider queue is still held.
      await sync('INBOX',11,[raw(1)]);client.mailbox.uidValidity=11n;release();
      expect((await outcome).error).toMatchObject({code:'identity_epoch_changed'});
      expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    } finally { spy.mockRestore();release(); }
  });
  it.each(['persistent','pooled'])('keeps acknowledged %s STORE success without replay after generation changes',async path=>{
    const folder=path==='persistent'?'INBOX':'Archive';await sync(folder,10,[raw(1)]);
    const source=await rowAt(folder,1);const client=clientFor(folder,10,[]);
    client.messageFlagsAdd=vi.fn(async()=>{
      await withTransaction(tx=>applyStorageIdentityDecision(tx,{accountId:account.id,expectedGeneration:account.storage_generation,decision:'replace'}));
      return true;
    });
    ImapFlow.mockImplementation(function(){return client;});
    await expect(flagManager(path==='persistent'?client:null).setFlag(account,1,folder,'\\Seen',true,{expectedSource:source})).resolves.toBeUndefined();
    expect(client.messageFlagsAdd).toHaveBeenCalledOnce();
  });

  const queuedFlagManager = client => ({...flagManager(client),_pendingFlagPush:new Map(),
    _enqueueFlagPush:ImapManager.prototype._enqueueFlagPush,_resolveFlagPush:ImapManager.prototype._resolveFlagPush,
    _rebumpFlagMarkers:ImapManager.prototype._rebumpFlagMarkers,_clearFlagMarker:ImapManager.prototype._clearFlagMarker,
    _reconcileFlagPushes:ImapManager.prototype._reconcileFlagPushes,
  });
  it('retries a healthy captured pending flag and clears only its own marker after acknowledgement',async()=>{
    await sync('INBOX',10,[raw(1)]);const source=await rowAt('INBOX',1);
    const client=clientFor('INBOX',10,[]);client.messageFlagsAdd=vi.fn(async()=>true);
    const mgr=queuedFlagManager(client);
    expect(mgr._enqueueFlagPush(account.id,source.id,'\\Seen',true,{expectedSource:source})).toBe(true);
    source.uid=999; // Caller object mutation cannot retarget the retained snapshot.
    const realSet=mgr.setFlag;
    mgr.setFlag=vi.fn().mockRejectedValueOnce(new Error('temporary provider outage'));
    await mgr._reconcileFlagPushes();expect(mgr._pendingFlagPush.get(account.id).size).toBe(1);
    expect((await rowAt('INBOX',1)).read_changed_at).not.toBeNull();
    mgr.setFlag=realSet;await mgr._reconcileFlagPushes();
    expect(client.messageFlagsAdd).toHaveBeenCalledWith('1',['\\Seen'],{uid:true});
    expect((await rowAt('INBOX',1)).read_changed_at).toBeNull();
    expect(mgr._pendingFlagPush.size).toBe(0);
  });
  it.each(['generation','epoch'])('discards queued proof before marker writes after %s replacement',async change=>{
    await sync('INBOX',10,[raw(1)]);const source=await rowAt('INBOX',1);
    const client=clientFor('INBOX',10,[]);client.messageFlagsAdd=vi.fn(async()=>true);
    const mgr=queuedFlagManager(client);mgr._enqueueFlagPush(account.id,source.id,'\\Seen',true,{expectedSource:source});
    if(change==='generation') {
      const replaced=await withTransaction(tx=>applyStorageIdentityDecision(tx,{accountId:account.id,expectedGeneration:account.storage_generation,decision:'replace'}));
      account={...account,storage_generation:replaced.storageGeneration};
    }
    await sync('INBOX',change==='epoch'?11:10,[raw(1)]);
    await h.pool.query("UPDATE messages SET is_read=false WHERE account_id=$1",[account.id]);
    await mgr._reconcileFlagPushes();
    const replacement=await rowAt('INBOX',1);
    expect(replacement.is_read).toBe(false);expect(replacement.read_changed_at).toBeNull();
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();expect(mgr._pendingFlagPush.size).toBe(0);
  });
  it('does not adopt a reused UID between queue reassertion and setFlag',async()=>{
    await sync('INBOX',10,[raw(1)]);const source=await rowAt('INBOX',1);
    const client=clientFor('INBOX',10,[]);client.messageFlagsAdd=vi.fn(async()=>true);
    const mgr=queuedFlagManager(client),realSet=mgr.setFlag;
    mgr._enqueueFlagPush(account.id,source.id,'\\Seen',true,{expectedSource:source});
    mgr.setFlag=async(...args)=>{
      await sync('INBOX',11,[raw(1)]);await h.pool.query('UPDATE messages SET is_read=false WHERE account_id=$1',[account.id]);client.mailbox.uidValidity=11n;
      return realSet.apply(mgr,args);
    };
    await mgr._reconcileFlagPushes();
    const replacement=await rowAt('INBOX',1);
    expect(replacement.is_read).toBe(false);expect(replacement.read_changed_at).toBeNull();
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();expect(mgr._pendingFlagPush.size).toBe(0);
  });
  it('does not clear or delete a newer toggle that arrives while the old queued STORE runs',async()=>{
    await sync('INBOX',10,[raw(1)]);const source=await rowAt('INBOX',1);
    const client=clientFor('INBOX',10,[]);const mgr=queuedFlagManager(client);
    mgr._enqueueFlagPush(account.id,source.id,'\\Seen',true,{expectedSource:source});
    client.messageFlagsAdd=vi.fn(async()=>{
      mgr._enqueueFlagPush(account.id,source.id,'\\Seen',false,{expectedSource:source});return true;
    });
    client.messageFlagsRemove=vi.fn(async()=>true);
    await mgr._reconcileFlagPushes();
    expect(mgr._pendingFlagPush.get(account.id).size).toBe(1);
    expect((await rowAt('INBOX',1)).read_changed_at).not.toBeNull();
    await mgr._reconcileFlagPushes();
    expect(client.messageFlagsRemove).toHaveBeenCalledOnce();expect(mgr._pendingFlagPush.size).toBe(0);
    expect((await rowAt('INBOX',1)).is_read).toBe(false);expect((await rowAt('INBOX',1)).read_changed_at).toBeNull();
  });
  it('refuses unproved queue entries rather than adopting current rows by UUID',async()=>{
    await sync('INBOX',10,[raw(1)]);const source=await rowAt('INBOX',1);const mgr=queuedFlagManager(null);
    expect(mgr._enqueueFlagPush(account.id,source.id,'\\Seen',true)).toBe(false);
    expect(mgr._enqueueFlagPush(account.id,source.id,'\\Seen',true,{expectedSource:{...source,entity_id:null}})).toBe(false);
    expect(mgr._pendingFlagPush.size).toBe(0);
  });

  it.each(['move','delete'])('rejects stale bulk %s snapshots before any provider action',async kind=>{
    await sync('INBOX',10,[raw(1),raw(2)]);
    const sources=[await rowAt('INBOX',1),await rowAt('INBOX',2)];
    await sync('INBOX',11,[raw(1),raw(2)]);
    const client=clientFor('INBOX',11,[],['MOVE','UIDPLUS']);client.messageMove=vi.fn();client.messageDelete=vi.fn();client.messageFlagsAdd=vi.fn();
    ImapFlow.mockImplementation(function(){return client;});
    const action=kind==='move' ? ImapManager.prototype.bulkMoveMessages.call({},account,[1,2],'INBOX','Archive',{expectedSources:sources})
      :ImapManager.prototype.bulkPermanentDelete.call({},account,[1,2],'INBOX',{expectedSources:sources});
    await expect(action).rejects.toMatchObject({code:'identity_source_changed'});
    expect(client.messageMove).not.toHaveBeenCalled();expect(client.messageDelete).not.toHaveBeenCalled();expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });
  it('rejects missing or duplicate batch proof atomically without preparing any partial operation',async()=>{
    await sync('INBOX',10,[raw(1),raw(2)]);const sources=[await rowAt('INBOX',1),await rowAt('INBOX',2)];const context=await observe('INBOX',10);
    for(const expectedSources of [[sources[0]],[sources[0],sources[0]],[sources[0],{...sources[1],entity_id:sources[0].entity_id}]]) {
      await expect(prepareIdentityOperations(context,'Archive',[1,2],'move',{expectedSources})).rejects.toMatchObject({code:'identity_source_changed'});
    }
    expect((await h.pool.query('SELECT count(*) FROM mail_identity_operations')).rows[0].count).toBe('0');
  });
  it.each(['move','delete'])('captures default bulk %s proof before provider selection waits',async kind=>{
    await sync('INBOX',10,[raw(1),raw(2)]);const client=clientFor('INBOX',10,[],['MOVE','UIDPLUS']);
    client.messageMove=vi.fn();client.messageDelete=vi.fn();client.messageFlagsAdd=vi.fn();
    client.getMailboxLock=async()=>{await sync('INBOX',11,[raw(1),raw(2)]);client.mailbox.uidValidity=11n;return {release(){}};};
    ImapFlow.mockImplementation(function(){return client;});
    const action=kind==='move'?ImapManager.prototype.bulkMoveMessages.call({},account,[1,2],'INBOX','Archive')
      :ImapManager.prototype.bulkPermanentDelete.call({},account,[1,2],'INBOX');
    await expect(action).rejects.toMatchObject({code:'identity_epoch_changed'});
    expect(client.messageMove).not.toHaveBeenCalled();expect(client.messageDelete).not.toHaveBeenCalled();expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });
  it('clones bulk sources before awaits and reports acknowledged unmapped MOVE as pending',async()=>{
    await sync('INBOX',10,[raw(1)]);const source=await rowAt('INBOX',1);const supplied=[source];
    const client=clientFor('INBOX',10,[],['MOVE','UIDPLUS']);client.messageMove=vi.fn(async()=>({}));client.status=async()=>({uidNext:1});
    client.getMailboxLock=async()=>{source.uid=999;source.entity_id='changed';supplied.length=0;return {release(){}};};
    ImapFlow.mockImplementation(function(){return client;});
    const result=await ImapManager.prototype.bulkMoveMessages.call({},account,[1],'INBOX','Archive',{expectedSources:supplied});
    expect(result).toMatchObject({succeeded:[],failed:[],pending:[1],identityPending:true});expect(result.uidMap.size).toBe(0);
    expect(client.messageMove).toHaveBeenCalledOnce();
    expect((await h.pool.query('SELECT state FROM mail_identity_operations')).rows[0].state).toBe('unresolved');
  });

  const emptyManager=()=>({
    _chunkedFolderOp:ImapManager.prototype._chunkedFolderOp,
    _deleteAllInFolder(client,folder,options){return ImapManager.prototype._deleteAllInFolder.call(this,client,folder,{...options,chunkSize:1,retryBackoffMs:0});},
  });
  it('emptyFolder refuses reused UIDs when SEARCH crosses an epoch reset',async()=>{
    await sync('Trash',10,[raw(1)]);const client=clientFor('Trash',10,[raw(1)]);
    client.search=async()=>{await sync('Trash',11,[raw(1)]);client.mailbox.uidValidity=11n;return [1];};
    client.messageDelete=vi.fn(async()=>true);ImapFlow.mockImplementation(function(){return client;});
    await expect(ImapManager.prototype.emptyFolder.call(emptyManager(),account,'Trash')).rejects.toMatchObject({code:'identity_epoch_changed'});
    expect(client.messageDelete).not.toHaveBeenCalled();
  });
  it.each(['retry','next-chunk'])('emptyFolder stops before %s can target a replacement epoch',async change=>{
    await sync('Trash',10,[raw(1),raw(2)]);const client=clientFor('Trash',10,[raw(1),raw(2)]);
    client.messageDelete=vi.fn(async()=>{
      await sync('Trash',11,[raw(1),raw(2)]);client.mailbox.uidValidity=11n;
      return change==='next-chunk';
    });ImapFlow.mockImplementation(function(){return client;});
    await expect(ImapManager.prototype.emptyFolder.call(emptyManager(),account,'Trash')).rejects.toMatchObject({code:'identity_epoch_changed'});
    expect(client.messageDelete).toHaveBeenCalledOnce();
  });
  it('emptyFolder returns verified cache scope even for an already empty folder',async()=>{
    const client=clientFor('Trash',10,[]);client.messageDelete=vi.fn();ImapFlow.mockImplementation(function(){return client;});
    const result=await ImapManager.prototype.emptyFolder.call(emptyManager(),account,'Trash');
    expect(result.identityContext).toMatchObject({accountId:account.id,storageGeneration:account.storage_generation,folderPath:'Trash',uidValidity:'10'});
    expect(client.messageDelete).not.toHaveBeenCalled();
  });
  it.each([['deleteFolder','generation'],['deleteFolder','epoch'],['renameFolder','generation'],['renameFolder','epoch']])('%s refuses a folder replaced during STATUS (%s)',async(method,change)=>{
    await sync('Folder',10,[raw(1)]);const capturedAccount={...account};const client=clientFor('INBOX',1,[]);
    client.mailboxDelete=vi.fn(async()=>true);client.mailboxRename=vi.fn(async()=>true);
    client.status=async()=>{
      if(change==='generation'){
        const result=await withTransaction(tx=>applyStorageIdentityDecision(tx,{accountId:account.id,expectedGeneration:account.storage_generation,decision:'replace'}));
        account={...account,storage_generation:result.storageGeneration};
      }
      await sync('Folder',11,[raw(1)]);return {uidValidity:11n};
    };ImapFlow.mockImplementation(function(){return client;});
    await expect(ImapManager.prototype[method].call({},capturedAccount,'Folder','Renamed')).rejects.toMatchObject({code:expect.stringMatching(/identity_epoch_changed|storage_generation_conflict/)});
    expect(client.mailboxDelete).not.toHaveBeenCalled();expect(client.mailboxRename).not.toHaveBeenCalled();
  });
  it('does not turn post-COPY plugin failure into a retryable provider failure',async()=>{
    await sync('INBOX',10,[raw(1)]);const source=await rowAt('INBOX',1);const client=clientFor('INBOX',10,[],['UIDPLUS']);
    client.messageCopy=vi.fn(async()=>({uidMap:new Map([[1,9]]),uidValidity:20n}));ImapFlow.mockImplementation(function(){return client;});
    const hook=vi.spyOn(pluginRegistry,'runHook').mockRejectedValueOnce(new Error('refresh failed'));
    try {
      const mgr={pluginFacade:{},syncFolderOnDemand:vi.fn(async()=>{})};
      await expect(ImapManager.prototype.copyMessage.call(mgr,account,1,'INBOX','Copy',{expectedSource:source})).resolves.toBe(9);
      expect(client.messageCopy).toHaveBeenCalledOnce();expect((await rowAt('Copy',9)).entity_id).not.toBeNull();
    } finally {hook.mockRestore();}
  });

});
