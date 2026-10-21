import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createSearchIndexLifecycle } from './searchIndexLifecycle.js';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn(async () => ({ rows: [] })), withTransaction: vi.fn() }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn(), encrypt: vi.fn() }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(async () => ({ host: '127.0.0.1' })), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn(async () => ({})) }));

import { ImapFlow } from 'imapflow';
import { query } from './db.js';
import { ImapManager, acquirePooledClient, releasePooledClient, evictPool } from './imapManager.js';

const gate = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const account = { id: 'index-drain-account', user_id: 'index-owner', imap_host: 'imap.example.test', imap_tls: true };

function managerFixture() {
  // Do not construct unrelated production timers. Exercise the real lifecycle,
  // pool, extractor, disconnect and quiesce methods below the scheduler boundary.
  const manager = Object.create(ImapManager.prototype);
  for (const name of ['connections', 'syncIntervals', 'pluginSyncIntervals', 'syncThrottleSkips', 'syncTickCount',
    'lastSyncOkAt', '_idleMissStreak', '_syncErrorState', '_pendingFlagSync', '_pendingNewMail',
    '_flagDebounceTimers', '_expungeDebounceTimers', '_connectCooldown']) manager[name] = new Map();
  manager._pollOnlyAccounts = new Set();
  manager.connectingAccounts = new Set();
  manager.lastUserActivity = new Map();
  manager._secondaryConnectBlocked = () => null;
  return manager;
}

beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [] });
  ImapFlow.mockReset().mockImplementation(() => { throw new Error('Unexpected replacement login'); });
});
afterEach(() => { evictPool(account.id); vi.restoreAllMocks(); });

