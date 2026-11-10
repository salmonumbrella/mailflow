import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalMembershipTargets, definitiveMembershipFailure, membershipDelta, membershipScope, membershipStates, verifiedMembershipSnapshot } from './nativeLabelMemberships.js';
const row = { account_id: 'a', storageGeneration: 'g', entityId: 'one', nativeLabelState: 'available' };
test('membership scope deduplicates entity locations without trusting headers or mixed accounts', () => {
  assert.deepEqual(membershipScope([row, { ...row, id: 'other-location', message_id: 'same-header' }]).targets, [{ entityId: 'one' }]);
  assert.equal(membershipScope([row, { ...row, entityId: 'two', message_id: 'same-header' }]).targets.length, 2);
  for (const rows of [[], [row, { ...row, account_id: 'b' }], [row, { ...row, storageGeneration: 'next' }], [{ ...row, nativeLabelState: 'unavailable' }], [{ ...row, is_draft: true }], Array.from({ length: 201 }, (_, i) => ({ ...row, entityId: String(i) }))]) assert.ok(membershipScope(rows).error);
});
test('mixed staging never replaces untouched memberships', () => {
  const initial = membershipStates([{ id: 'work' }, { id: 'home' }], [{ labelIds: ['work'] }, { labelIds: [] }]);
  assert.deepEqual(initial, { work: 'mixed', home: false });
  assert.deepEqual(membershipDelta(initial, initial), { addLabelIds: [], removeLabelIds: [] });
  assert.deepEqual(membershipDelta(initial, { work: false, home: true }), { addLabelIds: ['home'], removeLabelIds: ['work'] });
});
test('query DTO validation rejects unavailable identities, wrong generations and unsafe numeric versions', () => {
  const scope = membershipScope([row]);
  const valid = { accountId: 'a', storageGeneration: 'g', targets: [{ requestedEntityId: 'one', entityId: 'canonical', metadataVersion: '9007199254740993', available: true, labelIds: [] }] };
  assert.equal(verifiedMembershipSnapshot(valid, scope), true);
  for (const patch of [{ available: false }, { metadataVersion: 1 }, { requestedEntityId: 'other' }, { labelIds: null }]) assert.equal(verifiedMembershipSnapshot({ ...valid, targets: [{ ...valid.targets[0], ...patch }] }, scope), false);
  assert.equal(verifiedMembershipSnapshot({ ...valid, storageGeneration: 'old' }, scope), false);
});
test('canonical targets deduplicate exact aliases and reject conflicting versions', () => {
  assert.deepEqual(canonicalMembershipTargets([{ entityId: 'a', metadataVersion: '9007199254740993' }, { entityId: 'a', metadataVersion: '9007199254740993' }]), [{ entityId: 'a', expectedMetadataVersion: '9007199254740993' }]);
  assert.throws(() => canonicalMembershipTargets([{ entityId: 'a', metadataVersion: '1' }, { entityId: 'a', metadataVersion: '2' }]));
});
test('unknown recovery survives middleware and validation responses until the ledger settles it', () => {
  for (const status of [undefined, 400, 401, 403, 404, 408, 409, 413, 423, 429, 500]) assert.equal(definitiveMembershipFailure({ status }, true), false);
  for (const code of ['stale_generation', 'stale_metadata_version', 'identity_unavailable', 'mutation_expired', 'mutation_conflict', 'undo_unavailable', 'undo_identity_changed', 'metadata_version_exhausted', 'identity_alias_conflict']) assert.equal(definitiveMembershipFailure({ status: 409, code }, true), true);
  for (const code of ['identity_entity_missing', 'label_not_found']) assert.equal(definitiveMembershipFailure({ status: 404, code }, true), true);
  assert.equal(definitiveMembershipFailure({ status: 404, code: 'not_found' }, true), false);
});


test('scope and metadata validation use injected translations instead of English-only errors', () => {
  const translate = key => `localized:${key}`;
  assert.equal(membershipScope([], translate).error, 'localized:gmail.memberships.selectMessages');
  assert.throws(() => canonicalMembershipTargets([
    { entityId: 'one', metadataVersion: '1' },
    { entityId: 'one', metadataVersion: '2' },
  ], translate), /localized:gmail.memberships.metadataConflict/);
});
