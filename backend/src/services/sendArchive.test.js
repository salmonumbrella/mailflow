import { describe, expect, it, vi } from 'vitest';
vi.mock('./sendHold.js', () => ({ getSendStatus: vi.fn() }));
import { selectSendArchiveTargets } from './sendArchive.js';
const context = { pendingId: '11111111-1111-4111-8111-111111111111', accountId: '22222222-2222-4222-8222-222222222222', threadId: 'thread-original', inReplyTo: '<original>' };
const message = { id: 'original', account_id: context.accountId, thread_id: context.threadId, folder: 'INBOX' };
const sent = async () => ({ status: 'sent', result: { ok: true } });

describe('post-send archive gate', () => {
  it('requires a durable confirmed receipt for this user, not held, failed, cancelled, or uncertain outcomes', async () => {
    for (const status of ['pending', 'sending', 'cancelled', 'failed', 'unknown', 'lost']) {
      await expect(selectSendArchiveTargets('owner', context, [message], async () => ({ status, result: { ok: true } }))).rejects.toMatchObject({ status: 409 });
    }
    const statusOf = vi.fn(sent);
    await expect(selectSendArchiveTargets('owner', context, [message], statusOf)).resolves.toEqual([message]);
    expect(statusOf).toHaveBeenCalledWith('owner', context.pendingId);
  });
  it('will not archive partial sends, unconfirmed records, or a failed Sent copy', async () => {
    for (const result of [undefined, {}, { ok: true, rejected: ['bad'] }, { ok: true, sentCopySaved: false }]) {
      await expect(selectSendArchiveTargets('owner', context, [message], async () => ({ status: 'sent', result }))).rejects.toMatchObject({ status: 409 });
    }
  });
  it('keeps only requested original-account/thread INBOX rows and excludes moved/deleted mail', async () => {
    const owned = [message, { ...message, id: 'other-thread', thread_id: 'new' }, { ...message, id: 'other-account', account_id: 'other' }, { ...message, id: 'moved', folder: 'Trash' }, { ...message, id: 'deleted', is_deleted: true }];
    await expect(selectSendArchiveTargets('owner', context, owned, sent)).resolves.toEqual([message]);
  });
  it('rejects malformed context before reading statuses and propagates storage failure without archive targets', async () => {
    const statusOf = vi.fn(sent);
    for (const value of [null, [], {}, { ...context, pendingId: 'bad' }, { ...context, accountId: 'bad' }, { ...context, threadId: '' }]) await expect(selectSendArchiveTargets('owner', value, [message], statusOf)).rejects.toMatchObject({ status: 400 });
    expect(statusOf).not.toHaveBeenCalled();
    await expect(selectSendArchiveTargets('owner', context, [message], async () => { throw new Error('storage unavailable'); })).rejects.toThrow('storage unavailable');
  });
});
