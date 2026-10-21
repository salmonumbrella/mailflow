import test from 'node:test';
import assert from 'node:assert/strict';
import { MailflowClient, MailflowError, mapErrorResponse, retryAfterSeconds, MAY_HAVE_COMPLETED } from '../src/mailflowClient.js';
import { VERSION } from '../src/version.js';

const TOKEN = `mfat_${'T'.repeat(39)}abcd`;
const BASE = 'https://mail.example.com';

function respond(status, body, headers = {}) {
  const isText = typeof body === 'string';
  return new Response(isText ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': isText ? 'text/html' : 'application/json', ...headers },
  });
}

function stub(handler) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: new URL(url), init });
    return handler(new URL(url), init, calls.length);
  };
  return { fetch, calls };
}

function client(fetch, options = {}) {
  return new MailflowClient({ baseUrl: BASE, token: TOKEN, timeoutMs: 1000, fetch, ...options });
}

async function failure(promise) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof MailflowError, `expected a MailflowError, got ${err}`);
    assert.ok(!err.message.includes(TOKEN) && !err.message.includes(TOKEN.slice(5)), 'the token never appears in an error');
    return err;
  }
  assert.fail('expected the request to fail');
}

test('every request carries the bearer token, JSON accept and the user agent, and never a cookie', async () => {
  const { fetch, calls } = stub(() => respond(200, []));
  await client(fetch).listAccounts();
  const { url, init } = calls[0];
  assert.equal(url.href, `${BASE}/api/accounts`);
  assert.equal(init.method, 'GET');
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(init.headers.Accept, 'application/json');
  assert.equal(init.headers['User-Agent'], `mailflow-mcp/${VERSION}`);
  assert.equal(init.redirect, 'manual');
  assert.equal(init.body, undefined);
  for (const name of Object.keys(init.headers)) assert.notEqual(name.toLowerCase(), 'cookie');
  assert.equal(init.headers['X-Requested-With'], undefined);
  assert.equal(init.headers['X-Forwarded-For'], undefined);
});

test('writes send JSON with X-Requested-With', async () => {
  const { fetch, calls } = stub(() => respond(200, { ok: true, updated: [] }));
  await client(fetch).bulkRead(['b0000000-0000-4000-8000-000000000001'], true);
  const { url, init } = calls[0];
  assert.equal(url.pathname, '/api/mail/messages/bulk-read');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.headers['X-Requested-With'], 'mailflow-mcp');
  assert.deepEqual(JSON.parse(init.body), { ids: ['b0000000-0000-4000-8000-000000000001'], read: true });
});

test('the caller address goes out as the one X-Forwarded-For value', async () => {
  const { fetch, calls } = stub(() => respond(200, []));
  await client(fetch, { clientIp: '203.0.113.9' }).listAccounts();
  assert.equal(calls[0].init.headers['X-Forwarded-For'], '203.0.113.9');
});

test("MailFlow's public probes go without the token", async () => {
  const { fetch, calls } = stub(url => respond(200, url.pathname === '/api/version' ? { version: '3.9.0', sha: 'dev' } : { status: 'ok' }));
  const mailflow = new MailflowClient({ baseUrl: BASE, fetch });
  assert.equal((await mailflow.getVersion()).version, '3.9.0');
  await mailflow.checkHealth();
  for (const call of calls) assert.equal(call.init.headers.Authorization, undefined);
});

test('query parameters are sent once each, and empty ones are left out', async () => {
  const { fetch, calls } = stub(() => respond(200, { messages: [], total: 0 }));
  await client(fetch).listMessages({ accountId: undefined, folder: 'INBOX', unreadOnly: false, category: undefined, limit: 25, offset: 0 });
  assert.equal(calls[0].url.search, '?folder=INBOX&limit=25&offset=0&threaded=false');
});

