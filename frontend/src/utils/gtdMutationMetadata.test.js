import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { classifyWithUndo } from './gtdClassification.js';
import { doneGtdRow } from './gtdDone.js';
import {
  clearGtdMetadata, fetchVisibleGtdMetadata, getGtdMetadata,
  getGtdMetadataRefreshGeneration,
} from '../plugins/gtd/metadataStore.js';
import {
  clearGtdRemovalGuard, completedGtdRemovalMap, pendingGtdRemovalMap,
  setCompletedGtdRemoval, applyGtdRemovalGuard,
} from './pendingGtdRemovals.js';

const message = {
  id: 'mutation-a', account_id: 'account-a', thread_key: 'thread-a',
  message_id: '<mutation@synthetic.test>', date: '2026-10-20T12:00:00.000Z',
};
const sibling = { ...message, id: 'sibling-a' };
const other = { ...message, id: 'mutation-b', account_id: 'account-b' };
const metadata = state => ({ states: [state], dates: { [state]: message.date }, date: message.date });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function seed(state = 'todo') {
  await fetchVisibleGtdMetadata([message, sibling, other], {
    api: { gtdMetadata: async (_account, ids) => ({ messages: Object.fromEntries(ids.map(id => [id, metadata(state)])) }) },
  });
}
function harness(result = { ok: true, applied: true }) {
  const notices = [];
  const store = {
    selectedMessageId: null, scheduleGtdSectionsFetch() {},
    dismissUndoNotifications() {}, removeMessage() {}, setSelectedMessage() {},
    addNotification: notice => notices.push(notice),
  };
  const api = { gtdClassify: async () => result, gtdUndoClassify: async () => ({ ok: true }) };
  return { api, store, message, t: key => key, notices };
}
function doneDeps(request) {
  return {
    gtdDone: request, removeGtdThread: () => ({ captured: true }),
    restoreGtdThread() {}, addNotification() {}, scheduleGtdSectionsFetch() {}, t: key => key,
  };
}
afterEach(() => {
  clearGtdMetadata();
  for (const entry of [...pendingGtdRemovalMap.values(), ...completedGtdRemovalMap.values()]) {
    clearGtdRemovalGuard(entry.identity, entry.states);
  }
  mock.restoreAll();
});

