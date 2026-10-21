import 'express-async-errors';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Selected rows claim persistent request ownership before deferred IMAP batches.
// Same-value rows fence older actions without an unnecessary STORE; conflicting
// in-flight changes still need the final server write. Failures retain matching retries.
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    broadcast: vi.fn(),
    _newFlagAction: vi.fn(() => ({ generation: 1, version: Promise.resolve('1'), marker: '2026-10-21T12:00:00Z' })),
    _admitFlagIntent: vi.fn((accountId,messageId,flag,value,action) => ({...action,accountId,messageId,flag,value})),
    _isFlagIntentCurrent: vi.fn(() => true),
    _stampFlagIntent: vi.fn(async () => true),
    isLabelStore: vi.fn(() => false),
    setFlag: vi.fn(),
    _enqueueFlagPush: vi.fn(),
    _resolveFlagPush: vi.fn(),
  },
}));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const ID_STARRED   = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const ID_UNSTARRED = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';
const ACCOUNT_ID   = 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', mailRoutes);
  return app;
}

describe('POST /api/mail/messages/bulk-star (#434)', () => {
  let server, base;
  beforeAll(async () => { await new Promise(r => { server = buildApp().listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  beforeEach(() => {
    query.mockReset();
    imapManager._admitFlagIntent.mockClear();
    imapManager._stampFlagIntent.mockClear();
    imapManager.broadcast.mockReset();
    imapManager.setFlag.mockReset().mockResolvedValue(true);
    imapManager._enqueueFlagPush.mockReset();
    imapManager._resolveFlagPush.mockReset();
    query.mockImplementation((sql, params) => {
      if (sql.includes('FROM messages m')) {
        const all = [
          { id: ID_STARRED,   uid: '11', folder: 'INBOX', is_starred: true,  account_id: ACCOUNT_ID, message_id: '<m1@x>' },
          { id: ID_UNSTARRED, uid: '12', folder: 'INBOX', is_starred: false, account_id: ACCOUNT_ID, message_id: '<m2@x>' },
        ];
        return Promise.resolve({ rows: all.filter(r => params[1].includes(r.id)) });
      }
      if (sql.includes('SELECT * FROM email_accounts')) {
        return Promise.resolve({ rows: [{ id: ACCOUNT_ID, user_id: 'user-1', imap_host: 'imap.example.com' }] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  const post = (body) => fetch(`${base}/api/mail/messages/bulk-star`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  it.each([
    [{ starred: true }, 'ids array required'],
    [{ ids: [], starred: true }, 'ids array required'],
    [{ ids: Array.from({ length: 501 }, () => ID_STARRED), starred: true }, 'Too many ids'],
    [{ ids: ['not-a-uuid'], starred: true }, 'Invalid message IDs'],
    [{ ids: [ID_STARRED], starred: 'yes' }, 'starred must be a boolean'],
  ])('rejects bad input %#', async (body, msg) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(msg);
  });

  it('writes only rows whose state changes, with the local-wins stamp', async () => {
    const res = await post({ ids: [ID_STARRED, ID_UNSTARRED], starred: true });
    expect(res.status).toBe(200);
    expect((await res.json()).updated).toEqual([ID_UNSTARRED]); // already-starred row skipped

    const intent = imapManager._admitFlagIntent.mock.results.at(-1).value;
    expect(imapManager._stampFlagIntent).toHaveBeenCalledWith({ messageId: ID_UNSTARRED, flag: '\\Flagged', value: true, intent }, true);

    // One IMAP \Flagged write, on the row that changed; confirmation drops any queued op.
    expect(imapManager.setFlag).toHaveBeenCalledTimes(1);
    expect(imapManager.setFlag.mock.calls[0].slice(1)).toEqual(['12', 'INBOX', '\\Flagged', true, { intent }]);
    expect(imapManager._resolveFlagPush).toHaveBeenCalledWith(ACCOUNT_ID, ID_UNSTARRED, '\\Flagged', intent);
    expect(imapManager._enqueueFlagPush).not.toHaveBeenCalled();

    // Other sessions get the in-place flag change.
    const flagsEvent = imapManager.broadcast.mock.calls.find(c => c[0]?.type === 'message_flags')?.[0];
    expect(flagsEvent.changes).toEqual([{ id: ID_UNSTARRED, is_starred: true }]);
  });

  it('a no-op selection touches nothing', async () => {
    const res = await post({ ids: [ID_STARRED], starred: true });
    expect((await res.json()).updated).toEqual([]);
    expect(query.mock.calls.some(([sql]) => sql.includes('SET is_starred'))).toBe(false);
    expect(imapManager.setFlag).not.toHaveBeenCalled();
  });

  it('queues a durable retry when the IMAP write fails, instead of reverting silently', async () => {
    imapManager.setFlag.mockRejectedValue(new Error('Command failed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post({ ids: [ID_UNSTARRED], starred: true });
    expect(res.status).toBe(200); // DB write stands; IMAP catches up via the queue
    expect(imapManager._enqueueFlagPush).toHaveBeenCalledWith(ACCOUNT_ID, ID_UNSTARRED, '\\Flagged', true, expect.objectContaining({ messageId: ID_UNSTARRED }));
    expect(imapManager._resolveFlagPush).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
