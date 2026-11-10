import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listActionRowsCurrent, listActionSourceKey, listActionTargetsCurrent, listActionScopeKey, isPermanentListDelete, sameListActionTarget, createListActionCommitGuard } from './listActionScope.js';

const account = { id: 'a', storage_generation: 'g1' };
const row = { id: 'm', account_id: 'a', uid: 12, folder: 'INBOX', storageGeneration: 'g1' };
const state = () => ({ accounts: [account], folders: {}, messages: [row], threadMessages: {}, selectedAccountId: 'a', selectedFolder: 'INBOX', searchQuery: '' });

test('current source requires the exact mailbox identity and a live account generation', () => {
  assert.equal(listActionRowsCurrent([row], state()), true);
  for (const change of [{ uid: 13 }, { account_id: 'other' }, { folder: 'Trash' }, { storageGeneration: 'g2' }, { entityId: 'replacement' }]) {
    assert.equal(listActionRowsCurrent([row], { ...state(), messages: [{ ...row, ...change }] }), false);
  }
  assert.equal(listActionRowsCurrent([row], { ...state(), accounts: [{ ...account, storage_generation: 'g2' }] }), false);
  assert.equal(listActionRowsCurrent([row], { ...state(), accounts: [{ ...account, enabled: false }] }), false);
  assert.equal(listActionRowsCurrent([row], { ...state(), messages: [] }), false);
  assert.equal(listActionRowsCurrent([row], { ...state(), messages: [{ ...row, is_read: true, is_starred: true }] }), true);
});

test('resolved targets reject missing identities, removed accounts, and stale generations', () => {
  assert.equal(listActionTargetsCurrent([row], state()), true);
  for (const invalid of [{}, { ...row, id: null }, { ...row, account_id: 'unknown' }, { ...row, storageGeneration: 'g2' }]) {
    assert.equal(listActionTargetsCurrent([invalid], state()), false);
  }
});

test('scope includes selected reader/rows, account generation, native feed, and source view generation', () => {
  const initial = state();
  const key = listActionScopeKey(initial, new Set(['m']), 'inbox', 1);
  for (const change of [
    { selectedMessageId: 'different' }, { selectedAccountId: 'b' }, { searchQuery: 'new' },
    { selectedFolder: 'Trash' }, { accounts: [{ ...account, storage_generation: 'g2' }] },
    { activeLabel: { labelId: 'l', accountId: 'a', storageGeneration: 'g1' } },
    { nativeLabelFeed: { key: 'l', status: 'loading' } },
  ]) assert.notEqual(listActionScopeKey({ ...initial, ...change }, new Set(['m']), 'inbox', 1), key);
  assert.notEqual(listActionScopeKey(initial, new Set(['other']), 'inbox', 1), key);
  assert.notEqual(listActionScopeKey(initial, new Set(['m']), 'inbox', 2), key);
  assert.notEqual(listActionScopeKey(initial, new Set(['m']), 'search', 1), key);
});

test('permanent deletion follows provider mark, mapping, special use and native draft behavior', () => {
  assert.equal(isPermanentListDelete(row, state()), false);
  for (const change of [{ in_trash: true }, { is_draft: true }, { folder: 'Trash' }, { folder: '[Gmail]/Bin' }, { folder: 'Drafts' }]) {
    assert.equal(isPermanentListDelete({ ...row, ...change }, state()), true);
  }
  assert.equal(isPermanentListDelete({ ...row, folder: 'Waste' }, { ...state(), accounts: [{ ...account, folder_mappings: { trash: 'Waste' } }] }), true);
  assert.equal(isPermanentListDelete({ ...row, folder: 'Waste' }, { ...state(), folders: { a: [{ path: 'Waste', special_use: '\\Trash' }] } }), true);
});


test('cached mail does not substitute for the source row; expanded rows require their visible parent', () => {
  const parent = { ...row, id: 'parent', thread_id: 'thread' };
  const expanded = { ...state(), messages: [parent], expandedThreadId: 'thread', threadMessages: { thread: [row] } };
  assert.equal(listActionRowsCurrent([row], expanded), true);
  assert.notEqual(listActionSourceKey([row], expanded), listActionSourceKey([row], state()));
  assert.equal(listActionRowsCurrent([row], { ...expanded, expandedThreadId: null }), false);
  assert.equal(listActionRowsCurrent([row], { ...expanded, messages: [] }), false);
  assert.equal(listActionRowsCurrent([row], { ...state(), messages: [], threadMessages: { stale: [row] } }), false);
});


test('resolved anchor requires the same account and every known mailbox locator', () => {
  assert.equal(sameListActionTarget(row, { ...row, is_read: true }), true);
  for (const change of [{ account_id: 'other' }, { uid: 13 }, { folder: 'Trash' }, { uid: undefined }, { storageGeneration: 'g2' }]) {
    assert.equal(sameListActionTarget(row, { ...row, ...change }), false);
  }
});

test('commit proof permits navigation and optimistic removal but rejects account and known source replacement', () => {
  const initial = state();
  const valid = createListActionCommitGuard([row], initial);
  assert.equal(valid({ ...initial, messages: [], selectedAccountId: 'elsewhere', selectedFolder: 'Archive', selectedMessageId: 'other' }), true);
  for (const change of [
    { accounts: [] }, { accounts: [{ ...account, storage_generation: 'g2' }] },
    { accounts: [{ ...account, enabled: false }] }, { messages: [{ ...row, uid: 13 }] },
    { messages: [{ ...row, folder: 'Trash' }] }, { messages: [{ ...row, entityId: 'replacement', storageGeneration: 'g2' }] },
    { user: { id: 'replacement-user' } },
  ]) assert.equal(valid({ ...initial, ...change }), false);
  assert.equal(valid({ ...initial, messages: [{ ...row, is_read: true, is_starred: true }] }), true);
});