describe('current GTD mutations use the shared metadata producer', () => {
  for (const applied of [true, false]) {
    it(`patches successful non-switch classification and preserves account scope (applied=${applied})`, async () => {
      await seed();
      const before = getGtdMetadataRefreshGeneration();
      const h = harness({ ok: true, applied });
      await classifyWithUndo(message.id, 'watch', h);
      const expected = { states: ['todo', 'watch'], dates: { todo: message.date, watch: message.date }, date: message.date };
      assert.deepEqual(getGtdMetadata(message.id), expected);
      assert.deepEqual(getGtdMetadata(sibling.id), expected);
      assert.deepEqual(getGtdMetadata(other.id), metadata('todo'));
      assert.equal(getGtdMetadataRefreshGeneration(), before + 1);
    });
  }

  it('uses the visible row for the message-id-only caller', async () => {
    await seed();
    const h = harness();
    delete h.message;
    await classifyWithUndo(message.id, 'watch', h);
    assert.deepEqual(getGtdMetadata(message.id).states, ['todo', 'watch']);
    assert.deepEqual(getGtdMetadata(sibling.id).states, ['todo', 'watch']);
    assert.deepEqual(getGtdMetadata(other.id).states, ['todo']);
  });

  for (const outcome of ['switch', 'failure']) {
    it(`refreshes related metadata after classification ${outcome}`, async () => {
      mock.method(console, 'error', () => {});
      await seed();
      const before = getGtdMetadataRefreshGeneration();
      const h = harness({ ok: true, applied: true, switched: true });
      if (outcome === 'failure') h.api.gtdClassify = async () => { throw new Error('uncertain'); };
      await classifyWithUndo(message.id, 'watch', h);
      assert.equal(getGtdMetadata(message.id), null);
      assert.equal(getGtdMetadata(sibling.id), null);
      assert.deepEqual(getGtdMetadata(other.id), metadata('todo'));
      assert.equal(getGtdMetadataRefreshGeneration(), before + 1);
    });
  }

  for (const outcome of ['success', 'switch', 'failure']) {
    it(`does not mutate the new metadata session after stale classify ${outcome}`, async () => {
      mock.method(console, 'error', () => {});
      await seed();
      const request = deferred();
      const h = harness();
      h.api.gtdClassify = () => request.promise;
      const pending = classifyWithUndo(message.id, 'watch', h);
      clearGtdMetadata();
      await seed('reference');
      const before = getGtdMetadataRefreshGeneration();
      if (outcome === 'failure') request.reject(new Error('uncertain'));
      else request.resolve({ ok: true, applied: true, switched: outcome === 'switch' });
      await pending;
      assert.deepEqual(getGtdMetadata(message.id), metadata('reference'));
      assert.deepEqual(getGtdMetadata(sibling.id), metadata('reference'));
      assert.equal(getGtdMetadataRefreshGeneration(), before);
    });
  }

  for (const outcome of ['success', 'failure']) {
    it(`captures metadata session at Undo invocation and refreshes on ${outcome}`, async () => {
      mock.method(console, 'error', () => {});
      await seed();
      const h = harness({ ok: true, applied: true, undoToken: { uid: 42 } });
      await classifyWithUndo(message.id, 'watch', h);
      const undo = h.notices[0].onUndo;
      clearGtdMetadata();
      await seed('reference');
      const before = getGtdMetadataRefreshGeneration();
      if (outcome === 'failure') h.api.gtdUndoClassify = async () => { throw new Error('uncertain undo'); };
      assert.equal(await undo(), outcome === 'success');
      assert.equal(getGtdMetadata(message.id), null);
      assert.equal(getGtdMetadata(sibling.id), null);
      assert.deepEqual(getGtdMetadata(other.id), metadata('reference'));
      assert.equal(getGtdMetadataRefreshGeneration(), before + 1);
      assert.equal(await undo(), false);
      assert.equal(getGtdMetadataRefreshGeneration(), before + 1);
    });

    it(`ignores stale Undo ${outcome} after its invocation session ends`, async () => {
      mock.method(console, 'error', () => {});
      await seed();
      const h = harness({ ok: true, applied: true, undoToken: { uid: 42 } });
      await classifyWithUndo(message.id, 'watch', h);
      const request = deferred();
      h.api.gtdUndoClassify = () => request.promise;
      const pending = h.notices[0].onUndo();
      clearGtdMetadata();
      await seed('reference');
      const before = getGtdMetadataRefreshGeneration();
      if (outcome === 'failure') request.reject(new Error('uncertain undo'));
      else request.resolve({ ok: true });
      await pending;
      assert.deepEqual(getGtdMetadata(message.id), metadata('reference'));
      assert.equal(getGtdMetadataRefreshGeneration(), before);
    });
  }

  for (const outcome of ['success', 'partial', 'remaining', 'failure']) {
    it(`refreshes metadata in Done finally and preserves removal outcome on ${outcome}`, async () => {
      mock.method(console, 'error', () => {});
      await seed();
      const before = getGtdMetadataRefreshGeneration();
      let restored = 0;
      const result = { ok: true, archiveFailed: outcome === 'partial', threadRemains: outcome === 'remaining' };
      const deps = doneDeps(async () => {
        if (outcome === 'failure') throw new Error('uncertain Done');
        return result;
      });
      deps.restoreGtdThread = () => { restored += 1; };
      assert.deepEqual(await doneGtdRow(message, ['watch'], deps), outcome === 'failure' ? null : result);
      assert.equal(getGtdMetadata(message.id), null);
      assert.equal(getGtdMetadata(sibling.id), null);
      assert.deepEqual(getGtdMetadata(other.id), metadata('todo'));
      assert.equal(getGtdMetadataRefreshGeneration(), before + 1);
      assert.equal(pendingGtdRemovalMap.size, 0);
      assert.equal(completedGtdRemovalMap.size, ['success', 'partial'].includes(outcome) ? 1 : 0);
      assert.equal(restored, outcome === 'failure' ? 1 : 0);
    });
  }

  for (const fails of [false, true]) {
    it(`does not clear new-session metadata after stale Done (fails=${fails})`, async () => {
      mock.method(console, 'error', () => {});
      await seed();
      const request = deferred();
      const pending = doneGtdRow(message, ['watch'], doneDeps(() => request.promise));
      clearGtdMetadata();
      await seed('reference');
      const before = getGtdMetadataRefreshGeneration();
      if (fails) request.reject(new Error('uncertain Done'));
      else request.resolve({ ok: true });
      await pending;
      assert.deepEqual(getGtdMetadata(message.id), metadata('reference'));
      assert.equal(getGtdMetadataRefreshGeneration(), before);
    });
  }

  it('keeps the classification lock and applied-only removal release', async () => {
    await seed();
    setCompletedGtdRemoval(message.message_id, ['watch']);
    const request = deferred();
    const h = harness();
    let calls = 0;
    h.api.gtdClassify = () => { calls += 1; return request.promise; };
    const pending = classifyWithUndo(message.id, 'watch', h);
    const before = getGtdMetadataRefreshGeneration();
    assert.equal(await classifyWithUndo(message.id, 'watch', h), null);
    assert.equal(calls, 1);
    assert.equal(getGtdMetadataRefreshGeneration(), before);
    request.resolve({ ok: true, applied: false });
    await pending;
    const sections = { watch: { threads: [message], total: 1, unread: 0 } };
    assert.deepEqual(applyGtdRemovalGuard(sections).watch.threads, []);
    h.api.gtdClassify = async () => ({ ok: true, applied: true });
    await classifyWithUndo(message.id, 'watch', h);
    assert.deepEqual(applyGtdRemovalGuard(sections).watch.threads, [message]);
  });
});
