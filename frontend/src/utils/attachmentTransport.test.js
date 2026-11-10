import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAttachmentActionScope, createAttachmentSessionScope } from './attachmentActions.js';
import { fetchAttachmentBytes, fetchLegacyAttachmentBytes } from './attachmentTransport.js';

const source = { messageId: '11111111-1111-4111-8111-111111111111', accountId: '22222222-2222-4222-8222-222222222222', storageGeneration: '33333333-3333-4333-8333-333333333333', entityId: '44444444-4444-4444-8444-444444444444', folder: '收件箱', uidValidity: '1', uid: '42' };
function setup() {
  let state = { user: { id: 'user' }, accounts: [{ id: source.accountId, enabled: true, storage_generation: source.storageGeneration }] };
  const listeners = new Set(); const events = new EventTarget(); const effects = [];
  for (const type of ['mailflow:locked', 'mailflow:session_expired']) events.addEventListener(type, () => effects.push(type));
  const store = { getState: () => state, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, setState(patch) { state = { ...state, ...patch }; for (const fn of [...listeners]) fn(); } };
  const scope = createAttachmentActionScope({ store, source, sourceCurrent: () => true, eventTarget: events });
  return { scope, store, effects, events };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; }
const ok = bytes => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(bytes).buffer });

test('explicit request carries exact ASCII proof, credentials, CSRF and signal, with no cache or retry', async () => {
  const { scope } = setup(); const calls = [];
  const bytes = await fetchAttachmentBytes({ source, part: '2.1', scope, fetchImpl: async (...args) => { calls.push(args); return ok([1, 2]); } });
  assert.deepEqual(bytes, new Uint8Array([1, 2])); assert.equal(calls.length, 1);
  const [url, opts] = calls[0]; assert.equal(url, `/api/mail/messages/${source.messageId}/attachments/2.1`);
  assert.equal(opts.credentials, 'include'); assert.equal(opts.headers['X-Requested-With'], 'MailFlow');
  assert.equal(opts.signal, scope.signal); assert.equal(opts.cache, 'no-store');
  assert.deepEqual(JSON.parse(decodeURIComponent(opts.headers['X-Mailflow-Message-Source'])), source); scope.dispose();
});
test('scope construction performs no fetch and invalid proof/part never reaches fetch', async () => {
  const { scope } = setup(); let calls = 0; const fetchImpl = async () => { calls++; return ok([1]); };
  for (const invalid of [null, { ...source, uid: 42 }, { ...source, extra: true }]) {
    await assert.rejects(fetchAttachmentBytes({ source: invalid, part: '1', scope, fetchImpl }), { status: 400 });
  }
  for (const part of ['../1', '', '0', '01', '1.0', '1?x=2']) await assert.rejects(fetchAttachmentBytes({ source, part, scope, fetchImpl }), { status: 400 });
  await assert.rejects(fetchAttachmentBytes({ source: { ...source, uid: '43' }, part: '1', scope, fetchImpl }), { status: 409 });
  assert.equal(calls, 0); scope.dispose();
});
test('explicit legacy request cannot become a guarded missing-proof fallback', async () => {
  const { store, events, scope } = setup(); scope.dispose(); const legacy = createAttachmentSessionScope({ store, eventTarget: events });
  let request; const fetchImpl = async (...args) => { request = args; return ok([3]); };
  await assert.rejects(fetchAttachmentBytes({ source: null, part: '1', scope: legacy, fetchImpl }), { status: 400 });
  assert.equal(request, undefined);
  assert.deepEqual(await fetchLegacyAttachmentBytes({ messageId: source.messageId, part: '1', scope: legacy, fetchImpl }), new Uint8Array([3]));
  assert.equal(request[1].headers['X-Mailflow-Message-Source'], undefined); legacy.dispose();
});
for (const stage of ['fetch', 'bytes']) test(`abort plus sticky completion guard handles late ${stage}`, async () => {
  const { scope, store } = setup(); const wait = deferred(); let read = 0;
  const response = { ok: true, status: 200, arrayBuffer: () => { read++; return stage === 'bytes' ? wait.promise : Promise.resolve(new ArrayBuffer(1)); } };
  const run = fetchAttachmentBytes({ source, part: '1', scope, fetchImpl: () => stage === 'fetch' ? wait.promise : Promise.resolve(response) });
  await Promise.resolve(); await Promise.resolve();
  store.setState({ user: null }); store.setState({ user: { id: 'user' } });
  wait.resolve(stage === 'fetch' ? response : new ArrayBuffer(1));
  await assert.rejects(run, { name: 'AbortError' }); assert.equal(scope.signal.aborted, true);
  assert.equal(read, stage === 'fetch' ? 0 : 1);
});
for (const status of [401, 423]) {
  for (const stage of ['fetch', 'json']) test(`stale ${status} during ${stage} does not affect a new session`, async () => {
    const { scope, store, effects } = setup(); const wait = deferred(); let read = 0;
    const response = { ok: false, status, json: () => { read++; return stage === 'json' ? wait.promise : Promise.resolve({ error: 'old response' }); } };
    const run = fetchAttachmentBytes({ source, part: '1', scope, fetchImpl: () => stage === 'fetch' ? wait.promise : Promise.resolve(response) });
    await Promise.resolve(); await Promise.resolve();
    store.setState({ user: null }); store.setState({ user: { id: 'user' } });
    wait.resolve(stage === 'fetch' ? response : { error: 'old response' });
    await assert.rejects(run, { name: 'AbortError' }); assert.deepEqual(effects, []);
    assert.equal(read, stage === 'fetch' ? 0 : 1);
  });
  test(`current ${status} is surfaced once after error parsing`, async () => {
    const { scope, effects } = setup();
    const fetchImpl = async () => ({ ok: false, status, json: async () => ({ error: 'Denied', code: 'backend_code' }) });
    for (let n = 0; n < 2; n++) await assert.rejects(fetchAttachmentBytes({ source, part: '1', scope, fetchImpl }), { status, code: 'backend_code' });
    assert.deepEqual(effects, [status === 401 ? 'mailflow:session_expired' : 'mailflow:locked']); scope.dispose();
  });
}
for (const status of [400, 404, 409, 413, 503]) test(`current ${status} preserves refusal without retry or fallback`, async () => {
  const { scope, effects } = setup(); let calls = 0;
  await assert.rejects(fetchAttachmentBytes({ source, part: '1', scope, fetchImpl: async () => { calls++; return { ok: false, status, json: async () => ({ error: 'refused' }) }; } }), { status });
  assert.equal(calls, 1); assert.deepEqual(effects, []); scope.dispose();
});
test('declared length cap rejects before body read', async () => {
  const { scope } = setup(); let reads = 0;
  await assert.rejects(fetchAttachmentBytes({ source, part: '1', scope, maxBytes: 3, fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers({ 'Content-Length': '4' }), arrayBuffer() { reads++; return new ArrayBuffer(4); } }) }), { status: 413 });
  assert.equal(reads, 0); scope.dispose();
});
test('understated/unknown length is bounded by actual stream bytes and reader is cancelled', async () => {
  for (const length of [null, '1']) {
    const { scope } = setup(); let reads = 0, cancels = 0;
    const response = { ok: true, status: 200, headers: new Headers(length ? { 'Content-Length': length } : {}), body: { getReader: () => ({ async read() { reads++; return { done: false, value: new Uint8Array([1, 2]) }; }, async cancel() { cancels++; }, releaseLock() {} }) } };
    await assert.rejects(fetchAttachmentBytes({ source, part: '1', scope, maxBytes: 3, fetchImpl: async () => response }), { status: 413 });
    assert.equal(reads, 2); assert.equal(cancels, 1); scope.dispose();
  }
});
test('actual fallback arrayBuffer cap rejects before returning bytes', async () => {
  const { scope } = setup(); await assert.rejects(fetchAttachmentBytes({ source, part: '1', scope, maxBytes: 2, fetchImpl: async () => ok([1, 2, 3]) }), { status: 413 }); scope.dispose();
});
test('stream read invalidation rejects even when read ignores abort; no trailing bytes published', async () => {
  const { scope } = setup(); const wait = deferred(); let reads = 0, cancels = 0;
  const response = { ok: true, status: 200, body: { getReader: () => ({ read() { reads++; return wait.promise; }, async cancel() { cancels++; }, releaseLock() {} }) } };
  const run = fetchAttachmentBytes({ source, part: '1', scope, fetchImpl: async () => response });
  await Promise.resolve(); await Promise.resolve(); scope.dispose(); wait.resolve({ done: false, value: new Uint8Array([1]) });
  await assert.rejects(run, { name: 'AbortError' }); assert.equal(reads, 1); assert.equal(cancels, 1);
});
test('successful stream joins only current requested bytes', async () => {
  const { scope } = setup(); let reads = 0;
  const chunks = [new Uint8Array([1, 2]), new Uint8Array([3])];
  const response = { ok: true, status: 200, body: { getReader: () => ({ async read() { return reads < chunks.length ? { done: false, value: chunks[reads++] } : { done: true }; }, async cancel() {}, releaseLock() {} }) } };
  assert.deepEqual(await fetchAttachmentBytes({ source, part: '1', scope, maxBytes: 3, fetchImpl: async () => response }), new Uint8Array([1, 2, 3])); scope.dispose();
});