test('401s say which of the three causes it was', async () => {
  const cases = [
    [respond(401, { error: 'Invalid or expired API token' }), /rejected the API token: it is invalid, expired or revoked \(MailFlow: "Invalid or expired API token"\)/, 'invalid_token'],
    [respond(401, { error: 'API tokens are turned off on this server' }), /turned off on this server/, 'tokens_off'],
    [respond(401, { error: 'Not authenticated' }), /did not reach MailFlow \(check that your proxy forwards the Authorization header\) \(MailFlow: "Not authenticated"\)/, 'token_not_received'],
    [respond(401, '<html>Unauthorized</html>'), /did not reach MailFlow.*not JSON/, 'token_not_received'],
  ];
  for (const [response, pattern, code] of cases) {
    const { fetch } = stub(() => response);
    const err = await failure(client(fetch).listAccounts());
    assert.match(err.message, pattern);
    assert.equal(err.code, code);
    assert.equal(err.status, 401);
  }
});

test('403, 400, 409 and 422 pass MailFlow\'s own text through', async () => {
  for (const [status, text, pattern] of [
    [403, 'This API token does not have the organize scope', /^MailFlow refused this request: This API token does not have the organize scope$/],
    [400, 'Invalid reply header', /^MailFlow: Invalid reply header$/],
    [409, 'This reply draft changed on the mail server. Try again.', /^MailFlow: This reply draft changed/],
    [422, 'No Drafts folder found for this account', /^MailFlow: No Drafts folder found/],
  ]) {
    const { fetch } = stub(() => respond(status, { error: text }));
    const err = await failure(client(fetch).listAccounts());
    assert.match(err.message, pattern);
  }
});

test('a 404 explains that ids change only for message lookups', async () => {
  const { fetch } = stub(() => respond(404, { error: 'Message not found' }));
  const lookup = await failure(client(fetch).getMessage('b0000000-0000-4000-8000-000000000001'));
  assert.match(lookup.message, /message ids change when mail is moved or archived/);
  assert.match(lookup.message, /MailFlow: "Message not found"/);
  const { fetch: other } = stub(() => respond(404, { error: 'Account not found' }));
  const plain = await failure(client(other).listFolders('11111111-1111-4111-8111-111111111111'));
  assert.doesNotMatch(plain.message, /ids change/);
  assert.match(plain.message, /Account not found/);
});

test('"Message is not snoozed" says so, without the ids-change hint: the message was found', async () => {
  const { fetch } = stub(() => respond(404, { error: 'Message is not snoozed' }));
  for (const call of [c => c.unsnooze('b0000000-0000-4000-8000-000000000001'), c => c.rescheduleSnooze('b0000000-0000-4000-8000-000000000001', '2030-01-01T00:00:00Z')]) {
    const err = await failure(call(client(fetch)));
    assert.equal(err.code, 'not_snoozed');
    assert.equal(err.message, 'MailFlow says this message is not snoozed (MailFlow: "Message is not snoozed"). list_messages with folder "Snoozed" shows what is.');
  }
  const { fetch: missing } = stub(() => respond(404, { error: 'Message not found' }));
  assert.match((await failure(client(missing).unsnooze('b0000000-0000-4000-8000-000000000001'))).message, /message ids change when mail is moved or archived/);
});

test('a cancelled call sends nothing more: a write is never sent after the cancel', async () => {
  const { fetch, calls } = stub(() => respond(200, { ok: true, archived: [] }));
  const cancelled = new AbortController();
  cancelled.abort('user pressed Esc');
  const err = await failure(client(fetch).forCall(cancelled.signal).bulkArchive(['b0000000-0000-4000-8000-000000000001']));
  assert.equal(err.code, 'cancelled');
  assert.equal(calls.length, 0);
  // The client itself, and calls not cancelled, are untouched.
  await client(fetch).forCall(new AbortController().signal).bulkArchive(['b0000000-0000-4000-8000-000000000001']);
  assert.equal(calls.length, 1);
});

test('a write cancelled as soon as it is made is not sent', async () => {
  const { fetch, calls } = stub(() => respond(200, { ok: true }));
  const controller = new AbortController();
  const write = client(fetch).forCall(controller.signal).saveDraft({});
  controller.abort('user pressed Esc');
  assert.equal((await failure(write)).code, 'cancelled');
  assert.equal(calls.length, 0);
});

