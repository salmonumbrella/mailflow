import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./messageIdentity.js', () => import('./testSupport/identityTestAdapter.js'));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn() }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('./mailAccess.js', () => ({ getAccountAddresses: vi.fn(async () => []) }));
import { ImapManager, runIdentityCommand } from './imapManager.js';
import { query } from './db.js';
import { readMailboxIdentity, observeMailboxIdentity, writeObservedMessage,
  writeUnverifiedMessage, completeIdentityOperations } from './messageIdentity.js';

const account = { id: 'account-identity', user_id: 'owner', email_address: 'me@example.test', imap_host: 'imap.gmail.com' };
const context = { accountId: account.id, storageGeneration: 'generation', folderPath: 'Drafts',
  uidValidity: '9', revision: '2', providerNamespace: null };
beforeEach(() => {
  vi.clearAllMocks();
  query.mockReset().mockResolvedValue({ rows: [] });
});

describe('direct cache identity wiring', () => {
  it.each(['upsertDraftMessageRecord', 'upsertSentMessageRecord'])('%s uses only explicit APPEND proof', async method => {
    await ImapManager.prototype[method].call({}, account, 'Drafts', 5,
      { subject: 'Saved', identityContext: context });
    expect(writeObservedMessage).toHaveBeenCalledWith(context, { uid: 5 }, expect.any(Function));
    expect(writeUnverifiedMessage).not.toHaveBeenCalled();
  });

  it.each(['upsertDraftMessageRecord', 'upsertSentMessageRecord'])('%s does not turn a UID or Message-ID into proof', async method => {
    await ImapManager.prototype[method].call({}, account, 'Drafts', 5,
      { subject: 'Saved', messageId: '<same@example.test>', providerMsgid: '9007199254740993' });
    expect(writeUnverifiedMessage).toHaveBeenCalledWith(account, 'Drafts', 5, expect.any(Function));
    expect(writeObservedMessage).not.toHaveBeenCalled();
  });

  it('propagates stale APPEND proof rejection without executing an unverified fallback', async () => {
    const error = Object.assign(new Error('epoch changed'), { code: 'identity_epoch_changed' });
    writeObservedMessage.mockRejectedValueOnce(error);
    await expect(ImapManager.prototype.upsertDraftMessageRecord.call({}, account, 'Drafts', 5,
      { identityContext: context })).rejects.toBe(error);
    expect(writeUnverifiedMessage).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO messages'))).toBe(false);
  });
});

describe('journal outcome boundaries', () => {
  const operations = [{ id: 'intent' }];
  it('records the exact protocol mapping, including UIDVALIDITY', async () => {
    const result = { uidValidity: 42n, uidMap: new Map([[5, 7]]) };
    const command = vi.fn(async () => result);
    await runIdentityCommand(operations, command);
    expect(completeIdentityOperations).toHaveBeenCalledWith(operations, result, { outcome: 'confirmed' });
  });
  it.each([{ uid: 7, uidValidity: 42n }, { uidMap: new Map([[5, 7]]), uidValidity: 42n }])(
    'retains provider success without retry if durable completion fails: %o', async result => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      completeIdentityOperations.mockRejectedValueOnce(new Error('database unavailable'));
      const command = vi.fn(async () => result);
      try {
        expect(await runIdentityCommand(operations, command)).toEqual({ result, operations: [], identityPending: true, identityUnsafe: true });
        expect(command).toHaveBeenCalledOnce();
        expect(log).toHaveBeenCalledWith(expect.stringContaining('recovery is pending'), 'database unavailable');
      } finally { log.mockRestore(); }
    });

  it('records a refused command as failed', async () => {
    await runIdentityCommand(operations, async () => false);
    expect(completeIdentityOperations).toHaveBeenCalledWith(operations, false, { outcome: 'failed' });
  });
  it('records a thrown transport as unknown and never retries', async () => {
    const error = new Error('socket closed after write');
    const command = vi.fn(async () => { throw error; });
    await expect(runIdentityCommand(operations, command)).rejects.toBe(error);
    expect(command).toHaveBeenCalledOnce();
    expect(completeIdentityOperations).toHaveBeenCalledWith(operations, null, { outcome: 'unknown' });
  });
});

