import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true } : nextLoad(url, context);
} });
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { useStore } = await import('./index.js');
globalThis.window = new EventTarget(); globalThis.document = new EventTarget();
const { api } = await import('../utils/api.js');
const { countWriteTracker } = await import('../utils/countWriteTracker.js');
const { runThreadAction } = await import('../utils/threadActions.js');
const accounts = [{ id: 'a', enabled: true }, { id: 'b', enabled: true }];
const flush = async () => { for (let n = 0; n < 100; n++) await Promise.resolve(); };
const originalRefresh = api.refreshCounts;
let generation;
const row = account => ({ id: `${account}-inverse.test`, account_id: account, folder: 'INBOX', is_read: false });
const bounceB = () => {
  useStore.getState().updateAccount('b', { enabled: false }, generation);
  useStore.getState().updateAccount('b', { enabled: true }, generation);
};
function begin(account, commit = async () => {}) {
  const notifications = [];
  const message = row(account); useStore.getState().setMessages([message]);
  assert.equal(runThreadAction({ messages: [message], commit, notification: { title: 'Synthetic action', failTitle: 'Synthetic refusal' },
    addNotification: value => notifications.push(value) }), true);
  return notifications;
}
beforeEach(() => {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  mock.method(console, 'error', () => {});
  api.refreshCounts = async () => new Promise(() => {});
  const state = useStore.getState(); state.setUser({ id: 'nonarchive-inverse.test' }); state.setLocked(false);
  state.setAccounts(accounts); generation = useStore.getState().countGeneration;
  state.setUnreadCounts({ byAccount: { a: 10, b: 20 }, snapshots: Object.fromEntries(accounts.map(account => [account.id, {
    totalCount: account.id === 'a' ? 13 : 23, revision: '1', known: true, stale: false, observedAt: new Date().toISOString(),
  }])) });
});
afterEach(async () => {
  useStore.getState().setLocked(true); useStore.getState().setUser(null);
  api.refreshCounts = originalRefresh; await flush(); mock.timers.reset(); mock.restoreAll();
});

test('nonarchive thread old Undo after disable and re-enable cannot credit a pruned debit', async () => {
  let commits = 0;
  const notifications = begin('b', async () => { commits++; });
  assert.equal(useStore.getState().unreadCounts.byAccount.b, 19);
  bounceB();
  assert.equal(useStore.getState().unreadCounts.byAccount.b, 20);
  assert.equal(countWriteTracker.inspect().localIntents, 1, 'account lifecycle does not end the action lifetime');
  notifications[0].onUndo(); await flush();
  assert.equal(countWriteTracker.inspect().localIntents, 0);
  assert.equal(useStore.getState().unreadCounts.byAccount.b, 20, 'old Undo must not add one after its debit was pruned');
  assert.equal(useStore.getState().unreadCounts.byAccount.a, 10);
  mock.timers.tick(5000); await flush(); assert.equal(commits, 0);
});

test('nonarchive thread old known refusal after disable and re-enable cannot credit a pruned debit', async () => {
  let rejectWrite;
  begin('b', () => new Promise((_resolve, reject) => { rejectWrite = reject; }));
  mock.timers.tick(4500); await flush(); assert.equal(typeof rejectWrite, 'function');
  bounceB();
  assert.equal(useStore.getState().unreadCounts.byAccount.b, 20);
  assert.equal(countWriteTracker.inspect().localIntents, 1);
  rejectWrite(Object.assign(new Error('known-refusal.test'), { notApplied: true })); await flush();
  assert.equal(countWriteTracker.inspect().localIntents, 0);
  assert.equal(useStore.getState().unreadCounts.byAccount.b, 20, 'old known refusal must not add one after its debit was pruned');
  assert.equal(useStore.getState().unreadCounts.byAccount.a, 10);
});

test('nonarchive thread fresh Undo on a re-enabled account restores its own new debit', async () => {
  bounceB();
  const notifications = begin('b');
  assert.equal(useStore.getState().unreadCounts.byAccount.b, 19);
  notifications[0].onUndo(); await flush();
  assert.equal(useStore.getState().unreadCounts.byAccount.b, 20);
  assert.equal(useStore.getState().unreadCounts.byAccount.a, 10);
  assert.equal(countWriteTracker.inspect().localIntents, 0);
});

test('nonarchive thread other-account Undo survives B disable and re-enable', async () => {
  const notifications = begin('a');
  assert.equal(useStore.getState().unreadCounts.byAccount.a, 9);
  bounceB(); notifications[0].onUndo(); await flush();
  assert.equal(useStore.getState().unreadCounts.byAccount.a, 10);
  assert.equal(useStore.getState().unreadCounts.byAccount.b, 20);
  assert.equal(countWriteTracker.inspect().localIntents, 0);
});
