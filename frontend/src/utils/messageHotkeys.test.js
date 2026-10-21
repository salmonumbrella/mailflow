import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers';
import * as hotkeys from './messageHotkeys.js';
import { setReadIntentSession } from './pendingReads.js';

beforeEach(() => setReadIntentSession(Symbol('test session')));

const selectedMessage = hotkeys.selectedMessage ?? (() => null);
const markMessageUnread = hotkeys.markMessageUnread ?? (() => false);

const countReceipt = undo => {
  let state = 'live';
  return { state: () => state, revert: () => {
    if (state !== 'live') return false;
    state = 'pruned'; undo(); return true;
  } };
};

describe('selected message hotkeys', () => {
  const inbox = { folder: 'INBOX', id: 'inbox', account_id: 'acct', is_read: true, category: 'primary' };
  const rail = { id: 'rail', account_id: 'acct', is_read: true };

  it('resolves normal, search, thread, and GTD rail selections; no selection is a no-op', () => {
    assert.equal(selectedMessage({ selectedMessageId: 'inbox', messages: [inbox], searchResults: [], searchQuery: '', threadMessages: {} }), inbox);
    assert.equal(selectedMessage({ selectedMessageId: 'rail', messages: [inbox], searchResults: [], searchQuery: '', threadMessages: {}, gtdSections: { todo: { threads: [rail] } } }), rail);
    assert.equal(selectedMessage({ selectedMessageId: 'rail', messages: [], searchResults: [rail], searchQuery: 'q', threadMessages: {} }), rail);
    assert.equal(selectedMessage({ selectedMessageId: null, messages: [inbox] }), null);
  });

  it('uses the frontmost open message window when the main list has no selection', () => {
    const behind = { id: 'behind', account_id: 'acct' };
    const front = { id: 'front', account_id: 'acct' };
    const state = {
      selectedMessageId: null, messages: [behind, front],
      messageWindows: [
        { messageId: 'behind', z: 3, minimized: false },
        { messageId: 'front', z: 5, minimized: false },
      ],
    };
    assert.equal(selectedMessage(state), front);
    assert.equal(selectedMessage({ ...state, messageWindows: state.messageWindows.map(w => ({ ...w, minimized: true })) }), null);
  });

  it('explicit unread cancels a pending auto-read, even if row is still unread', async () => {
    const calls = [];
    const cancel = () => calls.push('cancel');
    const patch = async (ids, read) => calls.push(['patch', ids, read]);
    assert.equal(markMessageUnread({ ...inbox, is_read: false }, { cancel, patch }), true);
    assert.deepEqual(calls, ['cancel']);
    assert.equal(markMessageUnread(inbox, {
      cancel,
      update: (id, data) => calls.push(['update', id, data]),
      incrementUnread: () => calls.push('increment'),
      adjustCategoryCount: () => calls.push('category'),
      patch,
    }), true);
    await Promise.resolve();
    assert.deepEqual(calls.slice(1), ['cancel', ['update', 'inbox', { is_read: false }], 'increment', 'category', ['patch', ['inbox'], false]]);
  });

  for (const failure of [
    { name: 'network', error: new Error('connection lost'), rollback: false },
    { name: 'server failure', error: Object.assign(new Error('unconfirmed'), { status: 500 }), rollback: false },
    { name: 'generic conflict', error: Object.assign(new Error('conflict'), { status: 409 }), rollback: false },
    { name: 'running operation', error: Object.assign(new Error('running'), { status: 409, code: 'count-op-running' }), rollback: false },
    { name: 'known entry refusal', error: Object.assign(new Error('refused'), { status: 400, notApplied: true }), rollback: true },
  ]) {
    it(`${failure.name} reports failure and only an explicitly not-applied outcome rolls back`, async (t) => {
      t.mock.method(console, 'error', () => {});
      let row = { ...inbox };
      let unread = 0;
      let category = 0;
      const notifications = [];
      markMessageUnread(row, {
        update: (id, patch) => { assert.equal(id, inbox.id); row = { ...row, ...patch }; },
        incrementUnread: () => { unread++; return countReceipt(() => { unread--; }); },
        decrementUnread: () => { unread--; return countReceipt(() => { unread++; }); },
        adjustCategoryCount: (name, delta) => { assert.equal(name, 'primary'); category += delta; return countReceipt(() => { category -= delta; }); },
        patch: () => Promise.reject(failure.error),
        onError: error => notifications.push(error),
      });
      assert.equal(row.is_read, false, 'explicit unread is visible immediately');
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(row.is_read, failure.rollback);
      assert.equal(unread, failure.rollback ? 0 : 1);
      assert.equal(category, failure.rollback ? 0 : 1);
      assert.deepEqual(notifications, [failure.error]);
    });
  }

  it('holds a count intent from optimistic apply through the final write promise', async () => {
    let finish;
    const finalWrite = new Promise(resolve => { finish = resolve; });
    let activeIntents = 0;
    let ended = 0;
    let read = true;
    markMessageUnread(inbox, {
      beginIntent: () => {
        activeIntents++;
        return () => { activeIntents--; ended++; };
      },
      update: (_id, patch) => {
        assert.equal(activeIntents, 1, 'the optimistic update must already be covered');
        read = patch.is_read;
      },
      patch: () => finalWrite,
    });
    assert.equal(read, false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(activeIntents, 1, 'queue wait and internal funnel retry keep one lifetime');
    finish();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(activeIntents, 0);
    assert.equal(ended, 1);
  });

  it('ends its count intent after a final uncertain failure without reverting the flag', async (t) => {
    t.mock.method(console, 'error', () => {});
    let activeIntents = 0;
    let read = true;
    const errors = [];
    const failure = new Error('connection lost');
    markMessageUnread(inbox, {
      beginIntent: () => { activeIntents++; return () => { activeIntents--; }; },
      update: (_id, patch) => { read = patch.is_read; },
      patch: () => Promise.reject(failure),
      onError: error => errors.push(error),
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(activeIntents, 0);
    assert.equal(read, false);
    assert.deepEqual(errors, [failure]);
  });
});


describe('ordered selected-message read protocol', () => {
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const fixture = () => {
    let generation = 10;
    setReadIntentSession(Symbol('previous session'));
    let row = { id: 'queued', account_id: 'a', folder: 'INBOX', is_read: false, category: 'primary' };
    let unread = 1, intents = 0;
    const writes = [], notifications = [];
    const deps = {
      generation: () => generation,
      beginIntent: () => { intents++; return () => { intents--; }; },
      update: (_id, fields) => { row = { ...row, ...fields }; },
      incrementUnread: () => { unread++; return countReceipt(() => { unread--; }); }, decrementUnread: () => { unread--; return countReceipt(() => { unread++; }); },
      patch: (_ids, read) => { const response = deferred(); writes.push({ read, response }); return response.promise; },
      onError: error => notifications.push(error),
    };
    return { deps, writes, notifications, read: () => row.is_read, count: () => unread,
      intents: () => intents, change: read => hotkeys.changeMessageRead(row, read, deps),
      nextSession: () => { generation++; row = { ...row, is_read: false }; unread = 1; },
    };
  };

  it('serializes read then unread while keeping both optimistic intents covered', async () => {
    const f = fixture();
    f.change(true); f.change(false);
    assert.equal(f.read(), false);
    assert.equal(f.count(), 1);
    assert.equal(f.intents(), 2);
    await flush();
    assert.deepEqual(f.writes.map(w => w.read), [true]);
    f.writes[0].response.resolve(); await flush();
    assert.deepEqual(f.writes.map(w => w.read), [true, false]);
    assert.equal(f.read(), false, 'old success must not replace latest intent');
    assert.equal(f.intents(), 1);
    f.writes[1].response.resolve(); await flush();
    assert.equal(f.intents(), 0);
    assert.equal(f.count(), 1);
  });

  it('two known refusals restore the original truth rather than the earlier optimistic flag', async () => {
    const f = fixture();
    f.change(true); f.change(false); await flush();
    f.writes[0].response.reject(Object.assign(new Error('first refusal'), { notApplied: true }));
    await flush();
    f.writes[1].response.reject(Object.assign(new Error('second refusal'), { notApplied: true }));
    await flush();
    assert.equal(f.read(), false);
    assert.equal(f.count(), 1);
    assert.equal(f.notifications.length, 1, 'only the current operation reports an error');
    assert.equal(f.intents(), 0);
  });

  it('does not dispatch queued writes or roll back rows after the session changes', async () => {
    const f = fixture();
    f.change(true); f.change(false); await flush();
    f.nextSession();
    f.writes[0].response.reject(Object.assign(new Error('old refusal'), { notApplied: true }));
    await flush();
    assert.equal(f.writes.length, 1);
    assert.equal(f.read(), false);
    assert.equal(f.count(), 1);
    assert.equal(f.notifications.length, 0);
    assert.equal(f.intents(), 0);
  });
});

// Store-backed bounce/replace proof lives in the mounted R4c cases. These cases
// verify that the shared caller consumes the exact optional object contract.
for (const [accountState, categoryState] of [['live', 'live'], ['pruned', 'live'], ['live', 'pruned'], ['pruned', 'pruned'], ['none', 'none']]) {
  it(`R4c shared refusal: account ${accountState}, category ${categoryState}`, async () => {
    setReadIntentSession(Symbol('previous'));
    let reject, accountReverts = 0, categoryReverts = 0, forwardCalls = 0, intents = 0;
    let row = { id: 'r4c', account_id: 'a', category: 'primary', folder: 'INBOX', is_read: true };
    const generation = () => 7;
    const account = { state: () => accountState, revert: () => { accountReverts++; return true; } };
    const category = { state: () => categoryState, revert: () => { categoryReverts++; return true; } };
    hotkeys.changeMessageRead(row, false, {
      generation, beginIntent: () => { intents++; return () => { intents--; }; },
      update: (_id, fields) => { row = { ...row, ...fields }; },
      incrementUnread: () => { forwardCalls++; return accountState === 'none' ? undefined : account; },
      decrementUnread: () => { throw new Error('refusal must not create a fresh opposite delta'); },
      adjustCategoryCount: () => { forwardCalls++; return categoryState === 'none' ? null : category; },
      patch: () => new Promise((_resolve, no) => { reject = no; }),
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(intents, 1);
    reject(Object.assign(new Error('synthetic.test refusal'), { notApplied: true }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(row.is_read, true, 'visual rollback is independent of count authority');
    assert.equal(accountReverts, Number(accountState === 'live'));
    assert.equal(categoryReverts, Number(categoryState === 'live'));
    assert.equal(forwardCalls, 2, 'only original optimistic operations were created');
    assert.equal(intents, 0);
  });
}

// INBOX-scope controls: these assert only the shared caller contract. Real
// category certification, mixed-thread and verified Gmail-copy tests are separate.
for (const read of [true, false]) {
  for (const folder of ['INBOX', 'All Mail', 'Archive', undefined]) {
    it(`INBOX count scope: ${String(folder)} ${read ? 'read' : 'unread'} keeps provider target and count membership separate`, async t => {
      setReadIntentSession(Symbol('previous'));
      const deltas = [], categoryDeltas = [], writes = [];
      let row = { id: 'scope-row', account_id: 'scope-account', category: 'primary', folder, is_read: !read };
      let release, active = 0;
      const final = new Promise(resolve => { release = resolve; });
      t.after(async () => { release(); await new Promise(resolve => setImmediate(resolve)); });
      const receipt = { state: () => 'live', replace: () => true, revert: () => true };
      hotkeys.changeMessageRead(row, read, {
        generation: () => 83,
        beginIntent: accounts => { assert.deepEqual(accounts, [row.account_id]); active++; return () => { active--; }; },
        update: (_id, patch) => { row = { ...row, ...patch }; },
        incrementUnread: account => { assert.equal(account, row.account_id); deltas.push(1); return receipt; },
        decrementUnread: account => { assert.equal(account, row.account_id); deltas.push(-1); return receipt; },
        adjustCategoryCount: (_category, delta) => { categoryDeltas.push(delta); return receipt; },
        patch: (ids, value) => { writes.push({ ids, read: value }); return final; },
      });
      assert.equal(row.is_read, read, 'physical row intent remains visible in every folder');
      assert.equal(active, 1, 'no-origin writes still hold their original local lifetime');
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(writes, [{ ids: ['scope-row'], read }], 'scope never retargets the provider write');
      const expected = folder === 'INBOX' ? [read ? -1 : 1] : [];
      assert.deepEqual(deltas, expected, 'account deltas reflect INBOX membership only');
      assert.deepEqual(categoryDeltas, expected, 'category counts have the same INBOX scope');
      release();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(active, 0);
    });
  }
}

for (const folder of ['All Mail', undefined]) {
  for (const known of [false, true]) {
    it(`INBOX count scope: ${String(folder)} ${known ? 'refusal' : 'uncertain failure'} restores only eligible visuals`, async () => {
      setReadIntentSession(Symbol('previous'));
      let row = { id: 'outside-failure', account_id: 'scope-account', folder, category: 'primary', is_read: false };
      let active = 0;
      const error = Object.assign(new Error('synthetic.test outside write'), { notApplied: known });
      const calls = [], errors = [];
      hotkeys.changeMessageRead(row, true, {
        generation: () => 84,
        beginIntent: accounts => { assert.deepEqual(accounts, ['scope-account']); active++; return () => { active--; }; },
        update: (_id, patch) => { row = { ...row, ...patch }; },
        incrementUnread: () => assert.fail('outside read cannot create an account origin or inverse'),
        decrementUnread: () => assert.fail('outside read cannot create an account origin or inverse'),
        adjustCategoryCount: () => assert.fail('outside read cannot create a category origin or inverse'),
        patch: (ids, read) => { calls.push({ ids, read }); return Promise.reject(error); },
        onError: failure => errors.push(failure),
      });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(row.is_read, !known, 'uncertainty keeps intent; known-not-applied restores visual truth');
      assert.deepEqual(calls, [{ ids: ['outside-failure'], read: true }]);
      assert.deepEqual(errors, [error]);
      assert.equal(active, 0);
    });
  }
}
