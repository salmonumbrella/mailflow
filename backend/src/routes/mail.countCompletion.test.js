import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
vi.mock('../index.js', () => ({ imapManager: { _assertWritableSource: vi.fn(async () => {}), scheduleCountRefresh: vi.fn() } }));
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { ImapManager } from '../services/imapManager.js';
import { countCompletion, installProviderCountTracking } from '../services/countCompletion.js';
import mail from './mail.js';
import gtd from '../plugins/gtd/routes.js';
const uuid = '00000000-0000-4000-8000-000000000001';
const user = 'count-route.test';
const call = async (router, path, method, body = {}, opId, params = {}) => {
  let result, status = 200;
  const res = { status: code => { status = code; return res; }, json: value => { result = value; }, set: () => res };
  const handler = router.stack.find(r => r.route?.path === path && r.route.methods[method])?.route.stack.at(-1).handle;
  expect(handler, `${method} ${path}`).toBeTypeOf('function');
  await handler({ body, query: {}, params, session: { userId: user }, get: () => opId }, res);
  return { status, result };
};
beforeEach(() => { vi.clearAllMocks(); countCompletion.users.clear(); countCompletion.observations.clear(); countCompletion.pending = () => 0; });
it('refuses late dispatch before DB/provider work on every inventoried mail and GTD handler', async () => {
  const leaseToken = countCompletion.lease().token, opId = `${leaseToken}:${uuid}`;
  countCompletion.refresh(user, { ops: [{ leaseToken, uuid }] }, ['a'], '10');
  const inventory = [
    ['patch', '/messages/:id/read'], ['patch', '/messages/:id/star'], ['post', '/mark-all-read'],
    ['post', '/folders/delete'], ['post', '/folders/rename'], ['post', '/folders/empty'],
    ['post', '/messages/bulk-read'], ['post', '/messages/bulk-star'], ['post', '/messages/bulk-delete'],
    ['post', '/messages/bulk-move'], ['post', '/messages/:id/copy'], ['post', '/messages/bulk-archive'],
    ['post', '/messages/:id/snooze'], ['patch', '/messages/:id/snooze'], ['post', '/messages/:id/unsnooze'],
    ['delete', '/messages/:id'], ['post', '/messages/:id/spam'], ['patch', '/messages/:id/category'],
    ['post', '/messages/:id/unsubscribe'], ['post', '/messages/:id/ham'],
  ];
  for (const [method, path] of inventory) expect(await call(mail, path, method, {}, opId)).toMatchObject({ status: 409, result: { code: 'count-op-expired' } });
  for (const [method, path] of [['post', '/classify'], ['post', '/classify/undo'], ['delete', '/classify'], ['post', '/done']]) expect(await call(gtd, path, method, {}, opId)).toMatchObject({ status: 409, result: { code: 'count-op-expired' } });
  expect(query).not.toHaveBeenCalled();
});
it('refresh returns promptly with a sequence, registers all account trailing debt, and startup counts advertise the lease', async () => {
  query.mockImplementation(async sql => ({ rows: sql.includes('nextval') ? [{ revision: '30' }] : sql.includes('snoozed_messages') ? [] : [{ id: 'a', account_id: 'a', count: 2, server_count_revision: '29' }] }));
  let release;
  const running = countCompletion.run(user, null, () => new Promise(r => { release = r; }));
  const { result } = await call(mail, '/counts/refresh', 'post', { ops: [] });
  expect(result.refreshSeq).toBe('30');
  expect(result.epoch).toBe(countCompletion.epoch);
  expect(imapManager.scheduleCountRefresh).toHaveBeenCalledWith('a', expect.arrayContaining(['INBOX']));
  expect(countCompletion.observation(user, 'a').quiescentAtStart).toBe(false);
  release(); await running;
  const counts = (await call(mail, '/unread-counts', 'get')).result;
  expect(counts.lease.token).toBe(countCompletion.lease().token);
  expect(counts.snapshots.a.quiescentAtStart).toBe(false); // cached observation is not a refresh
});

