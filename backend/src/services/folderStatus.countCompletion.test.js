import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('./db.js', () => ({ query: vi.fn() }));
import { query } from './db.js';
import { countCompletion } from './countCompletion.js';
import { observeFolder, publicFolderCounts, FolderStatusMonitor } from './folderStatus.js';
const account = { id: 'count-account', user_id: 'count-user' };
const status = { messages: 4, unseen: 2, uidNext: 5, uidValidity: 1n };
const publicRow = { account_id: account.id, path: 'INBOX', server_count_revision: '20', server_counts_at: new Date(), server_total_count: 4, server_unread_count: 2 };
beforeEach(() => {
  countCompletion.users.clear(); countCompletion.observations.clear(); countCompletion.pending = () => 0;
  countCompletion.refresh(account.user_id, { ops: [] }, [account.id], '10');
  query.mockImplementation(async sql => sql.includes('SELECT f.*') ? { rows: [{ path: 'INBOX' }] } : sql.includes('nextval') ? { rows: [{ revision: '20', started_at: new Date() }] } : { rows: [{ id: 'f' }] });
});
afterEach(() => { vi.useRealTimers(); });
it('exposes quiescence only on the exact successful observation, capturing it before provider I/O', async () => {
  await observeFolder({ status: async () => status }, account.id, 'INBOX', () => countCompletion.observation(account.user_id, account.id));
  expect(publicFolderCounts(publicRow)).toMatchObject({ quiescentAtStart: true, refreshSeqAtStart: '10' });
  expect(publicFolderCounts({ ...publicRow, server_count_revision: '19' }).quiescentAtStart).toBe(false);
  let finishHandler, releaseStatus;
  const handler = countCompletion.run(account.user_id, null, () => new Promise(r => { finishHandler = r; }));
  query.mockImplementation(async sql => sql.includes('nextval') ? { rows: [{ revision: '21', started_at: new Date() }] } : { rows: [{ id: 'f' }] });
  const held = observeFolder({ status: () => new Promise(r => { releaseStatus = r; }) }, account.id, 'INBOX', () => countCompletion.observation(account.user_id, account.id));
  while (!releaseStatus) await Promise.resolve();
  finishHandler(); await handler; releaseStatus(status); await held;
  expect(publicFolderCounts({ ...publicRow, server_count_revision: '21' }).quiescentAtStart).toBe(false);
  await expect(observeFolder({ status: async () => false }, account.id, 'INBOX', () => countCompletion.observation(account.user_id, account.id))).rejects.toThrow('Incomplete');
  expect(publicFolderCounts({ ...publicRow, server_count_revision: '21' }).quiescentAtStart).toBe(false);
});
it('retains trailing debt while another account provider queue blocks user quiescence, then starts within three seconds', async () => {
  vi.useFakeTimers();
  countCompletion.refresh(account.user_id, { ops: [] }, [account.id, 'other-account'], '11');
  let pending = 1; countCompletion.pending = id => id === 'other-account' ? pending : 0;
  const starts = [], broadcast = vi.fn(), monitor = new FolderStatusMonitor({ withClient: async (_a, fn) => fn({ status: async () => { starts.push(Date.now()); return status; } }), enqueueSync: () => false, broadcast });
  monitor.scheduleTrailingStatus(account);
  await vi.advanceTimersByTimeAsync(10000);
  expect(starts).toEqual([]);
  expect(monitor.trailing.has(account.id)).toBe(true);
  const settled = Date.now(); pending = 0;
  await vi.advanceTimersByTimeAsync(3000);
  expect(starts).toHaveLength(1);
  expect(starts[0] - settled).toBeLessThanOrEqual(3000);
  expect(publicFolderCounts(publicRow)).toMatchObject({ quiescentAtStart: true, refreshSeqAtStart: '11' });
  expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ lease: expect.objectContaining({ token: countCompletion.lease().token }), observations: { INBOX: expect.objectContaining({ revision: '20', quiescentAtStart: true, refreshSeqAtStart: '11' }) } }), account.user_id);
});

it.each(['account lookup', 'connection acquisition'])('retains refresh debt when a handler starts during %s', async boundary => {
  vi.useFakeTimers();
  let releaseWait, finishHandler;
  const starts = [], gate = new Promise(resolve => { releaseWait = resolve; });
  const monitor = new FolderStatusMonitor({
    withClient: async (_a, fn) => { if (boundary === 'connection acquisition') await gate; return fn({ status: async () => { starts.push(countCompletion.observation(account.user_id, account.id)); return status; } }); },
    enqueueSync: () => false, broadcast: vi.fn(),
  });
  monitor.scheduleTrailingStatus(account, ['INBOX'], async () => { if (boundary === 'account lookup') await gate; return account; });
  await vi.advanceTimersByTimeAsync(100);
  const handler = countCompletion.run(account.user_id, null, () => new Promise(resolve => { finishHandler = resolve; }));
  releaseWait(); await vi.advanceTimersByTimeAsync(0);
  expect(starts).toHaveLength(1);
  expect(starts[0].quiescentAtStart).toBe(false);
  try { expect(monitor.trailing.has(account.id)).toBe(true); }
  finally { finishHandler(); await handler; }
  await vi.advanceTimersByTimeAsync(3000);
  expect(starts).toHaveLength(2);
  expect(starts[1].quiescentAtStart).toBe(true);
  expect(monitor.trailing.has(account.id)).toBe(false);
});
