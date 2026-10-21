import { USER_AGENT } from './version.js';
import { Semaphore, anySignal } from './concurrency.js';
import { IDENTITY_ERRORS, validRetryAfter } from './identityContract.js';

export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
export const MAX_CONCURRENT_REQUESTS = 4;
// MailFlow's own error texts (the API token feature's middleware).
export const INVALID_TOKEN_ERROR = 'Invalid or expired API token';
export const TOKENS_OFF_ERROR = 'API tokens are turned off on this server';
// MailFlow's 429 for an address that sent too many credentials it does not know; a valid token
// never counts against that limit.
export const FAILED_ATTEMPTS_ERROR = 'Too many failed API token attempts. Try again later.';
// The snooze routes' 404 for a message that exists but has no snooze to change or end.
export const NOT_SNOOZED_ERROR = 'Message is not snoozed';
export const MAY_HAVE_COMPLETED = 'MailFlow may still have completed this; check before retrying.';
const MOVED_HINT = 'message ids change when mail is moved or archived — re-find it with search_mail or by its Message-ID';
// A failure while connecting means the request never reached MailFlow.
const CONNECT_ERRORS = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_INVALID_URL',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export class MailflowError extends Error {
  constructor(message, { status = null, code = 'error', mailflowMessage = null, retryAfter = null, mayHaveCompleted = false } = {}) {
    super(message);
    this.name = 'MailflowError';
    this.status = status;
    this.code = code;
    this.mailflowMessage = mailflowMessage;
    this.retryAfter = retryAfter;
    this.mayHaveCompleted = mayHaveCompleted;
  }
}

// Seen by no one in practice: an MCP client that cancels a call drops its result.
function cancelledError() {
  return new MailflowError('The tool call was cancelled, so nothing more was sent to MailFlow for it.', { code: 'cancelled' });
}

export function retryAfterSeconds(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text);
  const when = Date.parse(text);
  if (Number.isNaN(when)) return null;
  return Math.max(0, Math.ceil((when - now) / 1000));
}

// One error message per HTTP outcome. MailFlow's own `error` text is always kept, because it
// is usually the most specific explanation there is.
export function mapErrorResponse({ status, data, headers, path = '', lookup = false, write = false }) {
  const said = typeof data?.error === 'string' && data.error.trim() ? data.error.trim().slice(0, 500) : null;
  const quoted = said ? ` (MailFlow: "${said}")` : '';
  const notJson = data === null ? ' The answer was not JSON, so it may have come from a proxy in front of MailFlow.' : '';
  const base = { status, mailflowMessage: said };

  if (status === 401) {
    if (said === INVALID_TOKEN_ERROR) {
      return new MailflowError(
        `MailFlow rejected the API token: it is invalid, expired or revoked${quoted}. Create a new one in MailFlow under Settings → Security → API tokens.`,
        { ...base, code: 'invalid_token' },
      );
    }
    if (said === TOKENS_OFF_ERROR) {
      return new MailflowError(
        `MailFlow rejected the API token because API tokens are turned off on this server${quoted}. An administrator can turn them on in MailFlow.`,
        { ...base, code: 'tokens_off' },
      );
    }
    return new MailflowError(
      `The API token did not reach MailFlow (check that your proxy forwards the Authorization header)${quoted}.${notJson}`,
      { ...base, code: 'token_not_received' },
    );
  }
  if (status === 403) {
    return new MailflowError(said ? `MailFlow refused this request: ${said}` : `MailFlow refused this request (403).${notJson}`, { ...base, code: 'forbidden' });
  }
  if (status === 404) {
    // MailFlow found the message, so nothing moved and the "ids change" hint would mislead.
    if (said === NOT_SNOOZED_ERROR) {
      return new MailflowError(`MailFlow says this message is not snoozed${quoted}. list_messages with folder "Snoozed" shows what is.`, { ...base, code: 'not_snoozed' });
    }
    if (lookup) {
      return new MailflowError(`Not found in MailFlow (it may have been moved; ${MOVED_HINT})${quoted}.`, { ...base, code: 'not_found' });
    }
    return new MailflowError(`Not found in MailFlow${quoted || ` (${path})`}.${notJson}`, { ...base, code: 'not_found' });
  }
  if (status === 400 || status === 409 || status === 422) {
    return new MailflowError(said ? `MailFlow: ${said}` : `MailFlow refused the request (${status}).${notJson}`, { ...base, code: 'rejected' });
  }
  if (status === 413) {
    return new MailflowError(`MailFlow refused the request as too large (413)${quoted}.`, { ...base, code: 'too_large' });
  }
  if (status === 429) {
    const after = retryAfterSeconds(headers?.get?.('retry-after'));
    const wait = after !== null ? `retry after ${after} seconds` : 'retry shortly';
    return new MailflowError(`MailFlow is rate limiting these requests; ${wait}${quoted}.`, { ...base, code: 'rate_limited', retryAfter: after });
  }
  if (status >= 500) {
    const text = `MailFlow answered ${status}${quoted}.${notJson}`;
    return new MailflowError(write ? `${text} ${MAY_HAVE_COMPLETED}` : text, { ...base, code: 'server_error', mayHaveCompleted: write });
  }
  return new MailflowError(`MailFlow answered ${status}${quoted}.${notJson}`, { ...base, code: 'unexpected' });
}