it('a read200 with a real queued flag retry cannot certify until retry resolution or drop', async () => {
  const accountId = uuid, message = { id: uuid, account_id: accountId, uid: 1, folder: 'INBOX', is_read: false, sibling_count: 1 };
  for (const name of ['setFlag', 'markAllReadImap', 'moveMessage', 'moveMessageGetNewUid', 'copyMessage', 'bulkMoveMessages', 'permanentDeleteMessage', 'bulkPermanentDelete', 'emptyFolder']) imapManager[name] = vi.fn();
  imapManager.broadcast = vi.fn(); imapManager._pendingFlagPush = new Map();
  imapManager._enqueueFlagPush = ImapManager.prototype._enqueueFlagPush.bind(imapManager);
  imapManager._resolveFlagPush = ImapManager.prototype._resolveFlagPush.bind(imapManager);
  imapManager.setFlag.mockRejectedValue(new Error('provider unavailable'));
  countCompletion.pending = installProviderCountTracking(imapManager);
  query.mockImplementation(async sql => ({ rows: sql.includes('FROM messages m') ? [message] : sql.includes('email_accounts') ? [{ id: accountId }] : [] }));
  const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
  try { expect(await call(mail, '/messages/:id/read', 'patch', { read: true }, null, { id: uuid })).toMatchObject({ status: 200, result: { is_read: true } }); }
  finally { warn.mockRestore(); }
  countCompletion.refresh(user, { ops: [] }, [accountId], '40');
  expect(countCompletion.observation(user, accountId).quiescentAtStart).toBe(false);
  expect(imapManager._pendingFlagPush.get(accountId).size).toBe(1);
  imapManager._resolveFlagPush(accountId, uuid, '\\Seen');
  expect(countCompletion.observation(user, accountId).quiescentAtStart).toBe(true);
  imapManager._enqueueFlagPush(accountId, uuid, '\\Seen', true);
  expect(countCompletion.observation(user, accountId).quiescentAtStart).toBe(false);
  imapManager._pendingFlagPush.delete(accountId); // reconciler gives up; next STATUS reports actual provider truth
  expect(countCompletion.observation(user, accountId).quiescentAtStart).toBe(true);
});
it('the real mark-all-read handler returns200 while its fire-and-forget provider write still blocks certification', async () => {
  let release;
  imapManager.markAllReadImap = () => new Promise(r => { release = r; });
  countCompletion.pending = installProviderCountTracking(imapManager);
  query.mockResolvedValue({ rows: [{ id: uuid, user_id: user }] });
  expect(await call(mail, '/mark-all-read', 'post', { accountId: uuid })).toMatchObject({ status: 200, result: { ok: true } });
  countCompletion.refresh(user, { ops: [] }, [uuid], '41');
  expect(countCompletion.observation(user, uuid).quiescentAtStart).toBe(false);
  release(); await Promise.resolve(); await Promise.resolve();
  expect(countCompletion.observation(user, uuid).quiescentAtStart).toBe(true);
});

it('keeps the empty-folder operation running after202 until its background DB writes finish', async () => {
  let finishDelete, response;
  imapManager.emptyFolder = vi.fn(async () => {}); imapManager.broadcast = vi.fn();
  query.mockImplementation(sql => sql.startsWith('DELETE FROM messages')
    ? new Promise(resolve => { finishDelete = () => resolve({ rows: [] }); })
    : Promise.resolve({ rows: [{ id: uuid, user_id: user }] }));
  countCompletion.refresh(user, { ops: [] }, [uuid], '42');
  const opId = `${countCompletion.lease().token}:${uuid}`;
  const handler = mail.stack.find(r => r.route?.path === '/folders/empty').route.stack.at(-1).handle;
  const res = { status: code => { expect(code).toBe(202); return res; }, json: body => { response = body; } };
  const running = handler({ body: { accountId: uuid, path: 'Trash' }, session: { userId: user }, get: () => opId }, res);
  while (!finishDelete) await Promise.resolve();
  await Promise.resolve(); await Promise.resolve();
  try {
    expect(response).toEqual({ ok: true, started: true });
    expect(countCompletion.observation(user, uuid).quiescentAtStart).toBe(false);
    await expect(countCompletion.run(user, opId, () => { throw new Error('duplicate ran'); })).rejects.toMatchObject({ code: 'count-op-running' });
  } finally { finishDelete(); await running; }
  expect(countCompletion.observation(user, uuid).quiescentAtStart).toBe(true);
  expect(imapManager.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'folder_emptied', ok: true }), user);
});
