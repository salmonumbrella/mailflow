// Preflight authoring only: UNRUN. Logical 4b must reject residue source actions
// before side effects; slice 5 will add supported Gmail label semantics later.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
vi.mock('../services/safeFetch.js', () => ({ safeFetch: vi.fn() }));
vi.mock('../services/spamModelStore.js', () => ({ updateIncrementalForUser: vi.fn() }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: {
  hasActiveAsync: vi.fn(), runHook: vi.fn(),
} }));
vi.mock('../index.js', () => ({ imapManager: Object.fromEntries([
  '_guardMoveUid', '_unguardMoveUid', 'moveMessage', 'moveMessageGetNewUid',
  'bulkMoveMessages', 'permanentDeleteMessage', 'bulkPermanentDelete',
  'copyMessage', 'removeMessageCopy', 'createFolder', 'emptyFolder', 'deleteFolder',
  'wakeSnoozed', 'snoozedRows', 'markRead', 'markStarred', 'bulkMarkRead',
  'bulkMarkStarred', 'broadcast', 'scheduleCountRefresh', 'syncFolderOnDemand',
  'setFlag', '_resolveFlagPush', '_enqueueFlagPush',
].map(name => [name, vi.fn()])) }));

import routes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { safeFetch } from '../services/safeFetch.js';
import { updateIncrementalForUser } from '../services/spamModelStore.js';
import { pluginRegistry } from '../plugins/registry.js';

const normalId = '11111111-1111-4111-8111-111111111111';
const residueId = '22222222-2222-4222-8222-222222222222';
const accountId = '33333333-3333-4333-8333-333333333333';
const normal = { id: normalId, account_id: accountId, uid: 7, folder: 'INBOX',
  user_id: 'owner', enabled: true, message_id: '<same@example.test>',
  provider_msgid: '9007199254740993', is_archive_residue: false };
const residue = { ...normal, id: residueId, uid: 23, folder: 'Étiquettes/Tous',
  is_archive_residue: true, list_unsubscribe: '<https://example.test/unsubscribe>' };

// Invoke the actual registered handler without opening a listener or IMAP client.
// These are owned, valid targets: ordinary validation/404 errors do not prove
// that the residue guard ran. A useful rejection identifies archive/residue.
async function invoke(method, path, body = {}, id = residueId) {
  const layer = routes.stack.find(item => item.route?.path === path && item.route.methods[method]);
  expect(layer, `${method} ${path} remains covered`).toBeDefined();
  const req = { params: { id }, body, query: {}, session: { userId: 'owner' } };
  const res = { statusCode: 200, body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; } };
  await layer.route.stack.at(-1).handle(req, res, error => { throw error; });
  return res;
}

function ownedTargets(targets) {
  query.mockImplementation(async sql => {
    if (/SELECT[\s\S]*FROM messages m[\s\S]*JOIN email_accounts a/i.test(sql)) {
      // A real DB cannot return a classification omitted from the projection.
      const projection = sql.slice(0, sql.search(/\bFROM\b/i));
      if (!/m\.\*|\bis_archive_residue\b/.test(projection)) {
        return { rows: targets.map(target => {
          const row = { ...target };
          delete row.is_archive_residue;
          return row;
        }) };
      }
      return { rows: targets };
    }
    throw new Error(`Residue rejection must precede further reads/writes: ${sql}`);
  });
}

function expectRejectedWithoutEffects(response) {
  expect(response.statusCode).toBeGreaterThanOrEqual(400);
  expect(response.statusCode).toBeLessThan(500);
  expect(response.body?.error).toMatch(/archive|residue/i);
  for (const method of Object.values(imapManager)) expect(method).not.toHaveBeenCalled();
  expect(safeFetch).not.toHaveBeenCalled();
  expect(updateIncrementalForUser).not.toHaveBeenCalled();
  expect(pluginRegistry.runHook).not.toHaveBeenCalled();
  expect(query).toHaveBeenCalledTimes(1);
}

beforeEach(() => {
  vi.resetAllMocks();
  pluginRegistry.hasActiveAsync.mockResolvedValue(false);
  pluginRegistry.runHook.mockResolvedValue(undefined);
});

