import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../services/db.js', () => ({ query: vi.fn(async () => ({ rows: [{ id: 'owner' }] })), withTransaction: vi.fn() }));
vi.mock('../services/lastSeen.js', () => ({ touchLastSeen: vi.fn() }));
vi.mock('../services/nativeLabelMemberships.js', () => ({ queryMemberships: vi.fn(), mutateMemberships: vi.fn(), undoMemberships: vi.fn() }));
vi.mock('../services/nativeLabelReadModel.js', () => ({ listNativeLabelMessages: vi.fn(), getNativeLabelCounts: vi.fn() }));
import express from 'express';
import routes from './labels.js';
import { queryMemberships, mutateMemberships, undoMemberships } from '../services/nativeLabelMemberships.js';
import { listNativeLabelMessages, getNativeLabelCounts } from '../services/nativeLabelReadModel.js';
import { LabelError } from '../services/nativeLabelDefinitions.js';
import { csrfGuard } from '../middleware/csrfGuard.js';
import { screenLockGate } from '../middleware/screenLock.js';
import { matchApiTokenRoute } from '../services/apiTokenAllowlist.js';
const accountId = '11111111-1111-4111-8111-111111111111', storageGeneration = '22222222-2222-4222-8222-222222222222';
const entityId = '33333333-3333-4333-8333-333333333333';
const broadcast = vi.fn(); let server, base;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.set('imapManager', { broadcast });
  app.use((req, _res, next) => { req.session = req.get('x-anonymous') ? {} : { userId: 'owner', locked: req.get('x-locked') === 'yes' }; next(); });
  app.use('/api', csrfGuard, screenLockGate); app.use('/api/labels', routes);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/labels`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));
beforeEach(() => vi.resetAllMocks());
const call = async (method, path, body, headers = {}) => {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json() };
};
describe('native membership API boundaries', () => {
  it.each([['POST', '/memberships'], ['POST', '/memberships/query'], ['POST', '/memberships/undo'], ['GET', '/counts'], ['GET', `/${entityId}/messages`]])('requires session and screen unlock, excludes API tokens: %s %s', async (method, path) => {
    expect((await call(method, path, method === 'POST' ? {} : undefined, { 'x-anonymous': 'yes' })).status).toBe(401);
    expect((await call(method, path, method === 'POST' ? {} : undefined, { 'x-locked': 'yes' })).status).toBe(423);
    expect(matchApiTokenRoute(method, `/api/labels${path}`)).toBeNull();
    expect(mutateMemberships).not.toHaveBeenCalled(); expect(queryMemberships).not.toHaveBeenCalled();
  });
  it('requires CSRF header for query and mutation POSTs', async () => {
    for (const path of ['/memberships', '/memberships/query', '/memberships/undo']) expect((await call('POST', path, {}, { 'x-requested-with': '' })).status).toBe(403);
    expect(queryMemberships).not.toHaveBeenCalled(); expect(mutateMemberships).not.toHaveBeenCalled();
  });
  it('publishes committed generation-scoped canonical changes once, and replay never publishes', async () => {
    const result = { accountId, storageGeneration, targets: [{ entityId }, { entityId }] };
    mutateMemberships.mockResolvedValueOnce({ result, changed: true }).mockResolvedValueOnce({ result, changed: false });
    expect((await call('POST', '/memberships', { accountId })).body).toEqual(result);
    expect(broadcast).toHaveBeenCalledWith({ type: 'label_memberships_changed', accountId, storageGeneration, entityIds: [entityId] }, 'owner');
    await call('POST', '/memberships', { accountId }); expect(broadcast).toHaveBeenCalledTimes(1);
  });
  it('keeps committed success despite push failure and maps stale conflict errors', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    broadcast.mockImplementationOnce(() => { throw new Error('offline'); });
    mutateMemberships.mockResolvedValueOnce({ result: { accountId, storageGeneration, targets: [{ entityId }] }, changed: true });
    expect((await call('POST', '/memberships', {})).status).toBe(200);
    mutateMemberships.mockRejectedValueOnce(new LabelError(409, 'stale_metadata_version', 'Refresh'));
    expect(await call('POST', '/memberships', {})).toEqual({ status: 409, body: { error: 'Refresh', code: 'stale_metadata_version' } }); warning.mockRestore();
  });
  it('routes Undo through identical commit-only notifications and error handling', async () => {
    const result = { accountId, storageGeneration, targets: [{ entityId }], undoSupported: false };
    undoMemberships.mockResolvedValueOnce({ result, changed: true }).mockResolvedValueOnce({ result, changed: false });
    expect((await call('POST', '/memberships/undo', { accountId })).body).toEqual(result);
    await call('POST', '/memberships/undo', { accountId }); expect(broadcast).toHaveBeenCalledTimes(1);
    expect(undoMemberships).toHaveBeenCalledWith('owner', { accountId });
    undoMemberships.mockRejectedValueOnce(new LabelError(409, 'stale_metadata_version', 'Refresh'));
    expect((await call('POST', '/memberships/undo', {})).body.code).toBe('stale_metadata_version');
  });
  it('routes queries/count/feed with authenticated owner overriding request userId', async () => {
    queryMemberships.mockResolvedValueOnce({ targets: [] });
    expect((await call('POST', '/memberships/query', { accountId })).body).toEqual({ targets: [] });
    expect(queryMemberships).toHaveBeenCalledWith('owner', { accountId });
    getNativeLabelCounts.mockResolvedValueOnce({ counts: [] }); listNativeLabelMessages.mockResolvedValueOnce({ messages: [] });
    await call('GET', `/counts?accountId=${accountId}&userId=attacker`);
    expect(getNativeLabelCounts).toHaveBeenCalledWith({ accountId, userId: 'owner' });
    await call('GET', `/${entityId}/messages?accountId=${accountId}&userId=attacker`);
    expect(listNativeLabelMessages).toHaveBeenCalledWith({ accountId, userId: 'owner', labelId: entityId });
  });
});
