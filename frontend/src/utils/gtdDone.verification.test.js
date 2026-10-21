import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { doneGtdRow } from './gtdDone.js';
import { classifyWithUndo } from './gtdClassification.js';
import {
  applyGtdRemovalGuard,
  clearGtdRemovalGuard,
  completedGtdRemovalMap,
  pendingGtdRemovalMap,
} from './pendingGtdRemovals.js';
import {
  removeGtdThreadFromSections,
  restoreGtdThreadRemoval,
  snapshotGtdThreadRemoval,
} from './gtd.js';

const acted = {
  id: 'watch-a', account_id: 'account-a', message_id: '<shared@synthetic.test>',
  thread_key: 'shared-thread', subject: 'Synthetic conversation', is_read: true,
};
const surviving = { ...acted, id: 'archive-a', folder: 'Archive' };
const otherAccount = { ...acted, id: 'watch-b', account_id: 'account-b' };

function sections(row, states = ['watch']) {
  return {
    watch: { total: states.includes('watch') ? 1 : 0, unread: 0, threads: states.includes('watch') ? [row] : [] },
    delegated: { total: states.includes('delegated') ? 1 : 0, unread: 0, threads: states.includes('delegated') ? [row] : [] },
    waiting: { total: states.length ? 1 : 0, unread: 0 },
  };
}

// The transport supplies section snapshots; real helpers own removal, rollback and guards.
// This harness proves frontend reconciliation only, not provider or database account isolation.
function harness(states = ['watch']) {
  let authoritative = sections(acted, states);
  let displayed = authoritative;
  const notifications = [];
  const requests = [];
  let refreshes = 0;
  const refresh = () => {
    refreshes += 1;
    displayed = applyGtdRemovalGuard(authoritative);
  };
  const store = {
    selectedMessageId: null,
    scheduleGtdSectionsFetch: refresh,
    addNotification: value => notifications.push(value),
    dismissUndoNotifications: () => {},
    removeMessage: () => {},
    setSelectedMessage: () => {},
  };
  const deps = {
    gtdDone: async (id, requestedStates) => {
      requests.push({ id, states: requestedStates });
      authoritative = sections(acted, []);
      return { ok: true };
    },
    removeGtdThread: (identity, removedStates) => {
      const snapshot = snapshotGtdThreadRemoval(displayed, identity, removedStates);
      displayed = removeGtdThreadFromSections(displayed, identity, removedStates);
      return snapshot;
    },
    restoreGtdThread: snapshot => { displayed = restoreGtdThreadRemoval(displayed, snapshot); },
    addNotification: store.addNotification,
    scheduleGtdSectionsFetch: refresh,
    t: key => key,
  };
  return {
    deps, requests, notifications, refresh,
    get displayed() { return displayed; },
    get refreshes() { return refreshes; },
    supply: value => { authoritative = value; },
    classify: (result = { ok: true, applied: true }, message = surviving) => classifyWithUndo(message.id, 'watch', {
      api: { gtdClassify: async () => result }, store, message, t: key => key,
    }),
  };
}

beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
afterEach(() => {
  for (const removal of [...pendingGtdRemovalMap.values(), ...completedGtdRemovalMap.values()]) {
    clearGtdRemovalGuard(removal.identity, removal.states);
  }
  mock.timers.reset();
  mock.restoreAll();
});

