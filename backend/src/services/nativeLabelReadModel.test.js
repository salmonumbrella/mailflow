import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
import { query, withTransaction } from './db.js';
import { getNativeLabelCounts, hydrateNativeLabels, listNativeLabelMessages } from './nativeLabelReadModel.js';

const accountId = '11111111-1111-4111-8111-111111111111';
const storageGeneration = '22222222-2222-4222-8222-222222222222';
const labelId = '33333333-3333-4333-8333-333333333333';
const entityId = '44444444-4444-4444-8444-444444444444';
const messageId = '55555555-5555-4555-8555-555555555555';
const input = { userId: 'owner', accountId, storageGeneration, labelId };
beforeEach(() => { vi.clearAllMocks(); });

describe('native label read boundaries', () => {
  it.each([
    { accountId: null }, { accountId: ['bad'] }, { storageGeneration: '' }, { labelId: 'not-a-uuid' },
    { limit: 0 }, { limit: 201 }, { limit: '2.5' }, { limit: '' }, { limit: NaN },
    { includeSpamTrash: 'yes' }, { unreadOnly: 'yes' }, { cursor: 'not-json' },
  ])('rejects malformed feed input without touching the database: %j', async changes => {
    await expect(listNativeLabelMessages({ ...input, ...changes })).rejects.toMatchObject({ status: 400, code: 'invalid_label_request' });
    expect(withTransaction).not.toHaveBeenCalled();
  });
  it.each([{ accountId: '' }, { storageGeneration: '' }, { includeSpamTrash: 1 }])('validates count scope: %j', async changes => {
    await expect(getNativeLabelCounts({ ...input, ...changes })).rejects.toMatchObject({ status: 400 });
    expect(withTransaction).not.toHaveBeenCalled();
  });
  it('rejects cursors from another filter, label, account or generation', async () => {
    const cursor = { v: 1, accountId, storageGeneration, labelId, unreadOnly: false, includeSpamTrash: false,
      date: '2026-11-01 12:00:00.123456+00', entityId };
    for (const changes of [{ v: 2 }, { accountId: entityId }, { storageGeneration: entityId }, { labelId: entityId },
      { unreadOnly: true }, { includeSpamTrash: true }, { entityId: 'bad' }, { date: 'drop table messages;' }, { date: '2026-02-30 12:00:00+00' }, { date: '2026-11-01 99:00:00+00' }, { date: '2026-11-01 12:00:00+99' }]) {
      await expect(listNativeLabelMessages({ ...input, cursor: Buffer.from(JSON.stringify({ ...cursor, ...changes })).toString('base64url') }))
        .rejects.toMatchObject({ status: 400 });
    }
    expect(withTransaction).not.toHaveBeenCalled();
  });
  it('does no reads for an empty list and makes unverifiable DTOs explicitly unavailable', async () => {
    expect(await hydrateNativeLabels('owner', [])).toEqual([]);
    const rows = await hydrateNativeLabels('owner', [{ id: 'not-a-cache-uuid', account_id: accountId }]);
    expect(rows[0]).toMatchObject({ nativeLabelState: 'unavailable', nativeLabels: null, nativeLabelScope: 'message', metadataVersion: null });
    expect(query).not.toHaveBeenCalled();
  });
  it('passes complete source coordinates and does not collapse old/new snapshots sharing one cache UUID', async () => {
    const old = { id: messageId, account_id: accountId, folder: 'INBOX', uid: '9', entity_id: entityId,
      storage_generation: storageGeneration, uid_validity: '42' };
    const current = { ...old, uid_validity: '43' };
    query.mockResolvedValue({ rows: [
      { request_index: 0, id: messageId, storage_generation: storageGeneration, entity_id: null },
      { request_index: 1, id: messageId, storage_generation: storageGeneration, entity_id: entityId, metadata_version: '9007199254740993', labels: [] },
    ] });
    const rows = await hydrateNativeLabels('owner', [old, current]);
    expect(rows[0].nativeLabels).toBeNull();
    expect(rows[1]).toMatchObject({ nativeLabels: [], entityId, metadataVersion: '9007199254740993' });
    const requested = JSON.parse(query.mock.calls[0][1][1]);
    expect(requested).toEqual([{ request_index: 0, ...old }, { request_index: 1, ...current }]);
    expect(query.mock.calls[0][0]).toContain('m.uid_validity=r.uid_validity');
    expect(query.mock.calls[0][0]).toContain('m.storage_generation=r.storage_generation');
    expect(query.mock.calls[0][0]).toContain('m.entity_id=r.entity_id');
  });
  it('does not swallow failed metadata queries and pretend the messages have no labels', async () => {
    query.mockRejectedValue(new Error('Database unavailable'));
    await expect(hydrateNativeLabels('owner', [{ id: messageId, account_id: accountId }])).rejects.toThrow('Database unavailable');
  });
});
