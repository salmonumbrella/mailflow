import 'express-async-errors';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';

const state = vi.hoisted(() => ({ enabled: true, token: null, cookieReads: 0 }));
vi.mock('../services/db.js', () => ({ withTransaction: vi.fn(), query: vi.fn(async (sql, values) => ({ rows: sql.includes('FROM users') ? [{ id: values[0] }]
  : sql.includes('FROM email_accounts') && values[1] === 'user-1' ? [{ id: values[0], user_id: 'user-1', enabled: true,
    smtp_host: 'smtp.fastmail.com', auth_user: 'owner@synthetic.test', fastmail_api_token: null }] : [] })) }));
vi.mock('../services/lastSeen.js', () => ({ touchLastSeen: vi.fn() }));
vi.mock('../services/rateLimiter.js', () => ({ consume: vi.fn(async () => ({ limited: false, resetMs: 3600000 })) }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/apiTokens.js', async importOriginal => ({ ...await importOriginal(),
  apiTokensEnabled: async () => state.enabled, findTokenByHash: async () => state.token,
  recordTokenUse: vi.fn(), tokenStillValid: async () => Boolean(state.token && !state.token.expired),
}));
vi.mock('../services/fastmailIdentities.js', async importOriginal => ({ ...await importOriginal(), createFastmailMaskedEmail: vi.fn() }));
import { mountApiAuth } from '../middleware/apiChain.js';
import { requireAuth } from '../middleware/auth.js';
import { createFastmailMaskedEmail, getSenderIdentityInventory } from '../services/fastmailIdentities.js';
import { consume } from '../services/rateLimiter.js';
import providerRouter from './providerIdentities.js';

const accountId = '11111111-1111-4111-8111-111111111111';
const clientRequestId = 'abcdefab-1111-4111-8111-111111111111';
const token = `mfat_${'a'.repeat(43)}`;
const body = { confirmed: true, clientRequestId };
let server, base;
beforeAll(async () => {
  const app = express();
  // Actual PAT/parser/CSRF/lock/guard order. Cookie stand-in only models precedence;
  // this fixture does not test express-session signing or the aggregate app entry point.
  mountApiAuth(app, (req, _res, next) => {
    if (!req.session) { state.cookieReads++; if (req.headers.cookie) req.session = { userId: 'user-1' }; }
    next();
  });
  app.get('/api/accounts/:id/sender-identities', requireAuth, async (req, res) => {
    res.json(await getSenderIdentityInventory(req.session.userId, req.params.id));
  });
  app.use('/api/accounts', providerRouter);
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}/api/accounts/${accountId}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
beforeEach(() => {
  vi.clearAllMocks(); state.enabled = true; state.cookieReads = 0;
  state.token = { id: 'synthetic-token', user_id: 'user-1', username: 'synthetic-user', name: 'synthetic',
    scopes: ['read'], expired: false, created_at: '2026-10-21T00:00:00Z', expires_at: null };
  createFastmailMaskedEmail.mockResolvedValue({ accountId, provider: 'fastmail', email: 'mask@synthetic.test', state: 'enabled', outcome: 'created', clientRequestId });
});
const call = (method, suffix, headers = {}) => fetch(`${base}/${suffix}`, { method, headers: {
  Authorization: `Bearer ${token}`, 'X-Requested-With': 'mailflow-mcp', ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }), ...headers,
}, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });

it('enforces identity read and write independently through the actual PAT middleware and exact allowlist', async () => {
  for (const [scopes, readStatus, writeStatus] of [[['read', 'organize', 'draft'], 403, 403],
    [['identity:read'], 200, 403], [['identity:write'], 403, 201]]) {
    state.token.scopes = scopes;
    expect((await call('GET', 'sender-identities')).status).toBe(readStatus);
    expect((await call('POST', 'masked-emails')).status).toBe(writeStatus);
  }
  expect(createFastmailMaskedEmail).toHaveBeenCalledTimes(1);
});
it('does not let cookies rescue revoked, expired, disabled or malformed bearer credentials', async () => {
  for (const variant of ['revoked', 'expired', 'disabled', 'malformed']) {
    const saved = state.token;
    state.token = variant === 'revoked' ? null : { ...saved, expired: variant === 'expired' };
    state.enabled = variant !== 'disabled';
    const authorization = variant === 'malformed' ? 'Bearer mfat_bad' : `Bearer ${token}`;
    const response = await call('POST', 'masked-emails', { Authorization: authorization, Cookie: 'synthetic-session=valid' });
    expect(response.status).toBe(401);
    state.token = saved; state.enabled = true;
  }
  expect(state.cookieReads).toBe(0); expect(createFastmailMaskedEmail).not.toHaveBeenCalled();
});
it('refuses foreign accounts after token authentication without a create budget or provider call', async () => {
  state.token.scopes = ['identity:write']; state.token.user_id = 'foreign-user';
  expect((await call('POST', 'masked-emails')).status).toBe(404);
  expect(consume.mock.calls.some(([key]) => key.startsWith('masked-create:'))).toBe(false);
  expect(createFastmailMaskedEmail).not.toHaveBeenCalled();
});
