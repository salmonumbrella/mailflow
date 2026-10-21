import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startFakeMailflow, TOKENS, UNKNOWN_TOKEN, IDS } from '../test-support/fakeMailflow.js';
import { startHttp, createHttpHandler, clientAddress, tokenFromAuthorization, containsToken, FailureLimiter, FAILURE_LIMIT } from '../src/http.js';
import { loadConfig } from '../src/config.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const ACCEPT = 'application/json, text/event-stream';
const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'http-test', version: '1.0.0' } },
};
const LIST_TOOLS = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
const callTool = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

let fake;
const servers = [];
const logs = [];

async function start(extra = {}) {
  const handle = await startHttp({
    env: { MAILFLOW_URL: fake.url, MCP_HTTP_PORT: '0', ...extra },
    log: line => logs.push(line),
  });
  servers.push(handle);
  return handle;
}

function request(base, { method = 'POST', path = '/mcp', headers = {}, body, raw, holdOpen = false } = {}) {
  const target = new URL(base);
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.request({ host: target.hostname, port: target.port, method, path, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        settled = true;
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
        if (holdOpen) req.destroy();
      });
    });
    req.on('error', err => { if (!settled) reject(err); });
    if (raw !== undefined) req.write(raw);
    else if (body !== undefined) req.write(JSON.stringify(body));
    // Node's client holds the headers back until the first write or end().
    if (holdOpen) req.flushHeaders();
    else req.end();
  });
}

function mcp(base, token, body, headers = {}) {
  return request(base, {
    headers: {
      'Content-Type': 'application/json',
      Accept: ACCEPT,
      'MCP-Protocol-Version': '2025-06-18',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body,
  });
}

// The server's own startup probe of /api/version carries no token; this counts what a caller caused.
function assertNothingReachedMailflow() {
  assert.deepEqual(fake.apiRequests().map(entry => entry.path), []);
  assert.ok(fake.requests.every(entry => entry.headers.authorization === undefined), 'no token was sent anywhere');
}

test.before(async () => { fake = await startFakeMailflow(); });
test.after(async () => {
  for (const server of servers) await server.close();
  await fake.close();
});
test.beforeEach(() => { fake.reset(); });

test('initialize and tools/list with a valid token answer JSON', async () => {
  const { url } = await start();
  const init = await mcp(url, TOKENS.read, INITIALIZE);
  assert.equal(init.status, 200);
  assert.match(init.headers['content-type'], /application\/json/);
  assert.equal(init.json.result.serverInfo.name, 'mailflow-mcp');
  assert.match(init.json.result.instructions, /untrusted third-party data/);
  assert.equal(init.headers['mcp-session-id'], undefined, 'stateless');
  const list = await mcp(url, TOKENS.read, LIST_TOOLS);
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.result.tools.map(tool => tool.name), ['list_accounts', 'list_folders', 'list_messages', 'search_mail', 'read_message', 'read_thread', 'unread_counts', 'find_contacts']);
  const self = fake.requests.filter(entry => entry.path === '/api/api-tokens/self');
  assert.equal(self.length, 1, '/self is cached for the token');
  assert.equal(self[0].headers.authorization, `Bearer ${TOKENS.read}`);
});

