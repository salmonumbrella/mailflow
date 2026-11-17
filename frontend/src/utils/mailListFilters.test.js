import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canFilterMailList, toggleStarredSearch, hasStarredSearch } from './mailListFilters.js';

test('starred search toggles only supported standalone operators and keeps quoted search terms', () => {
  assert.equal(toggleStarredSearch(''), 'is:starred');
  assert.equal(toggleStarredSearch('in:INBOX is:starred'), 'in:INBOX');
  assert.equal(toggleStarredSearch('subject:"is:starred proposal" from:alice'), 'subject:"is:starred proposal" from:alice is:starred');
  assert.equal(toggleStarredSearch('IS:"STARRED" from:alice'), 'from:alice');
  assert.equal(toggleStarredSearch('-is:starred from:alice'), 'from:alice is:starred');
  assert.equal(hasStarredSearch('subject:"is:starred proposal"'), false);
  assert.equal(hasStarredSearch('-is:starred'), false);
  assert.equal(hasStarredSearch('in:INBOX is:starred'), true);
});

test('list filters never target an ordinary layout, reader, modal, plugin view, scheduled view or popout', () => {
  const state = { user: { id: 'owner' }, layout: 'superhuman', selectedFolder: 'INBOX' };
  assert.equal(canFilterMailList(state), true);
  for (const change of [{ user: null }, { layout: 'comfortable' }, { isLocked: true }, { selectedMessageId: 'm' },
    { composing: true }, { showAdmin: true }, { showContacts: true }, { activeGtdTab: 'todo' },
    { selectedFolder: 'Snoozed' }, { selectedFolder: '__scheduled__' }, { messageWindows: [{ messageId: 'm', z: 2 }] }]) {
    assert.equal(canFilterMailList({ ...state, ...change }), false, JSON.stringify(change));
  }
});
