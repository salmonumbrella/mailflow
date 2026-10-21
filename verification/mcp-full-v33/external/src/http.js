import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig, isTokenFormat, hostnameOf } from './config.js';
import { MailflowClient, MailflowError, MAX_CONCURRENT_REQUESTS, FAILED_ATTEMPTS_ERROR } from './mailflowClient.js';
import { createMailflowServer, normalizeScopes } from './server.js';
import { Semaphore, InFlight } from './concurrency.js';
import { NEEDS_READ_SCOPE } from './errors.js';

export const MAX_BODY_BYTES = 1024 * 1024;
// A refused or oversized body is read and thrown away up to this size, so the client gets a clean
// answer; closing on unread data makes the kernel send a reset, and the client may lose the answer.
// Past it the connection is closed instead.
const DRAIN_LIMIT = 8 * 1024 * 1024;
export const SELF_TTL_MS = 60_000;
export const REJECTED_TTL_MS = 60_000;
// A token MailFlow turned away for its address's failed attempts is remembered for as long as
// MailFlow said to wait, within these bounds (its own window is 15 minutes).
const MIN_FAILED_ATTEMPTS_TTL_MS = 1000;
const MAX_FAILED_ATTEMPTS_TTL_MS = 15 * 60_000;
export const FAILURE_LIMIT = 30;
export const FAILURE_WINDOW_MS = 60_000;
const MAX_ENTRIES = 10_000;
const SHUTDOWN_GRACE_MS = 10_000;
const TOKEN_PATH = '[a path holding a token]';
const INVALID_TOKEN_HEADERS = { 'WWW-Authenticate': 'Bearer realm="mailflow-mcp", error="invalid_token"' };

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

class TtlCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  get(key, now = Date.now()) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expires <= now) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs = this.ttlMs, now = Date.now()) {
    this.map.delete(key);
    if (this.map.size >= MAX_ENTRIES) this.map.delete(this.map.keys().next().value);
    this.map.set(key, { value, expires: now + ttlMs });
  }

  delete(key) {
    this.map.delete(key);
  }

  sweep(now = Date.now()) {
    for (const [key, entry] of this.map) if (entry.expires <= now) this.map.delete(key);
  }
}

// Failed and unauthenticated requests per client address, in fixed one-minute windows. It holds
// back only requests without a well-formed token, or with one MailFlow refused (see handle).
export class FailureLimiter {
  constructor({ limit = FAILURE_LIMIT, windowMs = FAILURE_WINDOW_MS } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.map = new Map();
  }

  entry(ip, now) {
    const entry = this.map.get(ip);
    if (!entry || now - entry.start >= this.windowMs) return null;
    return entry;
  }

  // Seconds to wait, or 0 when the address may go on.
  blocked(ip, now = Date.now()) {
    const entry = this.entry(ip, now);
    if (!entry || entry.count < this.limit) return 0;
    return Math.max(1, Math.ceil((entry.start + this.windowMs - now) / 1000));
  }

  fail(ip, now = Date.now()) {
    const entry = this.entry(ip, now);
    if (entry) {
      entry.count += 1;
      return;
    }
    this.map.delete(ip);
    if (this.map.size >= MAX_ENTRIES) this.map.delete(this.map.keys().next().value);
    this.map.set(ip, { start: now, count: 1 });
  }

  sweep(now = Date.now()) {
    for (const [ip, entry] of this.map) if (now - entry.start >= this.windowMs) this.map.delete(ip);
  }
}

// `Bearer mfat_…`, or a bare `mfat_…`: claude.ai sends a custom header value exactly as typed.
export function tokenFromAuthorization(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const match = /^bearer[ \t]+(\S+)$/i.exec(text);
  const candidate = match ? match[1] : text;
  return isTokenFormat(candidate) ? candidate : null;
}