test('the SDK client works end to end over HTTP', async () => {
  const { url } = await start();
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKENS.all}` } } });
  const client = new Client({ name: 'sdk-http-test', version: '1.0.0' });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 16);
  const result = await client.callTool({ name: 'list_accounts', arguments: {} });
  assert.match(result.content[0].text, /Work <pat@work.example.com>/);
  await client.close();
});

test('a missing or malformed token gets 401 without any call to MailFlow', async () => {
  const { url } = await start();
  const cases = [
    {},
    { Authorization: 'Bearer' },
    { Authorization: 'Bearer abc' },
    { Authorization: 'Bearer mfat_short' },
    { Authorization: `Bearer ${TOKENS.read}x` },
    { Authorization: `Basic ${Buffer.from('pat:secret').toString('base64')}` },
    { Authorization: `Token ${TOKENS.read}` },
  ];
  for (const headers of cases) {
    const response = await mcp(url, null, INITIALIZE, headers);
    assert.equal(response.status, 401, JSON.stringify(headers));
    assert.match(response.headers['www-authenticate'], /^Bearer/);
    assert.equal(response.json.error.code, -32000);
  }
  assertNothingReachedMailflow();
});

test('a bare mfat_ value is accepted and forwarded as Bearer', async () => {
  const { url } = await start();
  const response = await mcp(url, null, INITIALIZE, { Authorization: TOKENS.read });
  assert.equal(response.status, 200);
  assert.equal(fake.requests.find(entry => entry.path === '/api/api-tokens/self').headers.authorization, `Bearer ${TOKENS.read}`);
});

test('a token MailFlow rejects gets 401, and is not sent again for a while', async () => {
  const { url } = await start();
  const first = await mcp(url, UNKNOWN_TOKEN, INITIALIZE);
  assert.equal(first.status, 401);
  assert.match(first.json.error.message, /invalid, expired or revoked/);
  assert.match(first.headers['www-authenticate'], /error="invalid_token"/);
  const second = await mcp(url, UNKNOWN_TOKEN, INITIALIZE);
  assert.equal(second.status, 401);
  assert.equal(fake.requests.filter(entry => entry.path === '/api/api-tokens/self').length, 1);
});

test('a token without the read scope is refused with a JSON-RPC error', async () => {
  const { url } = await start();
  const response = await mcp(url, TOKENS.draftOnly, INITIALIZE);
  assert.equal(response.status, 403);
  assert.equal(response.json.jsonrpc, '2.0');
  assert.match(response.json.error.message, /needs the read scope/);
});

test('Host and Origin are checked on /mcp; /healthz answers loopback callers regardless', async () => {
  const { url } = await start({ MCP_ALLOWED_HOSTS: 'mcp.example.com', MCP_ALLOWED_ORIGINS: 'https://claude.ai' });
  const health = await request(url, { method: 'GET', path: '/healthz', headers: { Host: '127.0.0.1' } });
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { ok: true });
  const wrongHost = await mcp(url, TOKENS.read, INITIALIZE, { Host: '127.0.0.1' });
  assert.equal(wrongHost.status, 403);
  assert.match(wrongHost.json.error.message, /MCP_ALLOWED_HOSTS/);
  const rightHost = await mcp(url, TOKENS.read, INITIALIZE, { Host: 'MCP.Example.com:443' });
  assert.equal(rightHost.status, 200, 'host names compare without case or port');
  const badOrigin = await mcp(url, TOKENS.read, INITIALIZE, { Host: 'mcp.example.com', Origin: 'https://evil.example.com' });
  assert.equal(badOrigin.status, 403);
  const nullOrigin = await mcp(url, TOKENS.read, INITIALIZE, { Host: 'mcp.example.com', Origin: 'null' });
  assert.equal(nullOrigin.status, 403);
  const goodOrigin = await mcp(url, TOKENS.read, INITIALIZE, { Host: 'mcp.example.com', Origin: 'https://claude.ai' });
  assert.equal(goodOrigin.status, 200);
  assert.equal(fake.requests.filter(entry => entry.path === '/api/api-tokens/self').length, 1, 'refused requests never reached MailFlow');
});

test('without MCP_ALLOWED_ORIGINS any request that sends an Origin is refused', async () => {
  const { url } = await start();
  assert.equal((await mcp(url, TOKENS.read, INITIALIZE, { Origin: 'https://claude.ai' })).status, 403);
  assert.equal((await mcp(url, TOKENS.read, INITIALIZE)).status, 200);
});

test('GET and DELETE /mcp are 405; other paths 404', async () => {
  const { url } = await start();
  for (const method of ['GET', 'DELETE', 'PUT']) {
    const response = await request(url, { method, headers: { Authorization: `Bearer ${TOKENS.read}` } });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.allow, 'POST');
  }
  assert.equal((await request(url, { method: 'GET', path: '/' })).status, 404);
  assert.equal((await request(url, { method: 'POST', path: '/mcp/', headers: { Authorization: `Bearer ${TOKENS.read}` } })).status, 404);
});

test('oversized bodies get 413 and never reach MailFlow', async () => {
  const { url } = await start();
  const headers = { Authorization: `Bearer ${TOKENS.read}`, 'Content-Type': 'application/json', Accept: ACCEPT };
  const declared = await request(url, { headers: { ...headers, 'Content-Length': String(2 * 1024 * 1024) }, raw: Buffer.alloc(2 * 1024 * 1024, 32) });
  assert.equal(declared.status, 413);
  assert.match(declared.json.error.message, /larger than 1 MB/);
  const streamed = await request(url, { headers: { ...headers, 'Transfer-Encoding': 'chunked' }, raw: Buffer.alloc(1200 * 1024, 32) });
  assert.equal(streamed.status, 413);
  // A body declared far larger is not waited for: the answer comes at once and the connection closes.
  const huge = await request(url, { headers: { ...headers, 'Content-Length': String(50 * 1024 * 1024) }, holdOpen: true });
  assert.equal(huge.status, 413);
  assert.equal(huge.headers.connection, 'close');
  assertNothingReachedMailflow();
});

test('a body that is not JSON is a JSON-RPC parse error; a wrong content type is 415', async () => {
  const { url } = await start();
  const parse = await request(url, { headers: { Authorization: `Bearer ${TOKENS.read}`, 'Content-Type': 'application/json', Accept: ACCEPT }, raw: '{"jsonrpc":' });
  assert.equal(parse.status, 400);
  assert.equal(parse.json.error.code, -32700);
  const type = await request(url, { headers: { Authorization: `Bearer ${TOKENS.read}`, 'Content-Type': 'text/plain', Accept: ACCEPT }, raw: '{}' });
  assert.equal(type.status, 415);
  assertNothingReachedMailflow();
});

test('a token in the URL is refused, and the query never reaches the log', async () => {
  const { url } = await start();
  logs.length = 0;
  const secret = TOKENS.read.slice(5);
  const paths = [
    `/mcp?token=${TOKENS.read}`, `/healthz?x=${encodeURIComponent(TOKENS.read)}`, '/mcp?t=mfat%5Fabc',
    `/mcp/${TOKENS.read}`, `/%6Dfat_${secret}`, `/%6dfat_${secret}`, `/mcp/mf%61t_${secret}`,
    `/mcp/%6D%66%61%74%5F${secret}`, `/%6Dfat_${secret}%ZZ`, `/%256Dfat_${secret}`,
  ];
  for (const path of paths) {
    const response = await request(url, { path, headers: { Authorization: `Bearer ${TOKENS.read}`, 'Content-Type': 'application/json', Accept: ACCEPT }, body: INITIALIZE });
    assert.equal(response.status, 400, path);
    assert.match(response.json.error.message, /Never put an API token in a URL/);
  }
  assertNothingReachedMailflow();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(logs.length >= paths.length);
  for (const line of logs) assert.ok(!/mfat|token=|\?/.test(line) && !line.includes(secret), line);
});

test('containsToken decodes each escape on its own, and twice-encoded ones too', () => {
  for (const value of ['mfat_x', 'MFAT_x', '%6Dfat_x', 'mf%61t_x', 'mfat%5Fx', '%6Dfat_x%ZZ', '%ZZ%6Dfat_x', '%256Dfat_x', 'a/b?c=%6d%66%61%74%5f']) {
    assert.equal(containsToken(value), true, value);
  }
  for (const value of ['', '/mcp', 'mfa_t', '%6Dfa', '%ZZ', 'm%fat_']) assert.equal(containsToken(value), false, value);
});

test('a caller that goes away mid-call is logged as such, its call stops sending, and the request ends', async () => {
  const lines = [];
  const handler = createHttpHandler({ config: loadConfig('http', { MAILFLOW_URL: fake.url }), log: line => lines.push(line) });
  const outcomes = [];
  const server = http.createServer((req, res) => {
    outcomes.push(handler.handle(req, res).then(() => 'settled', () => 'failed'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    fake.override('GET', /^\/api\/accounts\/[^/]+\/folders$/, async () => {
      await sleep(300);
      return false;
    });
    const caller = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method: 'POST',
      path: '/mcp',
      headers: { 'Content-Type': 'application/json', Accept: ACCEPT, Authorization: `Bearer ${TOKENS.all}` },
    });
    caller.on('error', () => {});
    const inbox = () => fake.users.pat.messages.filter(row => row.folder === 'INBOX').length;
    const before = inbox();
    caller.end(JSON.stringify(callTool(1, 'archive', { ids: [IDS.m1, IDS.h1] })));
    await sleep(100);
    caller.destroy();
    assert.equal(await Promise.race([outcomes[0], sleep(2000).then(() => 'still running')]), 'settled');
    // Long enough for the lookups the archive was waiting on to have come back.
    await sleep(500);
    assert.equal(fake.apiRequests().filter(entry => entry.path === '/api/mail/messages/bulk-archive').length, 0, 'no archive after the caller left');
    assert.equal(inbox(), before);
    assert.deepEqual(lines.filter(line => line.startsWith('POST ')).map(line => line.replace(/\d+ms$/, 'Nms')), ['POST /mcp aborted Nms']);
  } finally {
    handler.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('one log line per request: method, path, status and time, never a token', async () => {
  const { url } = await start();
  logs.length = 0;
  await mcp(url, TOKENS.read, INITIALIZE);
  await mcp(url, null, INITIALIZE);
  await new Promise(resolve => setTimeout(resolve, 20));
  const lines = logs.filter(line => /^(POST|GET) /.test(line));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^POST \/mcp 200 \d+ms$/);
  assert.match(lines[1], /^POST \/mcp 401 \d+ms$/);
  for (const line of logs) assert.ok(!line.includes('mfat_'), line);
});

test('/healthz is 503 when MailFlow is down', async () => {
  const { url } = await start();
  fake.override('GET', '/api/health', (req, res) => {
    res.writeHead(502, { 'content-type': 'text/html' });
    res.end('<html>Bad gateway</html>');
  });
  const response = await request(url, { method: 'GET', path: '/healthz' });
  assert.equal(response.status, 503);
  assert.equal(response.json.ok, false);
  const down = await startHttp({ env: { MAILFLOW_URL: 'http://127.0.0.1:9', MCP_HTTP_PORT: '0' }, log: () => {} });
  servers.push(down);
  assert.equal((await request(down.url, { method: 'GET', path: '/healthz' })).status, 503);
});

test('the failure limit holds back an address that keeps failing, but never a well-formed token MailFlow has not refused', async () => {
  const { url } = await start();
  assert.equal((await mcp(url, TOKENS.read, INITIALIZE)).status, 200);
  for (let i = 0; i < FAILURE_LIMIT; i++) assert.equal((await mcp(url, null, INITIALIZE)).status, 401);
  const blocked = await mcp(url, null, INITIALIZE);
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers['retry-after']) >= 1);
  // Someone else's junk from a shared address must not lock out a valid token this server has
  // not seen before: MailFlow decides, and its own failure limit never blocks a valid token.
  const neverSeen = await mcp(url, TOKENS.organize, INITIALIZE);
  assert.equal(neverSeen.status, 200, 'a valid token not seen before goes through');
  assert.equal((await mcp(url, TOKENS.read, LIST_TOOLS)).status, 200, 'an accepted token goes through');
  // A junk token goes to MailFlow once; sent again, it is held back with the rest.
  assert.equal((await mcp(url, UNKNOWN_TOKEN, INITIALIZE)).status, 401);
  assert.equal((await mcp(url, UNKNOWN_TOKEN, INITIALIZE)).status, 429);
  assert.equal(fake.requests.filter(entry => entry.path === '/api/api-tokens/self' && entry.headers.authorization === `Bearer ${UNKNOWN_TOKEN}`).length, 1);
});

test('a token MailFlow turns away for failed attempts is not sent again until MailFlow would look at it', async () => {
  let unknown = 0;
  fake.override('GET', '/api/api-tokens/self', (req, res) => {
    if (Object.values(TOKENS).some(token => req.headers.authorization === `Bearer ${token}`)) return false;
    // As MailFlow's middleware: 20 unknown tokens per address, then 429 with Retry-After.
    unknown += 1;
    if (unknown > 20) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '900' });
      return res.end(JSON.stringify({ error: 'Too many failed API token attempts. Try again later.' }));
    }
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid or expired API token' }));
  });
  const { url } = await start();
  const junk = Array.from({ length: 25 }, (_, i) => `mfat_${String(i).padStart(43, 'j')}`);
  const statuses = [];
  for (const token of junk) statuses.push((await mcp(url, token, INITIALIZE)).status);
  assert.deepEqual(statuses, [...Array(20).fill(401), ...Array(5).fill(429)]);
  const lookups = () => fake.requests.filter(entry => entry.path === '/api/api-tokens/self').length;
  const before = lookups();
  const again = await mcp(url, junk[24], INITIALIZE);
  assert.equal(again.status, 429);
  assert.ok(Number(again.headers['retry-after']) > 800, again.headers['retry-after']);
  assert.equal(lookups(), before, 'the turned-away token was not sent again');
  // All 26 of those failures counted towards this server's limit of 30 a minute.
  for (let i = 0; i < 4; i++) assert.equal((await mcp(url, null, INITIALIZE)).status, 401);
  assert.equal((await mcp(url, null, INITIALIZE)).status, 429, 'the address is held back now');
  assert.equal((await mcp(url, TOKENS.read, INITIALIZE)).status, 200, 'and a valid token still is not');
});

test('the failure limiter counts per address in fixed windows', () => {
  const limiter = new FailureLimiter({ limit: 2, windowMs: 1000 });
  limiter.fail('a', 0);
  limiter.fail('a', 10);
  assert.equal(limiter.blocked('a', 20), 1);
  assert.equal(limiter.blocked('b', 20), 0);
  assert.equal(limiter.blocked('a', 1000), 0, 'a new window');
});

test('two users\' tokens interleaved on one server never see each other\'s mail', async () => {
  const { url } = await start();
  const calls = [];
  for (let i = 0; i < 8; i++) {
    calls.push(mcp(url, TOKENS.all, callTool(i, 'list_accounts')).then(response => ({ who: 'pat', response })));
    calls.push(mcp(url, TOKENS.sam, callTool(100 + i, 'list_accounts')).then(response => ({ who: 'sam', response })));
  }
  calls.push(mcp(url, TOKENS.read, LIST_TOOLS).then(response => ({ who: 'read', response })));
  calls.push(mcp(url, TOKENS.sam, LIST_TOOLS).then(response => ({ who: 'samTools', response })));
  for (const { who, response } of await Promise.all(calls)) {
    assert.equal(response.status, 200, who);
    if (who === 'read') assert.equal(response.json.result.tools.length, 8);
    else if (who === 'samTools') assert.equal(response.json.result.tools.length, 16);
    else {
      const text = response.json.result.content[0].text;
      if (who === 'pat') {
        assert.match(text, /pat@work.example.com/);
        assert.ok(!text.includes('sam@example.org'));
      } else {
        assert.match(text, /sam@example.org/);
        assert.ok(!text.includes('pat@'));
      }
    }
  }
  for (const entry of fake.requests.filter(item => item.path === '/api/accounts')) {
    assert.ok([TOKENS.all, TOKENS.sam].map(token => `Bearer ${token}`).includes(entry.headers.authorization));
  }
});

test('MailFlow sees the caller\'s address as the one X-Forwarded-For entry', async () => {
  const direct = await start();
  await mcp(direct.url, TOKENS.read, INITIALIZE, { 'X-Forwarded-For': '198.51.100.7' });
  assert.equal(fake.requests.at(-1).headers['x-forwarded-for'], '127.0.0.1', 'with no trusted proxy the peer is the caller');
  fake.reset();
  const proxied = await start({ MCP_TRUST_PROXY_HOPS: '1' });
  await mcp(proxied.url, TOKENS.read, INITIALIZE, { 'X-Forwarded-For': '198.51.100.7, 203.0.113.5' });
  assert.equal(fake.requests.at(-1).headers['x-forwarded-for'], '203.0.113.5');
});

test('client addresses: trusted hops, IPv4-mapped peers and junk', () => {
  const req = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } });
  assert.equal(clientAddress(req('::ffff:10.0.0.2'), 0), '10.0.0.2');
  assert.equal(clientAddress(req('10.0.0.2', '1.1.1.1, 2.2.2.2'), 1), '2.2.2.2');
  assert.equal(clientAddress(req('10.0.0.2', '1.1.1.1, 2.2.2.2'), 2), '1.1.1.1');
  assert.equal(clientAddress(req('10.0.0.2', '2.2.2.2'), 3), '2.2.2.2', 'fewer entries than hops: the leftmost');
  assert.equal(clientAddress(req('10.0.0.2', 'not-an-ip'), 1), '10.0.0.2');
  assert.equal(clientAddress(req('10.0.0.2', '2.2.2.2:443'), 1), '10.0.0.2');
  assert.equal(clientAddress(req('10.0.0.2', '[2001:db8::1]'), 1), '2001:db8::1');
});

test('tokenFromAuthorization accepts Bearer in any case, or a bare token', () => {
  assert.equal(tokenFromAuthorization(`bearer ${TOKENS.read}`), TOKENS.read);
  assert.equal(tokenFromAuthorization(`  ${TOKENS.read}  `), TOKENS.read);
  assert.equal(tokenFromAuthorization(`Bearer  ${TOKENS.read}`), TOKENS.read);
  assert.equal(tokenFromAuthorization(`Bearer ${TOKENS.read} extra`), null);
  assert.equal(tokenFromAuthorization(undefined), null);
});

test('http mode will not start with MAILFLOW_TOKEN set', async () => {
  await assert.rejects(startHttp({ env: { MAILFLOW_URL: fake.url, MCP_HTTP_PORT: '0', MAILFLOW_TOKEN: TOKENS.read }, log: () => {} }), /must not be set in http mode/);
});
