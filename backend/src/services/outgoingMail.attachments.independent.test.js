import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager: { fetchAttachment: vi.fn() } }));
import { query } from './db.js';
import { imapManager } from '../index.js';
import { resolveForwarded } from './outgoingMail.js';

const owner = '11111111-1111-4111-8111-111111111111';
const stranger = '22222222-2222-4222-8222-222222222222';
const source = {
  id: '33333333-3333-4333-8333-333333333333', account_id: '44444444-4444-4444-8444-444444444444',
  storage_generation: '55555555-5555-4555-8555-555555555555', entity_id: '66666666-6666-4666-8666-666666666666',
  folder: 'INBOX', uid: 7, uid_validity: '10',
  attachments: [{ part: '2', filename: 'original.pdf', type: 'application/pdf', size: 8 }],
};
const input = { forwardedAttachments: [{ messageId: source.id, part: '2' }] };
let currentAccount, changeOwnerOnAccountRead;

beforeEach(() => {
  currentAccount = { id: source.account_id, user_id: owner, enabled: true, storage_generation: source.storage_generation };
  changeOwnerOnAccountRead = false;
  query.mockReset().mockImplementation(async (sql, params) => {
    if (sql.includes('FROM messages m')) {
      return { rows: params[0] === currentAccount.user_id ? [{ ...source }] : [] };
    }
    if (sql.includes('FROM email_accounts')) {
      if (changeOwnerOnAccountRead) currentAccount.user_id = stranger;
      const userParameter = sql.match(/user_id\s*=\s*\$(\d+)/)?.[1];
      return { rows: !userParameter || params[Number(userParameter) - 1] === currentAccount.user_id ? [{ ...currentAccount }] : [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  imapManager.fetchAttachment.mockReset().mockImplementation(async account => {
    // The engine can validate the owner it is given, but cannot recover the initiating user.
    expect(account.user_id).toBe(currentAccount.user_id);
    return Buffer.from('original');
  });
});

describe('independent forwarded attachment ownership fence', () => {
  it('preserves the selected physical source and ordinary attachment bytes', async () => {
    const result = await resolveForwarded(owner, input);
    expect(result.attachments).toEqual([{ filename: 'original.pdf', content: Buffer.from('original'), contentType: 'application/pdf' }]);
    expect(imapManager.fetchAttachment).toHaveBeenCalledWith(currentAccount, 7, 'INBOX', '2', { expectedSource: source });
  });

  it('does not adopt a new owner after selecting the original user-owned message', async () => {
    changeOwnerOnAccountRead = true;
    await expect(resolveForwarded(owner, input)).rejects.toMatchObject({ status: expect.any(Number) });
    expect(imapManager.fetchAttachment).not.toHaveBeenCalled();
  });

  it('retains the initiating owner through an engine await and does not retry under a replacement owner', async () => {
    let start, finish;
    const started = new Promise(resolve => { start = resolve; });
    const resume = new Promise(resolve => { finish = resolve; });
    imapManager.fetchAttachment.mockImplementation(async account => {
      start();
      await resume;
      expect(account.user_id).toBe(owner);
      expect(currentAccount.user_id).toBe(stranger);
      throw Object.assign(new Error('The attachment source changed'), { status: 409, code: 'identity_source_changed' });
    });
    const pending = resolveForwarded(owner, input);
    const rejected = expect(pending).rejects.toMatchObject({ status: 409 });
    await started;
    currentAccount.user_id = stranger;
    finish();
    await rejected;
    expect(imapManager.fetchAttachment).toHaveBeenCalledOnce();
  });
});
