import { afterEach, expect, it, vi } from 'vitest';
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
import { query } from './db.js';
import { ImapManager } from './imapManager.js';
import { FolderStatusMonitor } from './folderStatus.js';
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it('registers refresh debt before account lookup and retries a transient lookup failure', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  let lookups = 0;
  query.mockImplementation(async sql => {
    if (sql.includes('SELECT * FROM email_accounts')) { if (++lookups === 1) throw new Error('DB unavailable'); return { rows: [{ id: 'a' }] }; }
    if (sql.includes('SELECT f.*')) return { rows: [{ path: 'INBOX' }] };
    return { rows: [{ revision: '20', started_at: new Date(), id: 'f' }] };
  });
  const withClient = vi.fn(async (_a, fn) => fn({ status: async () => ({ messages: 1, unseen: 1, uidNext: 2, uidValidity: 1n }) }));
  const mgr = Object.create(ImapManager.prototype);
  mgr.folderStatusMonitor = new FolderStatusMonitor({ withClient, enqueueSync: () => false, broadcast: vi.fn() });
  mgr.scheduleCountRefresh('a', ['INBOX']);
  expect(mgr.folderStatusMonitor.trailing.has('a')).toBe(true);
  await vi.advanceTimersByTimeAsync(5000);
  expect(lookups).toBe(2);
  expect(withClient).toHaveBeenCalledOnce();
  expect(mgr.folderStatusMonitor.trailing.has('a')).toBe(false);
});
