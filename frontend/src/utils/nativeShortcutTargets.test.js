import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeShortcutTarget } from './nativeShortcutTargets.js';
const node = (options = {}) => ({ dataset: { conversationNavigation: 'm' }, parentElement: null, style: {}, hasAttribute: () => false, getAttribute: () => null, ...options });
const state = { user: { id: 'owner' }, layout: 'superhuman', selectedMessageId: 'm' };
test('conversation keys require the currently visible matching native reader', () => {
  const target = node(); const root = { querySelectorAll: () => [target] };
  assert.equal(nativeShortcutTarget('nextConversationMessage', state, root), target);
  for (const change of [{ user: null }, { layout: 'comfortable' }, { selectedMessageId: 'other' }, { isLocked: true },
    { showContacts: true }, { showAdmin: true }, { composing: true }, { messageWindows: [{ messageId: 'm', z: 4 }] }]) {
    assert.equal(nativeShortcutTarget('nextConversationMessage', { ...state, ...change }, root), null);
  }
  target.parentElement = node({ style: { display: 'none' } });
  assert.equal(nativeShortcutTarget('prevConversationMessage', state, root), null);
  assert.equal(nativeShortcutTarget('unknownAction', state, root), null, 'unknown commands are never claimed');
});
