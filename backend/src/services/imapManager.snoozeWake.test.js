// Waking snoozed mail (#269) when what the waker read has gone out of date: the sweep reads every
// due snooze first and wakes them one by one, and the reader can unsnooze one by hand, or give it
// a later time, in between.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => {
  const query = vi.fn();
  return { query, withTransaction: async fn => fn({ query }) };
});
vi.mock('./messageParser.js', () => ({ parseMessage: vi.fn(), buildSnippetFromHtml: vi.fn(), snippetFromBody: vi.fn(), decodeMimeWords: vi.fn(), detectBulkFromParsedHeaders: vi.fn(), parseRawHeaders: vi.fn(), enrichParsedMetadata: vi.fn((p) => p) }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn(() => 'pw') }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('../utils/redact.js', () => ({ redactEmail: vi.fn(() => 'a***@example.com') }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('./spamPipeline.js', () => ({ classifyAndTagMessage: vi.fn() }));
vi.mock('./mailAccess.js', () => ({ getAccountAddresses: vi.fn(async () => []) }));
vi.mock('../utils/mailUtils.js', async (importOriginal) => ({ ...(await importOriginal()), adjustFolderCounts: vi.fn() }));

import { ImapFlow } from 'imapflow';
import { ImapManager } from './imapManager.js';
import { query } from './db.js';
import { adjustFolderCounts } from '../utils/mailUtils.js';
import { routeIdentityFixture } from './testSupport/routeIdentityFixture.js';

const HOUR = 3_600_000;
const GENERATION = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = { storage_generation: GENERATION, id: 'acct-1', user_id: 'u1' };
let snoozes, messages, folders, noSelect, identityDb, mgr;
const snooze = (id, { until = -HOUR, uid = 10, isRead = false, mid = `<${id}@x>` } = {}) => {
  snoozes.set(id, { id, entity_id: `entity-${id}`, wake_state: 'ready', storage_generation: GENERATION,
    user_id: 'u1', account_id: ACCOUNT.id, message_id_header: mid, original_folder: 'INBOX',
    snoozed_folder: 'Snoozed', snooze_until: Date.now() + until });
  messages.push({ id: `cache-${id}`, entity_id: `entity-${id}`, account_id: ACCOUNT.id,
    storage_generation: GENERATION, uid_validity: '10', message_id: mid, folder: 'Snoozed', uid, is_read: isRead });
};
const messageOf = sm => messages.find(m => m.entity_id === sm.entity_id && m.folder === sm.snoozed_folder);
const rowRead = id => {
  const sm = snoozes.get(id);
  return { ...messageOf(sm), snooze_id: id, user_id: sm.user_id, message_id_header: sm.message_id_header,
    original_folder: sm.original_folder, snoozed_folder: sm.snoozed_folder,
    snooze_until: new Date(sm.snooze_until), snooze_until_snapshot: new Date(sm.snooze_until).toISOString() };
};
function fakeQuery(rawSql, params = []) {
  const sql = rawSql.replace(/\s+/g, ' ').trim();
  const identityResult = identityDb.query(sql, params);
  if (identityResult) return identityResult;
  if (sql.includes('FROM snoozed_messages sm')) {
    let live = [...snoozes.values()].filter(sm => sm.wake_state === 'ready' && sm.entity_id
      && sm.storage_generation === ACCOUNT.storage_generation && messageOf(sm));
    if (sql.includes('sm.id=$1')) live = live.filter(sm => sm.id === params[0]);
    if (sql.includes('sm.snooze_until <= NOW()')) live = live.filter(sm => sm.snooze_until <= Date.now());
    return { rows: live.map(sm => rowRead(sm.id)) };
  }
  if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [ACCOUNT] };
  if (sql.startsWith('SELECT 1 FROM folders')) return { rows: folders.has(params[1]) && !noSelect.has(params[1]) ? [{}] : [] };
  if (sql.startsWith("UPDATE snoozed_messages SET wake_state='waking'")) {
    const sm = snoozes.get(params[0]);
    const matches = sm && sm.account_id === params[1] && sm.storage_generation === params[2]
      && sm.entity_id === params[3] && sm.wake_state === 'ready'
      && sm.snooze_until === new Date(params[4]).getTime()
      && (!sql.includes('AND snooze_until <= NOW()') || sm.snooze_until <= Date.now());
    if (matches) sm.wake_state = 'waking';
    return { rows: matches ? [{ id: sm.id }] : [] };
  }
  if (sql.startsWith('UPDATE messages SET is_read=false')) {
    const row = messages.find(m => m.id === params[0]);
    if (row) row.is_read = false;
    return { rows: [] };
  }
  if (sql === "DELETE FROM snoozed_messages WHERE id=$1 AND wake_state='waking'") {
    if (snoozes.get(params[0])?.wake_state === 'waking') snoozes.delete(params[0]);
    return { rows: [] };
  }
  if (sql === "UPDATE snoozed_messages SET wake_state='pending' WHERE id=$1 AND wake_state='waking'") {
    const sm = snoozes.get(params[0]);
    if (sm?.wake_state === 'waking') sm.wake_state = 'pending';
    return { rows: [] };
  }
  throw new Error(`Unmodelled snooze SQL: ${sql}`);
}
function acknowledgeMove(uid = 500, beforeAck = () => {}) {
  mgr.moveMessage.mockImplementation(async (account, sourceUid, from, to, { expectedSource }) => {
    await beforeAck(account, sourceUid, from, to, expectedSource);
    const destinationUid = typeof uid === 'function' ? uid(sourceUid) : uid;
    identityDb.acknowledgeMove(expectedSource, to, destinationUid);
    return destinationUid;
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  snoozes = new Map(); messages = []; folders = new Set(['INBOX', 'Snoozed', 'Projects']); noSelect = new Set();
  identityDb = routeIdentityFixture({ account: ACCOUNT, getRows: () => messages,
    removeRow: id => { messages = messages.filter(m => m.id !== id); },
    saveRow: (id, row) => { messages = messages.map(m => m.id === id ? row : m); } });
  query.mockImplementation(async (sql, params) => fakeQuery(sql, params));
  mgr = new ImapManager(null);
  mgr.broadcast = vi.fn(); mgr.setFlag = vi.fn(async () => {}); mgr.moveMessage = vi.fn();
  mgr.syncFolderOnDemand = vi.fn(async () => {}); mgr._enqueueFlagPush = vi.fn();
  acknowledgeMove();
});

describe('waking a snooze that changed after it was read', () => {
  it('does not replay one already brought back by hand', async () => {
    snooze('a'); const stale = rowRead('a');
    expect(await mgr.wakeSnoozed(stale, { markUnread: false })).toBe(true);
    expect(await mgr.wakeSnoozed(stale, { onlyIfDue: true })).toBe(false);
    expect(mgr.moveMessage).toHaveBeenCalledTimes(1);
    expect(adjustFolderCounts).toHaveBeenCalledTimes(2);
    expect(mgr.broadcast).toHaveBeenCalledTimes(1);
  });
  it('leaves one given a later time, but brings it back by hand using the current schedule', async () => {
    snooze('a'); const stale = rowRead('a');
    snoozes.get('a').snooze_until = Date.now() + HOUR;
    expect(await mgr.wakeSnoozed(stale, { onlyIfDue: true })).toBe(false);
    expect(mgr.moveMessage).not.toHaveBeenCalled();
    expect(await mgr.wakeSnoozed(stale, { markUnread: false })).toBe(true);
    expect(messages[0].folder).toBe('INBOX');
  });
  it.each(['uid', 'uid_validity', 'entity_id', 'id'])('refuses a captured source whose %s changed', async key => {
    snooze('a'); const stale = rowRead('a');
    messages[0][key] = key === 'uid' ? 12 : 'changed';
    expect(await mgr.wakeSnoozed(stale, { onlyIfDue: true })).toBe(false);
    expect(mgr.moveMessage).not.toHaveBeenCalled();
    expect(adjustFolderCounts).not.toHaveBeenCalled();
  });
  it('distinguishes an in-flight wake from nothing to wake, with only one MOVE', async () => {
    snooze('a'); const read = rowRead('a'); let release;
    const gate = new Promise(resolve => { release = resolve; });
    acknowledgeMove(500, () => gate);
    const first = mgr.wakeSnoozed(read);
    await vi.waitFor(() => expect(mgr.moveMessage).toHaveBeenCalledTimes(1));
    expect(mgr.isWakingSnooze('a')).toBe(true);
    expect(await mgr.wakeSnoozed(read)).toBe(null);
    release(); expect(await first).toBe(true);
    expect(mgr.isWakingSnooze('a')).toBe(false);
    expect(await mgr.wakeSnoozed(read)).toBe(false);
    expect(mgr.moveMessage).toHaveBeenCalledTimes(1);
  });
});

describe('the sweep', () => {
  it('marks only the due sweep message unread when a manual wake runs during it', async () => {
    snooze('a'); snooze('b', { uid: 11 });
    acknowledgeMove(uid => uid + 100, async (_account, uid) => {
      if (uid === 10) await mgr.wakeSnoozed(rowRead('b'), { markUnread: false });
    });
    await mgr._runSnoozeWakeup();
    expect(mgr.moveMessage.mock.calls.map(c => c[1])).toEqual([10, 11]);
    expect(mgr.setFlag).toHaveBeenCalledExactlyOnceWith(ACCOUNT, 110, 'INBOX', '\\Seen', false,
      { expectedSource: expect.objectContaining({ entity_id: 'entity-a', storage_generation: GENERATION, uid_validity: '10' }) });
    expect(snoozes.size).toBe(0);
    expect(adjustFolderCounts).toHaveBeenCalledTimes(4);
  });
  it('retains orphaned ready decisions rather than treating missing cache as deletion proof', async () => {
    snooze('a'); messages = [];
    await mgr._runSnoozeWakeup();
    expect(snoozes.has('a')).toBe(true);
    expect(mgr.moveMessage).not.toHaveBeenCalled();
  });
});

describe('waking without an exact destination mapping', () => {
  it.each([null, 500])('keeps the source and holds recovery for unjournalled provider result %s', async uid => {
    snooze('a'); mgr.moveMessage.mockResolvedValue(uid);
    expect(await mgr.wakeSnoozed(rowRead('a'))).toBe(true);
    expect(messages[0]).toMatchObject({ folder: 'Snoozed', uid: 10 });
    expect(snoozes.get('a').wake_state).toBe('pending');
    expect(mgr.syncFolderOnDemand).toHaveBeenCalledWith(ACCOUNT, 'INBOX');
    expect(mgr.setFlag).not.toHaveBeenCalled();
    expect(adjustFolderCounts).not.toHaveBeenCalled();
    await mgr._runSnoozeWakeup();
    expect(mgr.moveMessage).toHaveBeenCalledTimes(1);
  });
  it('drops only the acknowledged source for noUID success, holds its decision, and never searches headers to mark unread', async () => {
    snooze('a'); snooze('b', { uid: 11, mid: '<a@x>' }); acknowledgeMove(null);
    expect(await mgr.wakeSnoozed(rowRead('a'))).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ entity_id: 'entity-b', folder: 'Snoozed', uid: 11 });
    expect(snoozes.get('a').wake_state).toBe('pending');
    expect(mgr.setFlag).not.toHaveBeenCalled();
    expect(ImapFlow).not.toHaveBeenCalled();
    expect(adjustFolderCounts).toHaveBeenCalledExactlyOnceWith(ACCOUNT.id, 'Snoozed', -1, -1, expect.any(Function));
  });
});

describe('exact destination mappings', () => {
  it('moves only the intended entity when two deliveries share a Message-ID', async () => {
    snooze('a', { mid: '<dup@x>' }); snooze('b', { uid: 11, mid: '<dup@x>' });
    expect(await mgr.wakeSnoozed(rowRead('a'), { markUnread: false })).toBe(true);
    expect(messages).toMatchObject([{ entity_id: 'entity-a', folder: 'INBOX', uid: 500 }, { entity_id: 'entity-b', folder: 'Snoozed', uid: 11 }]);
    expect(snoozes.has('a')).toBe(false); expect(snoozes.has('b')).toBe(true);
  });
  it('counts a destination already filed by sync only once and marks the verified entity unread', async () => {
    snooze('a', { isRead: true });
    acknowledgeMove(500, () => { messages.push({ ...messages[0], id: 'destination-cache', folder: 'INBOX', uid: 500 }); });
    expect(await mgr.wakeSnoozed(rowRead('a'))).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ entity_id: 'entity-a', folder: 'INBOX', uid: 500, is_read: false });
    expect(adjustFolderCounts.mock.calls.map(call => call.slice(1, 4))).toEqual([['Snoozed', -1, 0], ['INBOX', 0, 0], ['INBOX', 0, 1]]);
    expect(mgr.setFlag).toHaveBeenCalledTimes(1);
  });
  it('retains provider success when marking unread fails and queues only the verified target', async () => {
    snooze('a'); mgr.setFlag.mockRejectedValue(new Error('NO [UNAVAILABLE]'));
    const source = rowRead('a');
    expect(await mgr.wakeSnoozed(source)).toBe(true);
    expect(messages[0]).toMatchObject({ folder: 'INBOX', uid: 500, is_read: false });
    expect(snoozes.get('a').wake_state).toBe('waking');
    expect(mgr._enqueueFlagPush).toHaveBeenCalledExactlyOnceWith(ACCOUNT.id, 'cache-a', '\\Seen', false,
      { expectedSource: expect.objectContaining({ id: 'cache-a', entity_id: 'entity-a', storage_generation: GENERATION, folder: 'INBOX', uid: 500 }) });
    expect(await mgr.wakeSnoozed(source)).toBe(false);
    expect(mgr.moveMessage).toHaveBeenCalledTimes(1);
  });
  it('holds after a transport failure instead of replaying an uncertain MOVE', async () => {
    snooze('a'); const source = rowRead('a'); mgr.moveMessage.mockRejectedValue(new Error('connection lost'));
    expect(await mgr.wakeSnoozed(source)).toBe(false);
    expect(snoozes.get('a').wake_state).toBe('waking');
    await mgr._runSnoozeWakeup();
    expect(mgr.moveMessage).toHaveBeenCalledTimes(1);
  });
  it('does not count or mark a replacement source after provider success', async () => {
    snooze('a'); acknowledgeMove(500, () => { messages = []; });
    expect(await mgr.wakeSnoozed(rowRead('a'))).toBe(true);
    expect(adjustFolderCounts).not.toHaveBeenCalled(); expect(mgr.setFlag).not.toHaveBeenCalled();
    expect(snoozes.get('a').wake_state).toBe('pending');
  });
});

