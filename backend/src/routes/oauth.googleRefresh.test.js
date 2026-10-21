import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep app startup, persistence and provider I/O inert while exercising the real
// Google refresh helper together with its inventory consumer.
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/imapManager.js', () => ({ providerProfile: vi.fn(), PROVIDERS: {} }));
vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../services/encryption.js', () => ({ encrypt: vi.fn(value => value), decrypt: vi.fn(value => value) }));
vi.mock('../services/safeFetch.js', () => ({ safeFetch: vi.fn() }));

import { query } from '../services/db.js';
import { decrypt } from '../services/encryption.js';
import { safeFetch } from '../services/safeFetch.js';
import { readGmailIdentities } from '../services/gmailIdentities.js';
import { refreshGoogleToken } from './oauth.js';

const SECRET = 'synthetic-private-provider-text';
const row = () => ({
  id: '11111111-1111-4111-8111-111111111111', enabled: true, oauth_provider: 'google',
  email_address: 'primary@synthetic.test', oauth_access_token: 'old-access',
  oauth_refresh_token: 'stored-refresh', oauth_token_expiry: '2020-01-01T00:00:00Z',
});
const providerResponse = (body, status = 400) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  vi.clearAllMocks();
  decrypt.mockImplementation(value => value);
  query.mockResolvedValue({ rows: [] });
  vi.stubEnv('GOOGLE_CLIENT_ID', 'synthetic-client');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'synthetic-client-secret');
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Google permanent refresh failures consumed by Gmail inventory', () => {
  it('tags a falsy decrypted refresh credential before any provider or persistence operation', async () => {
    decrypt.mockReturnValue(null);
    await expect(refreshGoogleToken(row())).rejects.toMatchObject({ code: 'OAUTH_RECONNECT_REQUIRED' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(await readGmailIdentities(row())).toMatchObject({ reason: 'credentials_missing', identities: [] });
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('tags invalid_grant and returns a sanitized reconnect result without retrying', async () => {
    globalThis.fetch.mockImplementation(async () => providerResponse({ error: 'invalid_grant', error_description: SECRET }));
    await expect(refreshGoogleToken(row())).rejects.toMatchObject({ code: 'OAUTH_RECONNECT_REQUIRED' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    globalThis.fetch.mockClear();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await readGmailIdentities(row());
    expect(result).toMatchObject({ reason: 'credentials_missing', identities: [] });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
    expect(safeFetch).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not turn a non-invalid_grant provider error into a reconnect request based on its description', async () => {
    globalThis.fetch.mockImplementation(async () => providerResponse({
      error: 'temporarily_unavailable', error_description: `invalid_grant reconnect ${SECRET}`,
    }, 503));
    const result = await readGmailIdentities(row());
    expect(result).toMatchObject({ reason: 'provider_unavailable', identities: [] });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('keeps network failures transient and sends no inventory request', async () => {
    globalThis.fetch.mockRejectedValue(new TypeError(SECRET));
    expect(await readGmailIdentities(row())).toMatchObject({ reason: 'provider_unavailable', identities: [] });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('does not tag an unexpected decrypt exception as a known permanent credential failure', async () => {
    decrypt.mockImplementation(() => { throw new Error(SECRET); });
    const result = await readGmailIdentities(row());
    expect(result).toMatchObject({ reason: 'provider_unavailable', identities: [] });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('continues the existing successful refresh into the read using the refreshed credential', async () => {
    globalThis.fetch.mockResolvedValue(providerResponse({ access_token: 'refreshed-access', expires_in: 3600 }, 200));
    safeFetch.mockResolvedValue(providerResponse({ sendAs: [{ sendAsEmail: 'primary@synthetic.test', isPrimary: true }] }, 200));
    expect(await readGmailIdentities(row())).toMatchObject({ identityStatus: 'ready', reason: null,
      identities: [{ email: 'primary@synthetic.test' }],
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, request] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(request.method).toBe('POST');
    expect(request.body.get('grant_type')).toBe('refresh_token');
    expect(request.body.get('refresh_token')).toBe('stored-refresh');
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual(['refreshed-access', null, expect.any(Date), row().id]);
    expect(safeFetch).toHaveBeenCalledWith('https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs',
      expect.objectContaining({ headers: { Authorization: 'Bearer refreshed-access', Accept: 'application/json' } }));
  });
});
