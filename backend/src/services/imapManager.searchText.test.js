import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { Parser } from 'htmlparser2';
import { extractHtmlSnippetText } from './messageParser.js';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn(async () => ({ rows: [] })) }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn(), encrypt: vi.fn() }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(async () => ({ host: '127.0.0.1' })), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn(async () => ({})) }));

import { ImapFlow } from 'imapflow';
import { ImapManager, acquirePooledClient, releasePooledClient, evictPool } from './imapManager.js';

const account = { id: 'search-account', imap_tls: true, imap_host: 'imap.example.test', email_address: 'reader@example.test' };
const LIMIT = 16 * 1024 * 1024;
const leaf = (part, text = '', type = 'text/plain', extra = {}) => ({
  part, type, size: Buffer.byteLength(text), ...extra,
});
const mixed = (...childNodes) => ({ type: 'multipart/mixed', childNodes });
const alternative = (...childNodes) => ({ type: 'multipart/alternative', childNodes });

function fixture(structure, bodies = {}) {
  const payloads = new Map(Object.entries(bodies).map(([key, body]) => [key, Buffer.from(body)]));
  const client = Object.assign(new EventEmitter(), {
    usable: true, mailbox: { path: 'INBOX', uidValidity: 19n },
    connect: vi.fn(async () => {}), close: vi.fn(), logout: vi.fn(async () => {}), noop: vi.fn(async () => {}),
    release: vi.fn(), messageFlagsAdd: vi.fn(), messageMove: vi.fn(), messageCopy: vi.fn(), messageDelete: vi.fn(), append: vi.fn(),
  });
  client.getMailboxLock = vi.fn(async () => ({ release: client.release }));
  client.fetch = vi.fn(async function* (uid, query) {
    const msg = { uid: Number(uid) };
    if (query.bodyStructure) msg.bodyStructure = structure;
    if (query.bodyParts) {
      msg.bodyParts = new Map();
      for (const request of query.bodyParts) {
        const key = typeof request === 'string' ? request : request.key;
        if (!(key in bodies)) continue;
        const buf = payloads.get(key);
        msg.bodyParts.set(key, typeof request === 'string' ? buf : buf.subarray(request.start, request.start + request.maxLength));
      }
    }
    yield msg;
  });
  const manager = Object.create(ImapManager.prototype);
  manager._secondaryConnectBlocked = vi.fn(() => null);
  const run = (options = {}) => manager.fetchMessageBody(account, 42, 'INBOX', {
    purpose: 'search', client, uidValidity: '19', ...options,
  });
  return { client, run, manager };
}
const requested = client => client.fetch.mock.calls.flatMap(([, q]) => (q.bodyParts || []).map(p => p.key || p));
const texts = result => result.textParts.map(p => p.text).join('\n');

beforeEach(() => {
  ImapFlow.mockReset().mockImplementation(() => { throw new Error('Unexpected new login'); });
});

