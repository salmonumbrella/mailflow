// PR24 L2: strict boolean archive integrity verdict plus actual queue bookkeeping.
// Regression target: returning the raw archive batch object/undefined, returning
// before the held batch settles, or treating every deferred run as handled.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn(function () { throw new Error('No provider client in archive verdict control'); }) }));
vi.mock('./db.js', () => ({ query: vi.fn(), withTransaction: vi.fn(() => { throw new Error('No transaction in archive verdict control'); }) }));
vi.mock('./messageParser.js', () => ({ parseMessage: vi.fn(), parseMailboxList: vi.fn(), buildSnippetFromHtml: vi.fn(), snippetFromBody: vi.fn(), decodeMimeWords: vi.fn(), detectBulkFromParsedHeaders: vi.fn(), parseRawHeaders: vi.fn(), enrichParsedMetadata: vi.fn(parsed => parsed) }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn() }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('../utils/redact.js', () => ({ redactEmail: vi.fn() }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('./spamPipeline.js', () => ({ classifyAndTagMessage: vi.fn() }));
vi.mock('./mailAccess.js', () => ({ getAccountAddresses: vi.fn(async () => []) }));

import { ImapManager } from './imapManager.js';
import { query } from './db.js';

const account = { id: 'archive-verdict.test', user_id: 'owner.test', imap_host: 'imap.gmail.com' };
const folder = 'Étiquettes/Tous'; // Localized All Mail reaches the real observed-folder queue.
const key = `${account.id}:${folder}`;
const observed = { uidValidity: 9n, uidNext: 4, highestModseq: 12n, messages: 3, unseen: 1 };
const outcomes = [
  ['retained batch result', { stored: 3, suppressed: 1, pending: false }, true],
  ['zero-admission pending result', { stored: 0, suppressed: 0, pending: true }, true],
  ['budget-deferral envelope', { pending: true, deferAt: 70000 }, true],
  ['coalesced undefined', undefined, false],
  ['absent null', null, false],
];
let warn;
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  query.mockImplementation(async (sql, params) => {
    expect(params).toEqual([account.id, folder]);
    if (sql === 'SELECT special_use FROM folders WHERE account_id=$1 AND path=$2') {
      return { rows: [{ special_use: '\\All' }] };
    }
    if (sql === 'UPDATE folders SET status_sync_attempted_at=NOW() WHERE account_id=$1 AND path=$2') {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected DB work in archive verdict control: ${sql}`);
  });
});
afterEach(() => vi.restoreAllMocks());

function managerFor(result) {
  return Object.assign(Object.create(ImapManager.prototype), {
    _statusSyncBackoff: new Map(), _statusSyncRunning: new Set(),
    backfillRunning: new Set(), onDemandSyncing: new Set(),
    runArchiveCoverageBatch: vi.fn().mockResolvedValue(result),
    _withCountClient: () => { throw new Error('Archive verdict must not enter ordinary folder integrity'); },
  });
}

// Observe the real queue's finally, rather than using sleeps or copying its chain.
function queueFinished(manager) {
  return new Promise(resolve => {
    const remove = manager._statusSyncRunning.delete.bind(manager._statusSyncRunning);
    vi.spyOn(manager._statusSyncRunning, 'delete').mockImplementation(value => {
      const removed = remove(value);
      resolve();
      return removed;
    });
  });
}

describe('archive observed-folder boolean verdict', () => {
  it.each(outcomes)('returns the explicit verdict for %s', async (_name, result, expected) => {
    const manager = managerFor(result);
    expect(await manager._refreshObservedFolder(account, folder, observed)).toBe(expected);
    expect(manager.runArchiveCoverageBatch).toHaveBeenCalledTimes(1);
    expect(manager.runArchiveCoverageBatch).toHaveBeenCalledWith(account);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      'SELECT special_use FROM folders WHERE account_id=$1 AND path=$2', [account.id, folder]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('waits for the retained archive result before returning true', async () => {
    const manager = managerFor(undefined);
    let release, started;
    const entered = new Promise(resolve => { started = resolve; });
    manager.runArchiveCoverageBatch.mockImplementation(() => new Promise(resolve => {
      release = resolve;
      started();
    }));
    const result = manager._refreshObservedFolder(account, folder, observed);
    let settled = false;
    result.then(() => { settled = true; });
    try {
      await entered;
      await Promise.resolve();
      expect(settled).toBe(false);
    } finally {
      release?.({ stored: 0, suppressed: 0, pending: true });
    }
    expect(await result).toBe(true);
  });

  it('propagates an archive error instead of certifying success', async () => {
    const manager = managerFor(undefined);
    const error = new Error('synthetic.test archive failure');
    manager.runArchiveCoverageBatch.mockRejectedValue(error);
    await expect(manager._refreshObservedFolder(account, folder, observed)).rejects.toBe(error);
  });
});

describe('archive observed-folder retry bookkeeping', () => {
  it.each(outcomes)('settles the real queue after %s', async (_name, result, complete) => {
    const manager = managerFor(result);
    manager._statusSyncBackoff.set(key, { failures: 2, until: 0 });
    const finished = queueFinished(manager);
    expect(manager._queueObservedFolder(account, folder, observed)).toBe(true);
    expect(manager._statusSyncRunning.has(key)).toBe(true);
    await finished;
    expect(manager._statusSyncRunning.has(key)).toBe(false);
    if (complete) expect(manager._statusSyncBackoff.has(key)).toBe(false);
    else expect(manager._statusSyncBackoff.get(key)).toEqual({ failures: 3, until: 241000 });
    expect(manager.runArchiveCoverageBatch).toHaveBeenCalledTimes(1);
    expect(manager.runArchiveCoverageBatch).toHaveBeenCalledWith(account);
    expect(query).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('retains the existing retry ladder and releases ownership after a rejected batch', async () => {
    const manager = managerFor(undefined);
    manager._statusSyncBackoff.set(key, { failures: 2, until: 0 });
    manager.runArchiveCoverageBatch.mockRejectedValue(new Error('synthetic.test archive failure'));
    const finished = queueFinished(manager);
    expect(manager._queueObservedFolder(account, folder, observed)).toBe(true);
    await finished;
    expect(manager._statusSyncRunning.has(key)).toBe(false);
    expect(manager._statusSyncBackoff.get(key)).toEqual({ failures: 3, until: 241000 });
    expect(manager.runArchiveCoverageBatch).toHaveBeenCalledTimes(1);
    expect(manager.runArchiveCoverageBatch).toHaveBeenCalledWith(account);
    expect(query).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `Folder integrity sync failed for account ${account.id}: synthetic.test archive failure`);
  });
});