test('what a cancelled call has waiting for a turn is dropped at once, while the turns stay busy', async () => {
  let finish;
  const busy = new Promise(resolve => { finish = resolve; });
  const fetch = async () => {
    await busy;
    return respond(200, { ok: true, updated: [] });
  };
  const mailflow = client(fetch, { timeoutMs: 5000 });
  // Four writes of another call hold every turn; writes are not stopped by a cancel.
  const others = Array.from({ length: 4 }, () => mailflow.bulkRead(['b0000000-0000-4000-8000-000000000001'], true));
  const controller = new AbortController();
  const waiting = mailflow.forCall(controller.signal).listAccounts();
  controller.abort('user pressed Esc');
  const outcome = await Promise.race([waiting.then(() => 'answered', err => err.code), new Promise(resolve => setTimeout(() => resolve('still waiting'), 200))]);
  assert.equal(outcome, 'cancelled');
  finish();
  await Promise.all(others);
});

test('cancelling a call stops its reads, drops what waits for a turn, and lets a write already sent finish', async () => {
  const started = [];
  const fetch = (url, init) => new Promise((resolve, reject) => {
    started.push({ path: new URL(url).pathname, init });
    const timer = setTimeout(() => resolve(respond(200, init.method === 'GET' ? [] : { ok: true, archived: ['b0000000-0000-4000-8000-000000000001'] })), 200);
    init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason); });
  });
  const mailflow = client(fetch, { timeoutMs: 5000 });
  const controller = new AbortController();
  const call = mailflow.forCall(controller.signal);
  const write = call.bulkArchive(['b0000000-0000-4000-8000-000000000001']);
  const reads = Array.from({ length: 3 }, () => call.listAccounts());
  // Four in flight (the write and three reads); this write has to wait for a turn.
  const queued = call.bulkMove(['b0000000-0000-4000-8000-000000000002'], 'Archive');
  await new Promise(resolve => setTimeout(resolve, 50));
  controller.abort('user pressed Esc');
  for (const read of reads) assert.equal((await failure(read)).code, 'cancelled');
  assert.equal((await failure(queued)).code, 'cancelled');
  assert.deepEqual(await write, { ok: true, archived: ['b0000000-0000-4000-8000-000000000001'] }, 'the write already sent was not stopped');
  assert.deepEqual(started.map(entry => entry.path), ['/api/mail/messages/bulk-archive', '/api/accounts', '/api/accounts', '/api/accounts']);
  assert.ok(mailflow.semaphore.idle, 'every turn was given back');
});

test('a request stopped at a deadline while it waited for a turn was never sent', async () => {
  const fetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
  const mailflow = client(fetch, { timeoutMs: 1000 });
  const busy = Array.from({ length: 4 }, () => mailflow.listAccounts().catch(() => {}));
  const err = await failure(mailflow.request('POST', '/api/mail/draft', { body: {}, signal: AbortSignal.timeout(30) }));
  assert.equal(err.code, 'deadline');
  assert.equal(err.mayHaveCompleted, false);
  assert.ok(!err.message.includes(MAY_HAVE_COMPLETED));
  await Promise.all(busy);
});

test('429 gives the wait from Retry-After, or says to retry shortly', async () => {
  const { fetch } = stub(() => respond(429, { error: 'Too many requests for this API token' }, { 'retry-after': '7' }));
  const err = await failure(client(fetch).listAccounts());
  assert.match(err.message, /rate limiting these requests; retry after 7 seconds \(MailFlow: "Too many requests for this API token"\)/);
  assert.equal(err.retryAfter, 7);
  const { fetch: bare } = stub(() => respond(429, { error: 'Too many search requests. Try again shortly.' }));
  assert.match((await failure(client(bare).search({ q: 'x' }))).message, /retry shortly/);
  assert.equal(retryAfterSeconds('Wed, 14 Oct 2026 09:00:30 GMT', Date.parse('2026-10-14T09:00:00Z')), 30);
});

test('5xx on a read is plain; on a write it warns that MailFlow may have done it', async () => {
  const { fetch } = stub(() => respond(500, { error: 'Failed to load message' }));
  const read = await failure(client(fetch).getMessage('b0000000-0000-4000-8000-000000000001'));
  assert.match(read.message, /MailFlow answered 500 \(MailFlow: "Failed to load message"\)/);
  assert.ok(!read.message.includes(MAY_HAVE_COMPLETED));
  const { fetch: writeFetch, calls } = stub(() => respond(502, '<html>Bad gateway</html>'));
  const write = await failure(client(writeFetch).bulkArchive(['b0000000-0000-4000-8000-000000000001']));
  assert.ok(write.message.includes(MAY_HAVE_COMPLETED));
  assert.equal(write.mayHaveCompleted, true);
  assert.equal(calls.length, 1, 'a POST is never retried');
});

