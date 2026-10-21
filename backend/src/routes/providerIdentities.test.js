import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../services/lastSeen.js', () => ({ touchLastSeen: vi.fn() }));
vi.mock('../services/rateLimiter.js', () => ({ consume: vi.fn() }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/fastmailIdentities.js', async importOriginal => ({
  ...await importOriginal(), createFastmailMaskedEmail: vi.fn(),
}));
import { query } from '../services/db.js';
import { consume } from '../services/rateLimiter.js';
import { logAuthEvent } from '../services/authEvents.js';
import { createFastmailMaskedEmail } from '../services/fastmailIdentities.js';
import router from './providerIdentities.js';

const accountId = '11111111-1111-4111-8111-111111111111';
const clientRequestId = 'abcdefab-1111-4111-8111-111111111111';
const secret = 'synthetic-provider-secret';
const input = () => ({ confirmed: true, clientRequestId });
const created = () => ({ accountId, provider: 'fastmail', outcome: 'created', email: 'mask@synthetic.test', state: 'enabled', clientRequestId });
let server, base, consoleLines;

beforeAll(async () => {
  const app = express(); app.use(express.json());
  // Route-only fixture: actual PAT middleware/CSRF proof is separate, never inferred here.
  app.use((req, _res, next) => {
    req.session = { userId: req.get('x-test-user') || 'user-1', username: 'synthetic-user' };
    if (req.get('x-test-scopes')) req.apiToken = { id: req.get('x-test-token'), scopes: req.get('x-test-scopes').split(',') };
    next();
  });
  app.use('/api/accounts', router);
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}/api/accounts/${accountId}/masked-emails`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
beforeEach(() => {
  vi.clearAllMocks();
  query.mockImplementation(async (sql, values) => ({ rows: sql.includes('FROM users') || values[1] === 'user-1' ? [{ id: accountId }] : [] }));
  consume.mockReset().mockResolvedValue({ limited: false, resetMs: 3600000 });
  createFastmailMaskedEmail.mockReset().mockResolvedValue(created());
  consoleLines = []; vi.spyOn(console, 'info').mockImplementation(line => consoleLines.push(JSON.parse(line)));
});
afterEach(() => vi.restoreAllMocks());
const post = (body = input(), headers = {}) => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

it('returns the same foreign/missing 404 before consuming any budget or calling the producer', async () => {
  const response = await post(input(), { 'x-test-user': 'foreign' });
  expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'Account not found' });
  expect(consume).not.toHaveBeenCalled(); expect(createFastmailMaskedEmail).not.toHaveBeenCalled();
});
it.each([{ ...input(), confirmed: false }, { ...input(), description: '[MAILFLOW:forged]' }, { ...input(), token: secret }])(
  'rejects invalid owned input before throttle/discovery: %j', async body => {
    expect((await post(body)).status).toBe(400);
    expect(consume).not.toHaveBeenCalled(); expect(createFastmailMaskedEmail).not.toHaveBeenCalled();
    expect(logAuthEvent.mock.calls.map(([type]) => type)).toEqual(['masked_create_attempt', 'masked_create_refused']);
  });
it('throttles an owned validated account before invoking the decrypting producer and returns Retry-After', async () => {
  consume.mockResolvedValue({ limited: true, resetMs: 1001 });
  const response = await post(); expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('2');
  expect(consume).toHaveBeenCalledWith(`masked-create:${accountId}`, 10, 3600000);
  expect(createFastmailMaskedEmail).not.toHaveBeenCalled();
});
it('refuses a failed local admission check before any provider call and audits a safe definite outcome', async () => {
  consume.mockRejectedValue(new Error(secret));
  const response = await post(); const body = await response.json();
  expect(response.status).toBe(503);
  expect(body).toEqual({ error: 'Creation could not be admitted. No provider request was made.',
    reason: 'admission_unavailable', outcome: 'refused', accountId, clientRequestId });
  expect(response.headers.get('retry-after')).toBe(null);
  expect(createFastmailMaskedEmail).not.toHaveBeenCalled();
  expect(logAuthEvent.mock.calls.map(([type, fields]) => [type, fields.success]))
    .toEqual([['masked_create_attempt', true], ['masked_create_refused', false]]);
  expect(JSON.stringify({ body, consoleLines })).not.toContain(secret);
});
it('uses one per-account budget across sessions and distinct API token identities', async () => {
  for (const token of ['token-a', 'token-b']) await post(input(), { 'x-test-scopes': 'read,identity:write', 'x-test-token': token });
  await post();
  expect(consume.mock.calls).toEqual(Array(3).fill([`masked-create:${accountId}`, 10, 3600000]));
});
it('orders ownership and validation before throttle and throttle before producer; strips provider-only fields', async () => {
  createFastmailMaskedEmail.mockResolvedValue({ ...created(), token: secret, description: secret });
  const response = await post({ ...input(), clientRequestId: clientRequestId.toUpperCase() });
  expect(response.status).toBe(201); expect(await response.json()).toEqual(created());
  expect(query.mock.invocationCallOrder[1]).toBeLessThan(consume.mock.invocationCallOrder[0]);
  expect(consume.mock.invocationCallOrder[0]).toBeLessThan(createFastmailMaskedEmail.mock.invocationCallOrder[0]);
  expect(createFastmailMaskedEmail).toHaveBeenCalledTimes(1);
  expect(createFastmailMaskedEmail).toHaveBeenCalledWith('user-1', accountId, { ...input(), description: '' });
  expect(logAuthEvent.mock.calls.map(([type, values]) => [type, values.success])).toEqual([['masked_create_attempt', true], ['masked_create_ok', true]]);
  for (const [, fields] of logAuthEvent.mock.calls) {
    expect(Object.keys(fields).sort()).toEqual(['ip', 'success', 'userId', 'username']);
  }
  expect(consoleLines).toEqual([{ event: 'masked_create', accountId, clientRequestId, outcome: 'attempt' },
    { event: 'masked_create', accountId, clientRequestId, outcome: 'created' }]);
  expect(JSON.stringify(consoleLines)).not.toContain(secret);
});
it('preserves unknown mutation outcome, audits terminal uncertainty and never retries or leaks errors', async () => {
  createFastmailMaskedEmail.mockRejectedValue(Object.assign(new Error(secret), { reason: 'outcome_unknown', outcome: 'unknown' }));
  const response = await post(); const result = await response.json();
  expect(response.status).toBe(503); expect(result).toMatchObject({ reason: 'outcome_unknown', outcome: 'unknown', mayHaveCompleted: true });
  expect(JSON.stringify(result)).not.toContain(secret); expect(createFastmailMaskedEmail).toHaveBeenCalledTimes(1);
  expect(logAuthEvent.mock.calls.map(([type, fields]) => [type, fields.success])).toEqual([['masked_create_attempt', true], ['masked_create_unknown', false]]);
});
it('keeps definite provider refusals distinct and bounds retry metadata', async () => {
  for (const [after, expected] of [[30, 30], [86401, undefined]]) {
    createFastmailMaskedEmail.mockRejectedValue(Object.assign(new Error(secret), { reason: 'rate_limited', outcome: 'refused', retryAfter: after }));
    const response = await post(); const body = await response.json();
    expect(response.status).toBe(429); expect(body.outcome).toBe('refused'); expect(body.retryAfter).toBe(expected);
    expect(JSON.stringify(body)).not.toContain(secret);
  }
});
it('defends the write route against a token without identity:write before account lookup', async () => {
  expect((await post(input(), { 'x-test-scopes': 'read,identity:read' })).status).toBe(403);
  expect(query).toHaveBeenCalledTimes(1); // requireAuth user check only
  expect(consume).not.toHaveBeenCalled(); expect(createFastmailMaskedEmail).not.toHaveBeenCalled();
});

it('finishes and audits an issued creation after the caller disconnects, without passing a caller abort signal', async () => {
  let markStarted, finishProvider, markTerminal;
  const started = new Promise(resolve => { markStarted = resolve; });
  const provider = new Promise(resolve => { finishProvider = resolve; });
  const terminal = new Promise(resolve => { markTerminal = resolve; });
  createFastmailMaskedEmail.mockImplementation(() => { markStarted(); return provider; });
  console.info.mockImplementation(line => { const entry = JSON.parse(line); consoleLines.push(entry); if (entry.outcome === 'created') markTerminal(); });
  const controller = new AbortController();
  const request = fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input()), signal: controller.signal }).catch(() => null);
  await started; controller.abort(); finishProvider(created()); await terminal; await request;
  expect(createFastmailMaskedEmail.mock.calls[0]).toEqual(['user-1', accountId, { ...input(), description: '' }]);
  expect(logAuthEvent.mock.calls.map(([type]) => type)).toEqual(['masked_create_attempt', 'masked_create_ok']);
});
