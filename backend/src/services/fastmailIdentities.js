import { createHmac, randomUUID } from 'node:crypto';
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
const marker = /\[mailflow:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\](?![\s\S])/i;
const CREATE_REASONS = new Set(['unsupported_provider', 'account_disabled', 'credentials_missing', 'credentials_invalid',
  'account_mismatch', 'insufficient_scope', 'invalid_input', 'invalid_response', 'provider_unavailable', 'rate_limited']);
const CREATE_ERROR = Symbol('fastmail-create-error');

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
    await response.body?.cancel().catch(() => {});
    const error = failure(response.status === 401 ? 'credentials_invalid' : response.status === 403 ? 'insufficient_scope'
      : response.status === 429 ? 'rate_limited' : 'provider_unavailable');
    error.httpStatus = response.status;
    const value = response.headers.get('retry-after');
    if (response.status === 429 && /^\d+$/.test(value || '') && Number.isSafeInteger(Number(value)) && Number(value) <= 86400) error.retryAfter = Number(value);
    throw error;
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

// One transport/session implementation serves read and create; no caller endpoints.
function fastmailOptions(account, timeoutMs) {
  let token;
  try { token = decrypt(account.fastmail_api_token); } catch { throw failure('credentials_invalid'); }
  if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw failure('credentials_invalid');
  return { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs) };
}

async function discoverFastmailSession(account, options, requiredCapability) {
  const session = await fetchJson('https://api.fastmail.com/jmap/session', options);
  if (!object(session) || !object(session.accounts) || !object(session.primaryAccounts) || !object(session.capabilities)) throw failure('invalid_response');
  const login = normalized(account.smtp_auth_user || account.auth_user);
  if (!login || normalized(session.username) !== login) throw failure('account_mismatch');
  const id = session.primaryAccounts[requiredCapability];
  const personal = session.accounts[id];
  if (typeof id !== 'string' || !object(personal) || personal.isPersonal !== true) throw failure('account_mismatch');
  const url = apiUrl(session.apiUrl), capabilities = personal.accountCapabilities;
  if (!object(capabilities) || !object(session.capabilities[CORE])) throw failure('insufficient_scope');
  return { session, id, personal, url, capabilities };
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
    const match = masked && typeof row.description === 'string' ? marker.exec(row.description) : null;
    return { email: normalized(row.email), ...(masked ? { state: row.state } : {}),
      ...(match ? { clientRequestId: match[1].toLowerCase() } : {}) };
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
    const options = fastmailOptions(account, 8000);
    const { session, id, url, capabilities } = await discoverFastmailSession(account, options, SUBMISSION);
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

async function readProviderIdentities(account) {
  const google = !HOSTS.has(normalized(account.smtp_host)) && (account.oauth_provider === 'google'
    || ['smtp.gmail.com', 'smtp.googlemail.com'].includes(normalized(account.smtp_host)));
  if (!google) return readFastmailIdentities(account);
  if (account.enabled !== true) return { accountId: account.id, provider: 'gmail', identityStatus: 'unknown',
    maskedStatus: 'unsupported', reason: 'account_disabled', identities: [], maskedEmails: [],
    configRevision: null, checkedAt: new Date().toISOString() };
  // Import/refresh/network are deliberately after the public facade's owned query.
  const { readGmailIdentities } = await import('./gmailIdentities.js');
  return readGmailIdentities(account);
}

export async function listProviderIdentities(userId, accountId) {
  const { rows } = await query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [accountId, userId]);
  if (!rows.length) throw Object.assign(new Error('Account not found'), { status: 404 });
  return readProviderIdentities(rows[0]);
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
  const inventory = await readProviderIdentities(account);
  return { ...inventory, sender: inventory.provider === 'fastmail'
    ? { email, status: classifyFastmailSender(inventory, email) } : null };
}

