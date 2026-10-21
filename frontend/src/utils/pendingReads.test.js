import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setReadIntentSession, beginReadIntent, settleReadIntent,
  captureReadRequest, reconcileReadState,
  queueReadWrite, isCurrentReadIntent, completeReadIntent,
} from './pendingReads.js';

const message = { id: 'm', account_id: 'a', message_id: '<m@synthetic.test>', thread_id: 't', is_read: true };
beforeEach(() => setReadIntentSession(Symbol('session')));

test('a pending unread intent defeats a list request issued even after the click', () => {
  beginReadIntent(message, false);
  const rows = [message];
  const result = reconcileReadState(rows, captureReadRequest());
  assert.equal(result[0].is_read, false);
  assert.equal(rows[0].is_read, true, 'reconciliation must not mutate a server response');
});

test('request issuance, not completion time or a grace timer, decides authority', () => {
  const before = captureReadRequest();
  const intent = beginReadIntent(message, false);
  const during = captureReadRequest();
  settleReadIntent(intent);
  assert.equal(reconcileReadState([message], before)[0].is_read, false);
  assert.equal(reconcileReadState([message], during)[0].is_read, false);
  assert.equal(reconcileReadState([message])[0].is_read, false, 'missing token is conservative');
  const after = captureReadRequest();
  assert.equal(reconcileReadState([message], after)[0].is_read, true, 'new authoritative read may change the flag immediately');
});

test('an older post-completion response cannot reverse a newer authoritative response', () => {
  const intent = beginReadIntent(message, false);
  settleReadIntent(intent);
  const first = captureReadRequest();
  const second = captureReadRequest();
  reconcileReadState([{ ...message, is_read: false }], second);
  assert.equal(reconcileReadState([message], first)[0].is_read, false);
});

test('an obsolete automatic read completion cannot settle the explicit unread', () => {
  const automatic = beginReadIntent({ ...message, is_read: false }, true);
  const explicit = beginReadIntent(message, false);
  assert.equal(settleReadIntent(automatic), false);
  assert.equal(reconcileReadState([message], captureReadRequest())[0].is_read, false);
  assert.equal(settleReadIntent(explicit), true);
});

test('a same-id row or same Message-ID in another account is untouched', () => {
  beginReadIntent(message, false);
  const otherAccount = { ...message, account_id: 'b' };
  const otherCopy = { ...message, id: 'copy' };
  const result = reconcileReadState([otherAccount, message, otherCopy], captureReadRequest());
  assert.equal(result[0], otherAccount);
  assert.equal(result[2], otherCopy);
  assert.deepEqual(result.map(row => [row.account_id, row.id, row.thread_id]), [['b', 'm', 't'], ['a', 'm', 't'], ['a', 'copy', 't']]);
});

test('logout invalidates old operations and request tokens even when the next login has the same user', () => {
  const old = beginReadIntent(message, false);
  const oldRequest = captureReadRequest();
  setReadIntentSession(Symbol('same user, new session'));
  const current = beginReadIntent(message, false);
  settleReadIntent(current);
  assert.equal(settleReadIntent(old, true), false);
  assert.equal(reconcileReadState([message], oldRequest)[0].is_read, false);
  assert.equal(reconcileReadState([message], captureReadRequest())[0].is_read, true);
});

test('settling a current rollback retains a fence against earlier unread snapshots', () => {
  const intent = beginReadIntent(message, false);
  const old = captureReadRequest();
  settleReadIntent(intent, true);
  assert.equal(reconcileReadState([{ ...message, is_read: false }], old)[0].is_read, true);
});

test('all short read/unread sequences preserve the latest pending intent and row topology', () => {
  for (let length = 1; length <= 5; length++) {
    for (let mask = 0; mask < 2 ** length; mask++) {
      setReadIntentSession(Symbol('case'));
      const operations = [];
      for (let i = 0; i < length; i++) operations.push(beginReadIntent(message, Boolean(mask & (1 << i))));
      for (const old of operations.slice(0, -1).reverse()) assert.equal(settleReadIntent(old), false);
      const expected = Boolean(mask & (1 << (length - 1)));
      const untouched = { ...message, id: 'untouched', is_read: !expected };
      const rows = [untouched, { ...message, is_read: !expected }];
      const result = reconcileReadState(rows, captureReadRequest());
      assert.equal(result.length, 2);
      assert.equal(result[0], untouched);
      assert.equal(result[1].is_read, expected, `length=${length}, mask=${mask}`);
      assert.deepEqual(Object.keys(result[1]), Object.keys(rows[1]));
    }
  }
});

