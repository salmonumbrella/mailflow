import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager: { permanentDeleteMessage: vi.fn(), broadcast: vi.fn(), scheduleCountRefresh: vi.fn() } }));
vi.mock('./messageIdentity.js', async original => ({ ...await original(),
  captureMessageSource: vi.fn(), assertExpectedSource: vi.fn(),
  withMailboxIdentity: vi.fn(async (_context, run) => run({ query })),
}));
import { query } from './db.js';
import { imapManager } from '../index.js';
import { captureMessageSource } from './messageIdentity.js';
import { findReplacedDraft, deleteSentDraft } from './draftCopies.js';
const source = Object.freeze({ messageId: '11111111-1111-4111-8111-111111111111',
  accountId: '22222222-2222-4222-8222-222222222222', storageGeneration: '33333333-3333-4333-8333-333333333333',
  entityId: '44444444-4444-4444-8444-444444444444', folder: 'Drafts', uidValidity: '9', uid: '7' });
const row = { id: source.messageId, account_id: source.accountId, storage_generation: source.storageGeneration,
  entity_id: source.entityId, folder: source.folder, uid_validity: source.uidValidity, uid: 7, message_id: '<same@example.test>' };
const account = { id: source.accountId, user_id: 'owner', storage_generation: source.storageGeneration, folder_mappings: { drafts: 'Drafts' } };
const locator = { existingUid: 7, existingFolder: 'Drafts', existingAccountId: account.id };
beforeEach(() => {
  vi.clearAllMocks();
  query.mockImplementation(async sql => ({ rows: sql.includes('email_accounts') && !sql.includes('JOIN') ? [account] : [row], rowCount: 1 }));
  captureMessageSource.mockImplementation(async (_account, _folder, _uid, expectedSource) => ({
    context: { accountId: account.id, storageGeneration: account.storage_generation, folderPath: 'Drafts', uidValidity: '9', revision: '1' }, expectedSource,
  }));
  imapManager.permanentDeleteMessage.mockResolvedValue(true);
});
describe('draft cleanup never upgrades a locator into authority', () => {
  it('retains a legacy UID-only draft instead of adopting the current row', async () => {
    expect(await findReplacedDraft('owner', account, 'Drafts', locator)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
  it('refuses a reused UID even when its RFC Message-ID collides', async () => {
    query.mockResolvedValue({ rows: [{ ...row, id: '55555555-5555-4555-8555-555555555555' }] });
    expect(await findReplacedDraft('owner', account, 'Drafts', { ...locator, existingSource: source })).toBeNull();
  });
  it('carries the exact original row and owner through a same-source delete', async () => {
    const target = await findReplacedDraft('owner', account, 'Drafts', { ...locator, existingSource: source });
    expect(target).toMatchObject({ expectedSource: row, account, userId: 'owner' });
    expect(await deleteSentDraft('owner', account, { uid: 7, folder: 'Drafts', accountId: account.id, source })).toBe(true);
    expect(imapManager.permanentDeleteMessage).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'owner' }), 7, 'Drafts',
      expect.objectContaining({ expectedSource: row, expectedOwnerId: 'owner' }));
    const [sql, values] = query.mock.calls.find(([sql]) => sql.includes('DELETE FROM messages'));
    expect(sql).toContain('id=$1'); expect(values[0]).toBe(source.messageId);
  });
  it('retains a sent legacy draft without failing delivery cleanup', async () => {
    expect(await deleteSentDraft('owner', account, { uid: 7, folder: 'Drafts', accountId: account.id })).toBe(false);
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
  });
});
