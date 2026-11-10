import { randomBytes } from 'crypto';
import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
const h = vi.hoisted(() => ({ pool: null, failCounts: false }));
vi.mock('./db.js', () => ({
  pool: { connect: (...args) => h.pool.connect(...args) },
  query: (...args) => h.pool.query(...args),
  withTransaction: async fn => {
    const client = await h.pool.connect();
    const tx = { query: (...args) => h.failCounts && args[0].includes('WITH prev AS')
      ? client.query('SELECT 1 / 0') : client.query(...args) };
    try { await client.query('BEGIN'); const result = await fn(tx); await client.query('COMMIT'); return result; }
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
import { readMailboxIdentity, observeMailboxIdentity, applyStorageIdentityDecision, writeObservedMessage } from './messageIdentity.js';
import { withTransaction } from './db.js';
import { classifyAndTagMessage } from './spamPipeline.js';
import { archiveInboxCopy } from './archiveInbox.js';
import { markThreadRead } from './labels.js';
import { applyInboxRules, applyBlockList } from './inboxRules.js';
import { createEmptyModel, updateIncremental } from './spamModel.js';
import { getModelForUser } from './spamModelStore.js';
import { clearCarries, takeCarry } from './movedRowCarry.js';
vi.mock('./spamModelStore.js', () => ({ getModelForUser: vi.fn() }));

const databaseUrl = process.env.MAILFLOW_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('async mail callers preserve captured mailbox identity', () => {
  const dbName = `mailflow_async_identity_${randomBytes(5).toString('hex')}`;
  let admin, account, client, providerMove;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl }); await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(databaseUrl); url.pathname = `/${dbName}`;
    h.pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
    await runMigrations();
  }, 60_000);
  afterAll(async () => { await h.pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin?.end(); });
  beforeEach(async () => {
    h.failCounts = false;
    clearCarries();
    await h.pool.query('TRUNCATE users CASCADE');
    const owner = (await h.pool.query("INSERT INTO users(username) VALUES ('async-owner') RETURNING id")).rows[0].id;
    account = (await h.pool.query(`INSERT INTO email_accounts(user_id,name,email_address,imap_host,auth_user,auth_pass,antispam_enabled,folder_mappings)
      VALUES ($1,'Async','me@example.test','imap.example.test','synthetic','synthetic',true,'{"spam":"Junk","archive":"Junk"}') RETURNING *`, [owner])).rows[0];
    let model = createEmptyModel();
    for (let i = 0; i < 200; i++) model = updateIncremental(model,
      i % 2 ? ['meeting', 'agenda', 'notes', 'review', 'document', 'thanks'] : ['cheap', 'viagra', 'click', 'buy', 'offer', 'free'], {}, i % 2 ? 'ham' : 'spam');
    getModelForUser.mockReset().mockResolvedValue(model);
    providerMove = vi.fn(async () => ({ uidMap: new Map([[1, 9]]), uidValidity: 20n }));
    client = Object.assign(new EventEmitter(), {
      mailbox: { path: 'INBOX', uidValidity: 10n }, capabilities: new Set(['UIDPLUS', 'MOVE']),
      connect: async () => {}, close() {}, logout: async () => {}, noop: async () => true,
      getMailboxLock: async () => ({ release() {} }), messageMove: providerMove,
    });
    ImapFlow.mockImplementation(function () { return client; });
    await observe('Junk', 20);
  });
  afterEach(() => { h.failCounts = false; if (account) evictPool(account.id); });
  const observe = async (folder, epoch) => observeMailboxIdentity(await readMailboxIdentity(account, folder),
    { mailbox: { path: folder, uidValidity: BigInt(epoch) }, capabilities: new Set() });
  const seed = async (folder = 'INBOX', epoch = 10, uid = 1, subject = 'CHEAP VIAGRA!!! WIN $$$') => {
    const context = await observe(folder, epoch);
    return (await writeObservedMessage(context, { uid }, tx => tx.query(`
      INSERT INTO messages(account_id,folder,uid,subject,body_text,from_email,attachments,message_id,date,is_read)
      VALUES ($1,$2,$3,$4,'Click here. Buy now. Limited time offer, act now!','spammer@spoof.biz',
        '[{"filename":"invoice.exe"}]','<same@example.test>','2026-11-01T00:00:00Z',false) RETURNING *`,
    [account.id, folder, uid, subject]))).rows[0];
  };
  const replace = async () => {
    const result = await withTransaction(tx => applyStorageIdentityDecision(tx, {
      accountId: account.id, expectedGeneration: account.storage_generation, decision: 'replace' }));
    account = { ...account, storage_generation: result.storageGeneration };
  };
  const rowAt = async (folder, uid) => (await h.pool.query('SELECT * FROM messages WHERE account_id=$1 AND folder=$2 AND uid=$3', [account.id, folder, uid])).rows[0];
  const facade = ({ beforeMove, afterMove } = {}) => ({
    moveMessage: vi.fn(async (...args) => {
      await beforeMove?.();
      const uid = await ImapManager.prototype.moveMessage.call({}, ...args);
      await afterMove?.();
      return uid;
    }),
    syncFolderOnDemand: vi.fn(async () => {}), broadcast: vi.fn(), _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(),
  });

  it('repoints a confirmed auto-move only to its journal-proved destination', async () => {
    const source = await seed();
    const result = await classifyAndTagMessage(source.id, { imap: facade() });
    expect(result).toMatchObject({ verdict: 'spam', moved: true });
    expect(providerMove).toHaveBeenCalledOnce();
    expect(await rowAt('INBOX', 1)).toBeUndefined();
    expect(await rowAt('Junk', 9)).toMatchObject({ id: source.id, entity_id: source.entity_id, uid_validity: '20' });
  });

  it.each(['generation', 'epoch'])('does not move a reused UID after %s changes while loading the model', async change => {
    const source = await seed();
    const model = await getModelForUser();
    getModelForUser.mockImplementationOnce(async () => {
      if (change === 'generation') await replace();
      await seed('INBOX', 11, 1, 'New delivery');
      return model;
    });
    const imap = facade();
    const result = await classifyAndTagMessage(source.id, { imap }).catch(error => ({ error: error.code }));
    expect(result).toMatchObject(change === 'generation' ? { error: 'storage_generation_conflict' } : { skipped: 'source_changed' });
    expect(providerMove).not.toHaveBeenCalled();
    expect(imap.moveMessage).not.toHaveBeenCalled();
    expect(await rowAt('INBOX', 1)).toMatchObject({ subject: 'New delivery', spam_verdict: null });
  });

  it.each(['generation', 'epoch'])('does not move a reused UID after %s changes in the move queue', async change => {
    const source = await seed();
    const imap = facade({ beforeMove: async () => {
      if (change === 'generation') await replace();
      await seed('INBOX', 11, 1, 'New queued delivery');
      client.mailbox.uidValidity = 11n;
    } });
    expect(await classifyAndTagMessage(source.id, { imap })).toMatchObject({ moved: false });
    expect(providerMove).not.toHaveBeenCalled();
    expect(await rowAt('INBOX', 1)).toMatchObject({ subject: 'New queued delivery' });
  });

  it.each(['generation', 'epoch'])('rechecks identity after fallback FETCH changes %s before MOVE', async change => {
    const source = await seed();
    client.capabilities.delete('UIDPLUS');
    client.status = async () => ({ uidNext: 9 });
    client.fetch = async function* () {
      if (change === 'generation') await replace();
      await seed('INBOX', 11, 1, 'New delivery during FETCH');
      yield { uid: 1, envelope: { messageId: source.message_id } };
    };
    expect(await classifyAndTagMessage(source.id, { imap: facade() })).toMatchObject({ moved: false });
    expect(providerMove).not.toHaveBeenCalled();
    expect(await rowAt('INBOX', 1)).toMatchObject({ subject: 'New delivery during FETCH' });
  });

  it.each(['generation', 'epoch'])('preserves a replacement destination after acknowledged MOVE and %s change', async change => {
    const source = await seed();
    let replacement;
    const imap = facade({ afterMove: async () => {
      if (change === 'generation') await replace();
      replacement = await seed('Junk', 21, 9, 'Replacement destination');
    } });
    expect(await classifyAndTagMessage(source.id, { imap })).toMatchObject({ moved: true });
    expect(providerMove).toHaveBeenCalledOnce();
    expect(await rowAt('Junk', 9)).toMatchObject({ id: replacement.id, subject: 'Replacement destination', uid_validity: '21' });
    expect(await rowAt('INBOX', 1)).toBeUndefined();
  });

  it('drops only the captured source on an acknowledged move with no destination UID', async () => {
    const source = await seed();
    providerMove.mockResolvedValue({});
    const imap = facade();
    expect(await classifyAndTagMessage(source.id, { imap })).toMatchObject({ moved: true });
    expect(await rowAt('INBOX', 1)).toBeUndefined();
    expect(imap.syncFolderOnDemand).toHaveBeenCalledWith(expect.objectContaining({ storage_generation: account.storage_generation }), 'Junk');
    const oldGeneration = account.storage_generation;
    await replace();
    expect(takeCarry(account.id, 'Junk', source.message_id, source.date, Date.now(), account.storage_generation)).toBeNull();
    expect(takeCarry(account.id, 'Junk', source.message_id, source.date, Date.now(), oldGeneration)).toMatchObject({ spam_verdict: 'spam' });
  });

  it('marks current verified copies read with transactional counts and original STORE proof', async () => {
    const source = await seed();
    const sibling = await seed('Todo', 10, 2);
    await h.pool.query('UPDATE folders SET unread_count=5 WHERE account_id=$1', [account.id]);
    const mgr = { isLabelStore: () => true, setFlag: vi.fn(async () => {}) };
    expect(await markThreadRead(mgr, account, source)).toMatchObject({ pushedIds: [source.id] });
    expect((await h.pool.query('SELECT is_read FROM messages WHERE id=ANY($1::uuid[])', [[source.id, sibling.id]])).rows)
      .toEqual([{ is_read: true }, { is_read: true }]);
    expect(mgr.setFlag).toHaveBeenCalledWith(account, source.uid, 'INBOX', '\\Seen', true,
      { expectedSource: expect.objectContaining({ id: source.id, entity_id: source.entity_id,
        storage_generation: account.storage_generation, uid_validity: '10' }) });
    expect((await h.pool.query("SELECT unread_count FROM folders WHERE account_id=$1 AND path IN ('INBOX','Todo')", [account.id])).rows)
      .toEqual([{ unread_count: 4 }, { unread_count: 4 }]);
  });

  it('excludes a stale sibling cache row whose location no longer belongs to the current epoch', async () => {
    const source = await seed();
    const sibling = await seed('Todo', 10, 2);
    await observe('Todo', 11);
    // Reproduce a stale legacy cache callback without falsifying the epoch/location registry.
    await h.pool.query(`INSERT INTO messages(id,account_id,folder,uid,message_id,storage_generation,uid_validity,entity_id)
      VALUES ($1,$2,'Todo',2,$3,$4,$5,$6)`, [sibling.id, account.id, sibling.message_id,
      sibling.storage_generation, sibling.uid_validity, sibling.entity_id]);
    const mgr = { isLabelStore: () => true, setFlag: vi.fn(async () => {}) };
    await markThreadRead(mgr, account, source);
    expect((await h.pool.query('SELECT is_read FROM messages WHERE id=$1', [sibling.id])).rows[0].is_read).toBe(false);
    expect((await rowAt('INBOX', 1)).is_read).toBe(true);
  });

  it('rolls back read fanout when a transactional folder count write fails', async () => {
    const source = await seed();
    const sibling = await seed('Todo', 10, 2);
    await h.pool.query('UPDATE folders SET unread_count=5 WHERE account_id=$1', [account.id]);
    h.failCounts = true;
    const mgr = { isLabelStore: () => true, setFlag: vi.fn(async () => {}) };
    expect(await markThreadRead(mgr, account, source)).toMatchObject({ error: expect.any(Error), pushedIds: [] });
    expect((await h.pool.query('SELECT is_read FROM messages WHERE id=ANY($1::uuid[])', [[source.id, sibling.id]])).rows)
      .toEqual([{ is_read: false }, { is_read: false }]);
    expect(mgr.setFlag).not.toHaveBeenCalled();
  });

  const starRule = () => ({ id: 'star-rule', user_id: account.user_id, account_id: account.id,
    storage_generation: account.storage_generation,
    condition_logic: 'AND', conditions: [{ field: 'subject', operator: 'contains', value: 'viagra' }], actions: [{ type: 'star' }] });

  it.each(['generation', 'epoch'])('rule retries retain their original source after provider failure and %s change', async change => {
    const source = await seed();
    const originalGeneration = account.storage_generation;
    const imap = { _enqueueFlagPush: vi.fn(), setFlag: vi.fn(async () => {
      if (change === 'generation') await replace();
      await seed('INBOX', 11, 1, 'Replacement rule target');
      throw new Error('synthetic provider disconnect');
    }) };
    await applyInboxRules([source], account, imap, { rule: starRule() });
    expect(imap._enqueueFlagPush).toHaveBeenCalledWith(account.id, source.id, '\\Flagged', true,
      { expectedSource: expect.objectContaining({ id: source.id, account_id: account.id,
        entity_id: source.entity_id, uid_validity: '10', storage_generation: originalGeneration }) });
    expect(await rowAt('INBOX', 1)).toMatchObject({ subject: 'Replacement rule target', is_starred: false });
  });

  it('a delayed rule does not adopt the replacement row at its earlier UID', async () => {
    const source = await seed();
    await seed('INBOX', 11, 1, 'Replacement before rule');
    const imap = { _enqueueFlagPush: vi.fn(), setFlag: vi.fn() };
    await applyInboxRules([source], account, imap, { rule: starRule() });
    expect(imap.setFlag).not.toHaveBeenCalled();
    expect(imap._enqueueFlagPush).not.toHaveBeenCalled();
    expect(await rowAt('INBOX', 1)).toMatchObject({ subject: 'Replacement before rule', is_starred: false });
  });

  const moveRule = type => ({ ...starRule(), actions: [{ type, ...(type === 'move' ? { value: 'Junk' } : {}) }] });
  const ruleManager = ({ beforeMove, afterMove } = {}) => {
    const mgr = { ...facade(), _enqueueFlagPush: vi.fn(), setFlag: vi.fn(async () => {}) };
    mgr.bulkMoveMessages = vi.fn(async (...args) => {
      await beforeMove?.();
      const result = await ImapManager.prototype.bulkMoveMessages.call(mgr, ...args);
      await afterMove?.();
      return result;
    });
    return mgr;
  };
  const runRuleOrBlock = async (type, source, mgr) => {
    account.folder_mappings = { ...account.folder_mappings, trash: 'Junk' };
    if (type === 'block') {
      await h.pool.query('INSERT INTO block_list(user_id,email_address) VALUES ($1,$2)', [account.user_id, source.from_email]);
      return applyBlockList([{ ...source, fromEmail: source.from_email }], account, mgr);
    }
    return applyInboxRules([source], account, mgr, { rule: moveRule(type) });
  };

  it.each(['move', 'archive', 'delete', 'block'])('guards and persists a verified %s rule destination and its counts', async type => {
    const source = await seed();
    const originalUid = source.uid;
    await h.pool.query('UPDATE folders SET total_count=10,unread_count=5 WHERE account_id=$1', [account.id]);
    const mgr = ruleManager();
    await runRuleOrBlock(type, source, mgr);
    expect(providerMove).toHaveBeenCalledOnce();
    expect(await rowAt('INBOX', 1)).toBeUndefined();
    expect(await rowAt('Junk', 9)).toMatchObject({ id: source.id, entity_id: source.entity_id, uid_validity: '20' });
    expect(mgr.bulkMoveMessages).toHaveBeenCalledWith(expect.objectContaining({ storage_generation: account.storage_generation }),
      [originalUid], 'INBOX', 'Junk', { expectedSources: [expect.objectContaining({ id: source.id, uid_validity: '10' })] });
    expect((await h.pool.query('SELECT path,total_count,unread_count FROM folders WHERE account_id=$1 ORDER BY path', [account.id])).rows)
      .toEqual([{ path: 'INBOX', total_count: 9, unread_count: 4 }, { path: 'Junk', total_count: 11, unread_count: 6 }]);
  });

  it.each(['generation', 'epoch'])('a queued rule move cannot act on a replacement %s source', async change => {
    const source = await seed();
    const mgr = ruleManager({ beforeMove: async () => {
      if (change === 'generation') await replace();
      await seed('INBOX', 11, 1, 'Replacement before rule MOVE');
      client.mailbox.uidValidity = 11n;
    } });
    await runRuleOrBlock('move', source, mgr);
    expect(providerMove).not.toHaveBeenCalled();
    expect(await rowAt('INBOX', 1)).toMatchObject({ subject: 'Replacement before rule MOVE' });
  });

  it.each(['generation', 'epoch'])('acknowledged rule MOVE cannot rewrite replacement %s cache/counts', async change => {
    const source = await seed();
    const mgr = ruleManager({ afterMove: async () => {
      if (change === 'generation') await replace();
      await seed('Junk', 21, 9, 'New rule destination');
      await h.pool.query('UPDATE folders SET total_count=40,unread_count=30 WHERE account_id=$1', [account.id]);
    } });
    const result = await runRuleOrBlock('move', source, mgr);
    expect(result).toMatchObject({ failedCount: 0, identityPending: true });
    expect(providerMove).toHaveBeenCalledOnce();
    expect(await rowAt('Junk', 9)).toMatchObject({ subject: 'New rule destination', uid_validity: '21' });
    expect((await h.pool.query("SELECT total_count,unread_count FROM folders WHERE account_id=$1 AND path='Junk'", [account.id])).rows)
      .toEqual([{ total_count: 40, unread_count: 30 }]);
  });

  it('rolls back a rule read and its counters before sending STORE when count persistence fails', async () => {
    const source = await seed();
    await h.pool.query('UPDATE folders SET unread_count=5 WHERE account_id=$1', [account.id]);
    h.failCounts = true;
    const mgr = ruleManager();
    expect(await runRuleOrBlock('mark_read', source, mgr)).toMatchObject({ failedCount: 1 });
    expect(await rowAt('INBOX', 1)).toMatchObject({ is_read: false });
    expect(mgr.setFlag).not.toHaveBeenCalled();
    expect((await h.pool.query("SELECT unread_count FROM folders WHERE account_id=$1 AND path='INBOX'", [account.id])).rows[0].unread_count).toBe(5);
  });

  it('preserves acknowledged delete STORE as pending when local counts roll back', async () => {
    const source = await seed('Junk', 20);
    account.folder_mappings = { ...account.folder_mappings, trash: 'Junk' };
    await h.pool.query(`INSERT INTO inbox_rules(user_id,name,conditions,actions)
      VALUES ($1,'Delete matched mail',$2,$3)`, [account.user_id,
      JSON.stringify([{ field: 'subject', operator: 'contains', value: 'viagra' }]),
      JSON.stringify([{ type: 'delete' }])]);
    await h.pool.query('UPDATE folders SET total_count=10,unread_count=5 WHERE account_id=$1', [account.id]);
    h.failCounts = true;
    const mgr = ruleManager();
    const result = await applyInboxRules([source], account, mgr);
    expect(result).toMatchObject({ identityPending: true, pendingIds: [source.id] });
    expect(result.remaining).toHaveLength(0);
    expect(mgr.setFlag).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ storage_generation: account.storage_generation }),
      source.uid, 'Junk', '\\Deleted', true, { expectedSource: expect.objectContaining({ id: source.id, uid_validity: '20' }) });
    expect(await rowAt('Junk', 1)).toMatchObject({ id: source.id, is_deleted: false });
    expect((await h.pool.query("SELECT total_count,unread_count FROM folders WHERE account_id=$1 AND path='Junk'", [account.id])).rows)
      .toEqual([{ total_count: 10, unread_count: 5 }]);
  });

  it('keeps uncertain rule MOVE outcomes pending and never replays or edits the source cache', async () => {
    const source = await seed();
    providerMove.mockRejectedValue(new Error('connection lost during MOVE'));
    const result = await runRuleOrBlock('move', source, ruleManager());
    expect(result).toMatchObject({ failedCount: 0, identityPending: true, pendingIds: [source.id] });
    expect(result.remaining).toHaveLength(1);
    expect(providerMove).toHaveBeenCalledOnce();
    expect(await rowAt('INBOX', 1)).toMatchObject({ id: source.id });
  });

  it('archives with source, destination and count writes in one captured generation', async () => {
    const source = await seed();
    await h.pool.query("UPDATE folders SET total_count=10,unread_count=5 WHERE account_id=$1", [account.id]);
    expect(await archiveInboxCopy(facade(), account, source)).toMatchObject({ archived: true, uidKnown: true });
    expect(await rowAt('Junk', 9)).toMatchObject({ id: source.id, uid_validity: '20' });
    const counts = (await h.pool.query('SELECT path,total_count,unread_count FROM folders WHERE account_id=$1 ORDER BY path', [account.id])).rows;
    expect(counts).toEqual([{ path: 'INBOX', total_count: 9, unread_count: 4 }, { path: 'Junk', total_count: 11, unread_count: 6 }]);
  });

  it('rolls back archive cache and counts on database failure without retrying confirmed MOVE', async () => {
    const source = await seed();
    await h.pool.query("UPDATE folders SET total_count=10,unread_count=5 WHERE account_id=$1", [account.id]);
    h.failCounts = true;
    expect(await archiveInboxCopy(facade(), account, source)).toMatchObject({ archived: true, identityPending: true });
    expect(providerMove).toHaveBeenCalledOnce();
    expect(await rowAt('INBOX', 1)).toMatchObject({ id: source.id });
    expect(await rowAt('Junk', 9)).toBeUndefined();
    expect((await h.pool.query('SELECT total_count,unread_count FROM folders WHERE account_id=$1', [account.id])).rows)
      .toEqual([{ total_count: 10, unread_count: 5 }, { total_count: 10, unread_count: 5 }]);
    expect((await h.pool.query('SELECT state FROM mail_identity_operations')).rows).toEqual([{ state: 'bound' }]);
  });

  it('does not apply archive cache or count writes to a replaced account after MOVE', async () => {
    const source = await seed();
    const imap = facade({ afterMove: async () => {
      await replace(); await seed('Junk', 20, 9, 'Fresh mailbox');
      await h.pool.query("UPDATE folders SET total_count=40,unread_count=30 WHERE account_id=$1", [account.id]);
    } });
    expect(await archiveInboxCopy(imap, account, source)).toMatchObject({ archived: true, identityPending: true });
    expect(providerMove).toHaveBeenCalledOnce();
    expect(await rowAt('Junk', 9)).toMatchObject({ subject: 'Fresh mailbox' });
    expect((await h.pool.query('SELECT total_count,unread_count FROM folders WHERE account_id=$1', [account.id])).rows)
      .toEqual([{ total_count: 40, unread_count: 30 }]);
  });
  it.each(['archive-helper','move','archive','delete','block','auto-spam'].flatMap(action => [[action,false,true],[action,true,false]]))(
    '%s reconciles sync-first unread counts (source read=%s, destination read=%s)', async (action,sourceRead,destinationRead) => {
      const source = await seed();
      await h.pool.query('UPDATE messages SET is_read=$2 WHERE id=$1',[source.id,sourceRead]);
      source.is_read=sourceRead;
      providerMove.mockImplementation(async () => {
        const destination = await seed('Junk',20,9);
        await h.pool.query('UPDATE messages SET is_read=$2 WHERE id=$1',[destination.id,destinationRead]);
        await h.pool.query('UPDATE folders SET total_count=10,unread_count=5 WHERE account_id=$1',[account.id]);
        return {uidMap:new Map([[1,9]]),uidValidity:20n};
      });
      if (action==='archive-helper') await archiveInboxCopy(facade(),account,source);
      else if (action==='auto-spam') await classifyAndTagMessage(source.id,{imap:facade()});
      else await runRuleOrBlock(action,source,ruleManager());
      expect(providerMove).toHaveBeenCalledOnce();
      expect((await h.pool.query("SELECT total_count,unread_count FROM folders WHERE account_id=$1 AND path='Junk'",[account.id])).rows[0])
        .toEqual({total_count:10,unread_count:5+Number(!sourceRead)-Number(!destinationRead)});
      if (action!=='auto-spam') expect((await h.pool.query("SELECT total_count,unread_count FROM folders WHERE account_id=$1 AND path='INBOX'",[account.id])).rows[0])
        .toEqual({total_count:9,unread_count:5-Number(!sourceRead)});
      expect(await rowAt('Junk',9)).toMatchObject({is_read:sourceRead});
    });

});
