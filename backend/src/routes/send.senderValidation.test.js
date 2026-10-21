import { it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: req.headers['x-test-user'] || 'u1' }; next(); },
}));
// A small in-memory Redis: the undo flow reads back what it wrote, so plain mocks are not enough.
const store = new Map();
vi.mock('../services/redis.js', () => ({
  redisClient: {
    get: vi.fn(async key => store.get(key) ?? null),
    set: vi.fn(async (key, value, opts = {}) => {
      if (opts.NX && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async key => (store.delete(key) ? 1 : 0)),
  },
}));
vi.mock('../services/safeFetch.js', () => ({ safeFetch: vi.fn() }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { collectHook: vi.fn().mockResolvedValue([]) } }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn() }));
vi.mock('./draft.js', () => ({ deleteSentDraft: vi.fn() }));
// This focused route fixture isolates the pre-existing sanitizer/parser stack;
// it does not establish sanitizer integration or actual provider/SMTP evidence.
vi.mock('../services/emailSanitizer.js', () => ({ sanitizeSignature: value => value }));
vi.mock('../services/imapManager.js', () => ({ providerProfile: () => ({ labelStore: false }) }));
vi.mock('../services/searchCoverage.js', () => ({ getSearchCoverage: vi.fn() }));
vi.mock('../services/searchIndexJobs.js', () => ({ setSearchCoverageAction: vi.fn() }));
import express from 'express';
import routes from './send.js';
import accountRoutes from './accounts.js';
import { safeFetch } from '../services/safeFetch.js';
import { encrypt } from '../services/encryption.js';
import { query } from '../services/db.js';
import { createAccountSmtpTransport } from '../services/smtpTransport.js';
import { resolveSentFolder } from '../utils/mailUtils.js';
import { flushHeldSends } from '../services/sendHold.js';
import { deleteSentDraft } from './draft.js';

const accountId = '44444444-4444-4444-4444-444444444444', aliasId = '55555555-5555-5555-5555-555555555555';
let account, alias, identities, masks, offline;
const sendMail = vi.fn();
let server, base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', routes); app.use('/api/accounts', accountRoutes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  process.env.ENCRYPTION_KEY = '71'.repeat(32);
  account = { id: accountId, enabled: true, email_address: 'owner@synthetic.test', auth_user: 'owner@synthetic.test',
    smtp_host: 'smtp.fastmail.com', name: 'Owner', fastmail_api_token: encrypt('synthetic-token') };
  alias = { id: aliasId, name: 'Alias', email: 'alias@synthetic.test', signature: null };
  identities = ['alias@synthetic.test']; masks = []; offline = false;
  query.mockImplementation(async sql => ({ rows: sql.includes('FROM email_accounts') ? (account ? [account] : [])
    : sql.includes('FROM account_aliases') ? (alias ? [alias] : []) : [{ preferences: {}, id: 'book1' }] }));
  const core = 'urn:ietf:params:jmap:core', sub = 'urn:ietf:params:jmap:submission', mask = 'https://www.fastmail.com/dev/maskedemail';
  safeFetch.mockImplementation(async (_url, options) => {
    if (offline) throw new Error('offline');
    if (!options.method) return new Response(JSON.stringify({ username: 'owner@synthetic.test', apiUrl: 'https://api.fastmail.com/jmap/api',
      capabilities: { [core]: {}, [sub]: {}, [mask]: {} }, primaryAccounts: { [sub]: 'p', [mask]: 'p' },
      accounts: { p: { isPersonal: true, accountCapabilities: { [sub]: {}, [mask]: {} } } } }));
    return new Response(JSON.stringify({ methodResponses: JSON.parse(options.body).methodCalls.map(([name, , tag]) => [name,
      { accountId: 'p', state: '1', notFound: [], list: name === 'Identity/get' ? identities.map(email => ({ id: email, email }))
        : masks.map(email => ({ id: email, email, state: 'enabled' })) }, tag]) }));
  });
  createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail } });
  sendMail.mockResolvedValue({});
  resolveSentFolder.mockResolvedValue(null);
});
// Nothing may stay held between tests.
afterEach(async () => { await flushHeldSends(1000); });

const send = (extra = {}, key = 'send1') => fetch(`${base}/api/mail/send`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': key },
  body: JSON.stringify({ accountId, aliasId, to: ['recipient@synthetic.test'], subject: 'Test', body: 'Hello', ...extra }),
});
const status = (id, user = 'u1') => fetch(`${base}/api/mail/send/${id}`, { headers: { 'x-test-user': user } }).then(r => r.json());