describe('search extraction admission', () => {
  const structureReservation = 264192;
  const bodyBound = sizes => sizes.reduce((sum, size) => sum + size + 1088 * Math.max(1, Math.ceil(size / 65536)), 0);
  const identity = { accountId: account.id, folder: 'INBOX', uid: 42, uidValidity: '19' };
  const jsonBytes = value => Buffer.byteLength(JSON.stringify(value));
  const sizedStructure = bytes => {
    const structure = { ...leaf('1', 'Orion'), extra: '' };
    structure.extra = 'x'.repeat(bytes - jsonBytes(structure));
    return structure;
  };

  it('defers before acquiring a session even when a denied reservation was charged', async () => {
    const { run, client } = fixture(leaf('1', 'Orion'), { '1': 'Orion' });
    let charged = 0;
    const admit = vi.fn(async ({ bytes }) => { charged += bytes; return { allowed: false, deferAt: 60000 }; });
    expect(await run({ client: undefined, admit })).toMatchObject({
      complete: false, status: 'deferred', reason: 'budget', deferAt: 60000,
      bodyBytes: null, downloadBytes: 0, identity, requiredParts: [], textParts: [],
    });
    expect(admit).toHaveBeenCalledExactlyOnceWith({ messages: 1, bytes: structureReservation });
    expect(charged).toBe(structureReservation);
    expect(client.getMailboxLock).not.toHaveBeenCalled();
    expect(client.fetch).not.toHaveBeenCalled();
    expect(ImapFlow).not.toHaveBeenCalled();
  });

  it('admits structure before selection, then the entire body once before any PEEK', async () => {
    const { run, client } = fixture(leaf('1', 'Orion'), { '1': 'Orion' });
    const admit = vi.fn(async () => {
      expect(requested(client)).toEqual([]);
      if (admit.mock.calls.length === 1) expect(client.getMailboxLock).not.toHaveBeenCalled();
      else expect(client.fetch).toHaveBeenCalledOnce();
      return { allowed: true };
    });
    const result = await run({ admit });
    expect(result).toMatchObject({ complete: true, bodyBytes: 1093, identity });
    expect(texts(result)).toBe('Orion');
    expect(admit.mock.calls).toEqual([[{ messages: 1, bytes: structureReservation }], [{ messages: 0, bytes: 1093 }]]);
  });

  it('returns a body quotation and observed structure cost on denial without publishing a prefix', async () => {
    const structure = leaf('1', '', 'text/plain', { size: LIMIT });
    const { run, client } = fixture(structure);
    const admit = vi.fn().mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({ allowed: false, deferAt: 60000 });
    expect(await run({ admit })).toMatchObject({
      complete: false, status: 'deferred', reason: 'budget', deferAt: 60000,
      bodyBytes: 17055744, downloadBytes: 2048 + jsonBytes(structure),
      requiredParts: ['1'], identity, textParts: [],
    });
    expect(admit.mock.calls[1]).toEqual([{ messages: 0, bytes: 17055744 }]);
    expect(requested(client)).toEqual([]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('re-quotes nothing on a persisted-bound retry, allowing a sole fresh-window reservation', async () => {
    const body = 'x'.repeat(LIMIT);
    const { run } = fixture(leaf('1', body), { '1': body });
    const admit = vi.fn().mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false, deferAt: 60000 }).mockResolvedValueOnce({ allowed: true });
    const deferred = await run({ admit });
    // The worker persists this quotation with identity/generation; it is not prepaid credit.
    const quotation = JSON.parse(JSON.stringify({ bodyBytes: deferred.bodyBytes, identity: deferred.identity }));
    const result = await run({ admit, reservedBodyBytes: quotation.bodyBytes });
    expect(result).toMatchObject({ complete: true, bodyBytes: 17055744 });
    expect(texts(result)).toHaveLength(LIMIT);
    expect(admit.mock.calls).toEqual([
      [{ messages: 1, bytes: 264192 }], [{ messages: 0, bytes: 17055744 }], [{ messages: 1, bytes: 17319936 }],
    ]);
    expect(result.downloadBytes).toBeLessThanOrEqual(17319936);
  });

  it.each([0, 1092])('rejects a recomputed body bound above quotation %i before any PEEK', async reservedBodyBytes => {
    const { run, client } = fixture(leaf('1', 'Orion'), { '1': 'Orion' });
    const admit = vi.fn(async () => ({ allowed: true }));
    expect(await run({ admit, reservedBodyBytes })).toMatchObject({
      complete: false, status: 'retry', reason: 'bound-changed', bodyBytes: 1093, identity, textParts: [],
    });
    expect(admit).toHaveBeenCalledExactlyOnceWith({ messages: 1, bytes: structureReservation + reservedBodyBytes });
    expect(requested(client)).toEqual([]);
  });

  it('uses a larger quotation once without another body admission or treating it as credit', async () => {
    const { run } = fixture(leaf('1', 'Orion'), { '1': 'Orion' });
    const admit = vi.fn(async () => ({ allowed: true }));
    expect(await run({ admit, reservedBodyBytes: 2000 })).toMatchObject({ complete: true, bodyBytes: 1093 });
    expect(admit).toHaveBeenCalledExactlyOnceWith({ messages: 1, bytes: structureReservation + 2000 });
  });

  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER])('rejects unsafe quotation %s before admission or selection', async reservedBodyBytes => {
    const { run, client } = fixture(leaf('1', 'Orion'), { '1': 'Orion' });
    const admit = vi.fn(async () => ({ allowed: true }));
    expect(await run({ admit, reservedBodyBytes })).toMatchObject({ complete: false, status: 'retry', reason: 'bound-changed' });
    expect(admit).not.toHaveBeenCalled();
    expect(client.getMailboxLock).not.toHaveBeenCalled();
  });

  it('keeps an initial denied quotation and identity without fetching or assuming a refund', async () => {
    const { run, client } = fixture(leaf('1', 'Orion'));
    const admit = vi.fn(async () => ({ allowed: false, deferAt: 120000 }));
    expect(await run({ admit, reservedBodyBytes: 1093 })).toMatchObject({
      complete: false, status: 'deferred', bodyBytes: 1093, deferAt: 120000, identity, downloadBytes: 0, textParts: [],
    });
    expect(admit).toHaveBeenCalledExactlyOnceWith({ messages: 1, bytes: structureReservation + 1093 });
    expect(client.fetch).not.toHaveBeenCalled();
  });

  it('rejects required text over 16MiB before body admission', async () => {
    const { run, client } = fixture(leaf('1', '', 'text/plain', { size: LIMIT + 1 }));
    const admit = vi.fn(async () => ({ allowed: true }));
    expect(await run({ admit })).toMatchObject({ complete: false, status: 'unsupported', reason: 'text-too-large', textParts: [] });
    expect(admit).toHaveBeenCalledOnce();
    expect(requested(client)).toEqual([]);
  });

  it('preserves the honest one-byte structure overrun and refuses before body admission', async () => {
    const { run, client } = fixture(sizedStructure(262145), { '1': 'Orion' });
    const admit = vi.fn(async () => ({ allowed: true }));
    expect(await run({ admit })).toMatchObject({
      complete: false, status: 'unsupported', reason: 'structure-too-large', downloadBytes: 264193,
      structureOverrunBytes: 1, identity, textParts: [],
    });
    expect(admit).toHaveBeenCalledExactlyOnceWith({ messages: 1, bytes: 264192 });
    expect(requested(client)).toEqual([]);
    // Durable terminal identity/generation and zero-fetch second-pass behavior belong to 7b.
  });

  it('accepts the exact structure allowance and charges selection as well as the structure command', async () => {
    const { run } = fixture(sizedStructure(262144), { '1': 'Orion' });
    const admit = vi.fn().mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({ allowed: false, deferAt: 60000 });
    expect(await run({ admit })).toMatchObject({ downloadBytes: 264192, structureOverrunBytes: 0, status: 'deferred' });
  });

  it('does not classify an oversized structure as terminal after its selected epoch changes', async () => {
    const { run, client } = fixture(sizedStructure(262145));
    const fetch = client.fetch.getMockImplementation();
    client.fetch.mockImplementation(async function* (...args) {
      for await (const msg of fetch(...args)) {
        client.mailbox.uidValidity = 20n;
        yield msg;
      }
    });
    const admit = vi.fn(async () => ({ allowed: true }));
    expect(await run({ admit })).toMatchObject({ complete: false, status: 'retry', reason: 'stale-identity', textParts: [] });
    expect(admit).toHaveBeenCalledOnce();
    expect(requested(client)).toEqual([]);
  });

  it.each(['initial', 'body'])('checks cancellation after the %s admission await without a body read', async phase => {
    const controller = new AbortController();
    const { run, client } = fixture(leaf('1', 'Orion'), { '1': 'Orion' });
    const admit = vi.fn(async () => {
      if (admit.mock.calls.length === (phase === 'initial' ? 1 : 2)) controller.abort();
      return { allowed: true };
    });
    expect(await run({ admit, signal: controller.signal })).toMatchObject({ status: 'cancelled', complete: false, textParts: [] });
    expect(requested(client)).toEqual([]);
    if (phase === 'initial') expect(client.getMailboxLock).not.toHaveBeenCalled();
    else expect(client.release).toHaveBeenCalledOnce();
  });

  it('rechecks the selected epoch after body admission awaits', async () => {
    const { run, client } = fixture(leaf('1', 'Orion'), { '1': 'Orion' });
    const admit = vi.fn(async () => {
      if (admit.mock.calls.length === 2) client.mailbox.uidValidity = 20n;
      return { allowed: true };
    });
    expect(await run({ admit })).toMatchObject({ status: 'retry', reason: 'stale-identity', complete: false, textParts: [] });
    expect(requested(client)).toEqual([]);
  });

  it.each(['abort', 'storage-error'])('returns a pooled client unchanged after body admission %s', async mode => {
    const { manager, client } = fixture(leaf('1', 'Orion'), { '1': 'Orion' });
    const pooledAccount = { ...account, id: `admission-${mode}` };
    ImapFlow.mockImplementation(function () { return client; });
    const initial = await acquirePooledClient(pooledAccount);
    releasePooledClient(pooledAccount, initial);
    ImapFlow.mockClear();
    const controller = new AbortController();
    const admit = vi.fn(async () => {
      if (admit.mock.calls.length === 2) {
        if (mode === 'storage-error') throw new Error('budget database unavailable');
        controller.abort();
      }
      return { allowed: true };
    });
    try {
      const result = await manager.fetchMessageBody(pooledAccount, 42, 'INBOX', {
        purpose: 'search', uidValidity: '19', admit, signal: controller.signal,
      });
      expect(result).toMatchObject({ complete: false, status: mode === 'abort' ? 'cancelled' : 'retry', textParts: [] });
      if (mode === 'storage-error') expect(result).toMatchObject({ reason: 'budget-failed', detail: 'budget database unavailable' });
      expect(requested(client)).toEqual([]);
      expect(client.release).toHaveBeenCalledOnce();
      expect(client.logout).not.toHaveBeenCalled();
      expect(client.close).not.toHaveBeenCalled();
      const reused = await acquirePooledClient(pooledAccount);
      expect(reused).toBe(client);
      releasePooledClient(pooledAccount, reused);
      expect(ImapFlow).not.toHaveBeenCalled();
    } finally { evictPool(pooledAccount.id); }
  });

  it.each([undefined, { allowed: false }, { allowed: 'yes' }])('requires explicit allowed:true before selection (%j)', async admission => {
    const { run, client } = fixture(leaf('1', 'Orion'));
    expect(await run({ admit: async () => admission })).toMatchObject({ status: 'deferred', reason: 'budget', complete: false });
    expect(client.getMailboxLock).not.toHaveBeenCalled();
  });

  it('bounds observed accounting across deterministic conforming part sizes, empty parts and batching', async () => {
    for (let seed = 0; seed < 20; seed++) {
      const edges = [0, 1, 65535, 65536, 65537, 131072];
      const sizes = Array.from({ length: seed % 7 + 1 }, (_, i) => edges[(seed + i * 5) % edges.length]);
      const bodies = Object.fromEntries(sizes.map((size, i) => [String(i + 1), 'x'.repeat(size)]));
      const structure = mixed(...sizes.map((size, i) => leaf(String(i + 1), '', 'text/plain', { size })));
      const { run } = fixture(structure, bodies);
      const admit = vi.fn(async () => ({ allowed: true }));
      const result = await run({ admit });
      const reserved = admit.mock.calls.reduce((sum, [bounds]) => sum + bounds.bytes, 0);
      expect(result.complete, `seed ${seed}`).toBe(true);
      expect(result.bodyBytes).toBe(bodyBound(sizes));
      expect(result.downloadBytes).toBeLessThanOrEqual(reserved);
      expect(admit).toHaveBeenCalledTimes(2);
      expect(result.textParts.map(p => p.text.length)).toEqual(sizes);
    }
  });

  it.each(['partial', 'missing', 'failure', 'epoch'])('retains the accounting bound and no prefix on %s body reads', async mode => {
    const { run, client } = fixture(leaf('1', 'Orion'), { '1': 'Orion' });
    const fetch = client.fetch.getMockImplementation();
    client.fetch.mockImplementation(async function* (uid, query, options) {
      if (query.bodyParts && mode === 'failure') throw new Error('connection lost');
      for await (const msg of fetch(uid, query, options)) {
        if (query.bodyParts) {
          if (mode === 'partial') msg.bodyParts.set('1', Buffer.from('Or'));
          if (mode === 'missing') msg.bodyParts.clear();
          if (mode === 'epoch') client.mailbox.uidValidity = 20n;
        }
        yield msg;
      }
    });
    const admit = vi.fn(async () => ({ allowed: true }));
    const result = await run({ admit });
    expect(result).toMatchObject({ complete: false, status: 'retry', textParts: [], bodyBytes: 1093 });
    expect(result.downloadBytes).toBeLessThanOrEqual(structureReservation + 1093);
  });

  it('preserves extraction without an admission callback or a valid quotation', async () => {
    const { run } = fixture(sizedStructure(262145), { '1': 'Orion' });
    expect(texts(await run({ reservedBodyBytes: -1 }))).toBe('Orion');
  });
});

