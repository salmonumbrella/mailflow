import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn(() => 'test-password') }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));

import { ImapManager, evictPool, acquirePooledClient, releasePooledClient } from './imapManager.js';
import { ImapFlow } from 'imapflow';
import { query } from './db.js';
import { resolveForConnection } from './hostValidation.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { markCopySeen } from './labels.js';
import { pushSeen } from '../utils/mailUtils.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
let serial = 0;
let versionSerial = 0n;
let manager, account, client, row, marker, markerStamp;
function fakeClient() {
  return Object.assign(new EventEmitter(), {
    usable: true, mailbox: { path: 'INBOX', exists: 1000, uidValidity: 1n },
    connect: vi.fn(async () => {}), close: vi.fn(), logout: vi.fn(async () => {}),
    noop: vi.fn(async () => true),
    getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
    messageFlagsAdd: vi.fn(async () => true), messageFlagsRemove: vi.fn(async () => true),
    search: vi.fn(async () => []),
    fetch: vi.fn(async function* (range) {
      if (String(row?.uid) === String(range)) yield { uid: row.uid, envelope: { messageId: row.message_id } };
    }),
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  account = { id: `retry-review-${++serial}`, user_id: 'user', imap_host: 'imap.mail.yahoo.com',
    imap_port: 993, imap_tls: true, auth_user: 'test', auth_pass: 'encrypted', enabled: true };
  row = { id: 'message', uid: 17, folder: 'INBOX', message_id: '<copy@example.test>', is_deleted: false,
    flag_address_valid: true, flag_uid_validity: '1', read_intent_version: '0', star_intent_version: '0' };
  marker = true; markerStamp = null;
  query.mockReset().mockImplementation(async (sql, args = []) => {
    if (sql.includes('nextval(')) return { rows: [{ version: String(++versionSerial) }], rowCount: 1 };
    if (sql.includes('FROM email_accounts')) return { rows: [account] };
    if (sql.includes('FROM messages WHERE account_id = $1') && sql.includes('uid = $3')) {
      return { rows: row && row.folder === args[1] && row.uid === Number(args[2]) ? [{ ...row }] : [] };
    }
    if (sql.includes('SELECT uid, folder')) return { rows: row ? [{ ...row }] : [] };
    const versionCol = sql.includes('star_intent_version') ? 'star_intent_version' : 'read_intent_version';
    if (sql.includes('THEN NULL ELSE')) {
      if (row && BigInt(row[versionCol]) <= BigInt(args[1])) {
        row[versionCol] = args[1];
        if (markerStamp === args[2]) marker = false;
      }
    } else if (sql.includes('intent_version') && sql.includes('UPDATE messages')) {
      const reassert = sql.includes('SET is_read = $1') || sql.includes('SET is_starred = $1');
      const version = BigInt(args[reassert ? 3 : 2]);
      if (!row || version < BigInt(row[versionCol])) return { rows: [], rowCount: 0 };
      row[versionCol] = String(version);
      if (reassert) row[versionCol === 'read_intent_version' ? 'is_read' : 'is_starred'] = args[0];
      marker = true; markerStamp = args[reassert ? 2 : 1];
    }
    if (sql.includes('read_changed_at = NOW()')) marker = true;
    return { rows: [], rowCount: 1 };
  });
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
  resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
  client = fakeClient();
  ImapFlow.mockReset().mockImplementation(function () { return client; });
  manager = new ImapManager({ clients: new Set() });
  vi.clearAllTimers(); // drive reconciler explicitly; never run background sync in probes
  manager.connections.set(account.id, client);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  evictPool(account.id);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('production retry regression probes', () => {
  it('replays healthy INBOX over IDLE despite secondary-login backoff, without FETCH or login', async () => {
    manager._secondaryCooldown.set(account.id, { until: Date.now() + 60_000, failures: 3 });
    manager._enqueueFlagPush(account.id, row.id, '\\Seen', true);
    await manager._reconcileFlagPushes();
    expect(client.messageFlagsAdd).toHaveBeenCalledWith('17', ['\\Seen'], { uid: true });
    expect(client.fetch).not.toHaveBeenCalled();
    expect(ImapFlow).not.toHaveBeenCalled();
    expect(manager._pendingFlagPush.has(account.id)).toBe(false);
  });

  it('preserves STORE attempt budget across repeated typed provider gates', async () => {
    row.folder = 'Watch';
    manager._secondaryCooldown.set(account.id, { until: Date.now() + 60_000, failures: 3 });
    manager._enqueueFlagPush(account.id, row.id, '\\Seen', true);
    for (let i = 0; i < 45; i++) await manager._reconcileFlagPushes();
    expect(manager._pendingFlagPush.get(account.id)?.get('message:\\Seen')?.attempts).toBe(0);
    expect(marker).toBe(true);
    expect(ImapFlow).not.toHaveBeenCalled();
  });

  it('replays poll-only accounts through the existing pool', async () => {
    manager.connections.delete(account.id);
    manager._pollOnlyAccounts.add(account.id);
    manager.syncIntervals.set(account.id, 123);
    manager._enqueueFlagPush(account.id, row.id, '\\Seen', true);
    await manager._reconcileFlagPushes();
    expect(client.messageFlagsAdd).toHaveBeenCalledWith('17', ['\\Seen'], { uid: true });
    expect(manager._pendingFlagPush.has(account.id)).toBe(false);
  });

  it('expires an offline retry instead of renewing its marker forever', async () => {
    manager.connections.delete(account.id);
    manager._enqueueFlagPush(account.id, row.id, '\\Seen', true);
    await manager._rebumpFlagMarkers(manager._pendingFlagPush.get(account.id));
    vi.setSystemTime(Date.now() + 31 * 60_000);
    await manager._reconcileFlagPushes();
    expect(manager._pendingFlagPush.has(account.id)).toBe(false);
    expect(marker).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });

  it('keeps a newer retry admitted while terminal marker cleanup is awaiting DB', async () => {
    client.messageFlagsAdd.mockRejectedValue(new Error('STORE refused'));
    manager._secondaryCooldown.set(account.id, { until: Date.now() + 60_000, failures: 3 });
    manager._enqueueFlagPush(account.id, row.id, '\\Seen', true);
    manager._pendingFlagPush.get(account.id).get('message:\\Seen').attempts = 39;
    const clearing = deferred(), release = deferred();
    const normalQuery = query.getMockImplementation();
    query.mockImplementation(async (sql, args) => {
      if (sql.includes('THEN NULL ELSE')) { clearing.resolve(); await release.promise; }
      return normalQuery(sql, args);
    });
    const cycle = manager._reconcileFlagPushes();
    await clearing.promise;
    manager._enqueueFlagPush(account.id, row.id, '\\Seen', false);
    await manager._protectFlagMarker(manager._pendingFlagPush.get(account.id).get('message:\\Seen'));
    release.resolve();
    await cycle;
    expect(manager._pendingFlagPush.get(account.id)?.get('message:\\Seen')?.value).toBe(false);
    expect(marker).toBe(true);
  });

  it('does not replay old read after a newer unread confirmed during its DB reassertion', async () => {
    manager._enqueueFlagPush(account.id, row.id, '\\Seen', true);
    const reasserting = deferred(), release = deferred();
    const normalQuery = query.getMockImplementation();
    query.mockImplementation(async (sql, args) => {
      if (sql.includes('SET is_read = $1') && args[0] === true) { reasserting.resolve(); await release.promise; }
      return normalQuery(sql, args);
    });
    const cycle = manager._reconcileFlagPushes();
    await reasserting.promise;
    await manager.setFlag(account, 17, 'INBOX', '\\Seen', false);
    manager._resolveFlagPush(account.id, row.id, '\\Seen');
    release.resolve();
    await cycle;
    expect(client.messageFlagsRemove).toHaveBeenCalledWith('17', ['\\Seen'], { uid: true });
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    expect(row.is_read).toBe(false);
  });

  it('holds one pool lease for SEARCH and both precise UID Seen chunks', async () => {
    client.search.mockResolvedValue(Array.from({ length: 1000 }, (_, i) => i + 1));
    await manager.markAllReadImap(account, 'Archive');
    expect(client.search).toHaveBeenCalledWith({ seen: false }, { uid: true });
    expect(client.messageFlagsAdd.mock.calls).toEqual([
      [Array.from({ length: 500 }, (_, i) => i + 1).join(','), ['\\Seen'], { uid: true }],
      [Array.from({ length: 500 }, (_, i) => i + 501).join(','), ['\\Seen'], { uid: true }],
    ]);
    expect(client.getMailboxLock).toHaveBeenCalledTimes(1);
  });
});

describe('bounded immutable intent ownership', () => {
  it('keeps a newer queued intent when a legacy copy push skips its superseded STORE', async () => {
    const waiting = deferred(), release = deferred();
    const normal = query.getMockImplementation();
    let paused = false;
    query.mockImplementation(async (sql,args) => {
      if (!paused && sql.includes('SELECT id, message_id')) {
        paused = true; waiting.resolve(); await release.promise;
      }
      return normal(sql,args);
    });
    const push = pushSeen(manager,account,account.id,[{ ...row,is_read:true }],true);
    await waiting.promise;
    row.is_read = false;
    const newer = manager._enqueueFlagPush(account.id,row.id,'\\Seen',false);
    await manager._protectFlagMarker(manager._pendingFlagPush.get(account.id).get('message:\\Seen'));
    release.resolve(); const confirmed = await push;
    expect(manager._pendingFlagPush.get(account.id)?.get('message:\\Seen')?.intent).toBe(newer);
    expect(manager._isFlagIntentCurrent(newer)).toBe(true);
    expect(marker).toBe(true);
    expect(confirmed).toEqual([]);
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it('keeps generic Deleted outside read/star intent ownership', async () => {
    await manager.setFlag(account, 17, 'INBOX', '\\Deleted', true);
    expect(client.messageFlagsAdd).toHaveBeenCalledWith('17', ['\\Deleted'], { uid: true });
    expect(row.is_starred).not.toBe(true);
    expect(manager._flagIntents.size).toBe(0);
    expect(query.mock.calls.filter(([sql]) => sql.includes('intent_version'))).toEqual([]);
  });

  it('completes a real UIDPLUS wake before the destination cache row exists', async () => {
    row.folder = 'Snoozed';
    const snooze = { snooze_id: 'snooze', account_id: account.id, user_id: 'user', uid: 17,
      snoozed_folder: 'Snoozed', original_folder: 'INBOX', message_id_header: row.message_id, is_read: true };
    const normal = query.getMockImplementation();
    query.mockImplementation(async (sql, args) => {
      if (sql.includes('FROM snoozed_messages sm')) return { rows: [snooze] };
      if (sql.includes('UPDATE messages SET folder = $1, uid = $4')) Object.assign(row, { folder: args[0], uid: args[3] });
      return normal(sql, args);
    });
    client.capabilities = new Set(['MOVE']);
    client.messageMove = vi.fn(async () => ({ uidMap: new Map([[17,100]]) }));
    expect(await manager.wakeSnoozed(snooze)).toBe(true);
    expect(client.messageMove).toHaveBeenCalledWith('17', 'INBOX', { uid: true });
    expect(client.messageFlagsRemove).toHaveBeenCalledWith('100', ['\\Seen'], { uid: true });
    expect(row).toMatchObject({ folder: 'INBOX', uid: 100 });
  });

  it('settles an implicitly owned successful label STORE', async () => {
    expect(await markCopySeen(manager, account, { id: row.id, uid: 17, folder: 'INBOX', is_read: false })).toEqual({});
    expect(marker).toBe(false);
  });

  it('retires an older queued unread after the current label action confirms read', async () => {
    manager._enqueueFlagPush(account.id,row.id,'\\Seen',false);
    await markCopySeen(manager,account,{ id:row.id,uid:17,folder:'INBOX',is_read:false });
    expect(manager._pendingFlagPush.has(account.id)).toBe(false);
    expect(marker).toBe(false);
    await manager._reconcileFlagPushes();
    expect(client.messageFlagsRemove).not.toHaveBeenCalled();
  });

  it.each(['address','stamp'])('cancels a detached persistent STORE after its %s SQL await', async stage => {
    const waiting = deferred(), release = deferred();
    const normal = query.getMockImplementation();
    let paused = false;
    query.mockImplementation(async (sql, args) => {
      if (!paused && sql.includes(stage === 'address' ? 'SELECT id, message_id' : 'SET is_read = $1')) {
        paused = true; waiting.resolve(); await release.promise;
      }
      return normal(sql, args);
    });
    const intent = manager._admitFlagIntent(account.id, row.id, '\\Seen', true);
    const write = manager.setFlag(account, 17, 'INBOX', '\\Seen', true, { intent });
    await waiting.promise;
    await vi.advanceTimersByTimeAsync(5001); await write;
    expect(client.messageFlagsAdd).toHaveBeenCalledTimes(1);
    release.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(client.messageFlagsAdd).toHaveBeenCalledTimes(1);
  });

  it('does not issue per-cycle SQL for already protected offline markers', async () => {
    manager.connections.clear();
    manager._enqueueFlagPush(account.id, row.id, '\\Seen', true);
    await manager._rebumpFlagMarkers(manager._pendingFlagPush.get(account.id));
    const before = query.mock.calls.filter(([sql]) => sql.includes('UPDATE messages')).length;
    for (let n = 0; n < 3; n++) await manager._reconcileFlagPushes();
    expect(query.mock.calls.filter(([sql]) => sql.includes('UPDATE messages')).length).toBe(before);
  });

  it('retires the fortieth failed STORE even when its fallback pool is available', async () => {
    const pooled = await acquirePooledClient(account);
    releasePooledClient(account, pooled);
    manager._enqueueFlagPush(account.id, row.id, '\\Seen', true);
    manager._pendingFlagPush.get(account.id).get('message:\\Seen').attempts = 39;
    client.messageFlagsAdd.mockRejectedValue(new Error('fortieth failed STORE'));
    await manager._reconcileFlagPushes();
    expect(client.messageFlagsAdd).toHaveBeenCalledTimes(1);
    expect(manager._pendingFlagPush.has(account.id)).toBe(false);
    expect(marker).toBe(false);
  });

  it('enforces the actual per-account intent bound and releases expired tombstones', async () => {
    for (let n = 0; n < 10000; n++) manager._admitFlagIntent(account.id, `message-${n}`, '\\Seen', true);
    expect(() => manager._admitFlagIntent(account.id, 'over-limit', '\\Seen', true)).toThrow('Too many pending flag changes');
    expect(() => manager._enqueueFlagPush(account.id, 'legacy-over-limit', '\\Seen', true)).not.toThrow();
    expect(manager._flagIntents.get(account.id).size).toBe(10000);
    await manager._flagVersionChain;
    vi.setSystemTime(Date.now() + 30 * 60_000);
    await manager._reconcileFlagPushes();
    expect(manager._flagIntents.has(account.id)).toBe(false);
  }, 20000);

  it('bounds retained retries across expiry while terminal SQL is delayed', async () => {
    manager.connections.delete(account.id);
    const action = manager._newFlagAction();
    for (let n=0;n<10000;n++) manager._enqueueFlagPush(account.id,`old-${n}`,'\\Seen',true,
      manager._admitFlagIntent(account.id,`old-${n}`,'\\Seen',true,action));
    await Promise.all([...manager._pendingFlagPush.get(account.id).values()].map(op => op.markerReady));
    const waiting=deferred(), release=deferred(), normal=query.getMockImplementation();
    query.mockImplementation(async (sql,args) => {
      if (sql.includes('THEN NULL ELSE')) { waiting.resolve(); await release.promise; }
      return normal(sql,args);
    });
    vi.setSystemTime(Date.now()+30*60000);
    const cycle=manager._reconcileFlagPushes(); await waiting.promise;
    try {
      expect(manager._enqueueFlagPush(account.id,'new-first','\\Seen',false)).toBeTruthy();
      expect(manager._enqueueFlagPush(account.id,'new-overflow','\\Seen',false)).toBeNull();
      expect(manager._enqueueFlagPush(account.id,'old-1','\\Seen',false)).toBeTruthy();
      expect(manager._pendingFlagPush.get(account.id).size).toBe(10000);
      expect(manager._flagIntents.get(account.id).size).toBeLessThanOrEqual(10000);
    } finally { release.resolve(); await cycle; }
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.includes('SET is_read = $1'))).toBe(false);
    expect(manager._pendingFlagPush.get(account.id).size).toBe(2);
  },20000);

  it.each(['\\Seen', '\\Flagged'].flatMap(flag => [true, false].flatMap(value =>
    ['<copy@example.test>', '', '<>'].map(header => ({ flag, value, header })))))('preserves healthy IDLE for $flag=$value with header "$header"', async ({ flag, value, header }) => {
    row.message_id = header;
    manager._enqueueFlagPush(account.id, row.id, flag, value);
    await manager._reconcileFlagPushes();
    expect((value ? client.messageFlagsAdd : client.messageFlagsRemove).mock.calls)
      .toEqual([['17', [flag], { uid: true }]]);
    expect(client.fetch).not.toHaveBeenCalled();
    expect(ImapFlow).not.toHaveBeenCalled();
  });

  it('does not spend STORE failures when the one-session pool is exhausted', async () => {
    row.folder = 'Watch';
    const held = await acquirePooledClient(account);
    manager._enqueueFlagPush(account.id, row.id, '\\Seen', true);
    const cycle = manager._reconcileFlagPushes();
    await vi.advanceTimersByTimeAsync(36_000);
    await cycle;
    expect(manager._pendingFlagPush.get(account.id).get('message:\\Seen').attempts).toBe(0);
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    releasePooledClient(account, held);
  });

  it('gives up on the fortieth actual failed STORE and clears all owned state', async () => {
    manager._enqueueFlagPush(account.id, row.id, '\\Seen', true);
    manager._secondaryCooldown.set(account.id, { until: Date.now() + 60_000, failures: 3 });
    client.messageFlagsAdd.mockRejectedValue(new Error('STORE failed'));
    for (let i = 0; i < 39; i++) await manager._reconcileFlagPushes();
    expect(manager._pendingFlagPush.get(account.id).get('message:\\Seen').attempts).toBe(39);
    await manager._reconcileFlagPushes();
    expect(client.messageFlagsAdd).toHaveBeenCalledTimes(40);
    expect(manager._pendingFlagPush.has(account.id)).toBe(false);
    expect(manager._isFlagIntentCurrent(manager._flagIntents.get(account.id)?.get('message:\\Seen'))).toBe(false);
    expect(marker).toBe(false);
  });

  it('does not let a stale admission enqueue or resolve a newer intent', () => {
    const older = manager._admitFlagIntent(account.id, row.id, '\\Seen', true);
    const newer = manager._admitFlagIntent(account.id, row.id, '\\Seen', false);
    manager._enqueueFlagPush(account.id, row.id, '\\Seen', false, newer);
    manager._enqueueFlagPush(account.id, row.id, '\\Seen', true, older);
    manager._resolveFlagPush(account.id, row.id, '\\Seen', older);
    expect(manager._pendingFlagPush.get(account.id).get('message:\\Seen').intent).toBe(newer);
    expect(Object.isFrozen(older)).toBe(true);
    expect(newer.generation).toBeGreaterThan(older.generation);
  });

  it('skips an obsolete replay waiting inside the account chain', async () => {
    const older = manager._enqueueFlagPush(account.id, row.id, '\\Seen', true);
    const blocked = deferred();
    manager._flagOpChains.set(account.id, blocked.promise);
    const stale = manager.setFlag(account, row.uid, row.folder, '\\Seen', true, { intent: older });
    manager._admitFlagIntent(account.id, row.id, '\\Seen', false);
    blocked.resolve();
    expect(await stale).toBe(false);
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it('preserves pending intent across reconnect session cleanup', async () => {
    manager._enqueueFlagPush(account.id, row.id, '\\Seen', true);
    await manager.disconnectAccount(account.id);
    expect(manager._pendingFlagPush.get(account.id).size).toBe(1);
  });

  it('retires disabled accounts even without a persistent session', async () => {
    manager._enqueueFlagPush(account.id, row.id, '\\Seen', true);
    await manager._rebumpFlagMarkers(manager._pendingFlagPush.get(account.id));
    manager.connections.clear();
    account.enabled = false;
    await manager._reconcileFlagPushes();
    expect(manager._pendingFlagPush.has(account.id)).toBe(false);
    expect(manager._flagIntents.has(account.id)).toBe(false);
    expect(marker).toBe(false);
  });

  it('drops gone or soft-deleted ownership without looking for another shared-ID row', async () => {
    manager._enqueueFlagPush(account.id, row.id, '\\Seen', true);
    row.is_deleted = true;
    await manager._reconcileFlagPushes();
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    expect(manager._pendingFlagPush.has(account.id)).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes('message_id = $3'))).toBe(false);
  });

  it('counts an actual failed STORE but does not spend another attempt on its fallback gate', async () => {
    manager._enqueueFlagPush(account.id, row.id, '\\Seen', true);
    client.messageFlagsAdd.mockRejectedValue(new Error('STORE failed'));
    manager._secondaryCooldown.set(account.id, { until: Date.now() + 60_000, failures: 3 });
    await manager._reconcileFlagPushes();
    expect(manager._pendingFlagPush.get(account.id).get('message:\\Seen').attempts).toBe(1);
    expect(ImapFlow).not.toHaveBeenCalled();
  });

  it('expires at exactly thirty minutes without moving its creation time on repeated toggles', async () => {
    const start = Date.now();
    const first = manager._enqueueFlagPush(account.id, row.id, '\\Seen', true);
    vi.setSystemTime(start + 29 * 60_000);
    const second = manager._enqueueFlagPush(account.id, row.id, '\\Seen', false);
    expect(second.createdAt).toBe(first.createdAt + 29 * 60_000);
    manager.connections.clear();
    vi.setSystemTime(second.createdAt + 30 * 60_000);
    await manager._reconcileFlagPushes();
    expect(manager._pendingFlagPush.has(account.id)).toBe(false);
  });
});
