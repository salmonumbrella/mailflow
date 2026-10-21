// Source authoring only: real manager wrapper and pool lease, synthetic client
// and COMMIT-gated scanner result. Actual admission/COMMIT SQL is proved by PG.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('./archiveCoverage.js', async original => ({ ...await original(), runArchiveCoverageBatch: vi.fn() }));
vi.mock('./backgroundDownloadBudget.js', async original => ({ ...await original(),
  reserveBackgroundBudget: vi.fn(), recordBackgroundRefusal: vi.fn() }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn(() => 'synthetic') }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('./spamPipeline.js', () => ({ classifyAndTagMessage: vi.fn() }));
vi.mock('./mailAccess.js', () => ({ getAccountAddresses: vi.fn(async () => []) }));

import { ImapFlow } from 'imapflow';
import { query } from './db.js';
import { runArchiveCoverageBatch as scan } from './archiveCoverage.js';
import { reserveBackgroundBudget, recordBackgroundRefusal } from './backgroundDownloadBudget.js';
import { resolveForConnection } from './hostValidation.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { ImapManager, acquirePooledClient, releasePooledClient, evictPool } from './imapManager.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const counts = { stored: 2, suppressed: 0, pending: 0 };

describe('archive committed-ID handoff preserves public counts', () => {
  let account, manager, warnings, client;
  beforeEach(async () => {
    vi.clearAllMocks();
    account = { id: randomUUID(), user_id: 'synthetic-owner', imap_host: 'imap.gmail.com', imap_port: 993,
      imap_tls: true, auth_user: 'owner@example.test', auth_pass: 'synthetic' };
    query.mockImplementation(async sql => {
      if (sql.includes('email_accounts')) return { rows: [account] };
      throw new Error(`Unmodelled archive manager query: ${sql}`);
    });
    reserveBackgroundBudget.mockResolvedValue({ allowed: true });
    client = Object.assign(new EventEmitter(), { usable: true, connect: vi.fn(async () => {}),
      close: vi.fn(), logout: vi.fn(async () => {}), noop: vi.fn(async () => {}) });
    ImapFlow.mockImplementation(function () { return client; });
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
    const pooled = await acquirePooledClient(account); releasePooledClient(account, pooled);
    manager = Object.assign(Object.create(ImapManager.prototype), {
      _secondaryConnectBlocked: vi.fn(() => false),
      _bgConnSem: { acquire: vi.fn(async () => {}), release: vi.fn() },
      _searchIndexSources: { rescan: vi.fn() },
      enqueueCommittedSearchRows: vi.fn(async () => ({ changed: 0, deferred: false, reason: null })),
      broadcast: vi.fn(),
    });
    warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { evictPool(account.id); warnings.mockRestore(); });

  it('waits for the scanner COMMIT result and passes actual IDs only to the private helper', async () => {
    const committed = deferred(), entered = deferred(), ids = [randomUUID(), randomUUID()];
    scan.mockImplementation(() => { entered.resolve(); return committed.promise; });
    manager.enqueueCommittedSearchRows.mockImplementation(async () => {
      // Reacquiring the same single client without another construction proves
      // withFreshClient released its transport lease before the handoff.
      const released = await acquirePooledClient(account);
      try { expect(released).toBe(client); expect(ImapFlow).toHaveBeenCalledTimes(1); }
      finally { releasePooledClient(account, released); }
    });
    const running = manager.runArchiveCoverageBatch(account);
    try {
      await Promise.race([entered.promise, running.then(() => { throw new Error('Archive wrapper completed before its scanner COMMIT gate'); })]);
      expect(manager.enqueueCommittedSearchRows).not.toHaveBeenCalled();
      expect(manager.broadcast).not.toHaveBeenCalled();
    } finally { committed.resolve({ counts, admittedIds: ids }); }
    expect(await running).toEqual(counts);
    expect(manager.enqueueCommittedSearchRows).toHaveBeenCalledTimes(1);
    expect(manager.enqueueCommittedSearchRows).toHaveBeenCalledWith(account, ids);
    expect(manager.broadcast).toHaveBeenCalledTimes(1);
    expect(manager.broadcast).toHaveBeenCalledWith({
      type: 'archive_coverage_progress', accountId: account.id, phase: 'archive', ...counts,
    }, account.user_id);
    expect(warnings).not.toHaveBeenCalled();
  });

  it.each([
    ['verified-only', { stored: 1, suppressed: 0, pending: 0 }],
    ['suppressed', { stored: 0, suppressed: 1, pending: 0 }],
    ['pending', { stored: 0, suppressed: 0, pending: true }],
  ])('keeps %s count shape without empty/per-message discovery calls', async (_kind, publicCounts) => {
    scan.mockResolvedValue({ counts: publicCounts, admittedIds: [] });
    expect(await manager.runArchiveCoverageBatch(account)).toEqual(publicCounts);
    expect(manager.enqueueCommittedSearchRows).not.toHaveBeenCalled();
    expect(manager.broadcast.mock.calls[0][0]).toEqual({ type: 'archive_coverage_progress',
      accountId: account.id, phase: 'archive', ...publicCounts });
    expect(warnings).not.toHaveBeenCalled();
  });

  it.each([false, true])('keeps admission/cursor/budget/public outcome independent of rejected handoff (rescan fails=%s)', async rescanFails => {
    scan.mockResolvedValue({ counts, admittedIds: [randomUUID()] });
    manager.enqueueCommittedSearchRows.mockRejectedValue(new Error('synthetic handoff refusal'));
    if (rescanFails) manager._searchIndexSources.rescan.mockImplementation(() => { throw new Error('synthetic rescan failure'); });
    expect(await manager.runArchiveCoverageBatch(account)).toEqual(counts);
    expect(manager._searchIndexSources.rescan).toHaveBeenCalledTimes(1);
    expect(manager._searchIndexSources.rescan).toHaveBeenCalledWith(account.id);
    expect(manager.broadcast.mock.calls[0][0]).toEqual({ type: 'archive_coverage_progress',
      accountId: account.id, phase: 'archive', ...counts });
    expect(reserveBackgroundBudget).toHaveBeenCalledTimes(1);
    expect(reserveBackgroundBudget).toHaveBeenCalledWith(account.id, account.imap_host, { messages: 0, bytes: 1024 });
    expect(recordBackgroundRefusal).not.toHaveBeenCalled();
    expect(warnings).toHaveBeenCalledTimes(rescanFails ? 2 : 1);
    expect(manager._bgConnSem.release).toHaveBeenCalledTimes(1);
    expect(manager._bgConnSem.release).toHaveBeenCalledWith(account.imap_host);
  });

  it.each(['statement rollback', 'COMMIT failure'])('hands off no IDs or progress when scanner rejects for %s', async failure => {
    const error = new Error(failure); scan.mockRejectedValue(error);
    await expect(manager.runArchiveCoverageBatch(account)).rejects.toBe(error);
    expect(manager.enqueueCommittedSearchRows).not.toHaveBeenCalled();
    expect(manager.broadcast).not.toHaveBeenCalled();
    expect(recordBackgroundRefusal).not.toHaveBeenCalled();
    expect(manager._bgConnSem.release).toHaveBeenCalledTimes(1);
    expect(manager._bgConnSem.release).toHaveBeenCalledWith(account.imap_host);
    expect(warnings).not.toHaveBeenCalled();
  });

  it('hands the full500 arrival boundary to the existing bounded lifecycle helper once', async () => {
    const ids = Array.from({ length: 500 }, () => randomUUID());
    scan.mockResolvedValue({ counts: { ...counts, stored: 500 }, admittedIds: ids });
    expect(await manager.runArchiveCoverageBatch(account)).toEqual({ ...counts, stored: 500 });
    expect(manager.enqueueCommittedSearchRows).toHaveBeenCalledTimes(1);
    expect(manager.enqueueCommittedSearchRows).toHaveBeenCalledWith(account, ids);
    expect(manager.broadcast.mock.calls[0][0]).not.toHaveProperty('admittedIds');
    expect(manager.broadcast.mock.calls[0][0]).not.toHaveProperty('counts');
    expect(warnings).not.toHaveBeenCalled();
  });
});