describe('complete search-only body extraction', () => {
  it('includes the late mixed text, excludes attached files and CID images, and uses bounded PEEK reads', async () => {
    const target = 'How are we doing Orion?';
    const { client, run } = fixture(mixed(
      alternative(leaf('1.1', 'first'), leaf('1.2', '<b>first</b>', 'text/html')),
      leaf('2', 'report', 'text/plain', { disposition: 'attachment' }),
      leaf('3', 'image', 'image/png', { id: '<logo>' }), leaf('4', target),
    ), { '1.1': 'first', '1.2': '<b>first</b>', '2': 'report', '3': 'image', '4': target });
    const result = await run();
    expect(result.complete).toBe(true);
    expect(texts(result)).toBe(`first\n${target}`);
    expect(result.requiredParts).toEqual(['1.1', '4']);
    expect(result.identity).toEqual({ accountId: account.id, folder: 'INBOX', uid: 42, uidValidity: '19' });
    expect(requested(client)).toEqual(['1.1', '4']);
    expect(result.downloadBytes).toBeGreaterThan(Buffer.byteLength(`first${target}`));
    expect(client.getMailboxLock).toHaveBeenCalledWith('INBOX', { readOnly: true });
    for (const [, query, options] of client.fetch.mock.calls) {
      expect(options).toEqual({ uid: true, binary: false }); // ImapFlow emits BODY.PEEK for bodyParts.
      for (const p of query.bodyParts || []) expect(p.maxLength).toBeGreaterThan(0);
      expect(query.flags).toBeUndefined();
      expect(query.source).toBeUndefined();
    }
    for (const name of ['messageFlagsAdd', 'messageMove', 'messageCopy', 'messageDelete', 'append']) expect(client[name]).not.toHaveBeenCalled();
    expect(ImapFlow).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('converts complete HTML beyond the snippet cap, decoding entities and skipping invisible elements', async () => {
    const html = `<style>hidden target</style><p>${'visible '.repeat(12000)}</p><p>late &amp; Orion</p><img src="cid:logo">`;
    const { run } = fixture(leaf('1', html, 'text/html'), { '1': html });
    const result = await run();
    expect(result.complete).toBe(true);
    expect(texts(result)).toContain('late & Orion');
    expect(texts(result)).not.toContain('hidden target');
  });

  it.each([
    ['NBSP', '<p>alpha\u00a0</p><b>beta</b>', 'alpha\u00a0beta '],
    ['ideographic space', '<p>alpha\u3000</p><b>beta</b>', 'alpha\u3000beta '],
    ['whitespace-only nodes', '<p>alpha</p> \t <b>beta</b>', 'alpha beta '],
    ['invisible-only nodes', '<p>alpha</p><b>\u200b\ufeff</b><p>beta</p>', 'alpha beta '],
    ['skip tags', '<head><title>hidden</title></head><script>hidden</script><p>Orion</p>', 'Orion '],
    ['unclosed style', 'visible<style>unclosed', 'visible'],
  ])('preserves original capped and uncapped output for %s', async (_label, html, expected) => {
    expect(extractHtmlSnippetText(html)).toBe(expected);
    expect(extractHtmlSnippetText(html, Infinity)).toBe(expected);
    expect(await extractHtmlSnippetText(html, Infinity, { yieldBetweenChunks: true })).toBe(expected);
  });

  it('scales many-tag HTML from 1MiB to 4MiB within linear and absolute ceilings', () => {
    const moduleUrl = new URL('./messageParser.js', import.meta.url).href;
    const source = `
      import { extractHtmlSnippetText } from ${JSON.stringify(moduleUrl)};
      const times = [];
      for (const mib of [1, 4]) {
        const count = Math.floor(mib * 1024 * 1024 / 12);
        const html = '<p>Orion</p>'.repeat(count);
        const samples = [];
        for (let i = 0; i < 3; i++) {
          const start = performance.now();
          const text = await extractHtmlSnippetText(html, Infinity, { yieldBetweenChunks: true });
          samples.push(performance.now() - start);
          if (text !== 'Orion '.repeat(count)) throw new Error('Text mismatch');
        }
        times.push(samples.sort((a, b) => a - b)[1]);
      }
      console.log(JSON.stringify(times));
    `;
    const times = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { timeout: 15000, encoding: 'utf8' }));
    expect(times[0]).toBeLessThan(2000);
    expect(times[1]).toBeLessThan(6000);
    expect(times[1]).toBeLessThan(times[0] * 6 + 100);
  }, 20000);

  it('yields during search HTML extraction while retaining entity and parser state across chunks', async () => {
    const html = 'x'.repeat(65534) + '&amp;<p>Orion</p>' + '<b>end</b>'.repeat(20000);
    let beats = 0;
    let stopped = false;
    const heartbeat = () => { if (!stopped) { beats++; setImmediate(heartbeat); } };
    setImmediate(heartbeat);
    try {
      const output = await extractHtmlSnippetText(html, Infinity, { yieldBetweenChunks: true });
      expect(output).toBe('x'.repeat(65534) + '& Orion ' + 'end '.repeat(20000));
      expect(beats).toBeGreaterThanOrEqual(Math.floor(html.length / 65536));
    } finally { stopped = true; }
  });

  it.each([
    ['surrogate', 'x'.repeat(65535) + '😀<p>Orion</p>'],
    ['entity', 'x'.repeat(65533) + '&amp;<p>Orion</p>'],
    ['tag', 'x'.repeat(65532) + '<script>hidden</script><p>Orion</p>'],
    ['whitespace', 'x'.repeat(65532) + 'abc ' + '   <p>Orion</p>'],
  ])('preserves sync parser output across a split %s', async (_label, html) => {
    expect(await extractHtmlSnippetText(html, Infinity, { yieldBetweenChunks: true }))
      .toBe(extractHtmlSnippetText(html, Infinity));
  });

  it('stops extraction promptly after pause or lease cancellation at a chunk yield', async () => {
    const controller = new AbortController();
    const html = '<p>Orion</p>'.repeat(20000);
    const { run } = fixture(leaf('1', html, 'text/html'), { '1': html });
    let processed = 0;
    const writeOriginal = Parser.prototype.write;
    const write = vi.spyOn(Parser.prototype, 'write').mockImplementation(function (chunk) {
      processed += chunk.length;
      return writeOriginal.call(this, chunk);
    });
    setImmediate(() => controller.abort());
    try {
      const result = await run({ signal: controller.signal });
      expect(result.complete).toBe(false);
      expect(result.status).toBe('cancelled');
      expect(result.textParts).toEqual([]);
      expect(processed).toBeLessThanOrEqual(65536);
    } finally { write.mockRestore(); }
  });

  it('rechecks the mailbox epoch after cooperative HTML extraction', async () => {
    const html = '<p>Orion</p>'.repeat(20000);
    const { run, client } = fixture(leaf('1', html, 'text/html'), { '1': html });
    setImmediate(() => { client.mailbox.uidValidity = 20n; });
    expect(await run()).toMatchObject({ complete: false, status: 'retry', textParts: [] });
  });

  it('never publishes partial HTML extraction when the parser fails', async () => {
    const html = '<p>Orion</p>';
    const { run } = fixture(leaf('1', html, 'text/html'), { '1': html });
    const write = vi.spyOn(Parser.prototype, 'write').mockImplementationOnce(() => { throw new Error('parser failed'); });
    try {
      expect(await run()).toMatchObject({ complete: false, status: 'retry', textParts: [] });
    } finally { write.mockRestore(); }
  });

  it.each(['base64', 'quoted-printable'])('reuses transfer and non-UTF8 decoding for %s', async encoding => {
    const bytes = Buffer.from([99, 97, 102, 233]);
    const body = encoding === 'base64' ? bytes.toString('base64') : 'caf=E9';
    const { run } = fixture(leaf('1', body, 'text/plain', { encoding, parameters: { charset: 'windows-1252' } }), { '1': body });
    expect(texts(await run())).toBe('café');
  });

  it.each([0, 1, 2])('chooses HTML when the plain alternative has only %i bytes', async size => {
    const plain = ' '.repeat(size), html = '<p>complete Orion</p>';
    const { run, client } = fixture(alternative(leaf('1', plain), leaf('2', html, 'text/html')), { '1': plain, '2': html });
    expect(texts(await run())).toContain('complete Orion');
    expect(requested(client)).toEqual(['2']);
  });

  it('prefers substantial HTML over a small view-in-browser plain stub', async () => {
    const plain = 'View this message in your browser';
    const html = '<p>' + 'complete body '.repeat(4000) + 'Orion</p>';
    const { run, client } = fixture(alternative(leaf('1', plain), leaf('2', html, 'text/html')), { '1': plain, '2': html });
    const result = await run();
    expect(texts(result)).toContain('Orion');
    expect(result.requiredParts).toEqual(['2']);
    expect(new Set(requested(client))).toEqual(new Set(['2']));
  });

  it.each([['base64', 'DQo='], ['quoted-printable', '=0D=0A']])('accounts for %s overhead when selecting tiny alternatives', async (encoding, plain) => {
    const html = '<p>Orion project update</p>';
    const { run, client } = fixture(alternative(leaf('1', plain, 'text/plain', { encoding }), leaf('2', html, 'text/html')), { '1': plain, '2': html });
    expect(texts(await run())).toContain('Orion project update');
    expect(requested(client)).toEqual(['2']);
  });

  it('repairs interior base64 padding without discarding the late text suffix', async () => {
    const body = 'T3Jpb24=IGxhdGUgdGFyZ2V0';
    const { run } = fixture(leaf('1', body, 'text/plain', { encoding: 'base64' }), { '1': body });
    const result = await run();
    expect(result.complete).toBe(true);
    expect(texts(result)).toBe('Orion late target');
    expect(result.decodeRepair).toBe('interior-base64-padding');
  });

  it.each(['Pz8_T3Jpb24=', '____', 'T3Jpb24g8J-Ygw'])('accounts for Node-supported URL-safe base64 alphabet in %s', async body => {
    const { run } = fixture(leaf('1', body, 'text/plain', { encoding: 'base64' }), { '1': body });
    const result = await run();
    expect(result.complete).toBe(true);
    expect(texts(result)).toBe(new TextDecoder().decode(Buffer.from(body, 'base64')));
  });

  it.each(['T3Jpb24=IGxhdGUgdGFyZ2V0', 'T3Jpb24=Q', 'T3Jpb24='])('conservatively excludes legacy embedded MIME recovery, including clean fragments (%s)', async payload => {
    const body = '--x\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + payload + '\r\n--x--\r\n';
    const { run } = fixture(leaf('1', body, 'text/plain', { encoding: '7bit' }), { '1': body });
    expect(await run()).toMatchObject({ complete: false, status: 'unsupported', reason: 'decoder-discarded-input', textParts: [] });
  });

  it('does not publish base64 input with an unaccountable remainder after repair', async () => {
    const body = 'T3Jpb24=Q';
    const { run } = fixture(leaf('1', body, 'text/plain', { encoding: 'base64' }), { '1': body });
    expect(await run()).toMatchObject({ complete: false, status: 'unsupported', reason: 'decoder-discarded-input', textParts: [] });
  });

  it('consumes all quoted-printable input while retaining malformed equals literally', async () => {
    const body = 'Orion=XXlate=3Dtarget= trailing';
    const { run } = fixture(leaf('1', body, 'text/plain', { encoding: 'quoted-printable' }), { '1': body });
    const result = await run();
    expect(result.complete).toBe(true);
    expect(texts(result)).toBe('Orion=XXlate=target= trailing');
    expect(result.lossyDecode).toBe(true);
  });

  it.each([
    ['mislabeled1252', Buffer.concat([Buffer.from('Orion caf'), Buffer.from([0xe9])]), {}, true],
    ['invalid continuation', Buffer.concat([Buffer.from('Orion '), Buffer.from([0xc3, 0x28])]), {}, true],
    ['base64 junk', 'T3Jp$b24=', { encoding: 'base64' }, true],
    ['base64 whitespace', 'T3Jp\r\nb24=', { encoding: 'base64' }, false],
    ['unknown label', Buffer.concat([Buffer.from('Orion '), Buffer.from([0xa1])]), { parameters: { charset: 'x-unknown-test' } }, true],
    ['unsupported iso charset', Buffer.concat([Buffer.from('Orion '), Buffer.from([0xa1])]), { parameters: { charset: 'iso-8859-16' } }, true],
    ['quoted-printable noise', 'Orion=XXlate', { encoding: 'quoted-printable' }, true],
    ['invalid leading UTF8 byte', Buffer.concat([Buffer.from('Orion '), Buffer.from([0xff])]), {}, true],
    ['non-ASCII base64 bytes', Buffer.from([0xd4, 0x33, 0x4a, 0x70]), { encoding: 'base64' }, true, 'Ori'],
  ])('retains ASCII words with display-parity decoding for %s', async (_label, body, metadata, lossyDecode, expected = 'Orion') => {
    const { run } = fixture(leaf('1', body, 'text/plain', metadata), { '1': body });
    const result = await run();
    expect(result.complete).toBe(true);
    expect(texts(result)).toContain(expected);
    expect(result.lossyDecode).toBe(lossyDecode);
  });

  it.each([
    ['LIMIT', 'Too many connections', 'provider-refused'],
    ['AUTHENTICATIONFAILED', 'Invalid credentials', 'backoff'],
    ['THROTTLED', 'Slow down', 'provider-refused'],
    ['OVERQUOTA', 'Quota exhausted', 'backoff'],
    [null, 'ECONNRESET', 'retry'],
  ])('preserves the %s provider error classification and detail', async (code, detail, status) => {
    const { run, client } = fixture(leaf('1', 'body'), { '1': 'body' });
    client.fetch.mockImplementation(() => ({ [Symbol.asyncIterator]() {
      throw Object.assign(new Error('Command failed'), { serverResponseCode: code, responseText: detail });
    } }));
    const result = await run();
    expect(result.complete).toBe(false);
    expect(result.status).toBe(status);
    expect(result.detail).toContain(detail);
    expect(result.textParts).toEqual([]);
    expect(ImapFlow).not.toHaveBeenCalled();
  });

  it('honors the manager refusal gate before any pooled grow while allowing an explicitly reused session', async () => {
    const { manager, client, run } = fixture(leaf('1', 'body'), { '1': 'body' });
    manager._secondaryConnectBlocked.mockReturnValue({ until: Date.now() + 30000 });
    const result = await manager.fetchMessageBody(account, 42, 'INBOX', { purpose: 'search', uidValidity: '19' });
    expect(result).toMatchObject({ complete: false, status: 'backoff', reason: 'provider-refused' });
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(ImapFlow).not.toHaveBeenCalled();
    expect(client.fetch).not.toHaveBeenCalled();
    expect(await run()).toMatchObject({ complete: true });
  });

  it.each([[512, 5000, '1'], [100, 500, '1'], [100, 501, '2']])('applies the stub size boundaries to %i plain bytes and %i HTML bytes', async (plainSize, htmlSize, preferred) => {
    const plain = 'p'.repeat(plainSize), html = '<p>' + 'h'.repeat(htmlSize - 7) + '</p>';
    const { run } = fixture(alternative(leaf('1', plain), leaf('2', html, 'text/html')), { '1': plain, '2': html });
    expect((await run()).requiredParts).toEqual([preferred]);
  });

  it('keeps meaningful plain even when the unselected HTML exceeds the bound', async () => {
    const plain = 'plain '.repeat(100);
    const { run, client } = fixture(alternative(leaf('1', plain), leaf('2', '', 'text/html', { size: LIMIT + 1 })), { '1': plain });
    expect(texts(await run())).toBe(plain);
    expect(requested(client)).toEqual(['1']);
  });

  it('requires a present empty literal, distinguishing an omitted zero-length part', async () => {
    const empty = fixture(leaf('1'), { '1': '' });
    expect(await empty.run()).toMatchObject({ complete: true, textParts: [{ part: '1', text: '' }] });
    const missing = fixture(leaf('1'));
    expect(await missing.run()).toMatchObject({ complete: false, status: 'retry', textParts: [] });
  });

  it('completes attachment-only bodies without downloading files', async () => {
    const { run, client } = fixture(leaf('1', '', 'application/pdf', { disposition: 'attachment', size: LIMIT + 1 }));
    expect(await run()).toMatchObject({ complete: true, requiredParts: [], textParts: [] });
    expect(requested(client)).toEqual([]);
  });

  it.each(['missing', 'short', 'throw'])('never publishes a prefix after %s transfer', async failure => {
    const { run, client } = fixture(mixed(leaf('1', 'first'), leaf('2', 'later')), { '1': 'first', ...(failure === 'short' ? { '2': 'lat' } : {}) });
    if (failure === 'throw') {
      const fetch = client.fetch.getMockImplementation();
      client.fetch.mockImplementation(async function* (...args) {
        yield* fetch(...args);
        if (args[1].bodyParts) throw new Error('Command failed');
      });
    }
    const result = await run();
    expect(result).toMatchObject({ complete: false, status: 'retry', textParts: [] });
    expect(result.downloadBytes).toBeGreaterThan(5);
    expect(ImapFlow).not.toHaveBeenCalled();
  });

  it.each(['before', 'during', 'wrongUid'])('rejects identity changes: %s', async when => {
    const { run, client } = fixture(leaf('1', 'body'), { '1': 'body' });
    if (when === 'before') client.mailbox.uidValidity = 20n;
    else {
      const fetch = client.fetch.getMockImplementation();
      client.fetch.mockImplementation(async function* (...args) {
        for await (const msg of fetch(...args)) {
          if (when === 'wrongUid') msg.uid = 43;
          yield msg;
        }
        if (when === 'during' && args[1].bodyParts) client.mailbox.uidValidity = 20n;
      });
    }
    expect(await run()).toMatchObject({ complete: false, status: 'retry', textParts: [] });
    expect(client.release).toHaveBeenCalledOnce();
  });

  it.each(['single', 'sum'])('reports the 16MiB required-text bound explicitly: %s', async kind => {
    const structure = kind === 'single' ? leaf('1', '', 'text/plain', { size: LIMIT + 1 })
      : mixed(leaf('1', '', 'text/plain', { size: LIMIT }), leaf('2', 'x'));
    const { run, client } = fixture(structure);
    expect(await run()).toMatchObject({ complete: false, status: 'unsupported', reason: 'text-too-large', textParts: [] });
    expect(requested(client)).toEqual([]);
  });

  it('groups partial reads and preserves encoded text across chunk boundaries', async () => {
    const body = 'a'.repeat(65535) + '=E9' + 'Z'.repeat(65540);
    const { run, client } = fixture(mixed(leaf('1', body, 'text/plain', { encoding: 'quoted-printable', parameters: { charset: 'windows-1252' } }), leaf('2', 'last')), { '1': body, '2': 'last' });
    expect(texts(await run())).toBe('a'.repeat(65535) + 'é' + 'Z'.repeat(65540) + '\nlast');
    const reads = client.fetch.mock.calls.map(([, q]) => q.bodyParts).filter(Boolean);
    expect(reads[0]).toHaveLength(2);
    for (const batch of reads) for (const part of batch) expect(part.maxLength).toBeLessThanOrEqual(65536);
    expect(reads.map(batch => batch[0].start)).toEqual([0, 65536, 131072]);
  });

  it('accepts exactly 16MiB and retains text beyond the legacy body cap', async () => {
    const body = 'x'.repeat(LIMIT - 6) + ' Orion';
    const { run } = fixture(leaf('1', body), { '1': body });
    const result = await run();
    expect(result.complete).toBe(true);
    expect(texts(result)).toBe(body);
  });

  it('bounds the number of parts per command while retaining all distinct mixed text', async () => {
    const bodies = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i + 1), `part ${i}`]));
    const { run, client } = fixture(mixed(...Object.entries(bodies).map(([p, text]) => leaf(p, text))), bodies);
    expect(texts(await run())).toBe(Object.values(bodies).join('\n'));
    expect(client.fetch.mock.calls.map(([, q]) => q.bodyParts?.length).filter(Boolean)).toEqual([4, 4, 1]);
  });

  it('does not assert completeness when required size metadata is absent', async () => {
    const { run, client } = fixture(leaf('1', 'body', 'text/plain', { size: undefined }), { '1': 'body' });
    expect(await run()).toMatchObject({ complete: false, status: 'retry', reason: 'missing-part-size' });
    expect(requested(client)).toEqual([]);
  });

  it('retries absent structure and cancelled work without body reads', async () => {
    const missing = fixture(null);
    expect(await missing.run()).toMatchObject({ complete: false, status: 'retry' });
    const cancelled = fixture(leaf('1', 'body'), { '1': 'body' });
    expect(await cancelled.run({ signal: AbortSignal.abort() })).toMatchObject({ complete: false, status: 'cancelled' });
    expect(cancelled.client.fetch).not.toHaveBeenCalled();
  });

  it('the installed ImapFlow command emits UID FETCH BODY.PEEK with partial ranges and no flags', async () => {
    const { run, client } = fixture(leaf('1', 'body'), { '1': 'body' });
    await run();
    const imapFetch = createRequire(import.meta.url)('imapflow/lib/commands/fetch.js');
    const wire = { state: 1, states: { SELECTED: 1 }, capabilities: new Set(['BINARY']), enabled: new Set(), mailbox: {}, log: { warn: vi.fn() },
      exec: vi.fn(async () => ({ next: vi.fn() })) };
    for (const args of client.fetch.mock.calls) await imapFetch(wire, ...args);
    expect(wire.exec.mock.calls.map(([command]) => command)).toEqual(['UID FETCH', 'UID FETCH']);
    const atoms = wire.exec.mock.calls.flatMap(([, attributes]) => attributes.flat(Infinity));
    expect(atoms.filter(atom => atom.value?.includes('PEEK'))).toEqual([
      { type: 'ATOM', value: 'BODY.PEEK', section: [{ type: 'ATOM', value: '1' }], partial: [0, 4] },
    ]);
    expect(atoms.some(atom => atom.value === 'FLAGS')).toBe(false);
  });

  it('returns a cancelled pooled lease without eviction, logout or a replacement login', async () => {
    const html = '<p>Orion</p>'.repeat(20000);
    const { manager, client } = fixture(leaf('1', html, 'text/html'), { '1': html });
    const pooledAccount = { ...account, id: 'cancelled-pooled-search' };
    ImapFlow.mockImplementation(function () { return client; });
    const initial = await acquirePooledClient(pooledAccount);
    releasePooledClient(pooledAccount, initial);
    ImapFlow.mockClear();
    const controller = new AbortController();
    setImmediate(() => controller.abort());
    try {
      const result = await manager.fetchMessageBody(pooledAccount, 42, 'INBOX', { purpose: 'search', uidValidity: '19', signal: controller.signal });
      expect(result).toMatchObject({ complete: false, status: 'cancelled', textParts: [] });
      expect(client.logout).not.toHaveBeenCalled();
      expect(client.close).not.toHaveBeenCalled();
      const reused = await acquirePooledClient(pooledAccount);
      expect(reused).toBe(client);
      releasePooledClient(pooledAccount, reused);
      expect(ImapFlow).not.toHaveBeenCalled();
    } finally { evictPool(pooledAccount.id); }
  });

  it.each(['imap.example.test', 'imap.purelymail.com'])('uses the pooled session without fresh-login escalation on %s', async imap_host => {
    const { client, manager } = fixture(leaf('1', 'body'), { '1': 'body' });
    const pooledAccount = { ...account, id: `pooled-${imap_host}`, imap_host };
    ImapFlow.mockImplementation(function () { return client; });
    const pooled = await acquirePooledClient(pooledAccount);
    releasePooledClient(pooledAccount, pooled);
    ImapFlow.mockClear();
    manager._secondaryConnectBlocked.mockReturnValue({ until: Date.now() + 30000 });
    try {
      expect(await manager.fetchMessageBody(pooledAccount, 42, 'INBOX', { purpose: 'search', uidValidity: '19' })).toMatchObject({ complete: true });
      client.fetch.mockImplementation(() => ({ [Symbol.asyncIterator]() { throw new Error('Command failed'); } }));
      expect(await manager.fetchMessageBody(pooledAccount, 42, 'INBOX', { purpose: 'search', uidValidity: '19' })).toMatchObject({ complete: false, status: 'retry' });
      expect(ImapFlow).not.toHaveBeenCalled();
    } finally { evictPool(pooledAccount.id); }
  });
});
