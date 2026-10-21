import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCountWriteTracker } from './countWriteTracker.js';

function setup() {
  let generation = 1, accounts = ['a', 'b'];
  const starts = [], idle = [];
  const tracker = createCountWriteTracker({
    generation: () => generation, accounts: () => accounts,
    loadLease: async () => ({ lease: { token: 'scope.test.1', expiresInMs: 360000 } }),
    start: event => starts.push(event), idle: event => idle.push(event),
  });
  return { tracker, starts, idle, reset: () => generation++, roster: ids => { accounts = ids; } };
}

test('no-origin scope starts before queue dispatch and is bounded by enabled owned accounts', () => {
  const { tracker, starts, idle } = setup();
  const end = tracker.beginIntent(['a', 'a', 'foreign', null]);
  assert.deepEqual(starts.at(-1).accountIds, ['a']);
  assert.equal(tracker.inspect().inFlight, 0);
  assert.equal(tracker.inspect().localIntents, 1);
  assert.equal(idle.length, 0, 'a queued write cannot be certified early');
  end(); end();
  assert.equal(tracker.inspect().localIntents, 0);
  assert.deepEqual(idle.at(-1).accountIds, ['a']);
  assert.deepEqual(tracker.inspect().accountIds, ['a'], 'HTTP idle does not discard observation scope');
  tracker.acknowledge(tracker.inspect().version);
  assert.deepEqual(tracker.inspect().accountIds, []);
});

test('resolved accounts extend the same held lifetime without a new version or early certification', () => {
  const { tracker, starts, idle, roster } = setup();
  const end = tracker.beginIntent(['a']);
  const version = tracker.inspect().version;
  assert.equal(typeof end.addAccounts, 'function');
  assert.equal(end.addAccounts(['b', 'b', 'foreign']), true);
  assert.equal(end.addAccounts(['a', 'b']), false);
  assert.equal(tracker.inspect().version, version);
  assert.equal(tracker.inspect().localIntents, 1);
  assert.equal(starts.length, 2, 'only a changed scope republishes the start');
  assert.deepEqual(starts.at(-1).accountIds, ['a', 'b']);
  tracker.acknowledge(version);
  assert.deepEqual(tracker.inspect().accountIds, ['a', 'b'], 'a held intent prevents acknowledgment');
  assert.equal(idle.length, 0);
  end();
  assert.deepEqual(idle.at(-1).accountIds, ['a', 'b']);
  roster(['a', 'b', 'c']);
  assert.equal(end.addAccounts(['c']), false, 'an ended intent cannot register newly eligible scope');
});

test('generation reset rejects old additions and old double-end without affecting the new lifetime', () => {
  const { tracker, reset, starts } = setup();
  const old = tracker.beginIntent(['a']);
  assert.equal(typeof old.addAccounts, 'function');
  reset();
  assert.deepEqual(tracker.inspect().accountIds, []);
  const next = tracker.beginIntent(['b']);
  const publications = starts.length;
  assert.equal(old.addAccounts(['a']), false);
  old(); old();
  assert.equal(starts.length, publications);
  assert.equal(tracker.inspect().localIntents, 1);
  assert.deepEqual(tracker.inspect().accountIds, ['b']);
  next();
});

test('removed account scope is excluded while the healthy account remains observable', () => {
  const { tracker, roster, starts } = setup();
  const end = tracker.beginIntent(['a']);
  assert.equal(typeof end.addAccounts, 'function');
  roster(['b']);
  assert.equal(end.addAccounts(['a', 'b', 'foreign']), true);
  assert.deepEqual(starts.at(-1).accountIds, ['b']);
  assert.deepEqual(tracker.inspect().accountIds, ['b']);
  end();
});

test('uncertain HTTP and an internal epoch retry keep the originating scope until final completion', async () => {
  const { tracker, idle } = setup();
  const end = tracker.beginIntent(['a']);
  let calls = 0;
  await assert.rejects(tracker.track('PATCH', '/mail/messages/id/read', async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('expired lease'), { code: 'count-epoch-expired', notApplied: true });
    throw new Error('network outcome uncertain');
  }), /network outcome uncertain/);
  assert.equal(calls, 2);
  assert.equal(idle.length, 0, 'the caller still owns the queued/funnel lifetime');
  assert.equal(tracker.inspect().localIntents, 1);
  assert.deepEqual(tracker.inspect().accountIds, ['a']);
  end();
  assert.equal(idle.length, 1);
  assert.deepEqual(idle[0].accountIds, ['a']);
});