test('unchanged batches preserve their array and object identities', () => {
  const empty = [];
  const rows = [message];
  assert.equal(reconcileReadState(empty), empty);
  assert.equal(reconcileReadState(rows), rows);
  beginReadIntent(message, true);
  assert.equal(reconcileReadState(rows), rows);
});

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('an unread write cannot reach the provider before the earlier read finishes', async () => {
  const first = deferred();
  const calls = [];
  let providerRead = false;
  const read = beginReadIntent(message, true);
  const reading = queueReadWrite(read, async () => { calls.push(true); await first.promise; providerRead = true; });
  const unread = beginReadIntent(message, false);
  const unreading = queueReadWrite(unread, async () => { calls.push(false); providerRead = false; });
  await Promise.resolve();
  assert.deepEqual(calls, [true]);
  first.resolve();
  await Promise.all([reading, unreading]);
  assert.deepEqual(calls, [true, false]);
  assert.equal(providerRead, false);
});

test('a failed older write does not prevent the next intent from reaching the provider', async () => {
  const rejected = Object.assign(new Error('refused'), { status: 400, notApplied: true });
  const reading = queueReadWrite(beginReadIntent(message, true), () => Promise.reject(rejected));
  let providerRead = true;
  const unreading = queueReadWrite(beginReadIntent(message, false), async () => { providerRead = false; });
  await assert.rejects(reading, error => error === rejected);
  await unreading;
  assert.equal(providerRead, false);
});

test('a pending funnel retry is observed as one write until its final promise succeeds', async () => {
  const retry = deferred();
  const intent = beginReadIntent(message, false);
  let funnelCalls = 0;
  let providerRead = true;
  const writing = queueReadWrite(intent, async () => {
    // The API funnel owns both attempts and exposes one promise to the protocol.
    funnelCalls++;
    await retry.promise;
    providerRead = false;
  }).then(() => settleReadIntent(intent));
  await Promise.resolve();
  assert.equal(reconcileReadState([message], captureReadRequest())[0].is_read, false);
  retry.resolve();
  await writing;
  assert.equal(funnelCalls, 1, 'the read protocol must not retry the funnel itself');
  assert.equal(providerRead, false);
  assert.equal(reconcileReadState([{ ...message, is_read: false }], captureReadRequest())[0].is_read, false);
});

test('another account can write while the first account is waiting', async () => {
  const waiting = deferred();
  const first = queueReadWrite(beginReadIntent(message, false), () => waiting.promise);
  let otherWritten = false;
  await queueReadWrite(beginReadIntent({ ...message, account_id: 'b' }, false), async () => { otherWritten = true; });
  assert.equal(otherWritten, true);
  waiting.resolve();
  await first;
});

test('logout prevents a queued write from being sent with the next session credentials', async () => {
  const waiting = deferred();
  const first = queueReadWrite(beginReadIntent(message, true), () => waiting.promise);
  await Promise.resolve();
  let queuedSent = false;
  const queued = queueReadWrite(beginReadIntent(message, false), async () => { queuedSent = true; });
  setReadIntentSession(Symbol('new login'));
  waiting.resolve();
  await Promise.all([first, queued]);
  assert.equal(queuedSent, false);
});


