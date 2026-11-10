import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/messageIdentity.js', () => import('../services/testSupport/identityTestAdapter.js'));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({
  imapManager: { setFlag: vi.fn(), _resolveFlagPush: vi.fn(), _enqueueFlagPush: vi.fn(), markAllReadImap: vi.fn(), scheduleCountRefresh: vi.fn(), broadcast: vi.fn() },
}));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { pluginRegistry } from '../plugins/registry.js';

const ACCOUNT_ID = 'e5e5e5e5-5555-4555-8555-e5e5e5e5e5e5';
const ACCOUNT = { id: ACCOUNT_ID, storage_generation: 'test-generation', user_id: 'user-1' };
const source = (id = 'a', uid = 5) => ({ id, uid, folder: 'INBOX', account_id: ACCOUNT_ID, storage_generation: ACCOUNT.storage_generation, uid_validity: '10', entity_id: id, is_read: false });
let sources;
const database = (sql, params = []) => {
  if (sql.startsWith('UPDATE messages SET is_read = $1')) sources = sources.map(row => ({ ...row, is_read: params[0] }));
  return Promise.resolve({ rows: sql.includes('FROM email_accounts') ? [ACCOUNT]
    : sql.includes(' FROM messages WHERE id=$1') ? sources.filter(row => row.id === params[0]).map(row => ({ ...row }))
    : sql.includes(' FROM messages WHERE account_id = $1 AND folder = $2') ? sources.map(row => ({ ...row })) : [] });
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', mailRoutes);
  return app;
}

// The count refresh asks the IMAP server for UNSEEN. Mark all read answers before its \Seen
// write is done (a large folder is written in chunks), and the refresh used to be scheduled
// beside that write: its STATUS, 5s later, could find the folder still unread and put the old
// count back on the badge.
describe('POST /api/mail/mark-all-read', () => {
  let server, base;
  beforeAll(async () => { await new Promise(r => { server = buildApp().listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  beforeEach(() => {
    query.mockReset();
    sources = [source()];
    query.mockImplementation(database);
    imapManager.setFlag.mockReset();
    imapManager._enqueueFlagPush.mockReset();
    imapManager._resolveFlagPush.mockReset();
    imapManager.markAllReadImap.mockReset();
    imapManager.scheduleCountRefresh.mockReset();
    imapManager.broadcast.mockReset();
  });

  const markAllRead = () => fetch(`${base}/api/mail/mark-all-read`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: ACCOUNT_ID, folder: 'INBOX' }),
  });

  it('captures only identity and flag metadata for the whole folder', async () => {
    imapManager.setFlag.mockResolvedValue();
    expect((await markAllRead()).status).toBe(200);
    const [sql] = query.mock.calls.find(([text]) => text.includes(' FROM messages WHERE account_id = $1 AND folder = $2'));
    const projection = sql.slice('SELECT '.length, sql.indexOf(' FROM messages'));
    expect(projection.split(', ')).toEqual(['id', 'account_id', 'storage_generation', 'uid_validity', 'entity_id',
      'uid', 'folder', 'message_id', 'is_read', 'is_starred', 'is_deleted']);
  });

  it('answers without waiting for the IMAP write, and refreshes counts only once it is done', async () => {
    let finishWrite;
    imapManager.setFlag.mockReturnValue(new Promise(resolve => { finishWrite = resolve; }));
    const res = await markAllRead();
    expect(res.status).toBe(200);
    expect(imapManager.setFlag).toHaveBeenCalledWith(ACCOUNT, 5, 'INBOX', '\\Seen', true, { expectedSource: source() });
    expect(imapManager.markAllReadImap).not.toHaveBeenCalled();
    expect(imapManager.broadcast).toHaveBeenCalledWith({ type: 'sync_complete', accountId: ACCOUNT_ID }, 'user-1');
    expect(imapManager.scheduleCountRefresh).not.toHaveBeenCalled();
    finishWrite();
    await vi.waitFor(() => expect(imapManager.scheduleCountRefresh).toHaveBeenCalledWith(ACCOUNT_ID, ['INBOX']));
  });

  it('still refreshes counts when the IMAP write fails', async () => {
    imapManager.setFlag.mockRejectedValue(new Error('NO [THROTTLED]'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await markAllRead()).status).toBe(200);
      await vi.waitFor(() => expect(imapManager.scheduleCountRefresh).toHaveBeenCalledWith(ACCOUNT_ID, ['INBOX']));
      expect(warn).toHaveBeenCalledWith('IMAP flag update failed:', 'NO [THROTTLED]');
    } finally {
      warn.mockRestore();
    }
  });

  it('passes exact captured sources, so later mail and reused UIDs are never in the write', async () => {
    imapManager.setFlag.mockResolvedValue();
    sources = [source('a', 7), source('b', 12), source('c', 9)];
    expect((await markAllRead()).status).toBe(200);
    expect(imapManager.setFlag).toHaveBeenCalledTimes(3);
    for (const row of sources) expect(imapManager.setFlag).toHaveBeenCalledWith(ACCOUNT, row.uid, 'INBOX', '\\Seen', true, { expectedSource: { ...row, is_read: false } });
    expect(imapManager.markAllReadImap).not.toHaveBeenCalled();
  });

  it('still writes \\Seen to the folder when the label copies step fails', async () => {
    imapManager.setFlag.mockResolvedValue();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const active = vi.spyOn(pluginRegistry, 'hasActiveAsync').mockRejectedValue(new Error('connection reset'));
    try {
      expect((await markAllRead()).status).toBe(200);
      expect(imapManager.setFlag).toHaveBeenCalledWith(ACCOUNT, 5, 'INBOX', '\\Seen', true, { expectedSource: source() });
      expect(warn).toHaveBeenCalledWith('Mark-all-read label copies failed:', 'connection reset');
    } finally {
      warn.mockRestore();
      active.mockRestore();
    }
  });
});
