import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); } }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('../services/encryption.js', () => ({ decrypt: vi.fn(() => 'synthetic') }));
vi.mock('../services/hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('../services/aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('../services/pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('../index.js', async () => {
  const { ImapManager } = await import('../services/imapManager.js');
  return { imapManager: new ImapManager(null) };
});
import express from 'express';
import draftRoutes from './draft.js';
import { imapManager } from '../index.js';
import { query } from '../services/db.js';
import { removeLabel, removeExactLabelCopy } from '../services/labels.js';
import { evictPool } from '../services/imapManager.js';
import { ImapFlow } from 'imapflow';
import { pluginRegistry } from '../plugins/registry.js';
import { resolveForConnection } from '../services/hostValidation.js';
import { getConnectionPolicy } from '../services/connectionPolicy.js';
const A = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const account = { id: A, user_id: 'user-1', imap_host: '127.0.0.1', imap_port: 993, imap_tls: true,
  auth_user: 'synthetic', auth_pass: 'synthetic', folder_mappings: { drafts: 'Drafts' } };
const ids = range => String(range).split(',').map(Number);
const key = (folder, uid) => `${folder}:${uid}`;
let server, base, live, cache, counts, deletes, dbDeletes, countWrites, client, afterExpunge, refuseDelete, beforeCapture;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/mail', draftRoutes);
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/mail`;
});
afterAll(async () => {
  for (const timer of ['_healthCheckTimer', '_snippetSchedulerTimer', '_stalenessCheckTimer', '_flagPushReconcilerTimer']) clearInterval(imapManager[timer]);
  await new Promise(r => server.close(r));
});
beforeEach(() => {
  deletes = []; dbDeletes = []; countWrites = []; afterExpunge = null; refuseDelete = false; beforeCapture = null;
  live = new Map(); cache = new Map(); counts = new Map();
  for (const folder of ['Drafts', 'Labels/Todo']) {
    live.set(folder, new Map([[11, { id: '<other@test>', flags: new Set() }],
      [77, { id: '<expected@test>', flags: new Set() }],
      [99, { id: '<already-deleted@test>', flags: new Set(['\\Deleted']) }]]));
    cache.set(key(folder, 11), { id: folder === 'Drafts' ? 'b0000000-0000-4000-8000-000000000001' : 'b0000000-0000-4000-8000-000000000002', uid: 11, folder, account_id: A, message_id: '<expected@test>', is_read: false, is_deleted: false });
    counts.set(folder, { total: 1, unread: 1 });
  }
  const result = rows => ({ rows, rowCount: rows.length });
  query.mockReset().mockImplementation(async (raw, p = []) => {
    const sql = raw.replace(/\s+/g, ' ').trim();
    if (sql.startsWith('SELECT * FROM email_accounts')) return result([account]);
    if (sql.startsWith('SELECT') && sql.includes('FROM messages')) {
      if (sql.startsWith('SELECT uid')) {
        const row = cache.get(key(p[1], Number(p[2])));
        return result(row && row.message_id === p[3] ? [{ uid: row.uid }] : []);
      }
      beforeCapture?.(); beforeCapture = null;
      const row = cache.get(key(p[2], Number(p[1])));
      return result(row && !row.is_deleted ? [{ ...row }] : []);
    }
    if (sql.startsWith('DELETE FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3')) {
      const k = key(p[2], Number(p[1])); const row = cache.get(k);
      if (!row || (sql.includes('is_deleted = false') && row.is_deleted) || (sql.includes('id = $4') && row.id !== p[3]) || (sql.includes('message_id = $5') && row.message_id !== p[4])) return result([]);
      cache.delete(k); dbDeletes.push(k);
      return result(row ? [{ is_read: row.is_read }] : []);
    }
    if (sql.startsWith('WITH prev AS (') && sql.includes('UPDATE folders f')) {
      const count = counts.get(p[3]); count.total += p[0]; count.unread += p[1]; countWrites.push([p[3], p[0], p[1]]);
      return result([{ unread_clamped: false, total_clamped: false }]);
    }
    return result([]);
  });
  client = Object.assign(new EventEmitter(), { usable: true, capabilities: new Map([['MOVE', true]]),
    connect: async () => {}, noop: async () => true, close: () => {}, logout: async () => {},
    getMailboxLock: async folder => { client.mailbox = { path: folder, exists: 3, uidValidity: 7n }; client.locked = true; return { release() { client.locked = false; } }; },
    search: async (q, opts) => {
      expect(client.locked).toBe(true); expect(opts).toEqual({ uid: true });
      const folder = live.get(client.mailbox.path);
      if (q.uid) return ids(q.uid).filter(uid => folder.has(uid));
      if (q.deleted) return [...folder].filter(([, m]) => m.flags.has('\\Deleted')).map(([uid]) => uid);
      const expected = Object.entries(q.header || {}).find(([name]) => name.toLowerCase() === 'message-id')?.[1];
      if (expected != null) return [...folder].filter(([, m]) => m.id.includes(expected)).map(([uid]) => uid);
      throw new Error(`Unexpected SEARCH ${JSON.stringify(q)}`);
    },
    fetch: async function* (range, q, opts) {
      expect(client.locked).toBe(true); expect(q.envelope).toBe(true); expect(opts).toEqual({ uid: true });
      for (const uid of ids(range)) {
        const m = live.get(client.mailbox.path).get(uid); if (m) yield { uid, envelope: { messageId: m.id } };
      }
    },
    messageFlagsAdd: async (range, flags, opts) => {
      expect(client.locked).toBe(true); expect(opts).toEqual({ uid: true });
      for (const uid of ids(range)) for (const flag of flags) live.get(client.mailbox.path).get(uid)?.flags.add(flag);
      return true;
    },
    messageFlagsRemove: async (range, flags, opts) => {
      expect(client.locked).toBe(true); expect(opts).toEqual({ uid: true });
      for (const uid of ids(range)) for (const flag of flags) live.get(client.mailbox.path).get(uid)?.flags.delete(flag);
      return true;
    },
    messageDelete: async (range, opts) => {
      expect(client.locked).toBe(true); expect(opts).toEqual({ uid: true });
      if (refuseDelete) return false;
      const folder = live.get(client.mailbox.path);
      // No UIDPLUS: EXPUNGE removes every currently Deleted message.
      for (const [uid, m] of folder) if (m.flags.has('\\Deleted')) { deletes.push([client.mailbox.path, uid, m.id]); folder.delete(uid); }
      afterExpunge?.();
      return true;
    },
  });
  ImapFlow.mockImplementation(function () { return client; });
  resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'] });
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
  vi.spyOn(imapManager, 'broadcast').mockImplementation(() => {});
  vi.spyOn(pluginRegistry, 'runHook').mockResolvedValue(undefined);
});
afterEach(async () => { await evictPool(A); vi.restoreAllMocks(); });
const snapshot = (consumer, folder, response) => ({ consumer, response,
  wrongLivePreserved: live.get(folder).has(11), correctLivePreserved: live.get(folder).has(77),
  unrelatedDeletedPreserved: live.get(folder).get(99)?.flags.has('\\Deleted'),
  cacheRowPreserved: cache.has(key(folder, 11)), counts: counts.get(folder), deletes, dbDeletes, countWrites,
});
describe('raw draft and label-copy deletion through real consumers', () => {
  const unique = folder => { live.get(folder).get(11).id = '<expected@test>'; live.get(folder).delete(77); };
  const rawDelete = uid => fetch(`${base}/draft/${encodeURIComponent(uid)}?accountId=${A}&folder=Drafts`, { method: 'DELETE' });
  it('forwards explicit refusal through the real plugin facade', async () => {
    unique('Labels/Todo');
    expect(await imapManager.pluginFacade.removeMessageCopy(A, 11, 'Labels/Todo', { expectMessageId: null })).toBe(0);
    expect(deletes).toEqual([]); expect(cache.has(key('Labels/Todo', 11))).toBe(true);
  });
  it('retains the original label expectation when the cache now identifies another message', async () => {
    const message = { ...cache.get(key('Labels/Todo', 11)) };
    cache.get(key('Labels/Todo', 11)).message_id = '<other@test>';
    expect(await removeLabel(imapManager, message, 'Labels/Todo')).toEqual({ removed: false });
    expect(deletes).toEqual([]); expect(countWrites).toEqual([]);
  });
  it('rechecks exact label identity after its cache witness is replaced before remover capture', async () => {
    unique('Labels/Todo');
    const message = { ...cache.get(key('Labels/Todo', 11)) };
    beforeCapture = () => { cache.get(key('Labels/Todo', 11)).message_id = '<other@test>'; live.get('Labels/Todo').get(11).id = '<other@test>'; };
    expect(await removeExactLabelCopy(imapManager, message, 'Labels/Todo', 11)).toEqual({ removed: false });
    expect(deletes).toEqual([]); expect(countWrites).toEqual([]);
  });
  for (const uid of [[11], {}, '11junk', '1:77', 0, -1, 4294967296]) it(`refuses nonscalar or invalid copy UID ${JSON.stringify(uid)}`, async () => {
    expect(await imapManager.removeMessageCopy(A, uid, 'Labels/Todo')).toBe(0); expect(deletes).toEqual([]);
  });
  for (const consumer of ['draft', 'copy']) it(`${consumer} refuses a missing or soft-deleted cache witness`, async () => {
    const folder = consumer === 'draft' ? 'Drafts' : 'Labels/Todo'; unique(folder); cache.get(key(folder, 11)).is_deleted = true;
    if (consumer === 'draft') expect((await rawDelete(11)).status).toBe(409);
    else expect(await imapManager.removeMessageCopy(A, 11, folder)).toBe(0);
    expect(deletes).toEqual([]); expect(dbDeletes).toEqual([]); expect(countWrites).toEqual([]);
  });

  for (const uid of ['11junk', '0', '-1', '1:77', '11,77', '*', '4294967296', '9007199254740993']) {
    it(`rejects a whole invalid uint32 draft UID ${uid} before any destructive operation`, async () => {
      expect((await rawDelete(uid)).status).toBe(400); expect(deletes).toEqual([]); expect(dbDeletes).toEqual([]);
    });
  }
  for (const consumer of ['draft', 'copy']) for (const identity of [null, '<@>', '<same@test>']) {
    it(`${consumer} refuses missing, malformed or reused cache identity ${identity}`, async () => {
      const folder = consumer === 'draft' ? 'Drafts' : 'Labels/Todo';
      cache.get(key(folder, 11)).message_id = identity;
      live.get(folder).get(11).id = identity;
      if (identity === '<same@test>') live.get(folder).get(77).id = identity;
      if (consumer === 'draft') expect((await rawDelete(11)).status).toBe(409);
      else expect(await imapManager.removeMessageCopy(A, 11, folder)).toBe(0);
      expect(deletes).toEqual([]); expect(dbDeletes).toEqual([]); expect(countWrites).toEqual([]);
      expect(pluginRegistry.runHook).not.toHaveBeenCalled();
    });
  }
  for (const expectation of [null, undefined, '<@>', '<other@test>']) {
    it(`never downgrades an explicit invalid copy expectation ${String(expectation)}`, async () => {
      unique('Labels/Todo');
      expect(await imapManager.removeMessageCopy(A, 11, 'Labels/Todo', { expectMessageId: expectation })).toBe(0);
      expect(deletes).toEqual([]); expect(dbDeletes).toEqual([]); expect(countWrites).toEqual([]);
    });
  }
  for (const consumer of ['draft', 'copy']) {
    it(`${consumer} preserves a concurrently soft-deleted cache row after server confirmation`, async () => {
      const folder = consumer === 'draft' ? 'Drafts' : 'Labels/Todo'; unique(folder);
      afterExpunge = () => { cache.get(key(folder, 11)).is_deleted = true; counts.set(folder, { total: 0, unread: 0 }); };
      if (consumer === 'draft') expect((await rawDelete(11)).status).toBe(200);
      else expect(await imapManager.removeMessageCopy(A, 11, folder)).toBe(0);
      expect(cache.get(key(folder, 11))?.is_deleted).toBe(true);
      expect(dbDeletes).toEqual([]); expect(countWrites).toEqual([]); expect(pluginRegistry.runHook).not.toHaveBeenCalled();
    });

    it(`${consumer} preserves cache and counts when the server refuses the expunge`, async () => {
      const folder = consumer === 'draft' ? 'Drafts' : 'Labels/Todo'; unique(folder); refuseDelete = true;
      if (consumer === 'draft') expect((await rawDelete(11)).status).toBe(500);
      else await expect(imapManager.removeMessageCopy(A, 11, folder)).rejects.toThrow('server did not confirm');
      expect(cache.has(key(folder, 11))).toBe(true); expect(dbDeletes).toEqual([]); expect(countWrites).toEqual([]);
    });
    it(`${consumer} preserves a replacement cache UUID after confirmed server deletion`, async () => {
      const folder = consumer === 'draft' ? 'Drafts' : 'Labels/Todo'; unique(folder);
      const replacement = { ...cache.get(key(folder, 11)), id: 'c0000000-0000-4000-8000-000000000003', message_id: '<replacement@test>' };
      afterExpunge = () => cache.set(key(folder, 11), replacement);
      if (consumer === 'draft') expect((await rawDelete(11)).status).toBe(200);
      else expect(await imapManager.removeMessageCopy(A, 11, folder)).toBe(0);
      expect(cache.get(key(folder, 11))).toEqual(replacement); expect(dbDeletes).toEqual([]); expect(countWrites).toEqual([]);
      expect(pluginRegistry.runHook).not.toHaveBeenCalled();
      expect(deletes).toEqual([[folder, 11, '<expected@test>']]);
    });
    it(`${consumer} confirms a unique live UID and preserves an unrelated Deleted message`, async () => {
      const folder = consumer === 'draft' ? 'Drafts' : 'Labels/Todo'; unique(folder);
      if (consumer === 'draft') expect((await rawDelete(11)).status).toBe(200);
      else expect(await imapManager.removeMessageCopy(A, 11, folder)).toBe(1);
      expect(cache.has(key(folder, 11))).toBe(false); expect(deletes).toEqual([[folder, 11, '<expected@test>']]);
      expect(live.get(folder).get(99).flags.has('\\Deleted')).toBe(true);
      if (consumer === 'copy') expect(counts.get(folder)).toEqual({ total: 0, unread: 0 });
    });
  }

  it('draft DELETE refuses a cached Message-ID that differs from the live UID', async () => {
    const response = await fetch(`${base}/draft/11?accountId=${A}&folder=Drafts`, { method: 'DELETE' });
    const observed = snapshot('DELETE /draft/:uid', 'Drafts', { status: response.status, body: await response.json() });
    expect(observed).toMatchObject({ wrongLivePreserved: true, correctLivePreserved: true, cacheRowPreserved: true, deletes: [], dbDeletes: [] });
  });
  it('removeMessageCopy refuses a cached Message-ID that differs from the live UID', async () => {
    const removed = await imapManager.removeMessageCopy(A, 11, 'Labels/Todo');
    const observed = snapshot('removeMessageCopy', 'Labels/Todo', { removed });
    expect(observed).toMatchObject({ wrongLivePreserved: true, correctLivePreserved: true, cacheRowPreserved: true,
      counts: { total: 1, unread: 1 }, deletes: [], dbDeletes: [], countWrites: [] });
  });
  it.each(['Drafts', 'Labels/Todo'])('control: real permanentDeleteMessage with an expected identity refuses %s', async folder => {
    expect(await imapManager.permanentDeleteMessage(account, 11, folder, { expectMessageId: '<expected@test>' })).toBe(false);
    expect(snapshot('expected-identity control', folder, {})).toMatchObject({ wrongLivePreserved: true,
      correctLivePreserved: true, cacheRowPreserved: true, deletes: [], dbDeletes: [], countWrites: [] });
  });
});