describe('Done reconciliation verification', () => {
  it('targets the clicked row and allows the other account head back after expiry and refetch', async () => {
    const h = harness();
    await doneGtdRow(acted, ['watch'], h.deps);
    assert.deepEqual(h.requests, [{ id: 'watch-a', states: ['watch'] }]);
    const other = sections(otherAccount);
    const before = structuredClone(other);
    h.supply(other);
    h.refresh();
    // Existing unified identity masks B temporarily; this does not authorize mutating B.
    assert.deepEqual(h.displayed.watch.threads, []);
    assert.deepEqual(other, before);
    mock.timers.tick(10_001);
    h.refresh();
    assert.deepEqual(h.displayed.watch.threads, [otherAccount]);
    assert.equal(h.displayed.watch.total, 1);
    assert.equal(h.displayed.waiting.total, 1);
  });

  it('distinguishes guard expiry from a new authoritative refresh', async () => {
    const h = harness();
    await doneGtdRow(acted, ['watch'], h.deps);
    h.supply(sections(otherAccount));
    h.refresh();
    const refreshes = h.refreshes;
    mock.timers.tick(10_001);
    assert.equal(h.refreshes, refreshes);
    assert.deepEqual(h.displayed.watch.threads, []);
    h.refresh();
    assert.deepEqual(h.displayed.watch.threads, [otherAccount]);
  });

  it('restores the row and permits retry after a rejected Done', async () => {
    mock.method(console, 'error', () => {});
    const h = harness();
    const result = await doneGtdRow(acted, ['watch'], {
      ...h.deps,
      gtdDone: async () => { throw Object.assign(new Error('only copy'), { status: 409 }); },
    });
    assert.equal(result, null);
    assert.deepEqual(h.displayed.watch.threads, [acted]);
    assert.equal(h.displayed.waiting.total, 1);
    await doneGtdRow(acted, ['watch'], h.deps);
    assert.deepEqual(h.requests, [{ id: 'watch-a', states: ['watch'] }]);
    assert.deepEqual(h.displayed.watch.threads, []);
  });

  it('shows the surviving row after partial Done and uses its current id on retry', async () => {
    const h = harness();
    const remaining = { ...acted, id: 'remaining-watch-a' };
    await doneGtdRow(acted, ['watch'], {
      ...h.deps,
      gtdDone: async () => {
        h.supply(sections(remaining));
        return { ok: true, threadRemains: true };
      },
    });
    assert.deepEqual(h.displayed.watch.threads, [remaining]);
    assert.equal(h.displayed.watch.total, 1);
    assert.ok(h.notifications.some(n => n.title === 'gtd.doneThreadRemains'));
    await doneGtdRow(remaining, ['watch'], h.deps);
    assert.deepEqual(h.requests, [{ id: 'remaining-watch-a', states: ['watch'] }]);
    assert.deepEqual(h.displayed.watch.threads, []);
  });
});

