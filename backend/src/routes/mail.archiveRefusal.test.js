// L2 HTTP contract: drive real routes and the real manager's DB-only guards.
// No listener, provider client or database connection is opened by this file.
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('imapflow', () => ({ ImapFlow: vi.fn(() => { throw new Error('No provider client expected'); }) }));
vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
vi.mock('../index.js', () => ({ imapManager: Object.fromEntries([
  '_assertWritableSource', 'deleteFolder', 'renameFolder', 'emptyFolder', 'copyMessage', 'broadcast',
].map(name => [name, vi.fn()])) }));
import routes from './mail.js';
import { query } from '../services/db.js';
import { ImapManager } from '../services/imapManager.js';
import { imapManager } from '../index.js';
import { ImapFlow } from 'imapflow';

const accountId = '11111111-1111-4111-8111-111111111111';
const messageId = '22222222-2222-4222-8222-222222222222';
const account = { id: accountId, user_id: 'owner', imap_host: 'imap.gmail.com', folder_mappings: {} };
const manager = { _assertWritableSource: ImapManager.prototype._assertWritableSource,
  _isArchiveFolder: ImapManager.prototype._isArchiveFolder };
let race = false, targetRead = false;
function invoke(path, body) {
  const layer = routes.stack.find(item => item.route?.path === path && item.route.methods.post);
  expect(layer).toBeDefined();
  const req = { body, params: { id: messageId }, session: { userId: 'owner' }, query: {} };
  const res = { statusCode: 200, responses: [], status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; this.responses.push({ status: this.statusCode, body: value }); return this; } };
  return { res, completion: layer.route.stack.at(-1).handle(req, res, error => { throw error; }) };
}
beforeEach(() => {
  vi.resetAllMocks(); race = false; targetRead = false;
  query.mockImplementation(async (sql, values) => {
    if (sql.includes('SELECT EXISTS')) return { rows: [{ refused: false }] };
    if (sql.includes('SELECT special_use')) {
      return { rows: [{ special_use: values[1] === 'All' || (race && targetRead && values[1] === 'Projects') ? '\\All' : null }] };
    }
    if (sql.includes('FROM messages m')) return { rows: [{ id: messageId, account_id: accountId, folder: 'INBOX', uid: 11,
      user_id: 'owner', is_archive_residue: false, folder_mappings: {} }] };
    if (sql.includes('FROM folders') && sql.includes('SELECT')) {
      if (sql.includes('delimiter')) return { rows: [{ delimiter: '/' }] };
      targetRead = true;
      return { rows: [{ path: values[1], name: values[1], no_select: false, special_use: values[1] === 'All' ? '\\All' : null }] };
    }
    if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
    throw new Error(`Refusal must precede every DB mutation: ${sql}`);
  });
  imapManager._assertWritableSource.mockImplementation((...args) => manager._assertWritableSource(...args));
  for (const method of ['deleteFolder', 'renameFolder', 'emptyFolder', 'copyMessage']) {
    imapManager[method].mockImplementation((...args) => ImapManager.prototype[method].call(manager, ...args));
  }
});

describe('archive refusal HTTP contract', () => {
  it.each([
    ['/folders/delete', { accountId, path: 'All' }],
    ['/folders/rename', { accountId, oldPath: 'All', newName: 'Renamed' }],
    ['/folders/empty', { accountId, path: 'All' }],
    ['/messages/:id/copy', { folder: 'All' }],
  ])('returns 409/code before mutation or job acceptance at %s', async (path, body) => {
    const request = invoke(path, body); await request.completion;
    expect(request.res.statusCode).toBe(409);
    expect(request.res.body).toMatchObject({ code: 'archive-residue-read-only' });
    expect(request.res.responses).toHaveLength(1);
    expect(request.res.responses.some(response => response.status === 202)).toBe(false);
    expect(ImapFlow).not.toHaveBeenCalled();
    expect(imapManager.broadcast).not.toHaveBeenCalled();
    if (path === '/folders/empty') expect(imapManager.emptyFolder).not.toHaveBeenCalled();
    if (path.includes('/copy')) expect(imapManager.copyMessage).not.toHaveBeenCalled();
  });

  it('returns 409 through the real manager destination guard when target metadata races the route read', async () => {
    race = true;
    const request = invoke('/messages/:id/copy', { folder: 'Projects' }); await request.completion;
    expect(imapManager.copyMessage).toHaveBeenCalledOnce();
    expect(request.res.statusCode).toBe(409);
    expect(request.res.body).toMatchObject({ code: 'archive-residue-read-only' });
    expect(ImapFlow).not.toHaveBeenCalled();
    expect(imapManager.broadcast).not.toHaveBeenCalled();
  });

  it.each([
    ['/folders/delete', { accountId, path: 'Projects' }, 'deleteFolder', 500],
    ['/folders/rename', { accountId, oldPath: 'Projects', newName: 'Renamed' }, 'renameFolder', 500],
    ['/messages/:id/copy', { folder: 'Projects' }, 'copyMessage', 502],
  ])('keeps the existing generic failure mapping at %s', async (path, body, method, status) => {
    imapManager[method].mockRejectedValue(Object.assign(new Error('Synthetic provider failure'), { status: '409' }));
    const request = invoke(path, body); await request.completion;
    expect(request.res.statusCode).toBe(status);
    expect(request.res.body.code).toBeUndefined();
  });

  it('answers an empty-folder preflight failure without accepting a job or rejecting the handler', async () => {
    imapManager._assertWritableSource.mockRejectedValue(new Error('Synthetic database failure'));
    const request = invoke('/folders/empty', { accountId, path: 'Projects' });
    await expect(request.completion).resolves.toBe(request.res);
    expect(request.res.responses).toEqual([{ status: 500, body: { error: 'Failed to empty folder' } }]);
    expect(imapManager.emptyFolder).not.toHaveBeenCalled();
    expect(imapManager.broadcast).not.toHaveBeenCalled();
    expect(ImapFlow).not.toHaveBeenCalled();
  });

  it('keeps ordinary empty-folder 202 and runs provider work only after the response', async () => {
    let finish;
    const finished = new Promise(resolve => { finish = resolve; });
    let release;
    const provider = new Promise(resolve => { release = resolve; });
    let responseSeen = false;
    let responseSent;
    const response = new Promise(resolve => { responseSent = resolve; });
    imapManager.emptyFolder.mockImplementation(async () => { expect(responseSeen).toBe(true); await provider; });
    imapManager.broadcast.mockImplementation(event => { if (event.type === 'folder_emptied') finish(); });
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
      if (sql.includes('SELECT EXISTS')) return { rows: [{ refused: false }] };
      if (sql.includes('SELECT special_use')) return { rows: [{ special_use: null }] };
      if (/^(DELETE|UPDATE)/.test(sql.trim())) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected ordinary empty query: ${sql}`);
    });
    // Observe the real route's response before its asynchronous provider call.
    const layer = routes.stack.find(item => item.route?.path === '/folders/empty');
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; responseSeen = true; responseSent(); return this; } };
    const completion = layer.route.stack.at(-1).handle({ body: { accountId, path: 'Projects' }, session: { userId: 'owner' } }, res);
    try { await response; expect(res.statusCode).toBe(202); expect(res.body).toEqual({ ok: true, started: true }); }
    finally { release(); await completion; await finished; }
    expect(ImapFlow).not.toHaveBeenCalled();
  });
});