it('missing alias never falls back to primary, including non-Fastmail', async () => {
  account.smtp_host = 'smtp.other.synthetic.test'; alias = null;
  expect((await send()).status).toBe(422); expect(sendMail).not.toHaveBeenCalled(); expect(safeFetch).not.toHaveBeenCalled();
});
it('unsupported Gmail transport preserves exact From and does not call Fastmail', async () => {
  account.smtp_host = 'smtp.gmail.com'; account.oauth_provider = 'google';
  identities = []; masks = [];
  expect((await send()).status).toBe(200);
  expect(safeFetch).not.toHaveBeenCalled();
  expect(sendMail.mock.calls[0][0].from).toBe('Alias <alias@synthetic.test>');
});
it('genuine pre-acceptance SMTP rejection frees its reservation and keeps ordinary error status', async () => {
  sendMail.mockRejectedValueOnce(Object.assign(new Error('synthetic RCPT refusal'), { code: 'EENVELOPE' }));
  const rejected = await send({}, 'retryable');
  expect(rejected.status).toBe(500);
  expect(await rejected.json()).toEqual({ error: 'Failed to send message. Please try again.' });
  expect(store.has('send_idem:u1:retryable')).toBe(false);
  expect((await send({}, 'retryable')).status).toBe(200);
  expect(sendMail).toHaveBeenCalledTimes(2);
});
it('replays an accepted logical send without inventory calls or second SMTP handoff', async () => {
  const first = await (await send({}, 'accepted')).json();
  identities = []; safeFetch.mockClear();
  const replay = await (await send({}, 'accepted')).json();
  expect(replay).toEqual(first); expect(first.ok).toBe(true);
  expect(sendMail).toHaveBeenCalledTimes(1); expect(safeFetch).not.toHaveBeenCalled();
});
it('allowed and unknown both preserve the chosen alias, unavailable never reaches SMTP', async () => {
  expect((await send({}, 'allowed')).status).toBe(200);
  expect(sendMail.mock.calls[0][0].from).toBe('Alias <alias@synthetic.test>');
  identities = []; expect((await send({}, 'absent')).status).toBe(422); expect(sendMail).toHaveBeenCalledTimes(1);
  offline = true; expect((await send({}, 'unknown')).status).toBe(200);
  expect(sendMail.mock.calls[1][0].from).toBe('Alias <alias@synthetic.test>');
});
it.each(['deleted alias', 'changed alias', 'revoked identity', 'deleted account', 'changed SMTP login'])('%s during hold fails visibly and preserves draft', async change => {
  const pending = await (await send({ undoSeconds: 10, draft: { accountId, uid: 8, folder: 'Drafts' } })).json();
  expect(pending.pending).toBe(true);
  if (change === 'deleted alias') alias = null;
  if (change === 'changed alias') alias = { ...alias, email: 'changed@synthetic.test' };
  if (change === 'revoked identity') identities = [];
  if (change === 'deleted account') account = null;
  if (change === 'changed SMTP login') account = { ...account, smtp_auth_user: 'changed@synthetic.test' };
  await flushHeldSends(1000);
  const result = await status(pending.pendingId);
  expect(result.status).toBe('failed'); expect(result.error).toMatch(/sender|account/i);
  expect(sendMail).not.toHaveBeenCalled(); expect(deleteSentDraft).not.toHaveBeenCalled();
});
it('token clear during hold uses fresh config and retains the exact SMTP From', async () => {
  const pending = await (await send({ undoSeconds: 10 })).json();
  account = { ...account, fastmail_api_token: null }; safeFetch.mockClear();
  await flushHeldSends(1000);
  expect((await status(pending.pendingId)).status).toBe('sent'); expect(safeFetch).not.toHaveBeenCalled();
  expect(sendMail.mock.calls[0][0].from).toBe('Alias <alias@synthetic.test>');
});
it('generated endpoint and delivery decisions agree for exact, wildcard, mask-only and absent evidence', async () => {
  for (let i = 0; i < 12; i++) {
    alias.email = `person${i}@d${i}.synthetic.test`;
    identities = i % 4 === 0 ? [alias.email] : i % 4 === 1 ? [`*@d${i}.synthetic.test`] : [];
    masks = i % 4 === 2 ? [alias.email] : [];
    const result = await (await fetch(`${base}/api/accounts/${accountId}/sender-identities?aliasId=${aliasId}`)).json();
    const before = sendMail.mock.calls.length;
    const res = await send({}, `generated-${i}`);
    expect(res.status).toBe(result.sender.status === 'unavailable' ? 422 : 200);
    expect(sendMail.mock.calls.length - before).toBe(result.sender.status === 'unavailable' ? 0 : 1);
    if (result.sender.status !== 'unavailable') expect(sendMail.mock.calls.at(-1)[0].from).toBe(`Alias <${alias.email}>`);
  }
});


// Source-authored compatibility controls, UNRUN: actual Express send/hold code,
// fake API/SMTP only. No frontend warning assertion substitutes for delivery.
it.each([
  ['omitted', 0], ['null', 0], ['omitted', 10], ['null', 10],
])('token %s primary send with undoSeconds=%i preserves existing SMTP path', async (tokenState, undoSeconds) => {
  if (tokenState === 'omitted') delete account.fastmail_api_token;
  else account.fastmail_api_token = null;
  identities = []; masks = []; // Incomplete evidence must never mean unregistered.
  const inventory = await (await fetch(`${base}/api/accounts/${accountId}/sender-identities`)).json();
  expect(inventory.reason).toBe('credentials_missing');
  expect(inventory.sender).toEqual({ email: 'owner@synthetic.test', status: 'unknown' });
  const response = await send({ aliasId: undefined, undoSeconds }, `no-token-${tokenState}-${undoSeconds}`);
  if (undoSeconds) {
    expect(response.status).toBe(202);
    const pending = await response.json();
    expect(pending.pending).toBe(true);
    expect(sendMail).not.toHaveBeenCalled();
    await flushHeldSends(1000); // Fixture-only drain; no real SMTP or timer shortcut claim.
    const held = await status(pending.pendingId);
    expect(held.status).toBe('sent'); expect(held.result.ok).toBe(true);
  } else {
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
  }
  expect(sendMail).toHaveBeenCalledTimes(1);
  expect(sendMail.mock.calls[0][0].from).toBe('Owner <owner@synthetic.test>');
  expect(safeFetch).not.toHaveBeenCalled();
  expect(query.mock.calls.some(([sql]) => sql.includes('FROM account_aliases'))).toBe(false);
});
