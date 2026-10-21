import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('./safeFetch.js', () => ({ safeFetch: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./gmailIdentities.js', () => ({ readGmailIdentities: vi.fn() }));
import { query } from './db.js';
import { safeFetch } from './safeFetch.js';
import { readGmailIdentities } from './gmailIdentities.js';
import { encrypt } from './encryption.js';
import * as encryption from './encryption.js';
import { createFastmailMaskedEmail, getSenderIdentityInventory, listProviderIdentities, readFastmailIdentities, validateFastmailMaskedEmailInput } from './fastmailIdentities.js';

const CORE = 'urn:ietf:params:jmap:core';
const MASK = 'https://www.fastmail.com/dev/maskedemail';
const SUB = 'urn:ietf:params:jmap:submission';
const accountId = '12345678-1234-4234-8234-123456789abc';
const requestId = 'abcdef12-1234-4234-8234-123456789abc';
const account = () => ({ id: accountId, enabled: true, smtp_host: 'smtp.fastmail.com',
  auth_user: 'owner@synthetic.test', email_address: 'owner@synthetic.test', fastmail_api_token: encrypt('synthetic-token') });
const input = () => ({ confirmed: true, clientRequestId: requestId });
const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const session = () => ({ username: 'owner@synthetic.test', apiUrl: 'https://pod.api.fastmail.com/jmap/api/',
  capabilities: { [CORE]: {}, [MASK]: {}, [SUB]: {} }, primaryAccounts: { [MASK]: 'personal', [SUB]: 'personal' },
  accounts: { personal: { isPersonal: true, isReadOnly: false, accountCapabilities: { [MASK]: {}, [SUB]: {} } } } });
function provider({ changeSession, setResponse, masks = [] } = {}) {
  safeFetch.mockImplementation(async (_url, options) => {
    if (!options.method) {
      const s = session(); changeSession?.(s); return response(s);
    }
    const [[name, args, tag]] = JSON.parse(options.body).methodCalls;
    if (name === 'MaskedEmail/set') {
      if (setResponse) return setResponse(args, tag);
      return response({ methodResponses: [[name, { accountId: 'personal', oldState: '0', newState: '1',
        created: { [Object.keys(args.create)[0]]: { id: 'private-provider-id', email: 'mask@synthetic.test' } } }, tag]] });
    }
    return response({ methodResponses: JSON.parse(options.body).methodCalls.map(([method, , callId]) => [method,
      { accountId: 'personal', state: '1', list: method === 'MaskedEmail/get' ? masks : [], notFound: [] }, callId]) });
  });
}
const create = overrides => createFastmailMaskedEmail('user-1', accountId, { ...input(), ...overrides });
const setCalls = () => safeFetch.mock.calls.filter(([, o]) => o.method && JSON.parse(o.body).methodCalls[0][0] === 'MaskedEmail/set');
beforeEach(() => {
  process.env.ENCRYPTION_KEY = '71'.repeat(32);
  vi.resetAllMocks(); query.mockResolvedValue({ rows: [account()] }); provider();
});

it('checks ownership before any adapter, discovery or create request', async () => {
  query.mockResolvedValue({ rows: [] });
  for (const call of [() => listProviderIdentities('foreign', accountId), () => getSenderIdentityInventory('foreign', accountId),
    () => createFastmailMaskedEmail('foreign', accountId, input())]) {
    await expect(call()).rejects.toMatchObject({ status: 404 });
  }
  expect(query.mock.calls.every(([, values]) => values[0] === accountId && values[1] === 'foreign')).toBe(true);
  expect(safeFetch).not.toHaveBeenCalled(); expect(readGmailIdentities).not.toHaveBeenCalled();
});
it('dispatches an owned Google account only after the ownership query and never classifies Gmail as Fastmail', async () => {
  const google = { ...account(), smtp_host: 'smtp.gmail.com', oauth_provider: 'google' };
  const inventory = { accountId, provider: 'gmail', identityStatus: 'ready', identities: [{ email: 'owner@synthetic.test' }],
    maskedStatus: 'unsupported', maskedEmails: [], configRevision: null };
  query.mockResolvedValue({ rows: [google] }); readGmailIdentities.mockResolvedValue(inventory);
  expect(await listProviderIdentities('user-1', accountId)).toEqual(inventory);
  expect(await getSenderIdentityInventory('user-1', accountId)).toEqual({ ...inventory, sender: null });
  expect(readGmailIdentities.mock.calls[0][0]).toBe(google);
  expect(query.mock.invocationCallOrder[0]).toBeLessThan(readGmailIdentities.mock.invocationCallOrder[0]);
  expect(safeFetch).not.toHaveBeenCalled();
});
it('does not refresh disabled Google accounts and lets the Gmail adapter report missing app-password credentials', async () => {
  query.mockResolvedValue({ rows: [{ ...account(), smtp_host: 'smtp.gmail.com', enabled: false, oauth_provider: 'google' }] });
  expect(await listProviderIdentities('user-1', accountId)).toMatchObject({ provider: 'gmail', reason: 'account_disabled', identityStatus: 'unknown' });
  expect(readGmailIdentities).not.toHaveBeenCalled();
  query.mockResolvedValue({ rows: [{ ...account(), smtp_host: 'smtp.gmail.com', oauth_provider: null }] });
  readGmailIdentities.mockResolvedValue({ accountId, provider: 'gmail', identityStatus: 'unknown', reason: 'credentials_missing' });
  expect((await listProviderIdentities('user-1', accountId)).reason).toBe('credentials_missing');
});
it('creates one enabled mask with masked-only scope and a safe correlation marker, never submission or an inventory preflight', async () => {
  provider({ changeSession: s => { delete s.capabilities[SUB]; delete s.primaryAccounts[SUB]; delete s.accounts.personal.accountCapabilities[SUB]; } });
  const result = await create({ clientRequestId: requestId.toUpperCase(), forDomain: 'https://shop.synthetic.test', description: 'Checkout', emailPrefix: 'checkout_1' });
  expect(result).toEqual({ accountId, provider: 'fastmail', email: 'mask@synthetic.test', state: 'enabled', outcome: 'created', clientRequestId: requestId });
  expect(safeFetch).toHaveBeenCalledTimes(2); expect(setCalls()).toHaveLength(1);
  const [url, options] = setCalls()[0], body = JSON.parse(options.body);
  expect(url).toBe('https://pod.api.fastmail.com/jmap/api/');
  expect(body.using).toEqual([CORE, MASK]);
  expect(Object.values(body.methodCalls[0][1].create)).toEqual([{ state: 'enabled', url: null,
    description: `Checkout [mailflow:${requestId}]`, forDomain: 'https://shop.synthetic.test', emailPrefix: 'checkout_1' }]);
  expect(safeFetch.mock.calls.every(([, o]) => o.redirect === 'error')).toBe(true);
  expect(safeFetch.mock.calls[0][1].signal).toBe(options.signal);
  expect(JSON.stringify(result)).not.toMatch(/synthetic-token|private-provider-id|Checkout|enc:v1/);
});
it.each([
  null, [], {}, { confirmed: false }, { clientRequestId: 'invalid' }, { clientRequestId: `${requestId}\n` }, { token: 'no' },
  { description: 'a'.repeat(193) }, { description: 'bad\ntext' }, { description: '[MAILFLOW:forged]' },
  { emailPrefix: '' }, { emailPrefix: 'A' }, { emailPrefix: 'x'.repeat(65) }, { emailPrefix: 'a\n' },
  { forDomain: 'file:///etc/passwd' }, { forDomain: 'https://a.synthetic.test/path' },
  { forDomain: 'https://user@a.synthetic.test' }, { forDomain: 'https://a.synthetic.test?x=1' },
  { forDomain: 'https://a.synthetic.test/#x' },
].map(patch => [patch]))('refuses invalid create input before decrypt/discovery: %j', async patch => {
  const value = patch === null || Array.isArray(patch) || (patch && Object.keys(patch).length === 0) ? patch : { ...input(), ...patch };
  await expect(createFastmailMaskedEmail('user-1', accountId, value)).rejects.toMatchObject({ reason: 'invalid_input', outcome: 'refused' });
  expect(safeFetch).not.toHaveBeenCalled();
});
it('the pure route validator rejects trailing line terminators and accepts exact UUID/prefix boundaries without I/O', () => {
  for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    expect(() => validateFastmailMaskedEmailInput({ ...input(), clientRequestId: requestId + suffix })).toThrow('invalid_input');
    expect(() => validateFastmailMaskedEmailInput({ ...input(), emailPrefix: 'a' + suffix })).toThrow('invalid_input');
  }
  for (const prefix of ['a', 'a_0', 'a'.repeat(64)]) {
    expect(validateFastmailMaskedEmailInput({ ...input(), clientRequestId: requestId.toUpperCase(), emailPrefix: prefix }))
      .toEqual({ confirmed: true, clientRequestId: requestId, description: '', emailPrefix: prefix });
  }
  expect(query).not.toHaveBeenCalled(); expect(safeFetch).not.toHaveBeenCalled(); expect(readGmailIdentities).not.toHaveBeenCalled();
});
it.each([
  [{ enabled: false }, 'account_disabled'], [{ fastmail_api_token: null }, 'credentials_missing'],
  [{ smtp_host: 'smtp.gmail.com' }, 'unsupported_provider'],
])('refuses ineligible create accounts without discovery: %j', async (patch, reason) => {
  query.mockResolvedValue({ rows: [{ ...account(), ...patch }] });
  await expect(create()).rejects.toMatchObject({ reason, outcome: 'refused' }); expect(safeFetch).not.toHaveBeenCalled();
});
it.each([
  [s => { s.username = 'other@synthetic.test'; }, 'account_mismatch'],
  [s => { s.accounts.personal.isReadOnly = true; }, 'insufficient_scope'],
  [s => { delete s.capabilities[MASK]; }, 'insufficient_scope'],
  [s => { s.primaryAccounts[MASK] = 'foreign'; }, 'account_mismatch'],
  [s => { s.apiUrl = 'https://api.fastmail.com.evil.test/'; }, 'invalid_response'],
])('rejects session/capability failures before MaskedEmail/set', async (changeSession, reason) => {
  provider({ changeSession }); await expect(create()).rejects.toMatchObject({ reason, outcome: 'refused' });
  expect(safeFetch).toHaveBeenCalledTimes(1); expect(setCalls()).toHaveLength(0);
});
it.each([
  [401, 'credentials_invalid'], [403, 'insufficient_scope'], [429, 'rate_limited'],
])('HTTP%s refuses the single create and sanitizes provider text', async (status, reason) => {
  provider({ setResponse: () => response({ private: 'synthetic-token' }, status, { 'Retry-After': '12' }) });
  const error = await create().catch(e => e);
  expect(error).toMatchObject({ reason, outcome: 'refused' });
  if (status === 429) expect(error.retryAfter).toBe(12);
  expect(String(error)).not.toContain('synthetic-token'); expect(setCalls()).toHaveLength(1);
});
it.each([408, 500, 502, 503, 599])('HTTP%s after dispatch remains unknown without retry', async status => {
  provider({ setResponse: () => response({ error: 'secret' }, status) });
  await expect(create()).rejects.toMatchObject({ reason: 'outcome_unknown', outcome: 'unknown' }); expect(setCalls()).toHaveLength(1);
});
it('a decrypt exception is a sanitized credential refusal before any provider request', async () => {
  const spy = vi.spyOn(encryption, 'decrypt');
  try {
    spy.mockImplementationOnce(() => { throw new Error('synthetic-token private crypto detail'); });
    const error = await create().catch(e => e);
    expect(error).toMatchObject({ reason: 'credentials_invalid', outcome: 'refused' });
    expect(String(error)).not.toMatch(/synthetic-token|crypto detail/);
    spy.mockImplementationOnce(() => { throw new Error('synthetic-token private crypto detail'); });
    expect(await readFastmailIdentities(account())).toMatchObject({ identityStatus: 'unknown', reason: 'credentials_invalid' });
    expect(safeFetch).not.toHaveBeenCalled();
  } finally { spy.mockRestore(); }
});
it.each([
  () => { throw new Error('network synthetic-token'); },
  () => { throw new DOMException('Timed out', 'TimeoutError'); },
  () => new Response('{'), () => new Response('x'.repeat(1024 * 1024 + 1)),
  () => response({ methodResponses: [] }),
  (_args, tag) => response({ methodResponses: [['MaskedEmail/set', { accountId: 'personal' }, tag]] }),
  (_args, tag) => response({ methodResponses: [['MaskedEmail/set', { accountId: 'foreign', created: {} }, tag]] }),
])('ambiguous create response keeps outcome unknown and never repeats a mutation', async setResponse => {
  provider({ setResponse });
  await expect(create()).rejects.toMatchObject({ reason: 'outcome_unknown', outcome: 'unknown' }); expect(setCalls()).toHaveLength(1);
});
it.each([
  [() => response({ type: 'urn:ietf:params:jmap:error:requestTooLarge' }), 'provider_unavailable'],
  [(_args, tag) => response({ methodResponses: [['error', { type: 'forbidden' }, tag]] }), 'insufficient_scope'],
  [(args, tag) => response({ methodResponses: [['MaskedEmail/set', { accountId: 'personal',
    notCreated: { [Object.keys(args.create)[0]]: { type: 'rateLimit', description: 'secret' } } }, tag]] }), 'rate_limited'],
])('explicit JMAP refusal is definite and does not infer create permission from listing', async (setResponse, reason) => {
  provider({ setResponse }); await expect(create()).rejects.toMatchObject({ reason, outcome: 'refused' }); expect(setCalls()).toHaveLength(1);
});
it('uses a 30s independent operation deadline, not a caller cancellation signal', async () => {
  const spy = vi.spyOn(AbortSignal, 'timeout');
  try { await create(); expect(spy).toHaveBeenCalledWith(30000); } finally { spy.mockRestore(); }
});
it('discovery failure cannot dispatch a create and does not leak arbitrary transport reasons', async () => {
  safeFetch.mockRejectedValueOnce(Object.assign(new Error('synthetic-token'), { reason: 'private-provider-text', outcome: 'refused' }));
  const error = await create().catch(e => e);
  expect(error).toMatchObject({ reason: 'provider_unavailable', outcome: 'refused' });
  expect(String(error)).not.toMatch(/synthetic-token|private-provider-text/); expect(setCalls()).toHaveLength(0);
});
it('a readable inventory does not grant masked creation when the subsequent provider write is denied', async () => {
  provider({ setResponse: () => response({ private: 'synthetic-token' }, 403) });
  const inventory = await readFastmailIdentities(account());
  expect(inventory.identityStatus).toBe('ready'); expect(inventory.maskedStatus).toBe('ready');
  await expect(create()).rejects.toMatchObject({ reason: 'insufficient_scope', outcome: 'refused' });
  expect(setCalls()).toHaveLength(1);
});
it('a reused correlation hint is not an idempotency cache and each explicit call gets a new JMAP creation id', async () => {
  await create(); await create();
  const keys = setCalls().map(([, options]) => Object.keys(JSON.parse(options.body).methodCalls[0][1].create)[0]);
  expect(keys).toHaveLength(2); expect(keys[0]).not.toBe(keys[1]);
});
it('malformed account ids fail uniformly before any query or provider request', async () => {
  await expect(createFastmailMaskedEmail('user-1', 'invalid', input())).rejects.toMatchObject({ status: 404 });
  expect(query).not.toHaveBeenCalled(); expect(safeFetch).not.toHaveBeenCalled();
});
it('generated marker variants preserve only canonical terminal UUID hints, never raw descriptions or identity permission', async () => {
  for (let n = 0; n < 12; n++) {
    const id = `${n.toString(16).padStart(8, '0')}-1234-4234-8234-123456789abc`;
    const masks = [
      { id: 'one', email: 'one@synthetic.test', state: 'enabled', description: `private [mailflow:${id.toUpperCase()}]` },
      { id: 'two', email: 'two@synthetic.test', state: 'enabled', description: `other [mailflow:${id}]` },
      { id: 'bad', email: 'bad@synthetic.test', state: 'enabled', description: `[mailflow:${id}] trailing` },
      { id: 'newline', email: 'newline@synthetic.test', state: 'enabled', description: `[mailflow:${id}]\n` },
    ];
    provider({ masks });
    const result = await readFastmailIdentities(account());
    expect(result.maskedEmails).toEqual([{ email: 'one@synthetic.test', state: 'enabled', clientRequestId: id },
      { email: 'two@synthetic.test', state: 'enabled', clientRequestId: id }, { email: 'bad@synthetic.test', state: 'enabled' },
      { email: 'newline@synthetic.test', state: 'enabled' }]);
    expect(JSON.stringify(result)).not.toMatch(/private|description|personal/);
    expect(result.identities).toEqual([]);
  }
});
