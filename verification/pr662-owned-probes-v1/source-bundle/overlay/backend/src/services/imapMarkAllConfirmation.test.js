import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn(() => 'pw') }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
import { ImapFlow } from 'imapflow';
import { ImapManager, evictPool } from './imapManager.js';
import { query } from './db.js';
import { resolveForConnection } from './hostValidation.js';
import { getConnectionPolicy } from './connectionPolicy.js';
const require = createRequire(import.meta.url);
const { searchCompiler } = require('imapflow/lib/search-compiler.js');
const realFlow = require('imapflow').ImapFlow.prototype;
const storeCommand = require('imapflow/lib/commands/store.js');
const atoms = attrs => attrs.flatMap(a => Array.isArray(a) ? atoms(a) : [a.value]);
let manager, account, client, locks, stores, rows, serial;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
beforeEach(() => {
  account = { id: `markall-${Math.random()}`, user_id: 'user-1', imap_host: '127.0.0.1', imap_port: 993,
    imap_tls: true, auth_user: 'test', auth_pass: 'enc' };
  locks = 0; stores = []; serial = 0;
  rows = new Map([[1, { id: 'row-1', uid: 1, folder: 'INBOX', message_id: '<one@test>',
    is_read: false, is_deleted: false, flag_address_valid: true, flag_uid_validity: '7', read_intent_version: '0', read_changed_at: null }]]);
  client = Object.assign(new EventEmitter(), { usable: true, connect: async () => {}, close: () => {},
    noop: async () => true, capabilities: new Map(),
    getMailboxLock: vi.fn(async folder => {
      locks++; client.mailbox = { path: folder, exists: 1001, uidValidity: 7n };
      return { release: () => {} };
    }),
    search: vi.fn(async q => { expect(atoms(searchCompiler(client, q))).toEqual(['UNSEEN']); return [1, 2]; }),
    messageFlagsAdd: vi.fn(async (range, flags, opts) => { stores.push([range, flags, opts]); return true; }),
    messageFlagsRemove: vi.fn(async () => true),
    fetch: async function* (range) {
      for (const uid of String(range).split(',').map(Number)) if (rows.has(uid)) yield { uid, flags: new Set(['\\Seen']), envelope: { messageId: rows.get(uid).message_id } };
    },
  });
  ImapFlow.mockReset().mockImplementation(function () { return client; });
  resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'] });
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
  query.mockReset().mockImplementation(async (sql, p = []) => {
    const result = found => ({ rows: found, rowCount: found.length });
    if (sql.includes('nextval(')) return result([{ version: String(++serial) }]);
    if (sql.includes('FROM email_accounts')) return result([account]);
    if (sql.startsWith('SELECT') && sql.includes('FROM messages')) {
      const found = [...rows.values()].filter(r => !r.is_deleted && (!p[1] || r.folder === p[1]));
      return result(p.length > 2 && !Array.isArray(p[2]) ? found.filter(r => r.uid === Number(p[2])) : found);
    }
    const reassert = sql.includes('SET is_read = $1');
    if (reassert || sql.includes('SET read_changed_at = $2')) {
      const row = [...rows.values()].find(r => r.id === p[reassert ? 1 : 0]);
      const version = p[reassert ? 3 : 2], marker = p[reassert ? 2 : 1];
      if (!row || BigInt(row.read_intent_version) > BigInt(version) || (row.read_intent_version === version && row.read_changed_at !== marker)) return result([]);
      if (reassert) row.is_read = p[0];
      row.read_changed_at = marker; row.read_intent_version = version; return result([{ id: row.id }]);
    }
    if (sql.includes('SET read_changed_at = CASE')) {
      const row = [...rows.values()].find(r => r.id === p[0]);
      if (row && BigInt(row.read_intent_version) <= BigInt(p[1])) {
        if (row.read_changed_at === p[2]) row.read_changed_at = null; row.read_intent_version = p[1];
      }
    }
    return result([]);
  });
  manager = new ImapManager(null); manager.syncFolderOnDemand = vi.fn(async () => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  for (const key of ['_healthCheckTimer', '_snippetSchedulerTimer', '_stalenessCheckTimer', '_flagPushReconcilerTimer']) clearInterval(manager[key]);
  await evictPool(account.id); vi.restoreAllMocks();
});
describe('mark-all production confirmation baseline', () => {
  it.each([false, true])('holds one selected lease for the whole UID Seen pass UIDPLUS=%s', async uidplus => {
    if (uidplus) client.capabilities.set('UIDPLUS', true);
    client.search.mockResolvedValue(Array.from({ length: 1001 }, (_, i) => i + 1));
    await manager.markAllReadImap(account, 'INBOX', { retryBackoffMs: 0 });
    expect(locks).toBe(1);
    expect(client.search).toHaveBeenCalledExactlyOnceWith({ seen: false }, { uid: true });
    expect(stores.map(c => c[0].split(',').length)).toEqual([500, 500, 1]);
    for (const [, flags, opts] of stores) { expect(flags).toEqual(['\\Seen']); expect(opts).toEqual({ uid: true }); }
  });
  it.each([0, 1, 499, 500, 501])('stores exactly the unseen UID set at boundary %s', async size => {
    const uids = Array.from({ length: size }, (_, i) => 11 + i);
    client.search.mockResolvedValue(uids);
    await manager.markAllReadImap(account, 'INBOX', { retryBackoffMs: 0 });
    expect(stores.flatMap(c => c[0].split(',').map(Number))).toEqual(uids);
    expect(locks).toBe(1);
  });
  it.each([0, -1, 1.5, '1:*', null, 4294967296])('rejects invalid search UID %s before STORE', async uid => {
    client.search.mockResolvedValue([1, uid]);
    await expect(manager.markAllReadImap(account, 'INBOX', { retryBackoffMs: 0 })).rejects.toThrow(/UID/i);
    expect(stores).toEqual([]);
  });
  it('compiles the actual imapflow UID STORE with additive Seen flags', async () => {
    const commands = [];
    client.state = 3; client.states = { SELECTED: 3 }; client.enabled = new Set();
    client.resolveRange = realFlow.resolveRange;
    client.run = (command, ...args) => { expect(command).toBe('STORE'); return storeCommand(client, ...args); };
    client.exec = async (command, args) => { commands.push([command, atoms(args)]); return { next() {} }; };
    client.messageFlagsAdd = (...args) => realFlow.messageFlagsAdd.call(client, ...args);
    expect(await manager.markAllReadImap(account, 'INBOX')).toBe(2);
    expect(commands).toEqual([['UID STORE', ['1,2', '+FLAGS', '\\Seen']]]);
  });
  it('preserves exactly every generated unseen set across duplicates and chunk widths', async () => {
    for (let mask = 0; mask < 16; mask++) for (let chunkSize = 1; chunkSize <= 4; chunkSize++) {
      const unseen = [11, 12, 13, 14].filter((_, bit) => mask & (1 << bit)).reverse();
      stores.length = 0;
      client.search.mockResolvedValue([...unseen, ...unseen]);
      expect(await manager._markSeenInFolder(client, 'INBOX', { chunkSize, retryBackoffMs: 0 })).toBe(unseen.length);
      expect(stores.flatMap(c => c[0].split(',').map(Number)), `mask=${mask},chunk=${chunkSize}`).toEqual(unseen);
      for (const [range, flags, opts] of stores) {
        expect(range.split(',').length).toBeLessThanOrEqual(chunkSize);
        expect(flags).toEqual(['\\Seen']); expect(opts).toEqual({ uid: true });
      }
    }
  });
  it('reports exact confirmed progress when a later chunk fails', async () => {
    client.search.mockResolvedValue(Array.from({ length: 1001 }, (_, i) => i + 1));
    client.messageFlagsAdd.mockResolvedValueOnce(true).mockResolvedValue(false);
    await expect(manager.markAllReadImap(account, 'INBOX', { retryBackoffMs: 0 })).rejects.toMatchObject({ confirmed: 500, total: 1001 });
    expect(client.messageFlagsAdd).toHaveBeenCalledTimes(3);
    expect(locks).toBe(1);
  });
  it('retries a refused chunk on the same selected session and confirms only after true', async () => {
    client.messageFlagsAdd.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await manager.markAllReadImap(account, 'INBOX', { retryBackoffMs: 0 })).toBe(2);
    expect(client.messageFlagsAdd.mock.calls).toEqual([['1,2', ['\\Seen'], { uid: true }], ['1,2', ['\\Seen'], { uid: true }]]);
    expect(locks).toBe(1);
  });
  it('surfaces an unconfirmed STORE instead of silently completing', async () => {
    client.messageFlagsAdd.mockResolvedValue(false);
    await expect(manager.markAllReadImap(account, 'INBOX', { retryBackoffMs: 0 })).rejects.toThrow(/confirm/i);
  });
  it.each([false, null, undefined])('rejects failed SEARCH %s instead of counting it as an empty folder', async result => {
    client.search.mockResolvedValue(result);
    await expect(manager.markAllReadImap(account, 'INBOX', { retryBackoffMs: 0 })).rejects.toThrow(/search/i);
    expect(stores).toEqual([]);
  });
  it('rechecks later foreground ownership after the chunk retry delay', async () => {
    client.search.mockResolvedValue([1]);
    const refused = deferred(); let seen = false; let attempt = 0;
    client.messageFlagsAdd.mockImplementation(async () => {
      if (++attempt === 1) { refused.resolve(); return false; }
      seen = true; return true;
    });
    manager.connections.set(account.id, { usable: true, noop: async () => true,
      mailbox: { path: 'INBOX', uidValidity: 7n }, getMailboxLock: async () => ({ release() {} }), messageFlagsRemove: async () => { seen = false; return true; } });
    const pass = manager.markAllReadImap(account, 'INBOX', { retryBackoffMs: 30 });
    await refused.promise;
    await manager.setFlag(account, 1, 'INBOX', '\\Seen', false);
    const outcome = await pass.catch(err => err);
    if (outcome instanceof Error) expect(outcome).toMatchObject({ confirmed: 0 });
    expect(seen).toBe(false);
  });
  it.each(['search', 'between-chunks'])('stops if the selected UIDVALIDITY changes during %s', async when => {
    client.search.mockImplementation(async () => {
      if (when === 'search') client.mailbox.uidValidity = 8n;
      return Array.from({ length: 501 }, (_, i) => i + 1);
    });
    const store = client.messageFlagsAdd;
    client.messageFlagsAdd = vi.fn(async (...args) => { const result = await store(...args); client.mailbox.uidValidity = 8n; return result; });
    await expect(manager.markAllReadImap(account, 'INBOX', { retryBackoffMs: 0 })).rejects.toThrow(/UIDVALIDITY/);
    expect(stores).toHaveLength(when === 'search' ? 0 : 1);
  });
  it.each([1, 500, 501])('does not certify the last STORE after epoch drift for %s UIDs', async size => {
    const last = { ...rows.get(1), id: 'last-row', uid: size };
    rows.clear(); rows.set(size, last);
    client.search.mockResolvedValue(Array.from({ length: size }, (_, i) => i + 1));
    const store = client.messageFlagsAdd; let commands = 0;
    client.messageFlagsAdd = vi.fn(async (...args) => {
      const result = await store(...args);
      if (++commands === Math.ceil(size / 500)) client.mailbox.uidValidity = 8n;
      return result;
    });
    const outcome = await manager.markAllReadImap(account, 'INBOX', { retryBackoffMs: 0 }).catch(err => err);
    expect(outcome).toMatchObject({ uidValidityChanged: true, confirmed: size > 500 ? 500 : 0 });
    expect(manager._pendingFlagPush.get(account.id)?.get('last-row:\\Seen')).toMatchObject({ messageId: 'last-row', value: true });
    expect(last.read_changed_at).not.toBe(null); expect(last.flag_uid_validity).toBe('7');
  });
  it('keeps a newer healthy-IDLE unread confirmation made during SEARCH', async () => {
    const entered = deferred(), release = deferred();
    let seen = false;
    client.search.mockImplementation(async () => { entered.resolve(); await release.promise; return [1]; });
    client.messageFlagsAdd.mockImplementation(async () => { seen = true; return true; });
    manager.connections.set(account.id, { usable: true, noop: async () => true,
      mailbox: { path: 'INBOX', uidValidity: 7n }, getMailboxLock: async () => ({ release() {} }),
      messageFlagsRemove: async () => { seen = false; return true; },
    });
    const pass = manager.markAllReadImap(account, 'INBOX', { retryBackoffMs: 0 });
    await entered.promise;
    const foreground = manager.setFlag(account, 1, 'INBOX', '\\Seen', false);
    const ready = await Promise.race([foreground.then(() => true), new Promise(r => setTimeout(() => r(false), 40))]);
    release.resolve(); const outcome = await pass.catch(err => err); await foreground;
    if (outcome instanceof Error) expect(outcome).toMatchObject({ confirmed: 0 });
    expect(ready).toBe(true); expect(seen).toBe(false);
  });
  it('does not let an in-flight older STORE outlive a newer foreground confirmation', async () => {
    const entered = deferred(), release = deferred();
    let seen = false;
    client.messageFlagsAdd.mockImplementation(async () => { entered.resolve(); await release.promise; seen = true; return true; });
    manager.connections.set(account.id, { usable: true, noop: async () => true,
      mailbox: { path: 'INBOX', uidValidity: 7n }, getMailboxLock: async () => ({ release() {} }), messageFlagsRemove: async () => { seen = false; return true; } });
    const pass = manager.markAllReadImap(account, 'INBOX', { retryBackoffMs: 0 });
    await entered.promise;
    const foreground = manager.setFlag(account, 1, 'INBOX', '\\Seen', false);
    await new Promise(r => setTimeout(r, 20));
    release.resolve(); await pass; await foreground;
    expect(seen).toBe(false);
  });
  it('finishes with one provider pool session while a foreground chain task waits for that lease', async () => {
    account.imap_host = 'imap.mail.yahoo.com'; rows.get(1).folder = 'Archive';
    let foreground;
    client.search.mockResolvedValue(Array.from({ length: 501 }, (_, i) => i + 1));
    const store = client.messageFlagsAdd;
    client.messageFlagsAdd = vi.fn(async (...args) => {
      if (!foreground) foreground = manager.setFlag(account, 1, 'Archive', '\\Seen', false);
      return store(...args);
    });
    const outcome = await manager.markAllReadImap(account, 'Archive', { retryBackoffMs: 0 }).catch(err => err);
    await foreground;
    expect(outcome).toMatchObject({ flagChainBusy: true, confirmed: 500, total: 501 });
    expect(ImapFlow.mock.calls.filter(([cfg]) => cfg.auth.user === 'test')).toHaveLength(1);
    expect(client.messageFlagsRemove).toHaveBeenCalledWith('1', ['\\Seen'], { uid: true });
  });
  it.each([false, true])('releases its sole session to an actual MOVE UIDPLUS=%s waiting during the pass', async uidplus => {
    account.imap_host = 'imap.mail.yahoo.com';
    client.search.mockResolvedValue(Array.from({ length: 501 }, (_, i) => i + 1));
    client.capabilities.set('MOVE', true);
    if (uidplus) client.capabilities.set('UIDPLUS', true);
    client.messageMove = vi.fn(async () => uidplus ? { uidMap: new Map([[1, 77]]) } : true);
    const firstStore = deferred(); let move;
    const store = client.messageFlagsAdd;
    client.messageFlagsAdd = vi.fn(async (...args) => { firstStore.resolve(); return store(...args); });
    const pass = manager.markAllReadImap(account, 'Archive', { retryBackoffMs: 0 }).catch(err => err);
    await firstStore.promise;
    move = manager.moveMessage(account, 1, 'Archive', 'Done');
    const outcome = await pass;
    expect(await move).toBe(uidplus ? 77 : null);
    if (outcome instanceof Error) expect(outcome).toMatchObject({ flagChainBusy: true, confirmed: 500, total: 501 });
    else expect(outcome).toBe(501);
    expect(client.messageMove).toHaveBeenCalledWith('1', 'Done', { uid: true });
    expect(ImapFlow.mock.calls).toHaveLength(1);
  });
  it('handles the maximum UID32 without a signed or sequence-number conversion', async () => {
    rows.clear(); client.search.mockResolvedValue([4294967295]);
    expect(await manager.markAllReadImap(account, 'INBOX')).toBe(1);
    expect(stores).toEqual([['4294967295', ['\\Seen'], { uid: true }]]);
  });
  it('retires older queued unread after live proof that the server copy is already Seen', async () => {
    const old = manager._enqueueFlagPush(account.id, 'row-1', '\\Seen', false);
    await manager._pendingFlagPush.get(account.id).get('row-1:\\Seen').markerReady;
    client.search.mockResolvedValue([]);
    await manager.markAllReadImap(account, 'INBOX');
    expect(manager._pendingFlagPush.has(account.id)).toBe(false);
    expect(rows.get(1)).toMatchObject({ is_read: true, read_changed_at: null });
    expect(manager._isFlagIntentCurrent(old)).toBe(false); expect(stores).toEqual([]);
  });
  it('keeps already-Seen proof unconfirmed while an older unread STORE is still in flight', async () => {
    const entered = deferred(), release = deferred(); let seen = true;
    manager.connections.set(account.id, { usable: true, noop: async () => true,
      mailbox: { path: 'INBOX', uidValidity: 7n }, getMailboxLock: async () => ({ release() {} }),
      messageFlagsRemove: async () => { entered.resolve(); await release.promise; seen = false; return true; } });
    const older = manager.setFlag(account, 1, 'INBOX', '\\Seen', false); await entered.promise;
    client.search.mockResolvedValue([]);
    let outcome;
    try { outcome = await manager.markAllReadImap(account, 'INBOX').catch(err => err); }
    finally { release.resolve(); await older; }
    expect(outcome).toMatchObject({ markAllDeferred: true, confirmed: 0 });
    expect(seen).toBe(false); expect(stores).toEqual([]);
    expect(manager._pendingFlagPush.get(account.id)?.get('row-1:\\Seen')).toMatchObject({ value: true, attempts: 0 });
    expect(rows.get(1).read_changed_at).not.toBe(null);
  });
  it('hands proven mark-all authority to reconciliation after a real UIDPLUS move and cache replacement', async () => {
    client.capabilities.set('MOVE', true); client.capabilities.set('UIDPLUS', true);
    const old = manager._enqueueFlagPush(account.id, 'row-1', '\\Seen', false);
    await manager._pendingFlagPush.get(account.id).get(old.key).markerReady;
    client.messageMove = vi.fn(async () => ({ uidMap: new Map([[1, 77]]), uidValidity: 7n }));
    expect(await manager.moveMessage(account, 1, 'INBOX', 'Archive')).toBe(77);
    const replacement = { ...rows.get(1), id: 'replacement', uid: 77, folder: 'Archive', read_changed_at: null, read_intent_version: '0' };
    rows.clear(); rows.set(77, replacement); client.search.mockResolvedValue([]);
    expect(await manager.markAllReadImap(account, 'Archive')).toBe(1);
    manager.connections.set(account.id, { usable: true });
    await manager._reconcileFlagPushes();
    expect(manager._pendingFlagPush.has(account.id)).toBe(false);
    expect(stores).toEqual([]); expect(replacement.is_read).toBe(true);
  });
  it('reports a refused cache address as unconfirmed and never writes its UID', async () => {
    rows.get(1).flag_address_valid = false; client.search.mockResolvedValue([1]);
    await expect(manager.markAllReadImap(account, 'INBOX')).rejects.toMatchObject({ confirmed: 0 });
    expect(stores).toEqual([]);
  });
  it('keeps admitted unconfirmed rows in the existing bounded pending queue', async () => {
    client.search.mockResolvedValue([1]); client.messageFlagsAdd.mockResolvedValue(false);
    await expect(manager.markAllReadImap(account, 'INBOX', { retryBackoffMs: 0 })).rejects.toThrow();
    const pending = manager._pendingFlagPush.get(account.id)?.get('row-1:\\Seen');
    expect(pending).toMatchObject({ messageId: 'row-1', value: true, attempts: 2 });
    expect(Date.now() - pending.intent.createdAt).toBeLessThan(30 * 60 * 1000);
  });
  it.each([null, undefined])('refuses uncached UID writes without selected UIDVALIDITY=%s', async epoch => {
    rows.clear(); client.getMailboxLock.mockImplementation(async folder => { client.mailbox = { path: folder, exists: 1, uidValidity: epoch }; return { release() {} }; });
    await expect(manager.markAllReadImap(account, 'INBOX')).rejects.toThrow(/UIDVALIDITY/);
    expect(stores).toEqual([]);
  });
  it('honors provider backoff without opening a login', async () => {
    manager._secondaryCooldown.set(account.id, { until: Date.now() + 30000, failures: 1 });
    const logins = ImapFlow.mock.calls.length;
    await expect(manager.markAllReadImap(account, 'INBOX')).rejects.toMatchObject({ providerRefusing: true });
    expect(ImapFlow.mock.calls.length).toBe(logins);
  });
  it('does not await an unrelated account-chain task while retaining its lease', async () => {
    const chain = deferred(); manager._flagOpChains.set(account.id, chain.promise);
    const pass = manager.markAllReadImap(account, 'INBOX', { retryBackoffMs: 0 });
    const result = await Promise.race([pass.catch(err => err), new Promise(r => setTimeout(() => r('blocked'), 40))]);
    chain.resolve(); await pass.catch(() => {});
    expect(result).toMatchObject({ flagChainBusy: true, confirmed: 0, total: 2 });
    expect(stores).toEqual([]); expect(locks).toBe(1);
  });
});
