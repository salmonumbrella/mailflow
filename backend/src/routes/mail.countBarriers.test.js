import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
vi.mock('../index.js', () => ({ imapManager: { _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(), bulkMoveMessages: vi.fn(), scheduleCountRefresh: vi.fn(), broadcast: vi.fn(), syncFolderOnDemand: vi.fn() } }));
vi.mock('../utils/mailUtils.js', async original => ({ ...await original(), resolveArchiveFolder: async () => 'All Mail', isAllMailFolder: vi.fn().mockResolvedValue(true), adjustFolderCounts: vi.fn() }));
import router from './mail.js';
import { query, withTransaction } from '../services/db.js';
import { imapManager } from '../index.js';
import { isAllMailFolder, adjustFolderCounts } from '../utils/mailUtils.js';
const account = '00000000-0000-4000-8000-000000000001';
const rows = [1, 2].map(n => ({ id: `00000000-0000-4000-8000-00000000000${n + 1}`, account_id: account, uid: n, folder: n === 1 ? 'INBOX' : 'Sent', is_read: false, category: 'primary', provider_msgid: null, source_uid_validity: null, is_archive_residue: false, is_deleted: false }));
async function call(path, method, body = {}) {
  let response;
  const res = { json: value => { response = value; }, set: () => res, status: () => res };
  const handler = router.stack.find(r => r.route?.path === path && r.route.methods[method]).route.stack.at(-1).handle;
  await handler({ body, query: {}, session: { userId: 'u' } }, res);
  return response;
}
beforeEach(() => {
  vi.clearAllMocks(); isAllMailFolder.mockResolvedValue(true);
  // Model the SQL-only callback client, preserving query/provider event order.
  withTransaction.mockImplementation(work => work({ query }));
});
it('returns physical count targets after provider and DB success without a route settlement barrier', async () => {
  const events = [];
  query.mockImplementation(async (sql, params) => {
    if (sql.includes('jsonb_to_recordset')) return { rows: rows.filter(row => JSON.parse(params[0]).some(s => s.id === row.id)) };
    if (sql.includes('SELECT m.*')) return { rows };
    if (sql.includes('SELECT * FROM email_accounts')) return { rows: [{ id: account }] };
    if (sql.includes('DELETE FROM messages')) { events.push('db'); return { rows: rows.filter(row => params[0].includes(row.id)).map(row => ({ ...row, source_id: row.id })), rowCount: params[0].length }; }
    if (sql.includes('nextval')) { events.push('barrier'); return { rows: [{ revision: '20' }] }; }
    return { rows: [] };
  });
  imapManager.bulkMoveMessages.mockImplementation(async (_a, uids) => {
    events.push('provider');
    return { uidMap: new Map(), succeeded: uids.filter(uid => uid === 1), failed: uids.filter(uid => uid !== 1) };
  });
  const result = await call('/messages/bulk-archive', 'post', { ids: rows.map(r => r.id) });
  expect(result.countBarrierRevision).toBeUndefined();
  expect(query.mock.calls.some(([sql]) => sql.includes('nextval'))).toBe(false);
  expect(result.countTargets).toEqual([{ id: rows[0].id, account_id: account, folder: 'INBOX', category: 'primary', is_read: false }]);
  expect(events.at(-1)).toBe('db');
  expect(events.slice(0, -1).every(event => event === 'provider')).toBe(true);
  expect(imapManager.scheduleCountRefresh).toHaveBeenCalledWith(account, expect.arrayContaining(['INBOX']));
});
it('does not acknowledge a DB failure after a provider write', async () => {
  query.mockImplementation(async sql => {
    if (sql.includes('SELECT m.*')) return { rows: [rows[0]] };
    if (sql.includes('SELECT * FROM email_accounts')) return { rows: [{ id: account }] };
    if (sql.includes('DELETE FROM messages')) throw new Error('write failed');
    return { rows: [] };
  });
  imapManager.bulkMoveMessages.mockResolvedValue({ uidMap: new Map(), succeeded: [1], failed: [] });
  const response = await call('/messages/bulk-archive', 'post', { ids: [rows[0].id] });
  expect(response.countBarrierRevision).toBeUndefined();
  expect(response).toMatchObject({ archived: [], countTargets: [], unconfirmed: [rows[0].id] });
  expect(fenceWarnings).toHaveBeenCalledTimes(1);
  expect(fenceWarnings).toHaveBeenCalledWith('Post-provider message write is unconfirmed:', 'write failed');
  fenceWarnings.mockClear();
  expect(query.mock.calls.some(([sql]) => sql.includes('nextval'))).toBe(false);
});
it('category observations allocate their own pre-query DB fence and report local totals', async () => {
  query.mockImplementation(async sql => sql.includes('email_accounts') ? { rows: [{ id: account }] }
    : sql.includes('nextval') ? { rows: [{ revision: '21' }] }
      : { rows: [{ account_id: account, category: 'primary', unread_count: 3, total_count: 5 }] });
  const result = await call('/category-counts', 'get');
  expect(result).toMatchObject({ counts: { primary: 3 }, totals: { primary: 5 }, countRevision: '21' });
  expect(query.mock.calls.findIndex(([sql]) => sql.includes('nextval'))).toBeLessThan(query.mock.calls.findIndex(([sql]) => sql.includes('GROUP BY')));
});

it('scopes identically named Archive destinations by account when only one is Gmail All Mail', async () => {
  const second = '00000000-0000-4000-8000-000000000009';
  const owned = [rows[0], { ...rows[1], account_id: second, folder: 'INBOX' }];
  const writes = [];
  isAllMailFolder.mockImplementation(async id => id === account);
  query.mockImplementation(async (sql, params) => {
    if (sql.includes('jsonb_to_recordset')) return { rows: owned.filter(row => JSON.parse(params[0]).some(s => s.id === row.id)) };
    if (sql.includes('SELECT m.*')) return { rows: owned };
    if (sql.includes('SELECT * FROM email_accounts')) return { rows: [{ id: params[0] }] };
    if (sql.includes('DELETE FROM messages') || sql.includes('INSERT INTO messages')) {
      writes.push({ sql, ids: params[0] });
      return { rows: owned.filter(row => params[0].includes(row.id)).map(row => ({ ...row, source_id: row.id,
        ...(sql.includes('INSERT INTO messages') ? { destination_id: `destination-${row.id}` } : {}) })), rowCount: params[0].length };
    }
    return { rows: sql.includes('nextval') ? [{ revision: '20' }] : [] };
  });
  imapManager.bulkMoveMessages.mockImplementation(async (_a, uids) => ({ uidMap: new Map(uids.map(uid => [Number(uid), Number(uid) + 100])), succeeded: uids, failed: [] }));
  await call('/messages/bulk-archive', 'post', { ids: owned.map(m => m.id) });
  expect(writes.find(w => w.sql.includes('INSERT INTO messages'))?.ids).toEqual([rows[1].id]);
  expect(adjustFolderCounts).toHaveBeenCalledWith(second, 'All Mail', 1, 1);
});

// Unexpected fence/programming failures must fail these positive fixtures.
let fenceWarnings;
beforeEach(() => { fenceWarnings = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { try { expect(fenceWarnings).not.toHaveBeenCalled(); } finally { fenceWarnings.mockRestore(); } });
