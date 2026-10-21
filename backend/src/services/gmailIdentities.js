import { decrypt } from './encryption.js';
import { safeFetch } from './safeFetch.js';
import { refreshGoogleToken } from '../routes/oauth.js';

const SEND_AS_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs';
const MAX_BYTES = 262144;
const TIMEOUT_MS = 10000;

function address(value) {
  if (typeof value !== 'string' || value.length > 254 || /[\p{Cc}\p{Cf}]/u.test(value)
    || !/^[^\s<>@]+@[^\s<>@]+$/.test(value)) return null;
  return value.toLowerCase();
}

async function readJson(response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error('Response too large');
  }
  if (!response.body) throw new Error('Missing response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('Response too large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function forbiddenReason(data) {
  const reasons = [
    ...(Array.isArray(data?.error?.errors) ? data.error.errors : []),
    ...(Array.isArray(data?.error?.details) ? data.error.details : []),
  ].map(entry => entry?.reason);
  if (reasons.some(reason => ['accessNotConfigured', 'SERVICE_DISABLED'].includes(reason))) return 'api_not_enabled';
  if (reasons.some(reason => ['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'].includes(reason))) return 'insufficient_scope';
  if (reasons.some(reason => ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded',
    'quotaExceeded', 'RATE_LIMIT_EXCEEDED'].includes(reason))) return 'rate_limited';
  return 'provider_unavailable';
}

function retryAfter(headers) {
  const value = headers.get('retry-after');
  if (!value) return null;
  const seconds = /^\d+$/.test(value) ? Number(value)
    : /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)
      ? Math.ceil((Date.parse(value) - Date.now()) / 1000) : NaN;
  return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 86400 ? seconds : null;
}

// Internal adapter only: listProviderIdentities must establish ownership before calling it.
// A ready inventory is not permission to send or mutate provider settings.
export async function readGmailIdentities(account) {
  const result = {
    accountId: account.id, provider: 'gmail', identityStatus: 'unknown',
    maskedStatus: 'unsupported', reason: null, identities: [], maskedEmails: [],
    configRevision: null, checkedAt: new Date().toISOString(),
  };
  const unavailable = reason => ({ ...result, reason });
  if (account.enabled === false) return unavailable('account_disabled');
  if (!account.oauth_provider) return unavailable('credentials_missing');
  if (account.oauth_provider !== 'google') return unavailable('unsupported_provider');
  if (!account.oauth_access_token && !account.oauth_refresh_token) return unavailable('credentials_missing');
  const expected = address(account.email_address);
  if (!expected) return unavailable('account_mismatch');

  let token;
  try {
    const expiry = new Date(account.oauth_token_expiry ?? '').getTime();
    if (!account.oauth_access_token || !Number.isFinite(expiry) || expiry < Date.now() + 300000) {
      if (!account.oauth_refresh_token) return unavailable('credentials_missing');
      token = (await refreshGoogleToken(account)).oauth_access_token;
    } else {
      token = decrypt(account.oauth_access_token);
    }
  } catch {
    // refreshGoogleToken can throw the provider's error_description verbatim.
    return unavailable('provider_unavailable');
  }
  if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) return unavailable('credentials_missing');

  let response;
  try {
    response = await safeFetch(SEND_AS_URL, {
      method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return unavailable('provider_unavailable');
  }

  let data;
  const failed = reason => {
    const after = reason === 'rate_limited' ? retryAfter(response.headers) : null;
    return { ...unavailable(reason), ...(after === null ? {} : { retryAfter: after }) };
  };
  try {
    data = await readJson(response);
  } catch {
    return failed(response.status === 401 ? 'credentials_missing'
        : response.status === 429 ? 'rate_limited'
          : response.ok ? 'invalid_response' : 'provider_unavailable');
  }
  if (response.status === 401) return unavailable('credentials_missing');
  if (response.status === 403) return failed(forbiddenReason(data));
  if (response.status === 429) return failed('rate_limited');
  if (!response.ok) return unavailable('provider_unavailable');
  if (!Array.isArray(data?.sendAs)) return unavailable('invalid_response');

  const rows = data.sendAs;
  if (rows.some(row => !row || !address(row.sendAsEmail)
    || (row.isPrimary !== undefined && typeof row.isPrimary !== 'boolean')
    || (row.verificationStatus !== undefined && !['accepted', 'pending'].includes(row.verificationStatus)))) {
    return unavailable('invalid_response');
  }
  const primaries = rows.filter(row => row.isPrimary === true);
  if (primaries.length !== 1 || address(primaries[0].sendAsEmail) !== expected) return unavailable('account_mismatch');
  const emails = new Set(rows.filter(row => row.isPrimary === true || row.verificationStatus === 'accepted')
    .map(row => address(row.sendAsEmail)));
  return { ...result, identityStatus: 'ready', identities: [...emails].map(email => ({ email })) };
}