// Independent operation: a readable inventory never implies permission to create.
// The authenticated route owns throttling/audit and reuses this schema before its
// throttle. The service repeats validation/ownership and never accepts a signal.
export function validateFastmailMaskedEmailInput(input) {
  if (!object(input) || Object.keys(input).some(key => !['confirmed', 'clientRequestId', 'forDomain', 'description', 'emailPrefix'].includes(key))
    || input.confirmed !== true || typeof input.clientRequestId !== 'string' || input.clientRequestId.length !== 36 || !UUID.test(input.clientRequestId)) throw failure('invalid_input');
  const description = input.description === undefined ? '' : input.description;
  if (typeof description !== 'string' || description.length > 192 || /[\p{Cc}\p{Cf}]/u.test(description) || /\[mailflow:/i.test(description)) throw failure('invalid_input');
  if (input.emailPrefix !== undefined && (typeof input.emailPrefix !== 'string' || input.emailPrefix.length < 1
    || input.emailPrefix.length > 64 || /[^a-z0-9_]/.test(input.emailPrefix))) throw failure('invalid_input');
  let forDomain;
  if (input.forDomain !== undefined) {
    if (typeof input.forDomain !== 'string' || input.forDomain.length > 2048) throw failure('invalid_input');
    let url;
    try { url = new URL(input.forDomain); } catch { throw failure('invalid_input'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || ![url.origin, `${url.origin}/`].includes(input.forDomain)) throw failure('invalid_input');
    forDomain = url.origin;
  }
  return { confirmed: true, clientRequestId: input.clientRequestId.toLowerCase(), description,
    ...(forDomain === undefined ? {} : { forDomain }), ...(input.emailPrefix === undefined ? {} : { emailPrefix: input.emailPrefix }) };
}

function createError(reason, outcome, input, retryAfter) {
  return Object.assign(failure(reason), { [CREATE_ERROR]: true, outcome, ...(input?.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
    ...(Number.isSafeInteger(retryAfter) && retryAfter >= 0 && retryAfter <= 86400 ? { retryAfter } : {}) });
}

function setErrorReason(type) {
  return type === 'rateLimit' ? 'rate_limited' : ['forbidden', 'accountReadOnly'].includes(type) ? 'insufficient_scope'
    : type === 'accountNotFound' ? 'account_mismatch' : type === 'invalidProperties' ? 'invalid_input' : 'provider_unavailable';
}

export async function createFastmailMaskedEmail(userId, accountId, rawInput) {
  if (typeof accountId !== 'string' || !UUID.test(accountId)) throw Object.assign(new Error('Account not found'), { status: 404, outcome: 'refused' });
  const { rows } = await query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [accountId, userId]);
  if (!rows.length) throw Object.assign(new Error('Account not found'), { status: 404, outcome: 'refused' });
  const account = rows[0];
  let input, dispatched = false;
  try {
    input = validateFastmailMaskedEmailInput(rawInput);
    if (!HOSTS.has(normalized(account.smtp_host))) throw failure('unsupported_provider');
    if (account.enabled !== true) throw failure('account_disabled');
    if (!account.fastmail_api_token) throw failure('credentials_missing');
    const options = fastmailOptions(account, 30000);
    const { session, id, personal, url, capabilities } = await discoverFastmailSession(account, options, MASKED);
    if (!object(session.capabilities[MASKED]) || !object(capabilities[MASKED]) || personal.isReadOnly !== false) throw failure('insufficient_scope');
    const creationId = randomUUID(), tag = 'create-mask';
    const properties = { state: 'enabled', url: null,
      description: `${input.description}${input.description ? ' ' : ''}[mailflow:${input.clientRequestId}]`,
      ...(input.forDomain === undefined ? {} : { forDomain: input.forDomain }),
      ...(input.emailPrefix === undefined ? {} : { emailPrefix: input.emailPrefix }) };
    // From this point a transport error cannot prove whether the mutation ran.
    dispatched = true;
    const response = await fetchJson(url, { ...options, method: 'POST', body: JSON.stringify({ using: [CORE, MASKED],
      methodCalls: [['MaskedEmail/set', { accountId: id, create: { [creationId]: properties } }, tag]] }) });
    if (object(response) && typeof response.type === 'string' && response.type.startsWith('urn:ietf:params:jmap:error:')) {
      throw createError('provider_unavailable', 'refused', input);
    }
    if (!object(response) || !Array.isArray(response.methodResponses) || response.methodResponses.length !== 1) throw failure('invalid_response');
    const invocation = response.methodResponses[0];
    if (!Array.isArray(invocation) || invocation.length !== 3 || invocation[2] !== tag || !object(invocation[1])) throw failure('invalid_response');
    const [method, data] = invocation;
    if (method === 'error' && typeof data.type === 'string') throw createError(setErrorReason(data.type), 'refused', input);
    if (method !== 'MaskedEmail/set' || data.accountId !== id) throw failure('invalid_response');
    const created = data.created, refused = data.notCreated;
    if ((created != null && !object(created)) || (refused != null && !object(refused))) throw failure('invalid_response');
    if (Object.keys(created || {}).some(key => key !== creationId) || Object.keys(refused || {}).some(key => key !== creationId)) throw failure('invalid_response');
    if (refused?.[creationId] && !created?.[creationId] && object(refused[creationId]) && typeof refused[creationId].type === 'string') {
      throw createError(setErrorReason(refused[creationId].type), 'refused', input);
    }
    const row = created?.[creationId];
    if (!object(row) || refused?.[creationId] || typeof data.newState !== 'string' || typeof row.id !== 'string' || !row.id || !address(row.email)
      || (row.state !== undefined && row.state !== 'enabled')) throw failure('invalid_response');
    return { accountId, provider: 'fastmail', email: normalized(row.email), state: 'enabled', outcome: 'created', clientRequestId: input.clientRequestId };
  } catch (error) {
    if (error?.[CREATE_ERROR] === true) throw error;
    const unknown = dispatched && (!error.httpStatus || error.httpStatus === 408 || error.httpStatus >= 500);
    const reason = CREATE_REASONS.has(error.reason) ? error.reason : 'provider_unavailable';
    throw createError(unknown ? 'outcome_unknown' : reason, unknown ? 'unknown' : 'refused', input, error.retryAfter);
  }
}