describe('Done followed by Watch classification', () => {
  for (const states of [['watch'], ['watch', 'delegated'], ['delegated', 'watch', 'watch']]) {
    it(`shows freshly reclassified Watch without waiting for guard expiry (${states.join(',')})`, async () => {
      const h = harness(states);
      await doneGtdRow(acted, states, h.deps);
      mock.timers.tick(1);
      const reclassified = { ...surviving, id: 'new-watch-a', folder: 'Watch' };
      h.supply(sections(reclassified));
      await h.classify();
      assert.deepEqual(h.displayed.watch.threads, [reclassified]);
      assert.equal(h.displayed.watch.total, 1);
      assert.equal(h.displayed.waiting.total, 1);
    });
  }

  it('does not let an older Done response hide a later successful Watch classification', async () => {
    const h = harness();
    let resolveDone;
    const request = new Promise(resolve => { resolveDone = resolve; });
    const pending = doneGtdRow(acted, ['watch', 'delegated'], { ...h.deps, gtdDone: () => request });
    // Done has applied on the server, but its response is delayed past reclassification.
    const reclassified = { ...surviving, id: 'new-watch-a', folder: 'Watch' };
    try {
      h.supply(sections(reclassified));
      await h.classify();
    } finally {
      resolveDone({ ok: true });
      await pending;
    }
    h.refresh();
    assert.deepEqual(h.displayed.watch.threads, [reclassified]);
    assert.equal(h.displayed.watch.total, 1);
    assert.equal(h.displayed.waiting.total, 1);
  });

  it('releases Watch while preserving Delegated suppression from a combined removal', async () => {
    const h = harness(['watch', 'delegated']);
    await doneGtdRow(acted, ['watch', 'delegated'], h.deps);
    const reclassified = { ...surviving, id: 'new-watch-a', folder: 'Watch' };
    h.supply(sections(reclassified, ['watch', 'delegated']));
    await h.classify();
    assert.deepEqual(h.displayed.watch.threads, [reclassified]);
    assert.deepEqual(h.displayed.delegated.threads, []);
  });

  it('lets a newer Done suppress Watch after successful reclassification', async () => {
    const h = harness();
    await doneGtdRow(acted, ['watch'], h.deps);
    const reclassified = { ...surviving, id: 'new-watch-a', folder: 'Watch' };
    h.supply(sections(reclassified));
    await h.classify();
    await doneGtdRow(reclassified, ['watch'], h.deps);
    h.supply(sections(reclassified));
    h.refresh();
    assert.deepEqual(h.displayed.watch.threads, []);
  });

  it('keeps the remaining Delegated guard when a pending Done completes after Watch classification', async () => {
    const h = harness(['watch', 'delegated']);
    let resolveDone;
    const request = new Promise(resolve => { resolveDone = resolve; });
    const pending = doneGtdRow(acted, ['watch', 'delegated'], { ...h.deps, gtdDone: () => request });
    const reclassified = { ...surviving, id: 'new-watch-a', folder: 'Watch' };
    try {
      h.supply(sections(reclassified, ['watch', 'delegated']));
      await h.classify();
      assert.deepEqual(h.displayed.watch.threads, [reclassified]);
      assert.deepEqual(h.displayed.delegated.threads, []);
    } finally {
      resolveDone({ ok: true });
      await pending;
    }
    h.refresh();
    assert.deepEqual(h.displayed.watch.threads, [reclassified]);
    assert.deepEqual(h.displayed.delegated.threads, []);
  });

  it('uses the same row-id fallback when Done has a null header and classify has no header field', async () => {
    const h = harness();
    const headerless = { ...acted, message_id: null };
    h.supply(sections(headerless));
    h.refresh();
    await doneGtdRow(headerless, ['watch'], h.deps);
    h.supply(sections(headerless));
    const classificationMessage = { ...headerless };
    delete classificationMessage.message_id;
    await h.classify({ ok: true, applied: true }, classificationMessage);
    assert.deepEqual(h.displayed.watch.threads, [headerless]);
  });

  it('does not release a completed guard for a successful no-op classification', async () => {
    const h = harness();
    await doneGtdRow(acted, ['watch'], h.deps);
    h.supply(sections(acted));
    await h.classify({ ok: true, applied: false });
    assert.deepEqual(h.displayed.watch.threads, []);
  });

  it('does not turn an expired pending operation into a new completed guard', async () => {
    const h = harness();
    let resolveDone;
    const request = new Promise(resolve => { resolveDone = resolve; });
    const pending = doneGtdRow(acted, ['watch'], { ...h.deps, gtdDone: () => request });
    mock.timers.tick(30_001);
    resolveDone({ ok: true });
    await pending;
    h.refresh();
    assert.deepEqual(h.displayed.watch.threads, [acted]);
  });

  it('does not let an older response replace the guard of a newer pending Done', async () => {
    const h = harness();
    let finishOld, finishNew;
    const oldRequest = new Promise(resolve => { finishOld = resolve; });
    const newRequest = new Promise(resolve => { finishNew = resolve; });
    const oldDone = doneGtdRow(acted, ['watch'], { ...h.deps, gtdDone: () => oldRequest });
    const newDone = doneGtdRow(acted, ['watch'], { ...h.deps, gtdDone: () => newRequest });
    finishOld({ ok: true });
    await oldDone;
    try {
      // An old completion must not shorten the newer pending guard to ten seconds.
      mock.timers.tick(10_001);
      h.refresh();
      assert.deepEqual(h.displayed.watch.threads, []);
    } finally {
      h.supply(sections(acted, []));
      finishNew({ ok: true });
      await newDone;
    }
  });

  it('keeps stale Watch suppressed when reclassification is rejected', async () => {
    mock.method(console, 'error', () => {});
    const h = harness();
    await doneGtdRow(acted, ['watch'], h.deps);
    h.supply(sections(acted));
    await h.classify(Promise.reject(new Error('classification rejected')));
    assert.deepEqual(h.displayed.watch.threads, []);
    assert.ok(h.notifications.some(n => n.title === 'gtd.classifyFailed'));
  });

  it('does not let reclassification of an unrelated message clear this guard', async () => {
    const h = harness();
    await doneGtdRow(acted, ['watch'], h.deps);
    h.supply(sections(acted));
    await h.classify({ ok: true, applied: true }, {
      ...surviving, id: 'unrelated', message_id: '<unrelated@synthetic.test>', thread_key: 'unrelated',
    });
    assert.deepEqual(h.displayed.watch.threads, []);
  });

  it('keeps stale data suppressed while Done is pending even if a classification rejects', async () => {
    mock.method(console, 'error', () => {});
    const h = harness();
    let resolveDone;
    const request = new Promise(resolve => { resolveDone = resolve; });
    const pending = doneGtdRow(acted, ['watch'], { ...h.deps, gtdDone: () => request });
    try {
      await h.classify(Promise.reject(new Error('classification rejected')));
      assert.deepEqual(h.displayed.watch.threads, []);
      mock.timers.tick(10_001);
      h.refresh();
      assert.deepEqual(h.displayed.watch.threads, []);
    } finally {
      h.supply(sections(acted, []));
      resolveDone({ ok: true });
      await pending;
    }
  });
});
