import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createSearchIndexLifecycle } from './searchIndexLifecycle.js';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn(async () => ({ rows: [] })), withTransaction: vi.fn() }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: value => value, encrypt: value => value }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(async () => ({ host: '127.0.0.1' })), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn(async () => ({})) }));
import { ImapFlow } from 'imapflow';
import { ImapManager } from './imapManager.js';

const account = { id: '11111111-1111-4111-8111-111111111111', user_id: 'schedule-owner',
  imap_host: 'imap.example.test', imap_tls: true, email_address: 'synthetic@example.test', password: 'synthetic' };
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };

// Exercise actual tick/finally and start/lifecycle methods. The metadata sync and
// network transport are controlled boundaries; no constructor timers or DB. UNRUN.
describe('existing sync ticks drive body catch-up after cleanup', () => {
  let manager, client, activeSlots, observed;
  beforeEach(() => {
    vi.useFakeTimers(); observed = [];
    manager = Object.create(ImapManager.prototype);
    for (const name of ['syncThrottleSkips', 'syncStartedAt', 'connections', '_connectCooldown', 'syncIntervals',
      'syncTickCount', 'lastSyncOkAt', 'userFolderSyncIntervalMs', 'lastFolderSyncAt', '_pendingFlagSync']) manager[name] = new Map();
    manager.syncingAccounts = new Set(); manager.connectingAccounts = new Set();
    manager.lastFolderSyncAt.set(account.id, Date.now());
    manager.syncIntervals.set(account.id, 'existing-registration');
    manager._clearAccountError = vi.fn(async () => {});
    manager._recordAccountError = vi.fn(async () => {});
    manager._syncAgainIfMailArrived = vi.fn();
    manager._syncFlagsForRange = vi.fn(async () => {});
    manager.broadcast = vi.fn(); manager.syncMessages = vi.fn(async () => ({ insertedCount: 0 }));
    activeSlots = 0;
    manager._bgConnSem = { acquire: async () => { activeSlots++; }, release: () => { activeSlots--; } };
    client = Object.assign(new EventEmitter(), { usable: true, closed: false,
      connect: async () => {}, close() { this.closed = true; } });
    manager.connections.set(account.id, client);
    ImapFlow.mockImplementation(function () { return client; });
    manager._searchIndex = createSearchIndexLifecycle({ invalidateRun: async () => {}, runBatch: async () => {
      observed.push({ syncing: manager.syncingAccounts.has(account.id), slots: activeSlots, closed: client.closed });
    } });
  });
  afterEach(async () => { await manager._searchIndex.quiesce(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each(['_syncTick', '_pollOnlyTick'])('%s starts the real lifecycle after releasing its sync guard and transport slot', async method => {
    await manager[method](account); await flush();
    expect(observed).toEqual([{ syncing: false, slots: 0, closed: method === '_pollOnlyTick' }]);
    expect(manager.syncingAccounts.has(account.id)).toBe(false);
  });

  it.each(['_syncTick', '_pollOnlyTick'])('%s cannot restart indexing after its registration was removed while metadata was pending', async method => {
    const entered = gate(), release = gate();
    manager.syncMessages.mockImplementation(async () => { entered.resolve(); await release.promise; return {}; });
    const tick = manager[method](account); await entered.promise;
    manager.syncIntervals.delete(account.id); release.resolve(); await tick; await flush();
    expect(observed).toEqual([]);
  });

  it.each(['_syncTick', '_pollOnlyTick'])('%s completes metadata independently of a held body batch', async method => {
    const release = gate(); let entered = false;
    manager._searchIndex = createSearchIndexLifecycle({ invalidateRun: async () => {}, runBatch: async () => {
      entered = true; await release.promise;
    } });
    try {
      await manager[method](account); await flush();
      expect(entered).toBe(true);
      expect(manager.syncingAccounts.has(account.id)).toBe(false);
      expect(activeSlots).toBe(0);
    } finally { release.resolve(); await manager._searchIndex.settled(account.id); }
  });

  it.each(['_syncTick', '_pollOnlyTick'])('%s cannot reopen a globally quiesced lifecycle', async method => {
    await manager._searchIndex.quiesce();
    await manager[method](account); await flush();
    expect(observed).toEqual([]);
    expect(manager._searchIndex.isOpen(account.id)).toBe(false);
  });
});