test('caller cannot disable the actual byte backstop with an invalid or oversized budget', async () => {
  const { scope } = setup(); let calls = 0;
  for (const maxBytes of [0, -1, Infinity, NaN, 0.5, 50 * 1024 * 1024 + 1]) {
    await assert.rejects(fetchAttachmentBytes({ source, part: '1', scope, maxBytes, fetchImpl: async () => { calls++; return ok([1]); } }), { status: 400 });
  }
  assert.equal(calls, 0); scope.dispose();
});
test('mutable caller proof is captured before the request and cannot retarget it', async () => {
  const { scope } = setup(); const input = { ...source }; const wait = deferred(); let header;
  const run = fetchAttachmentBytes({ source: input, part: '1', scope, fetchImpl: async (_url, opts) => { header = opts.headers['X-Mailflow-Message-Source']; return wait.promise; } });
  input.uid = '43'; input.folder = 'Archive'; wait.resolve(ok([1])); await run;
  assert.deepEqual(JSON.parse(decodeURIComponent(header)), source); scope.dispose();
});
test('error JSON rejection in a stale scope also has no auth effect', async () => {
  const { scope, effects } = setup(); let reject; const parse = new Promise((_, fail) => { reject = fail; });
  const run = fetchAttachmentBytes({ source, part: '1', scope, fetchImpl: async () => ({ ok: false, status: 423, json: () => parse }) });
  await Promise.resolve(); await Promise.resolve(); scope.dispose(); reject(new Error('late broken JSON'));
  await assert.rejects(run, { name: 'AbortError' }); assert.deepEqual(effects, []);
});