test('a redirect is reported, not followed', async () => {
  const { fetch, calls } = stub(() => new Response(null, { status: 302, headers: { location: '/login' } }));
  const err = await failure(client(fetch).listAccounts());
  assert.equal(err.message, 'MAILFLOW_URL redirects to https://mail.example.com/login; use that URL.');
  assert.equal(calls.length, 1);
});

test('a 2xx that is not JSON is not MailFlow', async () => {
  const { fetch } = stub(() => respond(200, '<!doctype html><title>App</title>'));
  const err = await failure(client(fetch).listAccounts());
  assert.match(err.message, /This is not MailFlow's API \(check MAILFLOW_URL\)/);
});

test('timeouts and network errors, with the write warning only when the request may have arrived', async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const read = await failure(client(hang, { timeoutMs: 50 }).listAccounts());
  assert.match(read.message, /did not answer within 50 ms/);
  assert.ok(!read.message.includes(MAY_HAVE_COMPLETED));
  const write = await failure(client(hang, { timeoutMs: 50 }).saveDraft({}));
  assert.ok(write.message.includes(MAY_HAVE_COMPLETED));
  assert.equal(write.code, 'timeout');

  const refused = async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }); };
  const notSent = await failure(client(refused).saveDraft({}));
  assert.match(notSent.message, /Could not reach MailFlow at https:\/\/mail.example.com \(ECONNREFUSED\)/);
  assert.ok(!notSent.message.includes(MAY_HAVE_COMPLETED));
  const reset = async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) }); };
  assert.ok((await failure(client(reset).saveDraft({}))).message.includes(MAY_HAVE_COMPLETED));
});

test('answers over the size cap are not read', async () => {
  const { fetch } = stub(() => respond(200, { big: 'x'.repeat(2000) }));
  const err = await failure(client(fetch, { maxResponseBytes: 1000 }).listAccounts());
  assert.match(err.message, /larger than/);
  const declared = stub(() => new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': '99999999' } }));
  assert.match((await failure(client(declared.fetch).listAccounts())).message, /larger than 10 MB/);
});

test('at most four requests are in flight at once', async () => {
  let active = 0;
  let peak = 0;
  const fetch = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active -= 1;
    return respond(200, []);
  };
  const mailflow = client(fetch);
  await Promise.all(Array.from({ length: 12 }, () => mailflow.listAccounts()));
  assert.equal(peak, 4);
});

test('/self: an HTML 404 is "no token support" only once /api/version shows MailFlow', async () => {
  const older = stub(url => (url.pathname === '/api/version' ? respond(200, { version: '3.4.0', sha: 'abc' }) : respond(404, '<pre>Cannot GET /api/api-tokens/self</pre>')));
  const err = await failure(client(older.fetch).getSelf());
  assert.match(err.message, /This MailFlow server \(version 3.4.0\) has no API token support/);
  assert.deepEqual(older.calls.map(call => call.url.pathname), ['/api/api-tokens/self', '/api/version']);
  const other = stub(() => respond(404, '<h1>Not Found</h1>'));
  assert.match((await failure(client(other.fetch).getSelf())).message, /This is not MailFlow's API \(check MAILFLOW_URL\)/);
  const html = stub(url => (url.pathname === '/api/version' ? respond(200, '<html>app</html>') : respond(404, 'x')));
  assert.match((await failure(client(html.fetch).getSelf())).message, /not MailFlow's API/);
});

test('/self must list scopes; anything that is not a string is dropped', async () => {
  const { fetch } = stub(() => respond(200, { id: 't', name: 'n', scopes: ['read', 7, 'draft'] }));
  assert.deepEqual((await client(fetch).getSelf()).scopes, ['read', 'draft']);
  const { fetch: bad } = stub(() => respond(200, { id: 't' }));
  assert.match((await failure(client(bad).getSelf())).message, /has no scopes/);
});

test('mapErrorResponse keeps long MailFlow texts bounded', () => {
  const err = mapErrorResponse({ status: 403, data: { error: 'x'.repeat(5000) }, headers: new Headers() });
  assert.ok(err.message.length < 600);
});
