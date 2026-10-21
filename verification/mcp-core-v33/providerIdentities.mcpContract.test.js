import 'express-async-errors';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import { pathToFileURL } from 'node:url';

// Test-only transport/storage boundaries. No auth, facade, producer, encryption or SDK substitute.
const state = vi.hoisted(() => ({ tokens: new Map(), accounts: new Map(), sql: [], provider: [], audit: [],
  http: [], unexpected: [], mode: 'ok', maskedOnly: false, cookieReads: 0, masks: [] }));
vi.mock('../index.js', () => ({ imapManager: {} })); // Never boot the application entry point.
vi.mock('../services/redis.js', () => ({ redisClient: new Proxy({}, { get: () => async () => { throw new Error('Synthetic Redis offline'); } }) }));
vi.mock('../services/lastSeen.js', () => ({ touchLastSeen: () => { throw new Error('PAT must not touch lastSeen'); } }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: (...args) => state.audit.push(args) }));
vi.mock('./oauth.js', () => ({
  refreshGoogleToken: () => { throw new Error('Unexpected refresh: fixture tokens must be fresh'); },
  refreshMicrosoftToken: () => { throw new Error('Microsoft refresh is outside this proposal'); },
}));
vi.mock('../services/db.js', () => ({
  query: async (raw, values = []) => {
    const sql = raw.replace(/\s+/g, ' ').trim(); state.sql.push(sql);
    if (sql === "SELECT value FROM system_settings WHERE key = 'api_tokens_enabled'") return { rows: [{ value: 'true' }] };
    if (sql.includes('FROM api_tokens t JOIN users u') && sql.endsWith('WHERE t.token_hash = $1')) {
      return { rows: state.tokens.has(values[0]) ? [state.tokens.get(values[0])] : [] };
    }
    if (sql === 'UPDATE api_tokens SET last_used_at = NOW(), last_used_ip = $2 WHERE id = $1') return { rows: [] };
    if (sql === 'SELECT id FROM users WHERE id = $1') return { rows: values[0] === 'user-1' ? [{ id: 'user-1' }] : [] };
    if (/^SELECT (\*|id) FROM email_accounts WHERE id = \$1 AND user_id = \$2$/.test(sql)) {
      const account = state.accounts.get(values[0]); return { rows: account?.user_id === values[1] ? [account] : [] };
    }
    state.unexpected.push(sql); throw new Error('Unexpected SQL in isolated contract fixture');
  },
  withTransaction: () => { throw new Error('No SQL transactions in boundary proposal'); },
  pool: { connect: () => { throw new Error('No database allowed'); }, query: () => { throw new Error('No database allowed'); } },
}));
vi.mock('../services/safeFetch.js', () => ({ safeFetch: async (url, options) => {
  if (options.redirect !== 'error' || !(options.signal instanceof AbortSignal)) throw new Error('Unsafe provider request');
  const parsed = options.body ? JSON.parse(options.body) : null;
  state.provider.push({ url, method: options.method || 'GET', body: parsed });
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
  if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs' && options.method === 'GET') {
    if (options.headers.Authorization !== 'Bearer synthetic-google-token') throw new Error('Wrong Gmail account credential');
    return state.mode === 'api-disabled' ? json({ error: { errors: [{ reason: 'accessNotConfigured' }] } }, 403)
      : json({ sendAs: [{ sendAsEmail: 'owner@synthetic.test', isPrimary: true },
        { sendAsEmail: 'accepted@synthetic.test', verificationStatus: 'accepted' },
        { sendAsEmail: 'pending@synthetic.test', verificationStatus: 'pending' },
        { sendAsEmail: 'unspecified@synthetic.test', verificationStatus: 'verificationStatusUnspecified' }] });
  }
  if (options.headers.Authorization !== 'Bearer synthetic-fastmail-token') throw new Error('Wrong Fastmail account credential');
  const CORE = 'urn:ietf:params:jmap:core', MASK = 'https://www.fastmail.com/dev/maskedemail', SUB = 'urn:ietf:params:jmap:submission';
  if (url === 'https://api.fastmail.com/jmap/session' && !options.method) {
    const capabilities = { [MASK]: {}, ...(state.maskedOnly ? {} : { [SUB]: {} }) };
    return json({ username: 'owner@synthetic.test', apiUrl: 'https://pod.api.fastmail.com/jmap/api/',
      capabilities: { [CORE]: {}, ...capabilities }, primaryAccounts: { [MASK]: 'personal', ...(state.maskedOnly ? {} : { [SUB]: 'personal' }) },
      accounts: { personal: { isPersonal: true, isReadOnly: false, accountCapabilities: capabilities } } });
  }
  if (url !== 'https://pod.api.fastmail.com/jmap/api/' || options.method !== 'POST') throw new Error('Unexpected provider endpoint');
  const [[method, args, tag]] = parsed.methodCalls;
  if (method === 'MaskedEmail/set') {
    if (state.mode === 'network') throw new Error('synthetic-provider-secret');
    if (['408', '500', '401', '403', '429'].includes(state.mode)) return json({ error: 'synthetic-provider-secret' }, Number(state.mode), { 'retry-after': '7' });
    if (state.mode === 'malformed') return new Response('{', { status: 200 });
    return json({ methodResponses: [[method, { accountId: 'personal', newState: 'new', created: {
      [Object.keys(args.create)[0]]: { id: 'private-provider-id', email: 'mask@synthetic.test', state: 'enabled' },
    } }, tag]] });
  }
  if (!parsed.methodCalls.every(([name]) => ['Identity/get', 'MaskedEmail/get'].includes(name))) throw new Error('Unexpected JMAP method');
  return json({ methodResponses: parsed.methodCalls.map(([name, , callId]) => [name, { accountId: 'personal', state: 'list',
    list: name === 'Identity/get' ? [{ id: 'identity', email: 'owner@synthetic.test' }] : state.masks, notFound: [] }, callId]) });
} }));