export class MailflowClient {
  /**
   * @param {object} options
   * @param {string} options.baseUrl MailFlow's address without a trailing slash
   * @param {string|null} options.token an mfat_ token; never logged or put in a message
   * @param {number} [options.timeoutMs]
   * @param {string|null} [options.clientIp] the caller's address, sent as the only X-Forwarded-For entry
   * @param {Semaphore} [options.semaphore] shared by every client of one token
   */
  constructor({ baseUrl, token = null, timeoutMs = 60000, clientIp = null, semaphore = null, fetch: fetchImpl = globalThis.fetch, maxResponseBytes = MAX_RESPONSE_BYTES }) {
    this.baseUrl = baseUrl;
    this.origin = new URL(baseUrl).origin;
    this.timeoutMs = timeoutMs;
    this.clientIp = clientIp;
    this.semaphore = semaphore || new Semaphore(MAX_CONCURRENT_REQUESTS);
    this.maxResponseBytes = maxResponseBytes;
    // Kept off the enumerable fields, so logging or serialising a client cannot leak it.
    Object.defineProperty(this, 'token', { value: token, enumerable: false, writable: false });
    Object.defineProperty(this, 'fetchImpl', { value: fetchImpl, enumerable: false, writable: false });
  }

  /**
   * This client for one tool call. Once `signal` aborts (the MCP client cancelled the call, or its
   * connection closed), nothing more is sent for the call: a request waiting for its turn is
   * dropped and a read in flight is stopped. A write already sent is left to finish, since
   * stopping it could not undo it.
   * @param {AbortSignal} [signal]
   */
  forCall(signal) {
    if (!signal) return this;
    const call = Object.create(this);
    Object.defineProperty(call, 'callSignal', { value: signal, enumerable: false });
    return call;
  }

  url(path, query) {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    return url;
  }

  /**
   * @param {string} method
   * @param {string} path starts with /api/
   * @param {object} [options]
   * @param {object} [options.query]
   * @param {unknown} [options.body] sent as JSON
   * @param {boolean} [options.auth] send the token (false only for MailFlow's public probes)
   * @param {boolean} [options.lookup] a message lookup, so a 404 explains that ids change after moves
   * @param {boolean} [options.write] a request that may change mail; never retried
   * @param {AbortSignal} [options.signal] an extra deadline
   */
  async request(method, path, { query, body, auth = true, lookup = false, write = method !== 'GET', signal, identity = false } = {}) {
    const url = this.url(path, query);
    const headers = { Accept: 'application/json', 'User-Agent': USER_AGENT };
    if (auth) {
      if (!this.token) throw new MailflowError('No API token for this request', { code: 'no_token' });
      headers.Authorization = `Bearer ${this.token}`;
    }
    if (this.clientIp) headers['X-Forwarded-For'] = this.clientIp;
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    if (method !== 'GET' && method !== 'HEAD') headers['X-Requested-With'] = 'mailflow-mcp';

    const call = this.callSignal ?? null;
    const context = { method, path, lookup, write, identity, url, timeout: null, signal, call, sent: false };
    try {
      await this.semaphore.acquire(anySignal([signal, call]));
    } catch (err) {
      throw this.networkError(err, context);
    }
    try {
      // Looked at again with the turn in hand: a call cancelled while this waited sends nothing.
      if (call?.aborted) throw cancelledError();
      context.timeout = AbortSignal.timeout(this.timeoutMs);
      const combined = anySignal([context.timeout, signal, write ? null : call]);
      let response;
      try {
        context.sent = true;
        // No cookies are ever attached (Node's fetch has no cookie jar), and a redirect is
        // reported rather than followed, so the token never travels to another address.
        response = await this.fetchImpl(url, { method, headers, body: payload, redirect: 'manual', signal: combined });
      } catch (err) {
        throw this.networkError(err, context);
      }
      try {
        return await this.handle(response, context);
      } catch (err) {
        throw err instanceof MailflowError ? err : this.networkError(err, context);
      }
    } finally {
      this.semaphore.release();
    }
  }

