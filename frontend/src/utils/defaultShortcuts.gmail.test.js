import test from 'node:test';
import { canRunSelectedAction } from './shortcutApplicability.js';
import assert from 'node:assert/strict';
import { ACTION_DEFS, getGroupedActions, getEffectiveShortcuts, getShortcutConflicts, buildKeyMap, resolveShortcutAction, shortcutBindingFromEvent } from './defaultShortcuts.js';

const keyEvent = (key, modifiers = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers });

test('Gmail keys distinguish back, explicit read/unread and spam without changing native defaults', () => {
  const gmail = getEffectiveShortcuts({}, 'gmail');
  assert.equal(gmail.backToList, 'u');
  assert.equal(gmail.markUnread, 'shift+u');
  assert.equal(gmail.markRead, 'shift+i');
  assert.equal(gmail.markSpam, '!');
  assert.equal(getEffectiveShortcuts().markUnread, 'u');
  for (const action of ['backToList', 'markRead', 'markSpam']) assert.equal(getEffectiveShortcuts()[action], '');
  for (const [key, action] of Object.entries({ u: 'backToList', j: 'nextMessage', k: 'prevMessage', x: 'selectMessage', s: 'toggleStar', e: 'archive', '#': 'delete', r: 'reply', a: 'replyAll', f: 'forward', gi: 'goInbox' })) assert.equal(buildKeyMap({}, 'gmail')[key], action);
  assert.deepEqual(getShortcutConflicts({}, 'gmail'), []);
});

test('Gmail explicit modifiers and punctuation resolve independently of native bindings', () => {
  assert.equal(resolveShortcutAction(keyEvent('U', { shiftKey: true }), {}, 'gmail'), 'markUnread');
  assert.equal(resolveShortcutAction(keyEvent('I', { shiftKey: true }), {}, 'gmail'), 'markRead');
  assert.equal(resolveShortcutAction(keyEvent('!', { shiftKey: true }), {}, 'gmail'), 'markSpam');
  assert.equal(resolveShortcutAction(keyEvent('!', { shiftKey: true, ctrlKey: true }), {}, 'gmail'), null);
  assert.equal(resolveShortcutAction(keyEvent('u'), {}, 'gmail'), 'backToList');
  assert.equal(resolveShortcutAction(keyEvent('U', { shiftKey: true })), null);
  assert.equal(shortcutBindingFromEvent(keyEvent('!', { shiftKey: true })), '!');
});

test('explicit saved bindings, including old defaults and disabled actions, remain authoritative', () => {
  const overrides = { markUnread: 'u', markRead: null, markSpam: '', forward: 'shift+i' };
  const before = structuredClone(overrides);
  assert.equal(getEffectiveShortcuts(overrides, 'gmail').backToList, '');
  assert.equal(getEffectiveShortcuts(overrides, 'gmail').markUnread, 'u');
  assert.equal(getEffectiveShortcuts(overrides, 'gmail').markRead, null);
  assert.equal(getEffectiveShortcuts(overrides, 'gmail').markSpam, '');
  assert.equal(resolveShortcutAction(keyEvent('u'), overrides, 'gmail'), 'markUnread');
  assert.equal(resolveShortcutAction(keyEvent('I', { shiftKey: true }), overrides, 'gmail'), 'forward');
  assert.deepEqual(overrides, before);
  assert.equal(getEffectiveShortcuts({ compose: '!' }, 'gmail').markSpam, '');
  assert.equal(getEffectiveShortcuts({ compose: 'shift+!' }, 'gmail').markSpam, '');
  assert.equal(getEffectiveShortcuts({ compose: 'SHIFT+U' }, 'gmail').markUnread, '');
  assert.equal(getEffectiveShortcuts({ backToList: 'q' }, 'gmail').backToList, 'q');
  assert.deepEqual(getShortcutConflicts({ markUnread: 'u' }, 'gmail'), []);
});


test('Gmail focused-row actions do not inherit a hidden reader or bypass label readiness', () => {
  const state = { layout: 'gmail', selectedMessageId: null, messages: [] };
  assert.equal(canRunSelectedAction('selectMessage', state, { focusedRow: true }), true);
  assert.equal(canRunSelectedAction('toggleStar', state, { focusedRow: true }), true);
  assert.equal(canRunSelectedAction('selectMessage', state), false);
  assert.equal(canRunSelectedAction('selectMessage', { ...state, selectedMessageId: 'reader' }, { focusedRow: true }), false);
  const activeLabel = { accountId: 'a1', storageGeneration: 'g', labelId: 'l' };
  const blocked = { ...state, activeLabel, nativeLabelFeed: { key: JSON.stringify(['a1', 'g', 'l']), status: 'loading' } };
  for (const action of ['selectMessage', 'toggleStar', 'markRead', 'markUnread', 'markSpam']) {
    assert.equal(canRunSelectedAction(action, blocked, { focusedRow: true }), false, action);
  }
});


test('a saved shortcuts-off map from before Gmail actions keeps every layout shortcut off', () => {
  const savedOff = Object.fromEntries(Object.entries(ACTION_DEFS)
    .filter(([, definition]) => definition.defaultKey).map(([action]) => [action, '']));
  assert.equal(Object.values(getEffectiveShortcuts(savedOff, 'gmail')).some(Boolean), false);
});


test('Gmail-only actions and saved overrides survive layout switches without entering native groups', () => {
  const overrides = { backToList: 'q', markRead: 'shift+r', markSpam: 'shift+s' };
  const before = structuredClone(overrides);
  const actions = layout => Object.values(getGroupedActions(layout)).flat().map(item => item.action);
  for (const action of Object.keys(overrides)) {
    assert.ok(actions('gmail').includes(action));
    assert.equal(actions('comfortable').includes(action), false);
    assert.equal(actions().includes(action), false);
    assert.equal(getEffectiveShortcuts(overrides, 'gmail')[action], overrides[action]);
    assert.equal(getEffectiveShortcuts(overrides, 'comfortable')[action], '');
    assert.equal(getEffectiveShortcuts(overrides, 'gmail')[action], overrides[action]);
  }
  assert.deepEqual(overrides, before);
  const native = { backToList: 'u', markRead: 'e', markSpam: '#' };
  assert.equal(buildKeyMap(native, 'comfortable').u, 'markUnread');
  assert.equal(buildKeyMap(native, 'comfortable').e, 'archive');
  assert.equal(buildKeyMap(native, 'comfortable')['#'], 'delete');
  assert.deepEqual(getShortcutConflicts(native, 'comfortable'), []);
  assert.equal(getEffectiveShortcuts(native, 'gmail').backToList, 'u');
});