describe('search index manager drain', () => {
  it.each(['disconnect', 'quiesce'])('evicts an IMAP read that ignores abort before awaiting %s drain', async mode => {
    const entered = gate(), closed = gate();
    const manager = managerFixture();
    const client = Object.assign(new EventEmitter(), {
      usable: true, mailbox: { path: 'INBOX', uidValidity: 19n },
      connect: async () => {}, noop: async () => {},
      close() { closed.resolve(); },
      getMailboxLock: async () => ({ release() {} }),
      fetch: async function* () {
        entered.resolve();
        // Deliberately ignores the signal; only eviction releases it.
        yield await closed.promise.then(() => { throw new Error('transport closed'); });
      },
    });
    ImapFlow.mockImplementation(function () { return client; });
    const pooled = await acquirePooledClient(account);
    releasePooledClient(account, pooled);
    ImapFlow.mockClear();
    let drained = false;
    manager._searchIndex = createSearchIndexLifecycle({
      runBatch: (_account, { signal }) => manager.fetchMessageBody(account, 42, 'INBOX', {
        purpose: 'search', uidValidity: '19', signal,
      }).finally(() => { drained = true; }),
      invalidateRun: async () => {},
    });
    await manager._searchIndex.resume(account.id);
    const active = manager._searchIndex.run(account);
    try {
      await entered.promise;
      const stopping = mode === 'disconnect' ? manager.disconnectAccount(account.id) : manager.quiesceSearchIndex();
      await vi.waitFor(() => expect(drained).toBe(true));
      await stopping;
      expect(await active).toMatchObject({ status: 'cancelled', complete: false, textParts: [] });
      expect(await manager._searchIndex.run(account)).toBeNull();
      if (mode === 'quiesce') expect(await manager._searchIndex.resume(account.id)).toBe(false);
      expect(ImapFlow).not.toHaveBeenCalled();
    } finally { closed.resolve(); await active; }
  });

  it('propagates a strict disconnect fence failure only after every account batch drains', async () => {
    const manager = managerFixture();
    const entered = gate(), release = gate();
    let drained = false;
    query.mockResolvedValue({ rows: [{ id: account.id }, { id: 'other-account' }] });
    manager._searchIndex = createSearchIndexLifecycle({
      runBatch: async () => { entered.resolve(); await release.promise; drained = true; },
      invalidateRun: async id => { if (id === account.id) throw new Error('index fence unavailable'); },
    });
    await manager._searchIndex.resume('other-account');
    const active = manager._searchIndex.run({ id: 'other-account' });
    await entered.promise;
    let settled = false;
    const stopping = manager.disconnectUser(account.user_id, { strict: true }).finally(() => { settled = true; });
    const rejected = expect(stopping).rejects.toThrow('index fence unavailable');
    try {
      await new Promise(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      release.resolve();
      await rejected;
      expect(drained).toBe(true);
    } finally { release.resolve(); await active; }
  });

  it('continues ordinary reconnect after a failed fence and keeps indexing stopped until a successful stop retry', async () => {
    const manager = managerFixture();
    let fail = true, connected = false, batches = 0;
    manager._searchIndex = createSearchIndexLifecycle({
      runBatch: async () => ++batches,
      invalidateRun: async () => { if (fail) throw new Error('index fence unavailable'); },
    });
    manager._effectivePersistentCap = () => 1;
    manager._isPersistentEligible = async () => false;
    // Stop below the transport boundary after the real reconnect/disconnect path.
    manager._startPollOnly = () => { connected = true; };
    await manager._searchIndex.resume(account.id);
    await expect(manager.connectAccount(account)).resolves.toBe(true);
    expect(connected).toBe(true);
    expect(manager.connectingAccounts.has(account.id)).toBe(false);
    expect(await manager._searchIndex.run(account)).toBeNull();
    expect(batches).toBe(0);
    await expect(manager._searchIndex.resume(account.id)).rejects.toThrow('index fence unavailable');
    await expect(manager.startSearchIndex(account)).resolves.toBeNull();
    expect(batches).toBe(0);
    fail = false;
    await manager.disconnectAccount(account.id);
    await expect(manager._searchIndex.resume(account.id)).resolves.toBe(true);
    expect(await manager._searchIndex.run(account)).toBe(1);
  });

  it('yields index admission to existing recent user activity and allows it after the quiet window', () => {
    const manager = managerFixture();
    let clock = 1800000000000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    expect(manager._searchIndexForegroundPending(account)).toBe(false);
    manager.noteUserActivity(account.id);
    expect(manager._searchIndexForegroundPending(account)).toBe(true);
    clock += 8000;
    expect(manager._searchIndexForegroundPending(account)).toBe(false);
  });

  it('resumes scheduling after a failed restore without reopening an account session', async () => {
    const manager = managerFixture();
    let batches = 0;
    manager._searchIndex = createSearchIndexLifecycle({
      runBatch: async () => ++batches, invalidateRun: async () => {},
    });
    await manager._searchIndex.resume(account.id);
    await manager.quiesceSearchIndex();
    manager.resumeSearchIndexScheduling();
    expect(await manager._searchIndex.run(account)).toBeNull();
    expect(batches).toBe(0);
    await manager._searchIndex.resume(account.id);
    expect(await manager._searchIndex.run(account)).toBe(1);
  });

  it('hands off all500 committed IDs in bounded chunks while tracked, without starting an IMAP worker',async()=>{
    const manager=managerFixture(),calls=[];
    manager._searchIndex=createSearchIndexLifecycle({runBatch:async()=>{throw new Error('Unexpected IMAP batch');},invalidateRun:async()=>{}});
    const rescans=[];
    manager._searchIndexSources=Object.assign(async()=>{}, {
      enqueueRows:async(_account,ids)=>{calls.push([...ids]);return{changed:ids.length,rejected:0,deferred:false,reason:null};},
      rescan:id=>rescans.push(id),
    });
    const ids=Array.from({length:500},(_,n)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`);
    expect(await manager.enqueueCommittedSearchRows(account,ids)).toMatchObject({changed:0,deferred:true,reason:'stopped'});
    expect(calls).toEqual([]);await manager._searchIndex.resume(account.id);
    expect(await manager.enqueueCommittedSearchRows(account,ids)).toEqual({changed:500,rejected:0,deferred:false,reason:null});
    expect(calls).toHaveLength(10);expect(calls.every(part=>part.length===50)).toBe(true);expect(calls.flat()).toEqual(ids);
    await expect(manager.enqueueCommittedSearchRows(account,[...ids,ids[0]])).rejects.toThrow('500');
    expect(rescans).toEqual([account.id]);
  });


  it.each(['active-lease','newer-contract','stale-source'])('does not restart traversal for a per-group %s handoff result',async reason=>{
    const manager=managerFixture(),rescan=vi.fn();
    manager._searchIndex=createSearchIndexLifecycle({runBatch:async()=>{},invalidateRun:async()=>{}});
    manager._searchIndexSources=Object.assign(async()=>{}, {
      enqueueRows:async()=>({changed:0,rejected:0,deferred:true,reason}),rescan,
    });
    await manager._searchIndex.resume(account.id);
    expect(await manager.enqueueCommittedSearchRows(account,['00000000-0000-4000-8000-000000000001']))
      .toEqual({changed:0,rejected:0,deferred:true,reason});
    expect(rescan).not.toHaveBeenCalled();
  });

  it('adds caller-contract rejections across chunks without treating ignored IDs as deferred',async()=>{
    const manager=managerFixture(),rescan=vi.fn();let calls=0;
    manager._searchIndex=createSearchIndexLifecycle({runBatch:async()=>{},invalidateRun:async()=>{}});
    manager._searchIndexSources=Object.assign(async()=>{}, {
      enqueueRows:async()=>({changed:0,rejected:++calls===1?0:5,deferred:false,reason:null}),rescan,
    });
    await manager._searchIndex.resume(account.id);
    const ids=Array.from({length:100},(_,n)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`);
    expect(await manager.enqueueCommittedSearchRows(account,ids)).toEqual({changed:0,rejected:5,deferred:false,reason:null});
    expect(calls).toBe(2);expect(rescan).not.toHaveBeenCalled();
  });


  const busyHandoff=async enqueueRows=>{
    const finish=gate(),manager=managerFixture(),rescan=vi.fn();
    manager._searchIndex=createSearchIndexLifecycle({runBatch:async()=>finish.promise,invalidateRun:async()=>{}});
    manager._searchIndexSources=Object.assign(async()=>{}, {enqueueRows,rescan});
    await manager._searchIndex.resume(account.id);const active=manager._searchIndex.run(account);
    return{manager,finish,active,rescan};
  };
  it.each(['Spam','Trash','eligible','rejected'])('retries busy %s IDs once after settle without waiting on the batch or resetting for no-work',async kind=>{
    const enqueueRows=vi.fn(async()=>({changed:kind==='eligible'?1:0,rejected:kind==='rejected'?1:0,deferred:false,reason:null}));
    const {manager,finish,active,rescan}=await busyHandoff(enqueueRows);
    try{
      expect(await manager.enqueueCommittedSearchRows(account,['00000000-0000-4000-8000-000000000001']))
        .toMatchObject({deferred:true,reason:'active-batch'});
      expect(enqueueRows).not.toHaveBeenCalled();expect(rescan).not.toHaveBeenCalled();
      finish.resolve();await active;await vi.waitFor(()=>expect(enqueueRows).toHaveBeenCalledTimes(1));
      await manager._searchIndex.settled(account.id);await Promise.resolve();
      expect(rescan).not.toHaveBeenCalled();
    }finally{finish.resolve();await Promise.allSettled([active,manager._searchIndex.settled(account.id)]);}
  });

  it('refuses a detached retry after quiesce with no database access and falls back to rescan',async()=>{
    const enqueueRows=vi.fn();const {manager,finish,active,rescan}=await busyHandoff(enqueueRows);
    await manager.enqueueCommittedSearchRows(account,['00000000-0000-4000-8000-000000000001']);
    const drained=manager._searchIndex.quiesce();
    finish.resolve();await Promise.allSettled([active,drained]);
    await vi.waitFor(()=>expect(rescan).toHaveBeenCalledTimes(1));
    expect(enqueueRows).not.toHaveBeenCalled();expect(query).not.toHaveBeenCalled();
  });

  it('falls back to rescan on a second busy result without scheduling a third attempt',async()=>{
    const enqueueRows=vi.fn(),second=gate();const {manager,finish,active,rescan}=await busyHandoff(enqueueRows);
    // Register before the detached continuation so the second tracked task wins.
    const next=active.then(()=>manager._searchIndex.runDiscovery(account,async()=>second.promise));
    try{
      await manager.enqueueCommittedSearchRows(account,['00000000-0000-4000-8000-000000000001']);
      finish.resolve();await active;await vi.waitFor(()=>expect(rescan).toHaveBeenCalledTimes(1));
      expect(enqueueRows).not.toHaveBeenCalled();
    }finally{second.resolve();finish.resolve();await Promise.allSettled([active,next,manager._searchIndex.settled(account.id)]);}
    await Promise.resolve();expect(enqueueRows).not.toHaveBeenCalled();
  });

  it.each(['throw','handoff-failed'])('contains detached continuation %s and preserves a healthy process',async mode=>{
    const unhandled=[],observe=error=>unhandled.push(error);process.on('unhandledRejection',observe);
    const enqueueRows=vi.fn(async()=>{
      if(mode==='throw')throw new Error('simulated continuation storage failure');
      return{changed:0,rejected:0,deferred:true,reason:'search-index-handoff-failed'};
    });
    const {manager,finish,active,rescan}=await busyHandoff(enqueueRows);
    try{
      await manager.enqueueCommittedSearchRows(account,['00000000-0000-4000-8000-000000000001']);
      finish.resolve();await active;await vi.waitFor(()=>expect(rescan).toHaveBeenCalledTimes(1));
      await Promise.allSettled([manager._searchIndex.settled(account.id)]);await Promise.resolve();
      expect(enqueueRows).toHaveBeenCalledTimes(1);expect(unhandled).toEqual([]);expect(manager._searchIndex.isOpen(account.id)).toBe(true);
    }finally{finish.resolve();await Promise.allSettled([active,manager._searchIndex.settled(account.id)]);process.removeListener('unhandledRejection',observe);}
  });

});
