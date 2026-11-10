import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidForwardAddress } from './ruleActions.js';

test('accepts one plain forwarding address', () => {
  assert.equal(isValidForwardAddress('recipient@example.com'), true);
});

test('rejects empty, multiple, malformed, and injected forwarding addresses', () => {
  for (const value of [
    '',
    'not-an-address',
    'first@example.com,second@example.com',
    'recipient@example.com\r\nBcc: hidden@example.com',
  ]) {
    assert.equal(isValidForwardAddress(value), false, value);
  }
});

const { nativeRuleActionError, ruleActionsForAccount } = await import('./ruleActions.js');
const nativeContext = () => ({ accountId: 'a', expectedStorageGeneration: 'gen-1',
  accounts: [{ id: 'a', enabled: true, storage_generation: 'gen-1' }],
  snapshots: { a: { storageGeneration: 'gen-1', labels: [{ id: 'label-1', path: 'Parent/Child' }] } },
  actions: [{ type: 'apply_native_label', value: 'label-1' }] });

test('native rule actions preserve UUID identity across rename, never name-match a replacement', () => {
  const context = nativeContext();
  context.snapshots.a.labels[0].path = 'Renamed/Child';
  assert.equal(nativeRuleActionError(context), null);
  context.snapshots.a.labels = [{ id: 'replacement', path: 'Parent/Child' }];
  assert.equal(nativeRuleActionError(context), 'nativeLabelRules.missing');
});

test('native rules reject global, removed, replaced, unavailable and mismatched-generation accounts', () => {
  for (const patch of [{ accountId: '' }, { accounts: [] }, { accounts: [{ id: 'a', enabled: false, storage_generation: 'gen-1' }] },
    { expectedStorageGeneration: null }, { accounts: [{ id: 'a', storage_generation: 'gen-2' }] }]) {
    assert.equal(nativeRuleActionError({ ...nativeContext(), ...patch }), 'nativeLabelRules.accountChanged');
  }
  assert.equal(nativeRuleActionError({ ...nativeContext(), snapshots: {} }), 'nativeLabelRules.unverified');
  assert.equal(nativeRuleActionError({ ...nativeContext(), snapshots: { a: { storageGeneration: 'gen-2', labels: [{ id: 'label-1' }] } } }), 'nativeLabelRules.unverified');
});

test('opposite native decisions are rejected and account changes discard native actions without changing other actions', () => {
  const context = nativeContext();
  context.actions.push({ type: 'remove_native_label', value: 'label-1' });
  assert.equal(nativeRuleActionError(context), 'nativeLabelRules.conflicting');
  const actions = [...context.actions, { type: 'star' }, { type: 'move', value: 'Old/Folder' }];
  assert.deepEqual(ruleActionsForAccount(actions, 'b'), [{ type: 'star' }, { type: 'move', value: '' }]);
  assert.deepEqual(ruleActionsForAccount(actions, ''), [{ type: 'star' }]);
});
