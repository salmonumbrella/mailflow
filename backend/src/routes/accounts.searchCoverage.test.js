import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, res, next) => {
    if (req.get('x-test-auth') === 'none') return res.status(401).json({ error: 'Authentication required' });
    req.session = { userId: 'coverage-owner' };
    next();
  },
}));
vi.mock('../services/searchIndexJobs.js', () => ({ setSearchCoverageAction: vi.fn() }));
vi.mock('../services/searchCoverage.js', () => ({ getSearchCoverage: vi.fn() }));
vi.mock('../services/imapManager.js', () => ({ providerProfile: () => ({ labelStore: false }) }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn().mockResolvedValue({
    allowPrivateHosts: false, allowInsecureTls: false, allowNonstandardPorts: false,
  }),
}));

import express from 'express';
import accountRoutes from './accounts.js';
import { query } from '../services/db.js';
import { setSearchCoverageAction } from '../services/searchIndexJobs.js';
import { getSearchCoverage } from '../services/searchCoverage.js';

const accountId = '11111111-1111-4111-8111-111111111111';

// Retains all20 authorization/action/error cases from the earlier P3 draft.
// The new live coverage service has real-PG controls; this router test is UNRUN.
describe('account search coverage authorization and input boundaries', () => {
  let server;
  let base;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/accounts', accountRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/accounts`;
  });

  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    query.mockReset();
    // An account absent from the authenticated user's scope.
    query.mockResolvedValue({ rows: [] });
    getSearchCoverage.mockReset();
    getSearchCoverage.mockResolvedValue([]);
    setSearchCoverageAction.mockReset();
  });

  it.each(['GET', 'POST'])('rejects malformed account IDs before database work (%s)', async method => {
    const response = await fetch(`${base}/invalid/search-coverage`, {
      method,
      ...(method === 'POST' ? {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'pause' }),
      } : {}),
    });
    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', undefined],
    ['POST', 'pause'],
    ['POST', 'resume'],
    ['POST', 'retry'],
  ])('hides an unowned or deleted account for %s %s', async (method, action) => {
    const response = await fetch(`${base}/${accountId}/search-coverage`, {
      method,
      ...(action ? {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      } : {}),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Account not found' });
    // Require the real endpoint to invoke its owner-scoped service boundary.
    if (method === 'GET') {
      expect(getSearchCoverage).toHaveBeenCalledWith([accountId], {
        userId: 'coverage-owner', profileForAccount: expect.any(Function),
      });
    } else expect(setSearchCoverageAction).toHaveBeenCalledWith(accountId, action, { userId: 'coverage-owner' });
  });

  it.each(['GET', 'POST'])('requires authentication before account lookup (%s)', async method => {
    const response = await fetch(`${base}/${accountId}/search-coverage`, {
      method, headers: { 'x-test-auth': 'none', 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify({ action: 'pause' }) } : {}),
    });
    expect(response.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
    expect(setSearchCoverageAction).not.toHaveBeenCalled();
  });

  it.each([{}, { action: 'reindex' }, { action: ['pause'] }, { action: null }])('rejects unsupported action input %j', async body => {
    const response = await fetch(`${base}/${accountId}/search-coverage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(setSearchCoverageAction).not.toHaveBeenCalled();
  });

  it.each(['pause', 'resume', 'retry'])('applies only the authenticated account action %s', async action => {
    query.mockResolvedValueOnce({ rows: [{ id: accountId }] });
    setSearchCoverageAction.mockResolvedValueOnce({ paused: action === 'pause', run_epoch: '9007199254740993' });
    const response = await fetch(`${base}/${accountId}/search-coverage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ paused: action === 'pause' });
    expect(setSearchCoverageAction).toHaveBeenCalledWith(accountId, action, { userId: 'coverage-owner' });
  });

  it('returns live coverage without promoting completed bookkeeping to full provider coverage', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: accountId }] });
    const state = { accountId, paused: false, complete: false, providerMessageCount: null, estimateMs: null,
      body: { sources: 4, verified: 2, pending: 1, unsupported: 1 }, jobCounts: { complete: 3 } };
    getSearchCoverage.mockResolvedValueOnce([state]);
    const response = await fetch(`${base}/${accountId}/search-coverage`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(state);
    expect(getSearchCoverage).toHaveBeenCalledWith([accountId], { userId: 'coverage-owner', profileForAccount: expect.any(Function) });
  });

  it.each(['GET', 'POST'])('rechecks account ownership inside the state operation (%s)', async method => {
    query.mockResolvedValueOnce({ rows: [{ id: accountId }] });
    getSearchCoverage.mockResolvedValueOnce([]);
    setSearchCoverageAction.mockResolvedValueOnce(null);
    const response = await fetch(`${base}/${accountId}/search-coverage`, {
      method, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'pause' }) } : {}),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Account not found' });
  });

  it.each(['GET', 'POST'])('reports state-storage failures as an error (%s)', async method => {
    query.mockResolvedValueOnce({ rows: [{ id: accountId }] });
    getSearchCoverage.mockRejectedValueOnce(new Error('synthetic storage failure'));
    setSearchCoverageAction.mockRejectedValueOnce(new Error('synthetic storage failure'));
    const response = await fetch(`${base}/${accountId}/search-coverage`, {
      method, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'pause' }) } : {}),
    });
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/try again/i);
  });
});
