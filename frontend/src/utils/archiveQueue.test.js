import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createArchiveQueue } from './archiveQueue.js';
test('coalesces only due targets, caps each account batch at 50 and preserves actual partial-success targets', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  try {
    const calls = [];
    const queue = createArchiveQueue(async ids => {
      calls.push(ids);
      return { archived: ids.filter(id => id !== '2'), countTargets: ids.filter(id => id !== '2').map(id => ({ id, account_id: 'a', folder: 'INBOX' })) };
    });
    const jobs = Array.from({ length: 111 }, (_, i) => queue([{ id: String(i), account_id: 'a' }]));
    assert.equal(calls.length, 0);
    mock.timers.tick(1);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    const results = await Promise.all(jobs);
    assert.deepEqual(calls.map(ids => ids.length), [50, 50, 11]);
    assert.equal(results[2].archived.length, 0);
    assert.equal(results[0].countTargets[0].id, '0');
    assert.equal(results[110].countTargets[0].id, '110');
  } finally { mock.timers.reset(); }
});

test('a lost archive response is unconfirmed rather than a confirmed provider failure', async () => {
  const queue = createArchiveQueue(async () => { throw new Error('network lost'); });
  const result = await queue([{ id: 'unknown', account_id: 'a' }]);
  assert.deepEqual(result.unconfirmed, ['unknown']);
  assert.deepEqual(result.countTargets, []);
});

test('only confirmed actual batches refresh; a session switch cancels later chunks', async () => {
  let generation = 1, release;
  const calls = [], refreshed = [];
  const queue = createArchiveQueue(async ids => {
    calls.push(ids);
    if (calls.length === 1) await new Promise(resolve => { release = resolve; });
    return { archived: ids, countTargets: ids.map(id => ({ id, account_id: 'a', folder: 'INBOX' })) };
  }, { currentGeneration: () => generation, onBatch: (result, targets, captured) => refreshed.push({ result, targets, captured }) });
  const pending = queue(Array.from({ length: 111 }, (_, i) => ({ id: String(i), account_id: 'a' })), 1);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls.length, 1);
  generation = 2; release();
  await pending;
  assert.equal(calls.length, 1, 'old-user work must never dispatch the remaining chunks');
  assert.equal(refreshed.length, 0, 'old-user responses must not refresh the new user list');
});
test('one refresh per confirmed batch, no count attribution or refresh from no-op IDs', async () => {
  const refreshed = [];
  const queue = createArchiveQueue(async ids => ({ archived: ids, countTargets: ids[0] === 'no-op' ? [] : ids.map(id => ({ id, account_id: 'a', folder: 'INBOX' })) }), {
    currentGeneration: () => 1, onBatch: (result, targets) => refreshed.push(targets.map(t => t.id)),
  });
  const results = await Promise.all(Array.from({ length: 111 }, (_, i) => queue([{ id: String(i), account_id: 'a' }], 1)));
  assert.equal(refreshed.length, 3);
  assert.equal(results.flatMap(r => r.countTargets).length, 111);
  const noop = await queue([{ id: 'no-op', account_id: 'a' }], 1);
  assert.deepEqual(noop.countTargets, []);
  assert.equal(refreshed.length, 3);
});
test('explicit not-applied failure rolls back only that batch; uncertain failure stays unconfirmed', async () => {
  const known = createArchiveQueue(async () => { throw Object.assign(new Error('refused'), { notApplied: true }); });
  const result = await known([{ id: 'refused', account_id: 'a' }]);
  assert.deepEqual(result.unconfirmed, []);
  assert.equal(result.error.notApplied, true);
});

test('HTTP200 preserves chunk-owned uncertain writer-fence IDs alongside actual confirmed targets', async () => {
  const actual = { id: 'confirmed', account_id: 'a', folder: 'INBOX' };
  const queue = createArchiveQueue(async () => ({ archived: ['confirmed'], countTargets: [actual], unconfirmed: ['fence-rejected', 'foreign'] }));
  const [confirmed, uncertain] = await Promise.all([queue([actual]), queue([{ id: 'fence-rejected', account_id: 'a', folder: 'INBOX' }])]);
  assert.deepEqual(confirmed.archived, ['confirmed']);
  assert.deepEqual(confirmed.countTargets, [actual]);
  assert.deepEqual(confirmed.unconfirmed, []);
  assert.deepEqual(uncertain.archived, []);
  assert.deepEqual(uncertain.countTargets, []);
  assert.deepEqual(uncertain.unconfirmed, ['fence-rejected']);
});