describe('archive residue source guard (4b; no safe-action fallback yet)', () => {
  it.each([
    ['delete', '/messages/:id', {}],
    ['post', '/messages/:id/copy', { folder: 'Projects' }],
    ['post', '/messages/:id/spam', {}],
    ['post', '/messages/:id/ham', {}],
    ['post', '/messages/:id/snooze', { until: new Date(Date.now() + 86400000).toISOString() }],
    ['patch', '/messages/:id/snooze', { until: new Date(Date.now() + 86400000).toISOString() }],
    ['post', '/messages/:id/unsnooze', {}],
    ['patch', '/messages/:id/category', { category: 'primary' }],
    ['post', '/messages/:id/unsubscribe', {}],
  ])('rejects owned residue at %s %s before any effects', async (method, path, body) => {
    ownedTargets([residue]);
    expectRejectedWithoutEffects(await invoke(method, path, body));
  });

  it.each([
    ['/messages/bulk-delete', {}],
    ['/messages/bulk-move', { folder: 'Projects' }],
    ['/messages/bulk-archive', {}],
  ])('rejects a residue-only batch at %s', async (path, body) => {
    ownedTargets([residue]);
    expectRejectedWithoutEffects(await invoke('post', path, { ...body, ids: [residueId] }));
  });

  for (const order of [[normal, residue], [residue, normal]]) {
    it.each([
      ['/messages/bulk-delete', {}],
      ['/messages/bulk-move', { folder: 'Projects' }],
      ['/messages/bulk-archive', {}],
    ])(`rejects the entire mixed batch at %s when first target is ${order[0].folder}`, async (path, body) => {
      ownedTargets(order);
      expectRejectedWithoutEffects(await invoke('post', path, { ...body, ids: order.map(row => row.id) }));
    });
  }

  it('rejects mixed mutations for any valid batch size, residue position and bulk action', async () => {
    // No dependency install is authorized during preflight. API checked against
    // hegeldev/hegel-typescript README; dependency/runtime validation is pending.
    const hegel = await import('@hegeldev/hegel');
    const gs = await import('@hegeldev/hegel/generators');
    await hegel.testAsync(async tc => {
      const count = tc.draw(gs.integers({ minValue: 1, maxValue: 500 }));
      const residueAt = tc.draw(gs.integers({ minValue: 0, maxValue: count - 1 }));
      const action = tc.draw(gs.integers({ minValue: 0, maxValue: 2 }));
      const path = ['/messages/bulk-delete', '/messages/bulk-move', '/messages/bulk-archive'][action];
      const targets = Array.from({ length: count }, (_, index) => ({
        ...(index === residueAt ? residue : normal), uid: index + 1,
        id: `44444444-4444-4444-8444-${String(index + 1).padStart(12, '0')}`,
      }));
      // Reset between generated examples so one rejected input cannot mask an
      // earlier side effect, or inherit another example's provider calls.
      vi.clearAllMocks();
      ownedTargets(targets);
      expectRejectedWithoutEffects(await invoke('post', path, {
        ids: targets.map(row => row.id), ...(action === 1 ? { folder: 'Projects' } : {}),
      }));
    });
  });

  it.each([
    ['/messages/:id/read', { read: true }, '\\Seen'],
    ['/messages/:id/read', { read: false }, '\\Seen'],
    ['/messages/:id/star', { starred: true }, '\\Flagged'],
    ['/messages/:id/star', { starred: false }, '\\Flagged'],
  ])('permits the flag-only exception at %s using the residue physical locator', async (path, body, flag) => {
    const account = { id: accountId, user_id: 'owner' };
    query.mockImplementation(async sql => {
      if (sql.includes('FROM messages m')) return { rows: [{ ...residue, sibling_count: 1 }] };
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
      if (/^UPDATE messages SET is_(read|starred)/.test(sql.trim())) return { rows: [] };
      if (sql.includes('UPDATE folders')) return { rows: [] };
      throw new Error(`Unexpected flag-only query: ${sql}`);
    });
    const response = await invoke('patch', path, body);
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ ok: true });
    expect(imapManager.setFlag).toHaveBeenCalledTimes(1);
    expect(imapManager.setFlag).toHaveBeenCalledWith(account, residue.uid, residue.folder, flag, body.read ?? body.starred);
    for (const name of ['moveMessage', 'bulkMoveMessages', 'copyMessage', 'removeMessageCopy',
      'permanentDeleteMessage', 'bulkPermanentDelete', 'wakeSnoozed']) {
      expect(imapManager[name]).not.toHaveBeenCalled();
    }
    expect(imapManager._enqueueFlagPush).not.toHaveBeenCalled();
  });

  it('keeps ordinary Gmail Inbox-to-All-Mail archive working', async () => {
    const account = { id: accountId, user_id: 'owner' };
    query.mockImplementation(async sql => {
      if (sql.includes('FROM messages m')) return { rows: [normal] };
      if (sql.includes('FROM folders')) return { rows: [{ path: residue.folder, special_use: '\\All' }] };
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
      if (/^\s*(DELETE FROM messages|UPDATE folders)/.test(sql)) return { rows: [] };
      throw new Error(`Unexpected normal archive query: ${sql}`);
    });
    imapManager.bulkMoveMessages.mockResolvedValue({
      uidMap: new Map([[normal.uid, residue.uid]]), succeeded: [normal.uid], failed: [],
    });
    const response = await invoke('post', '/messages/bulk-archive', { ids: [normalId] });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ ok: true, archived: [normalId] });
    expect(imapManager.bulkMoveMessages).toHaveBeenCalledTimes(1);
    expect(imapManager.bulkMoveMessages).toHaveBeenCalledWith(account, [normal.uid], 'INBOX', residue.folder);
    expect(query.mock.calls.some(([sql]) => /INSERT INTO messages/.test(sql))).toBe(false);
  });
});