import { mountApiAuth } from '../middleware/apiChain.js';
import accountRouter from './accounts.js';
import providerRouter from './providerIdentities.js';
import tokenRouter from './apiTokens.js';
import { encrypt } from '../services/encryption.js';
import { generateToken, hashToken, invalidateApiTokenSettingsCache, resetTokenUseForTests } from '../services/apiTokens.js';
import * as limiter from '../services/rateLimiter.js';

const FAST = '11111111-1111-4111-8111-111111111111', GOOGLE = '22222222-2222-4222-8222-222222222222';
const FOREIGN = '33333333-3333-4333-8333-333333333333', MISSING = '44444444-4444-4444-8444-444444444444';
const REQUEST = 'abcdefab-1111-4111-8111-111111111111';
let server, url, nativeFetch, connect, tokens, sessions, consoleLines;
const createArgs = () => ({ accountId: FAST, confirmed: true, clientRequestId: REQUEST });
const sets = () => state.provider.filter(row => row.body?.methodCalls?.[0]?.[0] === 'MaskedEmail/set');
const readRequests = () => state.http.filter(row => row.path.endsWith('/sender-identities'));
const safeOutput = value => {
  expect(JSON.stringify(value)).not.toMatch(/synthetic-(fastmail|google)-token|synthetic-provider-secret|private-provider-id|enc:v1:/);
};
async function session(kind = 'both', advertisedScopes) {
  const f = await connect({ fake: { url }, token: tokens[kind], scopes: advertisedScopes || (await self(kind)).scopes });
  sessions.push(f); return f;
}
const self = async kind => (await raw('GET', '/api/api-tokens/self', undefined, tokens[kind])).json();
const raw = (method, path, body, token, extra = {}) => fetch(`${url}${path}`, { method,
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra },
  ...(body ? { body: JSON.stringify(body) } : {}) });

