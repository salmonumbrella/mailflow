import { afterEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { api } from './api.js';
import { observeCountWrites, isCountMutationKnownNotApplied } from './countWriteTracker.js';
let generation = 0;
const oldFetch = globalThis.fetch;
const response = (status, body) => ({ status, ok: status < 400, json: async () => body });
const lease = token => ({ lease: { token, expiresInMs: 360000 } });
afterEach(() => { generation++; globalThis.fetch = oldFetch; mock.restoreAll(); });
observeCountWrites({ generation: () => generation, start() {}, idle() {} });
test('coalesces existing startup metadata with a pre-startup mutation; epoch refusal retries once with the same UUID only', async () => {
  const calls = []; let release, reads = 0, mutations = 0;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (url.endsWith('/unread-counts')) {
      reads++;
      if (reads === 1) return new Promise(r => { release = () => r(response(200, lease('server.1'))); });
      return response(200, lease('server.2'));
    }
    return ++mutations === 1 ? response(409, { code: 'count-epoch-expired', error: 'Expired' }) : response(200, { ok: true });
  };
  const startup = api.getUnreadCounts();
  const write = api.bulkArchive(['a.test']);
  void write.catch(() => {});
  await Promise.resolve();
  assert.equal(mutations, 0, 'never sends an unbound operation before lease metadata');
  release(); await startup; await write;
  assert.equal(reads, 2, 'one initial read and one explicit-refusal refresh');
  const headers = calls.filter(c => !c.url.endsWith('/unread-counts')).map(c => c.opts.headers['X-Count-Op']);
  assert.equal(headers.length, 2);
  assert.equal(headers[0].split(':')[1], headers[1].split(':')[1]);
  assert.notEqual(headers[0].split(':')[0], headers[1].split(':')[0]);
});
test('tombstones and running/replayed refusals bypass generic409 callers and never retry', async () => {
  for (const code of ['count-op-expired', 'count-op-running', 'count-op-replayed']) {
    generation++; let commands = 0;
    globalThis.fetch = async url => url.endsWith('/unread-counts') ? response(200, lease('server.1')) : (commands++, response(409, { code, error: 'Refused' }));
    await assert.rejects(api.bulkArchive(['a.test']), error => {
      assert.equal(error.code, code); assert.equal(error.httpStatus, 409); assert.notEqual(error.status, 409);
      assert.equal(isCountMutationKnownNotApplied(error), code === 'count-op-expired'); return true;
    });
    assert.equal(commands, 1);
  }
});
test('a real generic409 keeps existing GTD only-copy handling and is not a proven rollback', async () => {
  globalThis.fetch = async url => url.endsWith('/unread-counts') ? response(200, lease('server.1')) : response(409, { error: 'Only copy', onlyCopy: true });
  await assert.rejects(api.post('/gtd/done', { id: 'a.test' }), error => error.status === 409 && !isCountMutationKnownNotApplied(error));
});
for (const [method, path, write] of [
  ['POST', '/gtd/classify', () => api.gtdClassify('residue.test', 'next')],
  ['POST', '/gtd/classify/undo', () => api.gtdUndoClassify({ messageId: 'residue.test' })],
  ['DELETE', '/gtd/classify', () => api.gtdUnclassify('residue.test', 'next')],
  ['POST', '/gtd/done', () => api.gtdDone('residue.test', ['next'])],
]) {
  test(`${method} ${path}: an explicit pre-write residue refusal is not applied and never retried`, async () => {
    const commands = [];
    globalThis.fetch = async (url, opts) => {
      if (url.endsWith('/unread-counts')) return response(200, lease('residue.test.1'));
      commands.push({ url, method: opts.method });
      return response(409, { code: 'archive-residue-read-only', error: 'This action is not supported for archive residue' });
    };
    await assert.rejects(write(), error => {
      assert.equal(isCountMutationKnownNotApplied(error), true);
      assert.equal(error.code, 'archive-residue-read-only');
      assert.equal(error.httpStatus, 409);
      assert.equal(error.status, undefined, 'recognized residue refusal must not enter legacy only-copy409 handling');
      assert.equal(error.message, 'This action is not supported for archive residue');
      return true;
    });
    assert.deepEqual(commands, [{ url: `/api${path}`, method }]);
  });
}
for (const [method, path, status, code] of [
  ['POST', '/mail/messages/bulk-archive', 409, 'archive-residue-read-only'],
  ['PATCH', '/gtd/classify', 409, 'archive-residue-read-only'],
  ['GET', '/gtd/done', 409, 'archive-residue-read-only'],
  ['POST', '/gtd/classify/undo/extra', 409, 'archive-residue-read-only'],
  ['POST', '/gtd/done', 500, 'archive-residue-read-only'],
  ['POST', '/gtd/done', 409, 'other-refusal'],
  ['POST', '/gtd/done', 409, 'count-op-running'],
  ['POST', '/gtd/done', 409, 'count-op-replayed'],
]) {
  test(`${method} ${path} ${status} ${code}: no unrelated refusal gains residue rollback proof`, async () => {
    let commands = 0;
    globalThis.fetch = async url => url.endsWith('/unread-counts')
      ? response(200, lease('residue.test.1')) : (commands++, response(status, { code, error: 'Refused' }));
    await assert.rejects(api[method.toLowerCase()](path, { messageId: 'residue.test' }), error => {
      assert.equal(isCountMutationKnownNotApplied(error), false);
      assert.equal(error.status, code.startsWith('count-') ? undefined : status, 'unrecognized residue responses retain existing status behavior');
      assert.equal(error.httpStatus, status);
      assert.equal(error.code, code);
      return true;
    });
    assert.equal(commands, 1);
  });
}
for (const [code, body] of [['archive-residue-read-only', 'gtd.state.next'], [undefined, 'gtd.onlyCopy']]) {
  test(`existing GTD unclassify wording distinguishes ${code || 'ordinary only-copy409'}`, async () => {
    const { unclassifyThread } = await import('./gtd.js');
    const notifications = [];
    let commands = 0;
    mock.method(console, 'error', () => {});
    globalThis.fetch = async url => url.endsWith('/unread-counts') ? response(200, lease('residue.test.1'))
      : (commands++, response(409, { code, error: code ? 'This action is not supported for archive residue' : 'Only copy' }));
    await unclassifyThread('residue.test', 'next', { gtdUnclassify: api.gtdUnclassify,
      addNotification: value => notifications.push(value), scheduleGtdSectionsFetch() {}, t: key => key });
    assert.deepEqual(notifications, [{ title: 'gtd.removeFailed', body }]);
    assert.equal(commands, 1);
  });
}
test('network/5xx uncertainty never retries or claims not-applied; pre-write read validation may roll back', async () => {
  for (const outcome of ['network', 500, 400]) {
    generation++; let commands = 0;
    globalThis.fetch = async url => {
      if (url.endsWith('/unread-counts')) return response(200, lease('server.1'));
      commands++;
      if (outcome === 'network') throw new TypeError('Connection reset');
      return response(outcome, { error: 'Failed' });
    };
    await assert.rejects(api.patch('/mail/messages/a.test/read', { read: false }), error => isCountMutationKnownNotApplied(error) === (outcome === 400));
    assert.equal(commands, 1);
  }
});
test('a generation change while bootstrap is held prevents old-session dispatch', async () => {
  let release, commands = 0;
  globalThis.fetch = async url => url.endsWith('/unread-counts') ? new Promise(r => { release = () => r(response(200, lease('server.1'))); }) : (commands++, response(200, {}));
  const write = api.bulkArchive(['a.test']);
  void write.catch(() => {});
  for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
  assert.equal(typeof release, 'function', 'bootstrap begins before mutation dispatch');
  generation++; release();
  await assert.rejects(write, error => error.code === 'count-session-ended' && isCountMutationKnownNotApplied(error));
  assert.equal(commands, 0);
});
test('a repeated epoch refusal stops after exactly one metadata refresh and one retry', async () => {
  let reads = 0, commands = 0;
  globalThis.fetch = async url => url.endsWith('/unread-counts') ? (reads++, response(200, lease(`server.${reads}`))) : (commands++, response(409, { code: 'count-epoch-expired', error: 'Expired' }));
  await assert.rejects(api.bulkArchive(['a.test']), error => error.code === 'count-epoch-expired' && isCountMutationKnownNotApplied(error));
  assert.equal(reads, 2); assert.equal(commands, 2);
});
test('after server done-record purge, the funnel never replays completed UUIDs and retries only its new refused attempt', async () => {
  const { CountCompletion, COUNT_LEASE_MS } = await import('../../../backend/src/services/countCompletion.js');
  let mono = 0, commands = 0; const server = new CountCompletion({ now: () => mono }); const headers = [];
  globalThis.fetch = async (url, opts) => {
    if (url.endsWith('/unread-counts')) return response(200, { lease: server.lease() });
    const id = opts.headers['X-Count-Op']; headers.push(id);
    try { await server.run('fixture-user.test', id, () => { commands++; }); return response(200, {}); }
    catch (error) { return response(error.status, { code: error.code, error: error.message }); }
  };
  await api.bulkArchive(['first.test']);
  mono = COUNT_LEASE_MS + 1;
  await api.bulkArchive(['second.test']);
  assert.equal(commands, 2);
  assert.equal(headers.length, 3);
  assert.notEqual(headers[0].split(':')[1], headers[1].split(':')[1]);
  assert.equal(headers[1].split(':')[1], headers[2].split(':')[1]);
});
