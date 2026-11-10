import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
const imap = vi.hoisted(() => ({ _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(), bulkMoveMessages: vi.fn(), broadcast: vi.fn(), pluginFacade: {} }));
vi.mock('../index.js', () => ({ imapManager: imap }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'owner' }; next(); } }));
vi.mock('../services/db.js', () => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }));
vi.mock('../services/mutedThreads.js', () => ({ verifyMutedArchive: vi.fn(async () => true) }));
vi.mock('../services/sendHold.js', () => ({ getSendStatus: vi.fn() }));
vi.mock('../services/ownership.js', async original => ({ ...await original(), findOwnedMessages: vi.fn() }));
vi.mock('../utils/mailUtils.js', async original => ({ ...await original(), resolveArchiveFolder: vi.fn(async () => 'Archive'), isAllMailFolder: vi.fn(async () => false), adjustFolderCounts: vi.fn() }));
import express from 'express';
import routes from './mail.js';
import { query } from '../services/db.js';
import { verifyMutedArchive } from '../services/mutedThreads.js';
import { getSendStatus } from '../services/sendHold.js';
import { findOwnedMessages } from '../services/ownership.js';
const accountId = '22222222-2222-4222-8222-222222222222';
const id = '33333333-3333-4333-8333-333333333333';
const afterSend = { pendingId: '11111111-1111-4111-8111-111111111111', accountId, threadId: 'original-thread', inReplyTo: '<original>' };
const original = { id, account_id: accountId, uid: 2, folder: 'INBOX', thread_id: afterSend.threadId, is_read: true, folder_mappings: {} };
let server, base;
beforeAll(async () => { const app = express(); app.use(express.json(), routes); await new Promise(resolve => { server = app.listen(0, resolve); }); base = `http://127.0.0.1:${server.address().port}`; });
afterAll(() => new Promise(resolve => server.close(resolve)));
beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue({ rows: [{ id: accountId, user_id: 'owner' }], rowCount: 1 });
  findOwnedMessages.mockResolvedValue([original]);
  getSendStatus.mockResolvedValue({ status: 'sent', result: { ok: true } });
  imap.bulkMoveMessages.mockResolvedValue({ uidMap: new Map([[2, 7]]), succeeded: [2], failed: [] });
});
async function archive(extra = { afterSend }) {
  const response = await fetch(`${base}/messages/bulk-archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id], ...extra }) });
  return { status: response.status, body: await response.json() };
}
it('the endpoint independently refuses every non-confirmed status before IMAP moves or guards', async () => {
  for (const status of ['pending', 'sending', 'failed', 'cancelled', 'unknown', 'lost']) {
    getSendStatus.mockResolvedValue({ status });
    expect((await archive()).status).toBe(409);
  }
  expect(imap.bulkMoveMessages).not.toHaveBeenCalled(); expect(imap._guardMoveUid).not.toHaveBeenCalled();
});
it('confirmed archive uses only the captured original thread/account/INBOX rows', async () => {
  expect(await archive()).toEqual({ status: 200, body: { ok: true, archived: [id], noArchiveFolder: [] } });
  expect(getSendStatus).toHaveBeenCalledWith('owner', afterSend.pendingId);
  expect(imap.bulkMoveMessages).toHaveBeenCalledWith(expect.objectContaining({ id: accountId }), [2], 'INBOX', 'Archive');
  expect(imap._unguardMoveUid).toHaveBeenCalledWith(accountId, 'INBOX', 2);
});
it('moved, other-thread or other-account IDs are never acted on by Send + Archive', async () => {
  for (const change of [{ folder: 'Trash' }, { thread_id: 'newly-selected' }, { account_id: 'other' }, { is_deleted: true }]) {
    findOwnedMessages.mockResolvedValue([{ ...original, ...change }]);
    expect((await archive()).body.archived).toEqual([]);
  }
  expect(imap.bulkMoveMessages).not.toHaveBeenCalled();
});
it('ordinary archive remains independent of the send receipt', async () => {
  expect((await archive({})).body.archived).toEqual([id]);
  expect(getSendStatus).not.toHaveBeenCalled();
});

it('mute guard errors are returned before any IMAP action', async () => {
  for (const status of [400, 404, 409]) {
    verifyMutedArchive.mockRejectedValueOnce(Object.assign(new Error('Mute changed'), { status }));
    expect((await archive({ muteGuard: { revision: 1 } })).status).toBe(status);
  }
  expect(imap.bulkMoveMessages).not.toHaveBeenCalled(); expect(imap._guardMoveUid).not.toHaveBeenCalled();
});