beforeAll(async () => {
  if (process.env.MCP_CONTRACT_ISOLATED !== '1') throw new Error('Dedicated isolated lease required');
  nativeFetch = globalThis.fetch;
  const app = express();
  app.use((req, _res, next) => { state.http.push({ method: req.method, path: req.originalUrl }); next(); });
  mountApiAuth(app, (req, _res, next) => {
    if (!req.session) { state.cookieReads++; if (req.headers.cookie) req.session = { userId: 'user-1' }; } next();
  });
  app.use('/api/api-tokens', tokenRouter);
  app.use('/api/accounts', accountRouter); app.use('/api/accounts', providerRouter);
  app.use((error, _req, res, _next) => { state.unexpected.push(error.message); res.status(500).json({ error: 'Contract fixture failure' }); });
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  url = `http://127.0.0.1:${server.address().port}`;
  vi.stubGlobal('fetch', (target, options) => {
    if (new URL(typeof target === 'string' || target instanceof URL ? target : target.url).origin !== url) throw new Error('Non-loopback HTTP blocked');
    return nativeFetch(target, options);
  });
  const path = process.env.MAILFLOW_MCP_SOURCE;
  if (!path) throw new Error('Pinned external source missing');
  ({ connect } = await import(pathToFileURL(`${path}/test-support/harness.js`).href));
});
afterAll(async () => {
  server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); vi.unstubAllGlobals();
});
beforeEach(async () => {
  vi.restoreAllMocks(); state.tokens.clear(); state.accounts.clear();
  for (const name of ['sql', 'provider', 'audit', 'http', 'unexpected', 'masks']) state[name] = [];
  state.mode = 'ok'; state.maskedOnly = false; state.cookieReads = 0; sessions = []; consoleLines = [];
  vi.spyOn(console, 'info').mockImplementation(line => consoleLines.push(JSON.parse(line)));
  invalidateApiTokenSettingsCache(); resetTokenUseForTests();
  const base = { user_id: 'user-1', enabled: true, email_address: 'owner@synthetic.test', auth_user: 'owner@synthetic.test' };
  state.accounts.set(FAST, { ...base, id: FAST, smtp_host: 'smtp.fastmail.com', fastmail_api_token: encrypt('synthetic-fastmail-token') });
  state.accounts.set(GOOGLE, { ...base, id: GOOGLE, smtp_host: 'smtp.gmail.com', oauth_provider: 'google',
    oauth_access_token: encrypt('synthetic-google-token'), oauth_token_expiry: new Date(Date.now() + 3600000).toISOString() });
  state.accounts.set(FOREIGN, { ...state.accounts.get(FAST), id: FOREIGN, user_id: 'other-user' });
  tokens = {};
  for (const [kind, scopes] of Object.entries({ old: ['read', 'organize', 'draft'], read: ['read', 'identity:read'],
    write: ['read', 'identity:write'], both: ['read', 'identity:read', 'identity:write'] })) {
    tokens[kind] = generateToken(); state.tokens.set(hashToken(tokens[kind]), { id: `synthetic-${kind}`, user_id: 'user-1',
      username: 'synthetic-user', name: kind, scopes, expired: false, created_at: '2026-10-21T00:00:00Z', expires_at: null });
  }
  await limiter.reset(`masked-create:${FAST}`);
});
afterEach(async () => {
  try { for (const s of sessions) await s.close(); }
  finally { expect(state.unexpected).toEqual([]); safeOutput(consoleLines); vi.restoreAllMocks(); }
});