  networkError(err, { write, timeout, signal, call, sent }) {
    if (err instanceof MailflowError) return err;
    // A write that went out is never stopped by a cancelled call, so its outcome is told as usual.
    if (call?.aborted && (!sent || !write)) return cancelledError();
    const maybeDone = Boolean(write && sent);
    const note = maybeDone ? ` ${MAY_HAVE_COMPLETED}` : '';
    if (timeout?.aborted) {
      const limit = this.timeoutMs >= 1000 ? `${Math.round(this.timeoutMs / 1000)} s` : `${this.timeoutMs} ms`;
      return new MailflowError(`MailFlow did not answer within ${limit}.${note}`, { code: 'timeout', mayHaveCompleted: maybeDone });
    }
    if (signal?.aborted) {
      return new MailflowError(`The request to MailFlow was stopped at this tool's deadline.${note}`, { code: 'deadline', mayHaveCompleted: maybeDone });
    }
    const code = err?.cause?.code || err?.code || '';
    const connectFailed = CONNECT_ERRORS.has(code);
    const detail = code || err?.cause?.message || err?.message || 'network error';
    return new MailflowError(
      `Could not reach MailFlow at ${this.origin} (${detail}).${connectFailed ? '' : note}`,
      { code: 'network', mayHaveCompleted: maybeDone && !connectFailed },
    );
  }

