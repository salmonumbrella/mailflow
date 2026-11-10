import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../services/messageIdentity.js', async original => ({ ...await original(),
  captureMessageSource: vi.fn(async (account, folderPath, uid, expectedSource) => ({
    context: { accountId: account.id, storageGeneration: account.storage_generation, folderPath, uidValidity: '9', revision: '1' }, expectedSource,
  })), assertExpectedSource: vi.fn(async () => {}),
  withMailboxIdentity: vi.fn(async (_context, run) => run({ query })),
}));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'owner' }; next(); } }));
const imapManager = vi.hoisted(() => ({ appendToFolder: vi.fn(), upsertDraftMessageRecord: vi.fn(),
  findUidByMessageId: vi.fn(), permanentDeleteMessage: vi.fn(), broadcast: vi.fn(), scheduleCountRefresh: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager }));
import { query } from '../services/db.js';
import router from './draft.js';
const source = { messageId: '11111111-1111-4111-8111-111111111111', accountId: '22222222-2222-4222-8222-222222222222',
  storageGeneration: '33333333-3333-4333-8333-333333333333', entityId: '44444444-4444-4444-8444-444444444444', folder: 'Drafts', uidValidity: '9', uid: '7' };
const account = { id: source.accountId, user_id: 'owner', enabled: true, storage_generation: source.storageGeneration,
  folder_mappings: { drafts: 'Drafts' }, name: 'Sender', email_address: 'me@example.test' };
const old = { id: source.messageId, account_id: account.id, storage_generation: source.storageGeneration,
  entity_id: source.entityId, folder: 'Drafts', uid_validity: '9', uid: 7, message_id: '<old@example.test>' };
const fresh = { ...old, id: '55555555-5555-4555-8555-555555555555', entity_id: '66666666-6666-4666-8666-666666666666', uid: 8 };
const newSource = { ...source, messageId: fresh.id, entityId: fresh.entity_id, uid: '8' };
const context = { accountId: account.id, storageGeneration: account.storage_generation, folderPath: 'Drafts', uidValidity: '9', revision: '1' };
let server, base, lastRequestBody;
beforeAll(async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { lastRequestBody = req.body; next(); }); app.use(router);
  await new Promise(resolve => { server = app.listen(0, resolve); }); base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
beforeEach(() => {
  vi.clearAllMocks();
  query.mockImplementation(async sql => ({ rows: sql.includes('JOIN email_accounts') ? [old] : sql.includes('email_accounts') ? [account] : [], rowCount: 1 }));
  imapManager.appendToFolder.mockResolvedValue({ uid: 8, identityContext: context });
  imapManager.upsertDraftMessageRecord.mockResolvedValue(fresh);
  imapManager.permanentDeleteMessage.mockResolvedValue(true);
});
const post = async (patch = {}) => {
  const response = await fetch(`${base}/draft`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    accountId: account.id, body: 'Saved text', existingUid: 7, existingFolder: 'Drafts', existingAccountId: account.id, existingSource: source, ...patch,
  }) }); return { status: response.status, body: await response.json() };
};
describe('draft save receipt is exact append authority, not an RFC header', () => {
  it('returns the verified new physical source, keeping the RFC identity separate', async () => {
    const result = await post({ includeIdentity: true });
    expect(result.status).toBe(200); expect(result.body.draftSource).toEqual(newSource);
    expect(result.body.messageId).toMatch(/^<.*@example\.test>$/);
    expect(result.body.cleanup).toEqual({ status: 'deleted' });
    expect(imapManager.permanentDeleteMessage.mock.calls[0][3]).toMatchObject({ expectedSource: old, expectedOwnerId: 'owner' });
    expect(imapManager.findUidByMessageId).not.toHaveBeenCalled();
  });
  it('freezes original cleanup proof before the first ownership wait', async () => {
    query.mockImplementationOnce(async () => {
      lastRequestBody.existingSource.messageId = '99999999-9999-4999-8999-999999999999';
      lastRequestBody.existingSource.uidValidity = '99';
      return { rows: [account] };
    });
    const result = await post(); expect(result.body.cleanup.status).toBe('deleted');
    expect(imapManager.permanentDeleteMessage.mock.calls[0][3].expectedSource).toEqual(old);
  });
  it.each(['unknown-uid', 'unresolved-append', 'missing-row', 'newer-row', 'cache-failure'])('retains the original after %s, without certifying a later locator', async scenario => {
    if (scenario === 'unknown-uid') imapManager.appendToFolder.mockResolvedValue({ uid: null, identityContext: null });
    if (scenario === 'unresolved-append') imapManager.appendToFolder.mockResolvedValue({ uid: 8, identityContext: null });
    if (scenario === 'missing-row') imapManager.upsertDraftMessageRecord.mockResolvedValue(null);
    if (scenario === 'newer-row') imapManager.upsertDraftMessageRecord.mockResolvedValue({ ...fresh, uid_validity: '10' });
    if (scenario === 'cache-failure') imapManager.upsertDraftMessageRecord.mockRejectedValueOnce(new Error('Cache unavailable'));
    const result = await post();
    expect(result.status).toBe(200); expect(result.body.draftSource).toBeNull();
    expect(result.body.cleanup.status).toBe('retained');
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
    expect(imapManager.findUidByMessageId).not.toHaveBeenCalled(); expect(imapManager.appendToFolder).toHaveBeenCalledOnce();
  });
  it('saves the new draft but retains a locator-only legacy original', async () => {
    const result = await post({ existingSource: undefined });
    expect(result.body.draftSource).toEqual(newSource); expect(result.body.cleanup.status).toBe('retained');
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
  });
  it('does not retry or clean up after an unknown APPEND outcome', async () => {
    imapManager.appendToFolder.mockRejectedValueOnce(new Error('APPEND outcome unknown'));
    const result = await post(); expect(result.status).toBe(500);
    expect(imapManager.appendToFolder).toHaveBeenCalledOnce(); expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
    expect(imapManager.upsertDraftMessageRecord).not.toHaveBeenCalled();
  });
});
describe('discard requires the clicked original source header', () => {
  it.each([null, { messageId: source.messageId }, { ...source, uid: '8' }])('refuses absent or inconsistent proof %j', async proof => {
    const response = await fetch(`${base}/draft/7?accountId=${account.id}&folder=Drafts`, { method: 'DELETE',
      headers: proof ? { 'X-Mailflow-Message-Source': encodeURIComponent(JSON.stringify(proof)) } : {} });
    expect(response.status).toBe(409); expect((await response.json()).cleanup.status).toBe('retained');
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM messages'))).toBe(false);
  });
  it('deletes only the verified clicked original', async () => {
    const response = await fetch(`${base}/draft/7?accountId=${account.id}&folder=Drafts`, { method: 'DELETE',
      headers: { 'X-Mailflow-Message-Source': encodeURIComponent(JSON.stringify(source)) } });
    expect(response.status).toBe(200); expect((await response.json()).cleanup.status).toBe('deleted');
    const [sql, params] = query.mock.calls.find(([sql]) => sql.includes('DELETE FROM messages'));
    expect(sql).toContain('id=$1'); expect(params[0]).toBe(old.id);
  });
});