it('J01 actual token-self grants discover only their identity tools', async () => {
  for (const [kind, want] of [['old', []], ['read', ['list_fastmail_masked_aliases', 'list_gmail_send_as']],
    ['write', ['create_fastmail_masked_alias']]]) {
    const s = await session(kind); const { tools } = await s.client.listTools();
    expect(tools.map(t => t.name).filter(n => /masked|send_as/.test(n)).sort()).toEqual(want.sort());
  }
  expect(state.provider).toHaveLength(0);
});
it('J02 Fastmail listing crosses SDK, authenticated real route and provider parser without credential disclosure', async () => {
  state.masks = [{ id: 'mask', email: 'mask@synthetic.test', state: 'enabled', description: `Private [mailflow:${REQUEST}]` }];
  const result = await (await session('read')).call('list_fastmail_masked_aliases', { accountId: FAST });
  expect(result.isError).toBeUndefined(); expect(result.structuredContent.maskedEmails)
    .toEqual([{ email: 'mask@synthetic.test', state: 'enabled', clientRequestId: REQUEST }]); safeOutput(result);
});
it('J03 Gmail excludes pending/unspecified aliases and the real route leaves sender null', async () => {
  const s = await session('read'); const result = await s.call('list_gmail_send_as', { accountId: GOOGLE });
  expect(result.isError).toBeUndefined(); expect(result.structuredContent.identities)
    .toEqual([{ email: 'owner@synthetic.test' }, { email: 'accepted@synthetic.test' }]);
  expect((await s.mailflow.getSenderIdentities(GOOGLE)).sender).toBe(null); safeOutput(result);
});
it('J04 Gmail disabled API and app-password accounts report actual capability gaps', async () => {
  state.mode = 'api-disabled'; const s = await session('read');
  const disabled = await s.call('list_gmail_send_as', { accountId: GOOGLE });
  expect(disabled.structuredContent.reason).toBe('api_not_enabled'); expect(disabled.text).toMatch(/enable the Gmail API for the OAuth project/);
  state.accounts.set(GOOGLE, { ...state.accounts.get(GOOGLE), oauth_provider: null, oauth_access_token: null });
  state.provider = []; const missing = await s.call('list_gmail_send_as', { accountId: GOOGLE });
  expect(missing.structuredContent.reason).toBe('credentials_missing'); expect(state.provider).toHaveLength(0);
});
it('J05 masked-only capability creates one enabled mask without reading inventory or requiring submission', async () => {
  state.maskedOnly = true; const result = await (await session('write')).call('create_fastmail_masked_alias', createArgs());
  expect(result.structuredContent).toEqual({ accountId: FAST, provider: 'fastmail', email: 'mask@synthetic.test', state: 'enabled', outcome: 'created', clientRequestId: REQUEST });
  expect(sets()).toHaveLength(1); expect(readRequests()).toHaveLength(0);
  expect(Object.values(sets()[0].body.methodCalls[0][1].create)).toEqual([{ state: 'enabled', url: null, description: `[mailflow:${REQUEST}]` }]);
  safeOutput(result); expect(state.audit.map(([type, fields]) => [type, fields.success])).toEqual([['masked_create_attempt', true], ['masked_create_ok', true]]);
});
it('J06 foreign and missing accounts give identical 404 before provider access or create budget', async () => {
  const s = await session('both'), consume = vi.spyOn(limiter, 'consume');
  for (const id of [FOREIGN, MISSING]) {
    const result = await s.call('create_fastmail_masked_alias', { ...createArgs(), accountId: id });
    expect(result.structuredContent).toMatchObject({ reason: 'account_not_found', outcome: 'refused', mayHaveCompleted: false });
    const read = await s.call('list_fastmail_masked_aliases', { accountId: id }); expect(read.structuredContent.reason).toBe('account_not_found');
  }
  expect(state.provider).toHaveLength(0); expect(consume.mock.calls.some(([key]) => key.startsWith('masked-create:'))).toBe(false);
});
it('J07 SDK rejects invalid confirmation, extra credentials, marker and noncanonical origin before HTTP', async () => {
  const s = await session('write'); state.http = [];
  for (const bad of [{ confirmed: false }, { token: 'synthetic-provider-secret' }, { description: '[mailflow:forged]' },
    { forDomain: 'https://SHOP.synthetic.test' }, { forDomain: 'https://shop.synthetic.test:443' }]) {
    expect((await s.call('create_fastmail_masked_alias', { ...createArgs(), ...bad })).isError).toBe(true);
  }
  expect(state.http).toHaveLength(0); expect(state.provider).toHaveLength(0);
});
it('J08 revoked/expired/malformed bearer credentials cannot be rescued by a cookie', async () => {
  for (const kind of ['revoked', 'expired', 'malformed']) {
    const token = generateToken();
    if (kind === 'expired') state.tokens.set(hashToken(token), { ...state.tokens.get(hashToken(tokens.write)), expired: true });
    const response = await raw('POST', `/api/accounts/${FAST}/masked-emails`, { confirmed: true, clientRequestId: REQUEST },
      kind === 'malformed' ? 'mfat_bad' : token, { Cookie: 'synthetic-session=valid' });
    expect(response.status).toBe(401);
  }
  expect(state.cookieReads).toBe(0); expect(state.provider).toHaveLength(0);
});
it('J09 real PAT allowlist refuses cross-grants and settings even if client discovery is forged', async () => {
  const forged = await session('write', ['read', 'identity:read']);
  expect((await forged.call('list_gmail_send_as', { accountId: GOOGLE })).structuredContent.reason).toBe('authorization_failed');
  const response = await raw('POST', `/api/accounts/${FAST}/masked-emails`, { confirmed: true, clientRequestId: REQUEST }, tokens.read);
  expect(response.status).toBe(403);
  expect((await raw('GET', '/api/api-tokens', undefined, tokens.both)).status).toBe(403);
  expect(state.provider).toHaveLength(0);
});
it('J10 one account shares a ten-create budget across token identities, with Retry-After on the eleventh', async () => {
  const a = await session('write'), b = await session('both');
  for (let i = 0; i < 10; i++) {
    const result = await (i % 2 ? a : b).call('create_fastmail_masked_alias', { ...createArgs(), clientRequestId: `abcdefab-1111-4111-8111-${String(i + 1).padStart(12, '0')}` });
    expect(result.structuredContent.outcome).toBe('created');
  }
  const result = await a.call('create_fastmail_masked_alias', createArgs());
  expect(result.structuredContent).toMatchObject({ reason: 'rate_limited', outcome: 'refused', mayHaveCompleted: false });
  expect(result.structuredContent.retryAfter).toBeGreaterThan(0); expect(sets()).toHaveLength(10);
});
it('J11 local admission failure remains a definite refusal through the matched external version', async () => {
  const original = limiter.consume;
  vi.spyOn(limiter, 'consume').mockImplementation((key, ...args) => key.startsWith('masked-create:')
    ? Promise.reject(new Error('synthetic-provider-secret')) : original(key, ...args));
  const result = await (await session('write')).call('create_fastmail_masked_alias', createArgs());
  expect(result.structuredContent).toMatchObject({ reason: 'admission_unavailable', outcome: 'refused', mayHaveCompleted: false });
  expect(state.provider).toHaveLength(0); safeOutput(result);
  expect(state.audit.map(([type, fields]) => [type, fields.success])).toEqual([['masked_create_attempt', true], ['masked_create_refused', false]]);
});
it.each(['408', '500', 'network', 'malformed'])('J12 %s after dispatch stays unknown with one write and no automatic list/retry', async mode => {
  state.mode = mode; const result = await (await session('write')).call('create_fastmail_masked_alias', createArgs());
  expect(result.structuredContent).toMatchObject({ reason: 'outcome_unknown', outcome: 'unknown', mayHaveCompleted: true });
  expect(result.text).toMatch(/This token cannot list/); expect(sets()).toHaveLength(1); expect(readRequests()).toHaveLength(0); safeOutput(result);
  expect(state.audit.map(([type, fields]) => [type, fields.success])).toEqual([['masked_create_attempt', true], ['masked_create_unknown', false]]);
});
it.each([['401', 'credentials_invalid'], ['403', 'insufficient_scope'], ['429', 'rate_limited']])(
  'J13 dispatched %s has a definite provider refusal and never retries', async (mode, reason) => {
    state.mode = mode; const result = await (await session('write')).call('create_fastmail_masked_alias', createArgs());
    expect(result.structuredContent).toMatchObject({ reason, outcome: 'refused', mayHaveCompleted: false });
    expect(sets()).toHaveLength(1); expect(readRequests()).toHaveLength(0); safeOutput(result);
  });
it('J14 explicit authorized reconciliation is correlation only and never sends a second creation', async () => {
  state.mode = '500'; const s = await session('both');
  expect((await s.call('create_fastmail_masked_alias', createArgs())).structuredContent.outcome).toBe('unknown');
  expect(readRequests()).toHaveLength(0);
  state.mode = 'ok'; state.masks = [{ id: 'mask', email: 'mask@synthetic.test', state: 'enabled', description: `[mailflow:${REQUEST}]` }];
  const listed = await s.call('list_fastmail_masked_aliases', { accountId: FAST });
  expect(listed.structuredContent.maskedEmails[0].clientRequestId).toBe(REQUEST); expect(sets()).toHaveLength(1);
});
