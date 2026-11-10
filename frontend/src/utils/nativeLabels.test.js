import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelTree, labelParentOptions, labelDraft, definitiveLabelFailure } from './nativeLabels.js';

test('tree orders nested labels and excludes self and descendants from valid parents', () => {
  const labels = [{ id: 'child', parentId: 'root', name: 'Child' }, { id: 'grand', parentId: 'child', name: 'Grand' }, { id: 'other', name: 'Other' }, { id: 'root', name: 'Root' }];
  assert.deepEqual(labelTree(labels).map(l => [l.id, l.depth]), [['other', 0], ['root', 0], ['child', 1], ['grand', 2]]);
  assert.deepEqual(labelParentOptions(labels, 'root').map(l => l.id), ['other']);
  assert.deepEqual(labelParentOptions(labels, 'child').map(l => l.id), ['other', 'root']);
});
test('draft keeps independent null colors and visibility without fake counts', () => {
  assert.deepEqual(labelDraft({ name: 'Work', color: '#112233', textColor: null, visibility: 'unread', messageVisible: false }), { name: 'Work', parentId: '', color: '#112233', textColor: null, visibility: 'unread', messageVisible: false });
});
test('timeouts and server failures are uncertain while refusals can be edited safely', () => {
  for (const status of [undefined, 408, 500, 502]) assert.equal(definitiveLabelFailure({ status }), false);
  for (const status of [400, 401, 403, 404, 409, 422]) assert.equal(definitiveLabelFailure({ status }), true);
});

test('auth and rate-limit gates cannot resolve an already uncertain mutation', () => {
  for (const status of [401, 403, 423, 429]) {
    assert.equal(definitiveLabelFailure({ status }), true);
    assert.equal(definitiveLabelFailure({ status }, true), false);
  }
});

test('recovering clears only an allowlisted native post-ledger conflict', () => {
  for (const status of [400, 404, 409, 413]) assert.equal(definitiveLabelFailure({ status }, true), false);
  for (const code of ['invalid_label_request', 'not_found', 'proxy_refusal']) assert.equal(definitiveLabelFailure({ status: 400, code }, true), false);
  for (const code of ['mutation_conflict', 'mutation_expired', 'stale_label_revision', 'stale_tree_revision', 'duplicate_name']) assert.equal(definitiveLabelFailure({ status: 409, code }, true), true);
});
