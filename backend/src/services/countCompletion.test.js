import { expect, it } from 'vitest';
import { CountCompletion, COUNT_LEASE_MS } from './countCompletion.js';
const epoch = 'test-epoch';
const id = n => `${epoch}.1:00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const setup = opts => new CountCompletion({ epoch, ...opts });
const refresh = (c, opIds = [], revision = '10') => c.refresh('u', { ops: opIds.map(id => ({ leaseToken: id.split(':')[0], uuid: id.split(':')[1] })) }, ['a', 'b'], revision);
it('holds certification through work before provider entry, after response, and throwing handlers', async () => {
  const c = setup(), held = deferred();
  const work = c.run('u', id(1), async () => { await held.promise; throw new Error('handler failed'); });
  refresh(c, [id(1)]);
  expect(c.observation('u', 'a').quiescentAtStart).toBe(false);
  held.resolve();
  await expect(work).rejects.toThrow('handler failed');
  expect(c.observation('u', 'a')).toMatchObject({ quiescentAtStart: true, refreshSeqAtStart: '10' });
});
it('tombstones uncertain late dispatch before any mutation, including another tab', async () => {
  const c = setup(); let commands = 0;
  refresh(c, [id(2)]);
  await expect(c.run('u', id(2), () => { commands++; })).rejects.toMatchObject({ status: 409, code: 'count-op-expired' });
  expect(commands).toBe(0);
  await c.run('u', id(3), () => { commands++; });
  await expect(c.run('u', id(3), () => { commands++; })).rejects.toMatchObject({ code: 'count-op-replayed' });
  expect(commands).toBe(1);
});
it('counts anonymous legacy handlers and shares quiescence across tabs and accounts', async () => {
  const c = setup(), a = deferred(), b = deferred();
  const first = c.run('u', null, () => a.promise), second = c.run('u', id(4), () => b.promise);
  refresh(c, [id(4)]);
  a.resolve(); await first;
  expect(c.canObserveAccount('a')).toBe(false);
  b.resolve(); await second;
  expect(c.canObserveAccount('a')).toBe(true);
});
it('blocks fire-and-forget provider writes and queued flag pushes until resolved or abandoned', () => {
  const pending = new Map([['a', 1]]), c = setup({ pending: account => pending.get(account) || 0 });
  refresh(c);
  expect(c.observation('u', 'b').quiescentAtStart).toBe(false);
  pending.set('a', 2);
  expect(c.canObserveAccount('b')).toBe(false);
  pending.set('a', 0);
  expect(c.observation('u', 'b').quiescentAtStart).toBe(true);
});
it('rejects stale boot epochs after restart without provider commands', async () => {
  const c = setup({ epoch: 'new-epoch' }); let commands = 0;
  await expect(c.run('u', id(1), () => { commands++; })).rejects.toMatchObject({ code: 'count-epoch-expired' });
  expect(() => refresh(c, [id(1)])).not.toThrow();
  expect(commands).toBe(0);
});
it('refuses capacity before mutation, never evicts running or unexpired tombstones, and permits retry after retention', async () => {
  let now = 0; const c = setup({ capacity: 2, now: () => now }), held = deferred();
  const running = c.run('u', id(1), () => held.promise);
  refresh(c, [id(2)]);
  let commands = 0;
  await expect(c.run('u', id(3), () => { commands++; })).rejects.toMatchObject({ status: 429, code: 'count-op-capacity', retryable: true });
  expect(commands).toBe(0);
  now = COUNT_LEASE_MS - 1;
  await expect(c.run('u', id(2), () => {})).rejects.toMatchObject({ code: 'count-op-expired' });
  now++;
  const next = `${c.lease().token}:${id(3).split(':')[1]}`;
  await c.run('u', next, () => {});
  await expect(c.run('u', id(1), () => {})).rejects.toMatchObject({ code: 'count-op-running' });
  held.resolve(); await running;
});
it('certifies only the matching successful observation revision, never persisted pre-restart counts', () => {
  const c = setup(); refresh(c);
  const meta = c.observation('u', 'a');
  expect(c.metadata('a', 'INBOX', '20').quiescentAtStart).toBe(false);
  c.remember('a', 'INBOX', '20', meta);
  expect(c.metadata('a', 'INBOX', '20')).toEqual(meta);
  expect(c.metadata('a', 'INBOX', '21').quiescentAtStart).toBe(false);
});
it('counts a fire-and-forget mark-all-read from invocation through completion and retains queued flag work', async () => {
  const { installProviderCountTracking } = await import('./countCompletion.js');
  const held = deferred(), engine = { _pendingFlagPush: new Map() };
  for (const name of ['setFlag', 'markAllReadImap', 'moveMessage', 'moveMessageGetNewUid', 'copyMessage', 'bulkMoveMessages', 'permanentDeleteMessage', 'bulkPermanentDelete', 'emptyFolder']) engine[name] = () => held.promise;
  const pending = installProviderCountTracking(engine), c = setup({ pending });
  refresh(c);
  const write = engine.markAllReadImap({ id: 'a' }, 'INBOX');
  expect(c.observation('u', 'a').quiescentAtStart).toBe(false);
  engine._pendingFlagPush.set('a', new Map([['read', {}]]));
  held.resolve(); await write;
  expect(c.observation('u', 'a').quiescentAtStart).toBe(false);
  engine._pendingFlagPush.clear();
  expect(c.observation('u', 'a').quiescentAtStart).toBe(true);
});

it('accepts the previous unexpired lease across rotation, expires admission without a gap, and ignores wall time', async () => {
  let mono = 0; const c = setup({ now: () => mono });
  const first = c.lease().token;
  refresh(c, [id(8)]);
  mono = COUNT_LEASE_MS / 2;
  expect(c.lease().token).not.toBe(first);
  await c.run('u', id(9), () => {}); // old lease remains admissible
  mono = COUNT_LEASE_MS - 0.001;
  await expect(c.run('u', id(8), () => {})).rejects.toMatchObject({ code: 'count-op-expired' });
  mono = COUNT_LEASE_MS;
  let commands = 0;
  await expect(c.run('u', id(8), () => { commands++; })).rejects.toMatchObject({ code: 'count-epoch-expired' });
  expect(commands).toBe(0);
  const oldWall = Date.now; Date.now = () => 9e15;
  try { await c.run('u', `${c.lease().token}:${id(10).split(':')[1]}`, () => { commands++; }); }
  finally { Date.now = oldWall; }
  expect(commands).toBe(1);
});
it('keeps a long-running old-lease handler pending after expiry and rejects UUID reuse while it runs', async () => {
  let mono = 0; const c = setup({ now: () => mono }), held = deferred();
  const work = c.run('u', id(12), () => held.promise);
  mono = COUNT_LEASE_MS + 1;
  refresh(c, [id(12)]);
  expect(c.observation('u', 'a').quiescentAtStart).toBe(false);
  await expect(c.run('u', `${c.lease().token}:${id(12).split(':')[1]}`, () => {})).rejects.toMatchObject({ code: 'count-op-running' });
  held.resolve(); await work;
  expect(c.observation('u', 'a').quiescentAtStart).toBe(true);
});

it('rejects a known done UUID under a newer lease until its original lease expires', async () => {
  let mono = 0; const c = setup({ now: () => mono }); let commands = 0;
  await c.run('u', id(20), () => { commands++; });
  mono = COUNT_LEASE_MS / 2;
  await expect(c.run('u', `${c.lease().token}:${id(20).split(':')[1]}`, () => { commands++; })).rejects.toMatchObject({ code: 'count-op-replayed' });
  expect(commands).toBe(1);
});
it('the handler wrapper stays active after json and releases a throwing handler in finally', async () => {
  const { countCompletion, countMutation } = await import('./countCompletion.js');
  const held = deferred(); let response;
  const work = countMutation(async (_req, res) => { res.json({ ok: true }); await held.promise; throw new Error('after response'); })({ session: { userId: 'after-response.test' }, get: () => undefined }, { json: value => { response = value; } });
  expect(response).toEqual({ ok: true });
  countCompletion.refresh('after-response.test', { ops: [] }, ['after-account'], '100');
  expect(countCompletion.observation('after-response.test', 'after-account').quiescentAtStart).toBe(false);
  held.resolve(); await expect(work).rejects.toThrow('after response');
  expect(countCompletion.observation('after-response.test', 'after-account').quiescentAtStart).toBe(true);
});
it('provider tracking releases synchronous throws and asynchronous rejections for string-account COPY too', async () => {
  const { installProviderCountTracking } = await import('./countCompletion.js');
  const engine = {};
  for (const name of ['setFlag', 'markAllReadImap', 'moveMessage', 'moveMessageGetNewUid', 'copyMessage', 'bulkMoveMessages', 'permanentDeleteMessage', 'bulkPermanentDelete', 'emptyFolder']) engine[name] = () => { throw new Error('provider failure'); };
  const pending = installProviderCountTracking(engine);
  await expect(engine.copyMessage('a', 1, 'INBOX', 'Archive')).rejects.toThrow('provider failure');
  expect(pending('a')).toBe(0);
  await expect(engine.trackProviderWrite('a', async () => { throw new Error('async failure'); })).rejects.toThrow('async failure');
  expect(pending('a')).toBe(0);
});

it.each([null, 42, 'invalid', {}, { leaseToken: 'test-epoch.1' }])('rejects malformed refresh op %j as a controlled admission error', op => {
  const c = setup();
  expect(() => c.refresh('u', { ops: [op] }, ['a'], '10')).toThrow(expect.objectContaining({ status: 400, code: 'count-op-invalid' }));
  expect(c.observation('u', 'a').quiescentAtStart).toBe(false);
});