describe('destination availability and legacy holds', () => {
  it.each([['Old project', false, 'INBOX'], ['Projects', true, 'INBOX'], ['Projects', false, 'Projects']])(
    'returns from %s with noSelect=%s to %s', async (original, unselectable, expected) => {
      snooze('a'); snoozes.get('a').original_folder = original;
      if (unselectable) noSelect.add(original);
      expect(await mgr.wakeSnoozed(rowRead('a'), { markUnread: false })).toBe(true);
      expect(mgr.moveMessage).toHaveBeenCalledExactlyOnceWith(ACCOUNT, 10, 'Snoozed', expected,
        { expectedSource: expect.objectContaining({ id: 'cache-a', entity_id: 'entity-a', storage_generation: GENERATION, uid_validity: '10' }) });
    });
  it.each([null, '22222222-2222-4222-8222-222222222222'])('retains prior generation %s while refusing provider work', async generation => {
    snooze('a'); const source = rowRead('a'); snoozes.get('a').storage_generation = generation;
    expect(await mgr.wakeSnoozed(source)).toBe(false);
    await mgr._runSnoozeWakeup(); messages = []; await mgr._runSnoozeWakeup();
    expect(snoozes.has('a')).toBe(true); expect(mgr.moveMessage).not.toHaveBeenCalled();
  });
  it('holds a legacy NULL-entity decision even when its header matches current mail', async () => {
    snooze('a'); const source = rowRead('a'); snoozes.get('a').entity_id = null;
    expect(await mgr.wakeSnoozed(source)).toBe(false);
    await mgr._runSnoozeWakeup();
    expect(snoozes.has('a')).toBe(true); expect(mgr.moveMessage).not.toHaveBeenCalled();
  });
});
