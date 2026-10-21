import { createHmac } from 'node:crypto';
import { decrypt, deriveKey } from './encryption.js';
import { query } from './db.js';
import { safeFetch } from './safeFetch.js';

const CORE = 'urn:ietf:params:jmap:core';
const SUBMISSION = 'urn:ietf:params:jmap:submission';
const MASKED = 'https://www.fastmail.com/dev/maskedemail';
const HOSTS = new Set(['smtp.fastmail.com', 'smtp.messagingengine.com']);
const STATES = new Set(['pending', 'enabled', 'disabled', 'deleted']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const normalized = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const domainName = value => value.length <= 253 && !/\p{Cc}/u.test(value) && value.split('.').every(label =>
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
// Affirm only ordinary ASCII dot-atom mailboxes. Unsupported quoted/international
// forms remain unknown rather than gaining permission from a domain wildcard.
const address = value => {
  if (typeof value !== 'string' || value.length > 254 || /\p{Cc}/u.test(value)) return false;
  const parts = value.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  return local.length <= 64 && local.split('.').every(atom => /^[a-z0-9!#$%&'*+\-/=?^_`{|}~]+$/i.test(atom))
    && domainName(domain);
};
// Identity wildcards are a provider capability syntax, not candidate validation.
const providerAddress = value => typeof value === 'string' && value.startsWith('*@')
  ? value.length <= 254 && domainName(value.slice(2)) : address(value);
const failure = reason => Object.assign(new Error(reason), { reason });

export function supportsFastmailVerification(account) {
  return account.enabled === true && HOSTS.has(normalized(account.smtp_host));
}

export function fastmailConfigRevision(account) {
  const key = deriveKey('fastmail-config-revision');
  if (!key) return null;
  const input = [account.id, account.fastmail_api_token ?? null, account.enabled,
    account.smtp_host ?? null, account.smtp_auth_user ?? null, account.auth_user ?? null];
  return createHmac('sha256', key).update(JSON.stringify(input)).digest('hex').slice(0, 32);
}

export function classifyFastmailSender(inventory, email) {
  if (!address(email) || inventory.identityStatus !== 'ready') return 'unknown';
  const candidate = normalized(email);
  const domain = candidate.slice(candidate.lastIndexOf('@') + 1);
  if (inventory.identities.some(row => row.email === candidate || row.email === `*@${domain}`)) return 'allowed';
  if (inventory.maskedStatus !== 'ready' || inventory.maskedEmails.some(row => row.email === candidate)) return 'unknown';
  return 'unavailable';
}

async function fetchJson(url, options) {
  const response = await safeFetch(url, { ...options, redirect: 'error' });
  if (!response.ok) {
    await response.body?.cancel();
    throw failure(response.status === 401 ? 'credentials_invalid' : response.status === 403 ? 'insufficient_scope' : 'provider_unavailable');
  }
  const reader = response.body?.getReader();
  if (!reader) throw failure('invalid_response');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw failure('invalid_response');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw failure(error.name === 'SyntaxError' ? 'invalid_response' : error.reason || 'provider_unavailable');
  } finally { reader.releaseLock(); }
}

function apiUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw failure('invalid_response'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
    || !(url.hostname === 'api.fastmail.com' || url.hostname.endsWith('.api.fastmail.com'))) throw failure('invalid_response');
  return url.href;
}

function parseMethod(responses, name, tag, accountId, masked) {
  const matches = responses.filter(row => Array.isArray(row) && row.length === 3 && row[2] === tag);
  if (matches.length !== 1) throw failure('invalid_response');
  const [method, data] = matches[0];
  if (method === 'error') throw failure(data?.type === 'forbidden' ? 'insufficient_scope' : 'provider_unavailable');
  if (method !== name || !object(data) || data.accountId !== accountId || typeof data.state !== 'string'
    || !Array.isArray(data.list) || !(data.notFound === null || (Array.isArray(data.notFound) && !data.notFound.length))) throw failure('invalid_response');
  const ids = new Set();
  return data.list.map(row => {
    if (!object(row) || typeof row.id !== 'string' || !row.id || ids.has(row.id) || !(masked ? address(row.email) : providerAddress(row.email))
      || (masked && !STATES.has(row.state))) throw failure('invalid_response');
    ids.add(row.id);
    return { email: normalized(row.email), ...(masked ? { state: row.state } : {}) };
  });
}

export async function readFastmailIdentities(account) {
  const result = { accountId: account.id, provider: HOSTS.has(normalized(account.smtp_host)) ? 'fastmail' : null,
    identityStatus: 'unknown', maskedStatus: 'unknown', reason: null, identities: [], maskedEmails: [],
    configRevision: fastmailConfigRevision(account), checkedAt: new Date().toISOString() };
  if (!result.provider) return { ...result, identityStatus: 'unsupported', maskedStatus: 'unsupported', reason: 'unsupported_provider' };
  if (account.enabled !== true) return { ...result, reason: 'account_disabled' };
  if (!account.fastmail_api_token) return { ...result, reason: 'credentials_missing' };
  try {
    const token = decrypt(account.fastmail_api_token);
    if (!token) throw failure('credentials_invalid');
    const options = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000) };
    const session = await fetchJson('https://api.fastmail.com/jmap/session', options);
    if (!object(session) || !object(session.accounts) || !object(session.primaryAccounts) || !object(session.capabilities)) throw failure('invalid_response');
    const login = normalized(account.smtp_auth_user || account.auth_user);
    if (!login || normalized(session.username) !== login) throw failure('account_mismatch');
    const id = session.primaryAccounts[SUBMISSION];
    const personal = session.accounts[id];
    if (typeof id !== 'string' || !object(personal) || personal.isPersonal !== true) throw failure('account_mismatch');
    const url = apiUrl(session.apiUrl);
    const capabilities = personal.accountCapabilities;
    if (!object(capabilities) || !object(session.capabilities[CORE])) throw failure('insufficient_scope');
    const hasIdentity = object(session.capabilities[SUBMISSION]) && object(capabilities[SUBMISSION]);
    const hasMasked = object(session.capabilities[MASKED]) && object(capabilities[MASKED]) && session.primaryAccounts[MASKED] === id;
    const calls = [];
    const using = [CORE];
    if (hasIdentity) { using.push(SUBMISSION); calls.push(['Identity/get', { accountId: id, ids: null }, 'identities']); }
    else { result.identityStatus = 'unsupported'; result.reason = 'insufficient_scope'; }
    if (hasMasked) { using.push(MASKED); calls.push(['MaskedEmail/get', { accountId: id, ids: null }, 'masks']); }
    else { result.maskedStatus = 'unsupported'; result.reason = 'insufficient_scope'; }
    if (!calls.length) return result;
    const response = await fetchJson(url, { ...options, method: 'POST', body: JSON.stringify({ using, methodCalls: calls }) });
    if (!object(response) || !Array.isArray(response.methodResponses)) throw failure('invalid_response');
    for (const [name, , tag] of calls) {
      const masked = tag === 'masks', status = masked ? 'maskedStatus' : 'identityStatus', rows = masked ? 'maskedEmails' : 'identities';
      try {
        result[rows] = parseMethod(response.methodResponses, name, tag, id, masked);
        result[status] = 'ready';
      } catch (error) { result[status] = 'unknown'; result.reason = error.reason || 'provider_unavailable'; }
    }
  } catch (error) { result.reason = error.reason || 'provider_unavailable'; }
  return result;
}

export async function listProviderIdentities(userId, accountId) {
  const { rows } = await query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [accountId, userId]);
  if (!rows.length) throw Object.assign(new Error('Account not found'), { status: 404 });
  return readFastmailIdentities(rows[0]);
}

// Resolve before network access; a stale selection must never become the primary sender.
export async function getSenderIdentityInventory(userId, accountId, aliasId) {
  if (aliasId !== undefined && (typeof aliasId !== 'string' || !UUID.test(aliasId))) throw Object.assign(new Error('Account not found'), { status: 404 });
  const { rows } = await query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [accountId, userId]);
  if (!rows.length) throw Object.assign(new Error('Account not found'), { status: 404 });
  const account = rows[0];
  let email = account.email_address;
  if (aliasId !== undefined) {
    const aliases = await query('SELECT email FROM account_aliases WHERE id = $1 AND account_id = $2', [aliasId, accountId]);
    if (!aliases.rows.length) throw Object.assign(new Error('Account not found'), { status: 404 });
    email = aliases.rows[0].email;
  }
  const inventory = await readFastmailIdentities(account);
  return { ...inventory, sender: { email, status: classifyFastmailSender(inventory, email) } };
}