  async readBody(response) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.maxResponseBytes) {
      await response.body?.cancel().catch(() => {});
      throw this.tooLarge();
    }
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > this.maxResponseBytes) {
        await reader.cancel().catch(() => {});
        throw this.tooLarge();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  tooLarge() {
    return new MailflowError(`MailFlow's answer was larger than ${Math.round(this.maxResponseBytes / 1048576)} MB, so it was not read.`, { code: 'too_large' });
  }

  async handle(response, { path, lookup, write, url, identity }) {
    const { status } = response;
    if (status >= 300 && status < 400) {
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get('location');
      let target = location;
      try {
        target = new URL(location, url).href;
      } catch { /* keep the raw value */ }
      throw new MailflowError(
        location ? `MAILFLOW_URL redirects to ${target}; use that URL.` : `MailFlow answered ${status} (a redirect) without a Location; check MAILFLOW_URL.`,
        { status, code: 'redirect' },
      );
    }
    const text = await this.readBody(response);
    const contentType = response.headers.get('content-type') || '';
    let data = null;
    if (/json/i.test(contentType)) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (status >= 200 && status < 300) {
      if (data === null) {
        throw new MailflowError(
          `This is not MailFlow's API (check MAILFLOW_URL): ${path} answered ${status} with ${contentType || 'no content type'} instead of JSON.`,
          { status, code: 'not_mailflow' },
        );
      }
      return data;
    }
    if (identity) {
      const known = Object.hasOwn(IDENTITY_ERRORS, data?.reason);
      const definite = [400, 401, 403, 404, 409, 413, 422, 429].includes(status);
      const refused = definite || (known && data.outcome === 'refused');
      const unknown = write && (!refused || data?.outcome === 'unknown');
      const reason = unknown ? 'outcome_unknown' : known ? data.reason
        : status === 401 || status === 403 ? 'authorization_failed'
          : status === 404 ? 'account_not_found' : status === 429 ? 'rate_limited' : 'provider_unavailable';
      const after = validRetryAfter(data?.retryAfter) ? data.retryAfter : retryAfterSeconds(response.headers.get('retry-after'));
      throw Object.assign(new MailflowError(IDENTITY_ERRORS[reason], {
        status, code: reason, mayHaveCompleted: unknown,
        retryAfter: reason === 'rate_limited' && validRetryAfter(after) ? after : null,
      }), { reason, ...(write ? { outcome: unknown ? 'unknown' : 'refused' } : {}) });
    }
    throw mapErrorResponse({ status, data, headers: response.headers, path, lookup, write });
  }

  // --- MailFlow's public probes (no token) ---

  async getVersion() {
    const data = await this.request('GET', '/api/version', { auth: false });
    if (!data || typeof data.version !== 'string') {
      throw new MailflowError("This is not MailFlow's API (check MAILFLOW_URL): /api/version did not answer with a MailFlow version.", { code: 'not_mailflow' });
    }
    return data;
  }

  async checkHealth(timeoutMs = 5000) {
    const data = await this.request('GET', '/api/health', { auth: false, signal: AbortSignal.timeout(timeoutMs) });
    if (data?.status !== 'ok') throw new MailflowError('MailFlow /api/health did not answer ok.', { code: 'unhealthy' });
    return data;
  }

  // --- The token itself ---

  async getSelf() {
    let self;
    try {
      self = await this.request('GET', '/api/api-tokens/self');
    } catch (err) {
      if (!(err instanceof MailflowError) || err.status !== 404) throw err;
      // Only call it MailFlow without token support once /api/version confirms it is MailFlow.
      const version = await this.getVersion().catch(() => null);
      if (version) {
        throw new MailflowError(
          `This MailFlow server (version ${version.version}) has no API token support. It needs a MailFlow build with API tokens (maathimself/mailflow#617).`,
          { status: 404, code: 'no_token_support' },
        );
      }
      throw new MailflowError("This is not MailFlow's API (check MAILFLOW_URL): /api/api-tokens/self and /api/version were not found.", { status: 404, code: 'not_mailflow' });
    }
    if (!self || !Array.isArray(self.scopes)) {
      throw new MailflowError("MailFlow's /api/api-tokens/self answer has no scopes (check MAILFLOW_URL).", { code: 'not_mailflow' });
    }
    return { ...self, scopes: self.scopes.filter(scope => typeof scope === 'string') };
  }

  // Provider identity routes use this same authenticated transport and cancellation policy.
  getSenderIdentities(accountId) {
    return this.request('GET', `/api/accounts/${encodeURIComponent(accountId)}/sender-identities`, { identity: true });
  }

  createMaskedEmail(accountId, input) {
    return this.request('POST', `/api/accounts/${encodeURIComponent(accountId)}/masked-emails`, { identity: true, body: input });
  }

  // --- read ---

  listAccounts() {
    return this.request('GET', '/api/accounts');
  }

  listFolders(accountId) {
    return this.request('GET', `/api/accounts/${encodeURIComponent(accountId)}/folders`);
  }

  listMessages({ accountId, folder, unreadOnly, category, limit, offset }) {
    return this.request('GET', '/api/mail/messages', {
      // Threaded rows mix two messages' fields, so this server always lists flat rows.
      query: { accountId, folder, unreadOnly: unreadOnly ? 'true' : undefined, category, limit, offset, threaded: 'false' },
    });
  }

  getMessage(id, { signal } = {}) {
    return this.request('GET', `/api/mail/messages/${encodeURIComponent(id)}`, { lookup: true, signal });
  }

  getMessageBody(id, { signal } = {}) {
    return this.request('GET', `/api/mail/messages/${encodeURIComponent(id)}/body`, { lookup: true, signal });
  }

  resolveMessage(ref, accountId) {
    return this.request('GET', '/api/mail/resolve-message', { query: { ref, accountId }, lookup: true });
  }

  getThread(key) {
    return this.request('GET', '/api/mail/thread', { query: { id: key } });
  }

  unreadCounts() {
    return this.request('GET', '/api/mail/unread-counts');
  }

  categoryCounts(accountId) {
    return this.request('GET', '/api/mail/category-counts', { query: { accountId } });
  }

  search({ q, accountId, folder, limit, offset }) {
    return this.request('GET', '/api/search', { query: { q, accountId, folder, limit, offset } });
  }

  searchContacts(q) {
    return this.request('GET', '/api/search/contacts', { query: { q } });
  }

  // --- organize ---

  bulkRead(ids, read) {
    return this.request('POST', '/api/mail/messages/bulk-read', { body: { ids, read } });
  }

  bulkStar(ids, starred) {
    return this.request('POST', '/api/mail/messages/bulk-star', { body: { ids, starred } });
  }

  bulkArchive(ids) {
    return this.request('POST', '/api/mail/messages/bulk-archive', { body: { ids } });
  }

  bulkMove(ids, folder) {
    return this.request('POST', '/api/mail/messages/bulk-move', { body: { ids, folder } });
  }

  snooze(id, until) {
    return this.request('POST', `/api/mail/messages/${encodeURIComponent(id)}/snooze`, { body: { until }, lookup: true });
  }

  rescheduleSnooze(id, until) {
    return this.request('PATCH', `/api/mail/messages/${encodeURIComponent(id)}/snooze`, { body: { until }, lookup: true });
  }

  unsnooze(id) {
    return this.request('POST', `/api/mail/messages/${encodeURIComponent(id)}/unsnooze`, { lookup: true });
  }

  setCategory(id, category) {
    return this.request('PATCH', `/api/mail/messages/${encodeURIComponent(id)}/category`, { body: { category }, lookup: true });
  }

  // --- draft ---

  // A POST, but it only reads MailFlow's cache of the Drafts folders.
  replyDraftIndicators(ids, accountId) {
    return this.request('POST', '/api/mail/reply-drafts/indicators', { body: { ids, ...(accountId ? { accountId } : {}) }, write: false });
  }

  saveDraft(payload) {
    return this.request('POST', '/api/mail/draft', { body: payload });
  }
}
