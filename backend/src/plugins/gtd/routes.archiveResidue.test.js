// Synthetic route/capability integration; no listener or provider connection.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../../middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
vi.mock('./gtdConfig.js', async importOriginal => ({ ...(await importOriginal()), getGtdConfig: vi.fn() }));
vi.mock('../../utils/mailUtils.js', async importOriginal => ({
  ...(await importOriginal()), resolveArchiveFolder: vi.fn(), isAllMailFolder: vi.fn(), adjustFolderCounts: vi.fn(),
}));

import routes from './routes.js';
import { setMailEngine } from '../mailEngine.js';
import { query } from '../../services/db.js';
import { getGtdConfig, DEFAULT_GTD_FOLDERS } from './gtdConfig.js';
import { resolveArchiveFolder, isAllMailFolder, adjustFolderCounts } from '../../utils/mailUtils.js';

const id = '11111111-1111-4111-8111-111111111111';
const residueId = '22222222-2222-4222-8222-222222222222';
const accountId = '33333333-3333-4333-8333-333333333333';
const archive = 'Étiquettes/Tous';
const normal = { id, account_id: accountId, uid: 10, folder: 'Watch', message_id: '<normal@example.test>',
  thread_key: 'synthetic-thread', is_read: false, is_archive_residue: false };
const residue = { ...normal, id: residueId, uid: 23, folder: archive, is_archive_residue: true };
const account = { id: accountId, user_id: 'owner', imap_host: 'imap.gmail.com', folder_mappings: {} };
const engine = Object.fromEntries(['ensureFolder', 'copyMessage', 'hasMessageCopy', 'removeMessageCopy',
  'setFlag', 'moveMessage', '_guardMoveUid', '_unguardMoveUid', 'broadcast', 'isLabelStore'].map(name => [name, vi.fn()]));

async function invoke(method, path, body) {
  const layer = routes.stack.find(item => item.route?.path === path && item.route.methods[method]);
  expect(layer).toBeDefined();
  const req = { body, session: { userId: 'owner' }, query: {}, params: {} };
  const res = { statusCode: 200, body: undefined,
    status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  await layer.route.stack.at(-1).handle(req, res, error => { throw error; });
  return res;
}

beforeEach(() => {
  vi.resetAllMocks();
  setMailEngine(engine);
  getGtdConfig.mockResolvedValue({ enabled: true, folders: DEFAULT_GTD_FOLDERS });
  engine.isLabelStore.mockReturnValue(true);
  engine.copyMessage.mockResolvedValue(90);
  engine.hasMessageCopy.mockResolvedValue(true);
  resolveArchiveFolder.mockResolvedValue(archive);
  isAllMailFolder.mockResolvedValue(true);
});

describe('GTD residue actions are known not applied', () => {
  it.each([
    ['post', '/classify', { messageId: residueId, state: 'todo' }],
    ['post', '/classify/undo', { messageId: residueId, state: 'todo', folder: 'Todo', uid: 77 }],
    ['delete', '/classify', { messageId: residueId, state: 'todo' }],
    ['post', '/done', { id: residueId, states: ['watch'] }],
  ])('%s %s returns the stable 409 before config, account, writes or provider calls', async (method, path, body) => {
    query.mockImplementation(async sql => {
      if (sql.includes('SELECT m.*') && sql.includes('JOIN email_accounts')) return { rows: [residue] };
      throw new Error(`Guard must precede further reads/writes: ${sql}`);
    });
    const response = await invoke(method, path, body);
    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({ code: 'archive-residue-read-only',
      error: 'This action is not supported for archive residue' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(getGtdConfig).not.toHaveBeenCalled();
    for (const method of Object.values(engine)) expect(method).not.toHaveBeenCalled();
    expect(resolveArchiveFolder).not.toHaveBeenCalled();
    expect(isAllMailFolder).not.toHaveBeenCalled();
    expect(adjustFolderCounts).not.toHaveBeenCalled();
  });
});

describe('ordinary Gmail thread with an All Mail residue sibling', () => {
  it.each(['classify', 'done'])('%s leaves the residue out of provider and move/label writes', async action => {
    // G3(a): residue exists ONLY in the special-use All Mail folder. GTD
    // candidates project no classification flag; their state-folder filter,
    // and Done's GTD-folder/INBOX targets, must provide the real protection.
    const inbox = { ...normal, id: '44444444-4444-4444-8444-444444444444', uid: 11, folder: 'INBOX' };
    const cached = [{ ...normal }, inbox, { ...residue }];
    const physical = (uid, folder) => cached.find(row => row.uid === uid && row.folder === folder);
    engine.copyMessage.mockImplementation(async (_accountId, uid, from, to) => {
      expect(physical(uid, from)?.is_archive_residue).toBe(false);
      expect(to).toBe('Todo');
      return 90;
    });
    engine.removeMessageCopy.mockImplementation(async (_accountId, uid, folder) => {
      expect(physical(uid, folder)?.is_archive_residue).toBe(false);
      expect(folder).toBe('Watch');
    });
    engine.moveMessage.mockImplementation(async (_account, uid, from, to) => {
      expect(physical(uid, from)?.is_archive_residue).toBe(false);
      expect([uid, from, to]).toEqual([11, 'INBOX', archive]);
      return 91;
    });
    query.mockImplementation(async (sql, params) => {
      if (sql.includes('SELECT m.*') && sql.includes('JOIN email_accounts')) return { rows: [cached[0]] };
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [account] };
      if (sql.includes('thread_key = ANY($2::text[])')) return { rows: cached.map(row => ({
        thread_key: row.thread_key, uid: row.uid, folder: row.folder, message_id: row.message_id,
        from_email: 'synthetic@example.test', date: '2026-10-01', id: row.id,
      })) };
      if (sql.startsWith('SELECT DISTINCT folder FROM messages')) return { rows: cached.map(row => ({ folder: row.folder })) };
      if (sql.startsWith('SELECT id, uid, is_read FROM messages')) return { rows: [{ ...inbox }] };
      if (sql.startsWith('SELECT uid FROM messages')) return { rows: cached.filter(row => row.folder === params[1]) };
      // Preserve the existing markThreadRead DB fan-out. It may mark a residue
      // sibling read; it must not repoint, relabel or delete that physical row.
      if (sql.startsWith('UPDATE messages SET is_read')) {
        for (const row of cached) row.is_read = true;
        return { rows: [] };
      }
      if (sql.startsWith('DELETE FROM messages')) {
        expect(params).toEqual([inbox.id, 'INBOX']);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected ordinary-thread query: ${sql}`);
    });
    const response = action === 'classify'
      ? await invoke('post', '/classify', { messageId: id, state: 'todo' })
      : await invoke('post', '/done', { id, states: 'all' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject(action === 'classify'
      ? { ok: true, applied: true, switched: true }
      : { ok: true, removed: ['Watch'], archived: true, archiveFailed: false });
    expect(engine.removeMessageCopy).toHaveBeenCalledWith(accountId, normal.uid, 'Watch');
    if (action === 'classify') {
      expect(engine.copyMessage).toHaveBeenCalledWith(accountId, normal.uid, 'Watch', 'Todo');
      expect(engine.moveMessage).not.toHaveBeenCalled();
    } else {
      expect(engine.copyMessage).not.toHaveBeenCalled();
      expect(engine.moveMessage).toHaveBeenCalledTimes(1);
      expect(engine.setFlag).toHaveBeenCalledExactlyOnceWith(account, inbox.uid, 'INBOX', '\\Seen', true);
    }
    expect(cached[2]).toEqual({ ...residue, is_read: action === 'done' });
  });
});