describe('sync identity evidence and legacy reconciliation', () => {
  function syncClient(namespace = null) {
    return { mailbox: { exists: 1, uidValidity: 9n, highestModseq: 7n },
      capabilities: new Set(namespace ? [namespace] : []), noop: async () => true,
      getMailboxLock: vi.fn(async () => ({ release() {} })),
      fetch: vi.fn(async function* (range) {
        // Only legacy UID 5 is fetched; the new-mail watermark yields nothing.
        if (String(range) === '5') yield { uid: 5, emailId: '9007199254740993', size: 123,
          flags: new Set(['\\Seen']), envelope: { subject: 'Existing', from: [{ address: 'sender@example.test' }] } };
      }) };
  }
  function syncDatabase() {
    query.mockImplementation(async sql => {
      if (sql.includes('SELECT uid_validity')) return { rows: [{ uid_validity: '9', highest_modseq: '7' }] };
      if (sql.includes('COUNT(*) FILTER')) return { rows: [{ n: 0 }] };
      if (sql.includes('COALESCE(MAX(uid), 0)')) return { rows: [{ max_uid: 5 }] };
      if (sql.includes('LIMIT 100')) return { rows: [{ uid: '5' }] };
      if (sql.includes('INSERT INTO messages')) return { rows: [{ id: 'cache', is_new: false }] };
      return { rows: [] };
    });
  }
  it.each([[null, null], ['OBJECTID', 'imap-objectid'], ['X-GM-EXT-1', 'gmail-x-gm-msgid']])(
    'uses negotiated %s and refetches a bounded legacy slice even on unchanged modseq', async (capability, expectedNamespace) => {
      syncDatabase();
      const client = syncClient(capability);
      await ImapManager.prototype.syncMessages.call({ pluginFacade: {}, maybeClassifyNewMessage: vi.fn() }, account, client, 'INBOX', 20, false, true);
      expect(readMailboxIdentity.mock.invocationCallOrder[0]).toBeLessThan(client.getMailboxLock.mock.invocationCallOrder[0]);
      expect(observeMailboxIdentity).toHaveBeenCalledWith(expect.any(Object), client);
      expect(client.fetch).toHaveBeenCalledWith('5', expect.objectContaining({ size: true }), { uid: true });
      expect(writeObservedMessage).toHaveBeenCalledOnce();
      const [, , writeMessage, options] = writeObservedMessage.mock.calls[0];
      expect(typeof writeMessage).toBe('function');
      expect(Object.keys(options)).toEqual(['captureRuleSource']);
      const { captureRuleSource } = options;
      expect(typeof captureRuleSource).toBe('function');
      expect(writeObservedMessage).toHaveBeenCalledWith(expect.objectContaining({ providerNamespace: expectedNamespace }),
        expect.objectContaining({ uid: 5, emailId: '9007199254740993' }), writeMessage, { captureRuleSource });
      // The transaction-local capture hook must not promote this read legacy
      // message into an unread-arrival rule candidate, even if the row is new.
      const transaction = { query: vi.fn() };
      const persistedSource = { id: 'cache', account_id: account.id, folder: 'INBOX', uid: 5 };
      const queryCount = query.mock.calls.length;
      expect(captureRuleSource(transaction, persistedSource, { id: 'cache', is_new: false })).toBeNull();
      expect(captureRuleSource(transaction, persistedSource, { id: 'cache', is_new: true })).toBeNull();
      expect(transaction.query).not.toHaveBeenCalled();
      expect(query).toHaveBeenCalledTimes(queryCount);
      const [sql, params] = query.mock.calls.find(([text]) => text.includes('INSERT INTO messages'));
      const columns = sql.match(/INSERT INTO messages\s*\(([^)]*)\)/)[1].split(',').map(c => c.trim());
      expect(params[columns.indexOf('rfc822_size_bytes')]).toBe(123);
      expect(params[columns.indexOf('provider_msgid')]).toBe(expectedNamespace ? '9007199254740993' : null);
    });
});

describe('pending flag proof retention', () => {
  const source = () => ({ id:'message',account_id:account.id,entity_id:'entity',storage_generation:'generation',uid_validity:'10',folder:'INBOX',uid:1 });
  const manager = () => ({ _pendingFlagPush:new Map(),_enqueueFlagPush:ImapManager.prototype._enqueueFlagPush,_resolveFlagPush:ImapManager.prototype._resolveFlagPush });
  it('rejects missing, cross-account and unverified producer proof without looking up a new row',()=>{
    const mgr=manager();
    expect(mgr._enqueueFlagPush(account.id,'message','\\Seen',true)).toBe(false);
    expect(mgr._enqueueFlagPush(account.id,'message','\\Seen',true,{expectedSource:{...source(),account_id:'other'}})).toBe(false);
    expect(mgr._enqueueFlagPush(account.id,'message','\\Seen',true,{expectedSource:{...source(),entity_id:null}})).toBe(false);
    expect(query).not.toHaveBeenCalled();expect(mgr._pendingFlagPush.size).toBe(0);
  });
  it('copies source proof and invalidates an older in-flight toggle without adopting new coordinates',()=>{
    const mgr=manager(),original=source();
    mgr._enqueueFlagPush(account.id,'message','\\Seen',true,{expectedSource:original});
    const first=mgr._pendingFlagPush.get(account.id).get('message:\\Seen');
    original.uid=99;expect(first.expectedSource.uid).toBe(1);expect(Object.isFrozen(first.expectedSource)).toBe(true);
    first.attempts=2;
    mgr._enqueueFlagPush(account.id,'message','\\Seen',false,{expectedSource:source()});
    const next=mgr._pendingFlagPush.get(account.id).get('message:\\Seen');
    expect(first.resolved).toBe(true);expect(next).toMatchObject({value:false,attempts:2,expectedSource:{uid:1}});
    mgr._resolveFlagPush(account.id,'message','\\Seen');expect(next.resolved).toBe(true);expect(mgr._pendingFlagPush.size).toBe(0);
  });
});