for (const state of ['queued', 'dispatched', 'completed']) {
  test(`late bulk resolution preserves a newer ${state} unread member`, async () => {
    const bulk = beginReadIntent(message, true);
    const sibling = { ...message, id: 'child' };
    const latest = beginReadIntent(sibling, false);
    const hold = deferred();
    const writes = [];
    const single = queueReadWrite(latest, async () => {
      writes.push('unread');
      if (state !== 'completed') await hold.promise;
      completeReadIntent(latest);
    });
    if (state !== 'queued') await Promise.resolve();
    if (state === 'completed') await single;
    let unrelated = false;
    const independent = queueReadWrite(beginReadIntent({ ...message, id: 'unrelated' }, true), async () => { unrelated = true; });
    const enrolled = beginReadIntent(sibling, true, bulk.order);
    assert.equal(isCurrentReadIntent(enrolled), false);
    const batch = queueReadWrite([bulk, enrolled], async () => {
      const active = [bulk, enrolled].filter(isCurrentReadIntent);
      writes.push(active.map(intent => JSON.parse(intent.key)[1]));
      active.forEach(intent => completeReadIntent(intent));
    });
    await independent;
    assert.equal(unrelated, true, 'unresolved bulk does not block its account');
    hold.resolve();
    await Promise.all([single, batch]);
    assert.deepEqual(writes, ['unread', ['m']]);
    assert.equal(reconcileReadState([sibling])[0].is_read, false);
  });
}

test('bulk shares member queues while another account remains independent', async () => {
  const hold = deferred();
  const calls = [];
  const a = beginReadIntent(message, true);
  const b = beginReadIntent({ ...message, id: 'child' }, true);
  const bulk = queueReadWrite([a, b], async () => { calls.push('bulk'); await hold.promise; });
  const later = queueReadWrite(beginReadIntent(message, false), async () => calls.push('unread'));
  await queueReadWrite(beginReadIntent({ ...message, account_id: 'b' }, false), async () => calls.push('other'));
  assert.deepEqual(calls, ['bulk', 'other']);
  hold.resolve();
  await Promise.all([bulk, later]);
  assert.deepEqual(calls, ['bulk', 'other', 'unread']);
});


for (const reverse of [false, true]) {
  test(`overlapping bulk expansions retain newer intent when resolution order is ${reverse ? 'reversed' : 'forward'}`, async () => {
    const first = beginReadIntent({ ...message, id: 'first' }, true);
    const second = beginReadIntent({ ...message, id: 'second' }, false);
    const shared = { ...message, id: 'shared' };
    const provider = new Map();
    const expand = (operation, read) => {
      const member = beginReadIntent(shared, read, operation.order);
      return queueReadWrite([operation, member].filter(isCurrentReadIntent), async () => {
        for (const intent of [operation, member].filter(isCurrentReadIntent)) {
          provider.set(intent.key, read);
          completeReadIntent(intent);
        }
      });
    };
    const pending = reverse ? [expand(second, false), expand(first, true)] : [expand(first, true), expand(second, false)];
    await Promise.all(pending);
    assert.equal(provider.get(JSON.stringify(['a', 'shared'])), false);
    assert.equal(reconcileReadState([shared])[0].is_read, false);
  });
}

test('an earlier member write precedes bulk rejection, then a later unread still dispatches', async () => {
  const hold = deferred();
  const calls = [];
  const early = queueReadWrite(beginReadIntent(message, false), async () => { calls.push('early'); await hold.promise; });
  const bulk = queueReadWrite([beginReadIntent(message, true)], async () => { calls.push('bulk'); throw Object.assign(new Error('refused'), { notApplied: true }); });
  const rejected = assert.rejects(bulk, /refused/);
  const last = queueReadWrite(beginReadIntent(message, false), async () => calls.push('last'));
  await Promise.resolve();
  assert.deepEqual(calls, ['early']);
  hold.resolve();
  await Promise.all([early, rejected, last]);
  assert.deepEqual(calls, ['early', 'bulk', 'last']);
});


test('count reconciliation excludes its own optimistic intent but retains the prior other action', () => {
  const older = beginReadIntent({ ...message, is_read: false }, true);
  const current = beginReadIntent(message, false);
  const rows = [{ ...message, is_read: false }];
  assert.equal(reconcileReadState(rows, undefined, { except: current.order })[0].is_read, true);
  assert.equal(reconcileReadState(rows)[0].is_read, false);
  assert.equal(isCurrentReadIntent(older), false);
  assert.equal(isCurrentReadIntent(current), true);
});
