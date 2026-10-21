import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./encryption.js', () => ({ decrypt: vi.fn() }));
vi.mock('./safeFetch.js', () => ({ safeFetch: vi.fn() }));
vi.mock('../routes/oauth.js', () => ({ refreshGoogleToken: vi.fn() }));

import { decrypt } from './encryption.js';
import { safeFetch } from './safeFetch.js';
import { refreshGoogleToken } from '../routes/oauth.js';
import { readGmailIdentities } from './gmailIdentities.js';

const URL = 'https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs';
const SECRET = 'synthetic-provider-secret';
const account = (overrides = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  email_address: 'primary@synthetic.test', enabled: true, oauth_provider: 'google',
  oauth_access_token: 'encrypted-access', oauth_refresh_token: 'encrypted-refresh',
  oauth_token_expiry: new Date(Date.now() + 3600000).toISOString(),
  ...overrides,
});
const primary = (email = 'primary@synthetic.test') => ({ sendAsEmail: email, isPrimary: true });
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });

beforeEach(() => {
  vi.resetAllMocks();
  decrypt.mockReturnValue(SECRET);
  safeFetch.mockResolvedValue(response({ sendAs: [primary()] }));
});

describe('readGmailIdentities', () => {
  it('returns only primary and accepted addresses, with no Fastmail revision or masked capability', async () => {
    safeFetch.mockResolvedValue(response({ sendAs: [
      primary(),
      { sendAsEmail: 'accepted@synthetic.test', verificationStatus: 'accepted', smtpMsa: { password: SECRET } },
      { sendAsEmail: 'pending@synthetic.test', verificationStatus: 'pending', treatAsAlias: true },
      { sendAsEmail: 'unverified@synthetic.test', displayName: 'accepted' },
    ] }));
    const result = await readGmailIdentities(account());
    expect(result).toEqual({
      accountId: account().id, provider: 'gmail', identityStatus: 'ready',
      maskedStatus: 'unsupported', reason: null,
      identities: [{ email: 'primary@synthetic.test' }, { email: 'accepted@synthetic.test' }],
      maskedEmails: [], configRevision: null, checkedAt: expect.any(String),
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(safeFetch).toHaveBeenCalledWith(URL, expect.objectContaining({
      method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${SECRET}`, Accept: 'application/json' },
      signal: expect.any(AbortSignal),
    }));
  });

  it.each([
    [{ enabled: false }, 'account_disabled'],
    [{ oauth_provider: null, oauth_access_token: null }, 'credentials_missing'],
    [{ oauth_provider: 'microsoft' }, 'unsupported_provider'],
    [{ oauth_access_token: null, oauth_refresh_token: null }, 'credentials_missing'],
  ])('does not decrypt or call a provider for unavailable account %j', async (overrides, reason) => {
    expect(await readGmailIdentities(account(overrides))).toMatchObject({ identityStatus: 'unknown', reason, identities: [] });
    expect(decrypt).not.toHaveBeenCalled();
    expect(safeFetch).not.toHaveBeenCalled();
    expect(refreshGoogleToken).not.toHaveBeenCalled();
  });

  it('refreshes an expired token through the existing account refresh path', async () => {
    const row = account({ oauth_token_expiry: '2020-01-01T00:00:00Z' });
    refreshGoogleToken.mockResolvedValue({ ...row, oauth_access_token: 'refreshed-secret' });
    expect((await readGmailIdentities(row)).identityStatus).toBe('ready');
    expect(refreshGoogleToken).toHaveBeenCalledWith(row);
    expect(decrypt).not.toHaveBeenCalled();
    expect(safeFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer refreshed-secret');
  });

  it('sanitizes a refresh error_description instead of returning or logging it', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      refreshGoogleToken.mockRejectedValue(new Error(`invalid_grant ${SECRET} <script>`));
      const result = await readGmailIdentities(account({ oauth_token_expiry: null }));
      expect(result).toMatchObject({ identityStatus: 'unknown', reason: 'provider_unavailable', identities: [] });
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(safeFetch).not.toHaveBeenCalled();
    } finally { log.mockRestore(); warn.mockRestore(); }
  });

  it.each([
    [401, {}, 'credentials_missing'],
    [403, { error: { errors: [{ reason: 'accessNotConfigured', message: SECRET }] } }, 'api_not_enabled'],
    [403, { error: { details: [{ reason: 'SERVICE_DISABLED' }] } }, 'api_not_enabled'],
    [403, { error: { errors: [{ reason: 'insufficientPermissions' }] } }, 'insufficient_scope'],
    [403, { error: { details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }, 'insufficient_scope'],
    [403, { error: { message: SECRET } }, 'provider_unavailable'],
    [429, {}, 'rate_limited'], [500, {}, 'provider_unavailable'], [503, {}, 'provider_unavailable'],
  ])('maps HTTP %s safely without retry', async (status, body, reason) => {
    safeFetch.mockResolvedValue(response(body, status));
    const result = await readGmailIdentities(account());
    expect(result).toMatchObject({ identityStatus: 'unknown', reason, identities: [] });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  it.each(['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'quotaExceeded', 'RATE_LIMIT_EXCEEDED'])(
    'recognizes quota reason %s in either Google error form', async reason => {
      for (const field of ['errors', 'details']) {
        safeFetch.mockResolvedValue(response({ error: { [field]: [{ reason, message: SECRET }] } }, 403));
        expect(await readGmailIdentities(account())).toMatchObject({ reason: 'rate_limited', identities: [] });
      }
    },
  );

  it('uses the database email_address column and does not dot-fold or alias Google domains', async () => {
    expect(account()).not.toHaveProperty('email');
    for (const different of ['pri.mary@synthetic.test', 'primary@googlemail.com']) {
      safeFetch.mockResolvedValue(response({ sendAs: [primary(different)] }));
      expect(await readGmailIdentities(account())).toMatchObject({ reason: 'account_mismatch', identities: [] });
    }
  });

  it('uses stable disabled-API, scope, quota precedence for mixed reasons regardless of order', async () => {
    const reasons = ['unexpected', 'quotaExceeded', 'insufficientPermissions', 'SERVICE_DISABLED'];
    for (let count = 1; count <= reasons.length; count++) {
      const subset = reasons.slice(0, count);
      for (const order of [subset, [...subset].reverse()]) {
        safeFetch.mockResolvedValue(response({ error: { errors: order.map(reason => ({ reason })) } }, 403));
        expect((await readGmailIdentities(account())).reason).toBe(
          ['provider_unavailable', 'rate_limited', 'insufficient_scope', 'api_not_enabled'][count - 1],
        );
      }
    }
  });

  it('returns Retry-After only for quota errors with bounded valid header values', async () => {
    for (const [header, expected] of [['30', 30], ['0', 0], ['-1', undefined], ['1.5', undefined],
      ['999999999999999999999', undefined], [SECRET, undefined]]) {
      safeFetch.mockResolvedValue(new Response(JSON.stringify({ error: { errors: [{ reason: 'quotaExceeded' }] } }),
        { status: 403, headers: { 'Retry-After': header } }));
      const result = await readGmailIdentities(account());
      expect(result.reason).toBe('rate_limited');
      expect(result.retryAfter).toBe(expected);
    }
    safeFetch.mockResolvedValue(new Response('{}', { status: 403, headers: { 'Retry-After': '30' } }));
    expect(await readGmailIdentities(account())).not.toHaveProperty('retryAfter');
  });

  it('fails closed on missing credentials and does not fetch with a corrupt token', async () => {
    for (const value of [null, '', `bad\r\n${SECRET}`]) {
      decrypt.mockReturnValue(value);
      expect(await readGmailIdentities(account())).toMatchObject({ reason: 'credentials_missing', identities: [] });
    }
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it.each([
    [primary('another@synthetic.test')], [], [primary(), primary()],
  ].map(sendAs => [sendAs]))('requires exactly one primary address bound to the stored Google account', async (sendAs) => {
    safeFetch.mockResolvedValue(response({ sendAs }));
    expect(await readGmailIdentities(account())).toMatchObject({ identityStatus: 'unknown', reason: 'account_mismatch', identities: [] });
  });

  it.each([
    {}, { sendAs: null }, { sendAs: [primary(), null] },
    { sendAs: [primary(), { sendAsEmail: 'bad\r\naddress@synthetic.test', verificationStatus: 'accepted' }] },
    { sendAs: [primary(), { sendAsEmail: 'a@synthetic.test', isPrimary: 'true' }] },
  ])('rejects malformed inventory completely instead of claiming a partial ready list', async (body) => {
    safeFetch.mockResolvedValue(response(body));
    expect(await readGmailIdentities(account())).toMatchObject({ identityStatus: 'unknown', reason: 'invalid_response', identities: [] });
  });

  it('refuses invalid JSON, oversized bodies and redirect responses', async () => {
    for (const reply of [
      new Response('{'), new Response('x'.repeat(262145)),
      new Response('', { status: 302, headers: { Location: 'https://other.synthetic.test/' } }),
    ]) {
      safeFetch.mockResolvedValueOnce(reply);
      const result = await readGmailIdentities(account());
      expect(result.identityStatus).toBe('unknown');
      expect(result.identities).toEqual([]);
    }
    expect(safeFetch).toHaveBeenCalledTimes(3);
  });

  it('bounds the provider request and sanitizes network/timeout failures', async () => {
    safeFetch.mockImplementation(async (_url, { signal }) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      throw new Error(`network ${SECRET}`);
    });
    expect(await readGmailIdentities(account())).toMatchObject({ reason: 'provider_unavailable', identities: [] });
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  it('does not cache or cross account credentials across generated account/address pairs', async () => {
    for (let i = 0; i < 24; i++) {
      const email = `owner${i}@synthetic.test`;
      const row = account({ id: `account-${i}`, email_address: email, oauth_access_token: `encrypted-${i}` });
      decrypt.mockImplementation(value => `plain-${value}`);
      safeFetch.mockResolvedValue(response({ sendAs: [primary(email.toUpperCase()),
        { sendAsEmail: `alias${i}@synthetic.test`, verificationStatus: 'accepted' },
        { sendAsEmail: `pending${i}@synthetic.test`, verificationStatus: 'pending' },
      ] }));
      const result = await readGmailIdentities(row);
      expect(result.accountId).toBe(row.id);
      expect(result.identities).toEqual([{ email }, { email: `alias${i}@synthetic.test` }]);
      expect(safeFetch.mock.lastCall[1].headers.Authorization).toBe(`Bearer plain-encrypted-${i}`);
      safeFetch.mockResolvedValue(response({}, 403));
      expect((await readGmailIdentities(row)).identityStatus).toBe('unknown');
    }
    expect(safeFetch).toHaveBeenCalledTimes(48);
  });
});