function normalizeIp(value) {
  let ip = String(value ?? '').trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  if (/^::ffff:/i.test(ip) && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  return ip;
}

// The caller's address: the socket peer, or with trusted proxies the entry the outermost trusted
// proxy appended to X-Forwarded-For. Anything that is not an IP address falls back to the peer.
export function clientAddress(req, trustProxyHops = 0) {
  const peer = normalizeIp(req.socket?.remoteAddress) || 'unknown';
  if (!trustProxyHops) return peer;
  const header = req.headers['x-forwarded-for'];
  const entries = (Array.isArray(header) ? header.join(',') : String(header ?? '')).split(',').map(part => part.trim()).filter(Boolean);
  const chain = [...entries, peer];
  const candidate = normalizeIp(chain[Math.max(0, chain.length - 1 - trustProxyHops)]);
  return net.isIP(candidate) ? candidate : peer;
}

// Each %XX escape is decoded on its own, so a malformed one elsewhere cannot hide an encoded token,
// and a few times over, so a doubly encoded one is found too.
export function containsToken(text) {
  let value = String(text ?? '');
  for (let round = 0; round < 3; round++) {
    if (/mfat_/i.test(value)) return true;
    const decoded = value.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    if (decoded === value) return false;
    value = decoded;
  }
  return /mfat_/i.test(value);
}

function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function rpcError(code, message) {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

function declaredLength(req) {
  const value = Number(req.headers['content-length']);
  return Number.isFinite(value) ? value : null;
}

// Ends the connection once the answer is out, for a body too large to read away.
function closeAfter(req, res) {
  res.once('finish', () => req.destroy());
  return { Connection: 'close' };
}

// A refusal before the body is read. The body, if any, is discarded as it arrives; one declared
// larger than DRAIN_LIMIT is not waited for.
function refuse(req, res, status, message, { code = -32000, headers = {} } = {}) {
  let extra = headers;
  if (!req.complete) {
    if ((declaredLength(req) ?? 0) > DRAIN_LIMIT) extra = { ...headers, ...closeAfter(req, res) };
    else req.resume();
  }
  sendJson(res, status, rpcError(code, message), extra);
}

// The body as text, or { tooLarge } past `limit`. Past the limit the rest is read and dropped
// (nothing more is kept), up to DRAIN_LIMIT, and `close` asks for the connection to be ended.
function readBody(req, limit) {
  if ((declaredLength(req) ?? 0) > DRAIN_LIMIT) return Promise.resolve({ tooLarge: true, close: true });
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const settle = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', chunk => {
      size += chunk.length;
      if (size > DRAIN_LIMIT) settle({ tooLarge: true, close: true });
      else if (size <= limit) chunks.push(chunk);
    });
    req.on('end', () => settle(size > limit ? { tooLarge: true } : { text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', err => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function loggablePath(pathname, tokenInUrl) {
  if (tokenInUrl || /mfat/i.test(pathname)) return TOKEN_PATH;
  const clean = pathname.replace(/[^\x21-\x7e]/g, '?');
  return clean.length > 120 ? `${clean.slice(0, 120)}…` : clean;
}

/**
 * The request handler for `mailflow-mcp http`. Each POST /mcp builds its own MailFlow client
 * from the caller's token, and its own MCP server and stateless transport.
 */
export function createHttpHandler({ config, fetch: fetchImpl = globalThis.fetch, log = () => {} }) {
  const { mailflowUrl, timeoutMs } = config;
  const { allowedHosts, allowedOrigins, trustProxyHops } = config.http;
  const accepted = new TtlCache(SELF_TTL_MS);
  // Hashes MailFlow refused, with the answer to give again: { status, message, until }.
  const rejected = new TtlCache(REJECTED_TTL_MS);
  const limiter = new FailureLimiter();
  const semaphores = new Map();
  const sweeper = setInterval(() => {
    const now = Date.now();
    accepted.sweep(now);
    rejected.sweep(now);
    limiter.sweep(now);
  }, 60_000);
  sweeper.unref();

  // One concurrency limit per token, shared by all of that token's requests in flight.
  function takeSemaphore(hash) {
    let entry = semaphores.get(hash);
    if (!entry) {
      entry = { semaphore: new Semaphore(MAX_CONCURRENT_REQUESTS), users: 0 };
      semaphores.set(hash, entry);
    }
    entry.users += 1;
    return entry;
  }

  function giveSemaphore(hash, entry) {
    entry.users -= 1;
    if (entry.users === 0 && semaphores.get(hash) === entry) semaphores.delete(hash);
  }

  async function health(res) {
    const probe = new MailflowClient({ baseUrl: mailflowUrl, timeoutMs: 5000, fetch: fetchImpl });
    try {
      await probe.checkHealth(5000);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 503, { ok: false, error: err.message });
    }
  }

  // A refusal remembered for a token hash, answered again without asking MailFlow.
  function remembered(refusal, now = Date.now()) {
    if (refusal.status === 429) {
      const wait = Math.max(1, Math.ceil((refusal.until - now) / 1000));
      return { status: 429, code: -32000, headers: { 'Retry-After': String(wait) } };
    }
    return { status: 401, code: -32001, headers: INVALID_TOKEN_HEADERS };
  }

  async function handle(req, res) {
    const started = Date.now();
    const target = req.url || '/';
    const queryAt = target.indexOf('?');
    const pathname = queryAt === -1 ? target : target.slice(0, queryAt);
    const query = queryAt === -1 ? '' : target.slice(queryAt + 1);
    // Decided once, so the refusal and the log line agree.
    const tokenInUrl = containsToken(query) || containsToken(pathname);
    let callerGone = false;
    const gone = new Promise(resolve => {
      res.once('close', () => {
        callerGone = true;
        // A caller that went away before the whole answer was sent got no answer at all.
        log(`${req.method} ${loggablePath(pathname, tokenInUrl)} ${res.writableFinished ? res.statusCode : 'aborted'} ${Date.now() - started}ms`);
        resolve();
      });
    });
    const ip = clientAddress(req, trustProxyHops);

    if (tokenInUrl) {
      limiter.fail(ip);
      return refuse(req, res, 400, 'Never put an API token in a URL; send it in the Authorization header. URLs end up in logs, so revoke this token in MailFlow and create a new one.');
    }
    if (pathname === '/healthz') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return refuse(req, res, 405, 'Use GET /healthz', { headers: { Allow: 'GET' } });
      return health(res);
    }
    if (pathname !== '/mcp') {
      limiter.fail(ip);
      return refuse(req, res, 404, 'Not found: the MCP endpoint is /mcp');
    }
    if (allowedHosts.length && !allowedHosts.includes(hostnameOf(req.headers.host))) {
      limiter.fail(ip);
      return refuse(req, res, 403, 'This Host is not allowed here (MCP_ALLOWED_HOSTS).');
    }
    if (req.headers.origin !== undefined) {
      let origin = null;
      try {
        origin = new URL(req.headers.origin).origin;
      } catch { /* not an origin at all */ }
      if (!origin || !allowedOrigins.includes(origin)) {
        limiter.fail(ip);
        return refuse(req, res, 403, 'This Origin is not allowed here (MCP_ALLOWED_ORIGINS).');
      }
    }
    if (req.method !== 'POST') {
      return refuse(req, res, 405, 'Method not allowed: this server is stateless and answers only POST /mcp.', { headers: { Allow: 'POST' } });
    }

    const token = tokenFromAuthorization(req.headers.authorization);
    const hash = token ? sha256(token) : null;
    const refusal = hash ? rejected.get(hash) : undefined;
    const fail = () => limiter.fail(ip);
    // What guessing and scanning look like is held back here: no well-formed token, or one
    // MailFlow already refused. A well-formed token MailFlow has not refused always goes on to
    // MailFlow, whose own limit on failed attempts never blocks a valid token, so junk sent from
    // an address many clients share (a NAT, a connector's egress) cannot lock their tokens out.
    if (!token || refusal) {
      const wait = limiter.blocked(ip);
      if (wait) return refuse(req, res, 429, `Too many failed requests from this address; retry after ${wait} seconds.`, { headers: { 'Retry-After': String(wait) } });
    }
    if (!token) {
      fail();
      const message = req.headers.authorization
        ? 'The Authorization header does not hold a MailFlow API token (expected Bearer mfat_…).'
        : 'This MCP server needs a MailFlow API token: send Authorization: Bearer mfat_…';
      return refuse(req, res, 401, message, { headers: { 'WWW-Authenticate': 'Bearer realm="mailflow-mcp"' } });
    }
    if (refusal) {
      fail();
      const { status, code, headers } = remembered(refusal);
      return refuse(req, res, status, refusal.message, { code, headers });
    }
    if (!/^application\/json(\s*;|\s*$)/i.test(String(req.headers['content-type'] || '').trim())) {
      fail();
      return refuse(req, res, 415, 'Content-Type must be application/json.');
    }

    let body;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch {
      return; // the caller went away
    }
    if (body.tooLarge) {
      fail();
      const headers = body.close ? closeAfter(req, res) : {};
      return sendJson(res, 413, rpcError(-32000, `The request body is larger than ${MAX_BODY_BYTES / 1048576} MB.`), headers);
    }
    let message;
    try {
      message = JSON.parse(body.text);
    } catch {
      fail();
      return sendJson(res, 400, rpcError(-32700, 'Parse error: the body is not valid JSON.'));
    }

    const slot = takeSemaphore(hash);
    const calls = new InFlight();
    let server = null;
    let transport = null;
    try {
      const client = new MailflowClient({ baseUrl: mailflowUrl, token, timeoutMs, clientIp: ip, semaphore: slot.semaphore, fetch: fetchImpl });
      let self = accepted.get(hash);
      if (!self) {
        try {
          self = await client.getSelf();
        } catch (err) {
          if (err instanceof MailflowError && err.status === 401) {
            rejected.set(hash, { status: 401, message: err.message });
            fail();
            return sendJson(res, 401, rpcError(-32001, err.message), INVALID_TOKEN_HEADERS);
          }
          if (err instanceof MailflowError && err.status === 429) {
            const headers = err.retryAfter !== null ? { 'Retry-After': String(err.retryAfter) } : {};
            // MailFlow says this only of credentials it does not know, so the token is not sent
            // again before MailFlow would look at it. Its other 429s are a valid token's own limits.
            if (err.mailflowMessage === FAILED_ATTEMPTS_ERROR) {
              const ttl = Math.min(MAX_FAILED_ATTEMPTS_TTL_MS, Math.max(MIN_FAILED_ATTEMPTS_TTL_MS, (err.retryAfter ?? 60) * 1000));
              rejected.set(hash, { status: 429, message: err.message, until: Date.now() + ttl }, ttl);
              fail();
            }
            return sendJson(res, 429, rpcError(-32000, err.message), headers);
          }
          return sendJson(res, 502, rpcError(-32000, `Could not check the token with MailFlow: ${err.message}`));
        }
        accepted.set(hash, self);
      }
      const scopes = normalizeScopes(self.scopes);
      if (!scopes.includes('read')) return sendJson(res, 403, rpcError(-32003, NEEDS_READ_SCOPE));
      if (callerGone) return;

      server = createMailflowServer({ client, scopes, calls });
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      const handling = transport.handleRequest(req, res, message);
      // Once the caller has gone, an error here has no one to be told to.
      handling.catch(() => {});
      // A caller that goes away ends the request here, and closing the server below stops its calls.
      await Promise.race([handling, gone]);
    } finally {
      transport?.close().catch(() => {});
      server?.close().catch(() => {});
      // The token's concurrency limit is shared with its other requests until these calls end.
      calls.idle().then(() => giveSemaphore(hash, slot));
    }
  }

  return { handle, close: () => clearInterval(sweeper), limiter };
}

export async function startHttp({ env = process.env, fetch: fetchImpl = globalThis.fetch, log = message => process.stderr.write(`[mailflow-mcp] ${message}\n`) } = {}) {
  const config = loadConfig('http', env);
  for (const warning of config.warnings) log(`warning: ${warning}`);
  const handler = createHttpHandler({ config, fetch: fetchImpl, log });
  const server = http.createServer((req, res) => {
    handler.handle(req, res).catch(err => {
      log(`request failed: ${err?.name || 'Error'}: ${err?.message || err}`);
      if (!res.headersSent) sendJson(res, 500, rpcError(-32603, 'Internal error'));
      else res.destroy();
    });
  });
  // Slow clients get a bounded time to send a request; answering one may take longer.
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.http.port, config.http.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.http.port;
  const host = config.http.host.includes(':') ? `[${config.http.host}]` : config.http.host;
  const url = `http://${host}:${port}`;
  log(`listening on ${url}/mcp for MailFlow at ${config.origin}`);
  new MailflowClient({ baseUrl: config.mailflowUrl, timeoutMs: 10_000, fetch: fetchImpl }).getVersion()
    .then(version => log(`MailFlow ${version.version} answers at ${config.origin}`))
    .catch(err => log(`warning: MailFlow did not answer the version check yet: ${err.message}`));

  let closing = null;
  const close = () => {
    if (closing) return closing;
    handler.close();
    closing = new Promise(resolve => {
      server.close(() => resolve());
      server.closeIdleConnections?.();
      setTimeout(() => {
        server.closeAllConnections?.();
        resolve();
      }, SHUTDOWN_GRACE_MS).unref();
    });
    return closing;
  };
  return { server, url, port, close };
}
