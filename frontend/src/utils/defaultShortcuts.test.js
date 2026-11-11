// Run with: node --test src/utils/defaultShortcuts.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildKeyMap, buildModKeyMap, getShortcutConflicts, resolveShortcutAction, shortcutBindingFromEvent, shortcutActionText } from './defaultShortcuts.js';

const keyEvent = (key, modifiers = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...modifiers });

describe('general shortcut resolution', () => {
  it('registers message and mailbox actions without default collisions', (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const plain = buildKeyMap();
    const modified = buildModKeyMap();
    for (const [key, action] of Object.entries({ u: 'markUnread', i: 'loadRemoteImages', f: 'forward', '?': 'showHelp', '#': 'delete' })) assert.equal(plain[key], action);
    for (const [key, action] of Object.entries({ 'shift+u': 'unsubscribe', enter: 'replyAllFromSelection', '\\': 'toggleLeftSidebar', l: 'openLabelPicker' })) assert.equal(modified[key], action);
    for (let n = 1; n <= 9; n++) assert.equal(modified[String(n)], `goVisibleMailbox${n}`);
    assert.equal(warn.mock.callCount(), 0);
  });

  it('matches exact modifiers and shifted punctuation', () => {
    assert.equal(resolveShortcutAction(keyEvent('U', { ctrlKey: true, shiftKey: true })), 'unsubscribe');
    assert.equal(resolveShortcutAction(keyEvent('Enter', { ctrlKey: true })), 'replyAllFromSelection');
    assert.equal(resolveShortcutAction(keyEvent('\\', { ctrlKey: true })), 'toggleLeftSidebar');
    assert.equal(resolveShortcutAction(keyEvent('?', { shiftKey: true })), 'showHelp');
    assert.equal(resolveShortcutAction(keyEvent('#', { shiftKey: true })), 'delete');
    assert.equal(resolveShortcutAction(keyEvent('e', { ctrlKey: true })), null);
    assert.equal(resolveShortcutAction(keyEvent('Enter', { ctrlKey: true, shiftKey: true })), null);
    assert.equal(resolveShortcutAction(keyEvent('r', { shiftKey: true })), null);
    assert.equal(resolveShortcutAction(keyEvent('f', { altKey: true })), null);
    assert.equal(resolveShortcutAction(keyEvent('f', { metaKey: true })), null);
  });

  it('keeps user overrides and deterministic last-writer wins', () => {
    assert.equal(resolveShortcutAction(keyEvent('z'), { forward: 'z' }), 'forward');
    assert.equal(resolveShortcutAction(keyEvent('f'), { forward: 'z' }), null);
    assert.equal(resolveShortcutAction(keyEvent('p', { ctrlKey: true, shiftKey: true }), { forward: 'ctrl+shift+p' }), 'forward');
    assert.equal(resolveShortcutAction(keyEvent('u'), { archive: 'u', delete: 'u' }), 'delete');
  });
});

describe('buildKeyMap', () => {
  it('does not warn when no overrides are given (defaults have no collisions)', (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    buildKeyMap();
    assert.equal(warn.mock.callCount(), 0);
  });

  it('maps the GTD default keys (t/w/d) with no startup collision', (t) => {
    // buildKeyMap runs at app startup with the merged defaults+overrides; the new
    // GTD keys must not collide with any existing default.
    const warn = t.mock.method(console, 'warn', () => {});
    const map = buildKeyMap();
    assert.equal(warn.mock.callCount(), 0, 'default key set must have no collisions');
    assert.equal(map.t, 'gtdTodo');
    assert.equal(map.w, 'gtdWatch');
    assert.equal(map.d, 'gtdDelegated');
  });

  it('warns and keeps last-writer-wins when an override collides with a default key', (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    // 'archive' defaults to 'e'; override 'delete' (default '#') to the same key.
    const map = buildKeyMap({ delete: 'e' });
    assert.equal(warn.mock.callCount(), 1);
    const [message] = warn.mock.calls[0].arguments;
    assert.match(message, /"e"/);
    assert.match(message, /"archive"/);
    assert.match(message, /"delete"/);
    assert.equal(map.e, 'delete', 'later action (delete) should win');
  });
});

describe('buildModKeyMap', () => {
  it('does not warn when no overrides are given (defaults have no collisions)', (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const map = buildModKeyMap();
    assert.equal(warn.mock.callCount(), 0);
    assert.equal(map.z, 'undoAction');
  });

  it('warns and keeps last-writer-wins when an override collides on a modifier+key', (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    // 'printMessage' defaults to 'ctrl+p'; override 'toggleStar' (default 's') to the same combo.
    const map = buildModKeyMap({ toggleStar: 'ctrl+p' });
    assert.equal(warn.mock.callCount(), 1);
    const [message] = warn.mock.calls[0].arguments;
    assert.match(message, /"ctrl\+p"/);
    assert.match(message, /"toggleStar"/);
    assert.match(message, /"printMessage"/);
    assert.equal(map.p, 'printMessage', 'later action (printMessage) should win');
  });

  it('binds toggleRightSidebar to ctrl+/ without colliding with the plain "/" search key', (t) => {
    // ctrl+/ (right-sidebar toggle) and bare / (focusSearch) resolve in different maps, so
    // they must coexist with no collision warning.
    const warn = t.mock.method(console, 'warn', () => {});
    const modMap = buildModKeyMap();
    const keyMap = buildKeyMap();
    assert.equal(modMap['/'], 'toggleRightSidebar', 'ctrl+/ resolves to the right-sidebar toggle');
    assert.equal(keyMap['/'], 'focusSearch', 'bare / stays the search key (separate map)');
    assert.equal(warn.mock.callCount(), 0);
  });
});

describe('modifier shortcuts', () => {
  it('binds GTD Done to Shift+E while leaving Firefox Ctrl+Shift+E available', () => {
    assert.equal(resolveShortcutAction({ key: 'E', ctrlKey: true, shiftKey: true }), null);
    assert.equal(resolveShortcutAction({ key: 'e', ctrlKey: true, shiftKey: false }), null);
    assert.equal(resolveShortcutAction({ key: 'E', ctrlKey: false, shiftKey: true }), 'gtdDone');
    assert.equal(resolveShortcutAction(keyEvent('E', { ctrlKey: true, shiftKey: true }), { gtdDone: 'ctrl+shift+e' }), 'gtdDone');
  });

  it('reports the final winner of a full modifier collision before dispatch', (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const overrides = { toggleStar: 'ctrl+p' };
    assert.deepEqual(getShortcutConflicts(overrides), [{ key: 'ctrl+p', loser: 'toggleStar', winner: 'printMessage' }]);
    buildKeyMap(overrides);
    assert.equal(warn.mock.callCount(), 1);
    const action = resolveShortcutAction(keyEvent('p', { ctrlKey: true }), overrides);
    assert.equal(action, 'printMessage');
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /toggleStar.*printMessage/);
  });

  it('keeps Ctrl+P and Ctrl+Shift+P separate and records the full modifier set', (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const overrides = { toggleStar: 'ctrl+shift+p' };
    assert.deepEqual(getShortcutConflicts(overrides), []);
    buildModKeyMap(overrides);
    assert.equal(warn.mock.callCount(), 0);
    assert.equal(resolveShortcutAction(keyEvent('p', { ctrlKey: true }), overrides), 'printMessage');
    assert.equal(resolveShortcutAction(keyEvent('P', { ctrlKey: true, shiftKey: true }), overrides), 'toggleStar');
    assert.equal(shortcutBindingFromEvent(keyEvent('E', { ctrlKey: true, shiftKey: true })), 'ctrl+shift+e');
  });

  it('treats modifier order and case as the same binding', () => {
    assert.deepEqual(getShortcutConflicts({ toggleStar: 'shift+ctrl+U' }), [
      { key: 'ctrl+shift+u', loser: 'unsubscribe', winner: 'toggleStar' },
    ]);
  });
});

describe('Superhuman keyboard preset', () => {
  it('uses opt-in workspace bindings without changing other layouts', () => {
    assert.equal(resolveShortcutAction(keyEvent('Enter'), {}, 'superhuman'), 'openMessage');
    assert.equal(resolveShortcutAction(keyEvent('R', { shiftKey: true }), {}, 'superhuman'), 'replyAll');
    assert.equal(resolveShortcutAction(keyEvent('z'), {}, 'superhuman'), 'undoAction');
    assert.equal(resolveShortcutAction(keyEvent('h'), {}, 'superhuman'), 'snooze');
    for (const layout of [undefined, 'comfortable', 'list']) {
      assert.equal(resolveShortcutAction(keyEvent('Enter'), {}, layout), null);
      assert.equal(resolveShortcutAction(keyEvent('h'), {}, layout), null);
      assert.equal(resolveShortcutAction(keyEvent('a'), {}, layout), 'replyAll');
      assert.equal(resolveShortcutAction(keyEvent('z', { ctrlKey: true }), {}, layout), 'undoAction');
    }
    assert.equal(buildKeyMap({}, 'superhuman').Enter, 'openMessage');
    assert.deepEqual(getShortcutConflicts({}, 'superhuman'), []);
  });

  it('preserves custom actions, disabled actions, and keys claimed by another override', () => {
    const overrides = { openMessage: 'q', replyAll: null, forward: 'h', toggleStar: 'z' };
    assert.equal(resolveShortcutAction(keyEvent('q'), overrides, 'superhuman'), 'openMessage');
    assert.equal(resolveShortcutAction(keyEvent('Enter'), overrides, 'superhuman'), null);
    assert.equal(resolveShortcutAction(keyEvent('R', { shiftKey: true }), overrides, 'superhuman'), null);
    assert.equal(resolveShortcutAction(keyEvent('h'), overrides, 'superhuman'), 'forward');
    assert.equal(resolveShortcutAction(keyEvent('z'), overrides, 'superhuman'), 'toggleStar');
    assert.equal(resolveShortcutAction(keyEvent('z', { ctrlKey: true }), overrides, 'superhuman'), 'undoAction');
    assert.deepEqual(getShortcutConflicts(overrides, 'superhuman'), []);
    assert.deepEqual(overrides, { openMessage: 'q', replyAll: null, forward: 'h', toggleStar: 'z' });
  });
});


describe('untranslated command help', () => {
  it('provides human-readable labels and descriptions for new native actions', () => {
    const translateFallback = (_key, options) => options?.defaultValue;
    assert.equal(shortcutActionText(translateFallback, 'snooze', 'label'), 'Snooze');
    assert.equal(shortcutActionText(translateFallback, 'moveMessage', 'label'), 'Move to folder');
    assert.equal(shortcutActionText(translateFallback, 'snooze'), 'Choose when the selected message returns');
    assert.equal(shortcutActionText(translateFallback, 'moveMessage'), 'Move the selected message to another folder');
  });
});


describe('Superhuman native reference actions', () => {
  it('maps native folder, read, label and conversation actions without claiming unsupported features', () => {
    const bindings = { l: 'openLabelPicker', v: 'moveMessage', u: 'toggleRead', n: 'nextConversationMessage', p: 'prevConversationMessage', ArrowLeft: 'openFolderDrawer', ArrowRight: 'openHighlightedMessage' };
    for (const [key, action] of Object.entries(bindings)) {
      assert.equal(resolveShortcutAction(keyEvent(key), {}, 'superhuman'), action);
      assert.equal(resolveShortcutAction(keyEvent(key), { [action]: null }, 'superhuman'), null);
      assert.equal(resolveShortcutAction(keyEvent(key), { compose: key }, 'superhuman'), 'compose');
    }
    assert.equal(resolveShortcutAction(keyEvent('m'), {}, 'superhuman'), null);
    for (const key of ['M', 'I']) assert.equal(resolveShortcutAction(keyEvent(key, { shiftKey: true }), {}, 'superhuman'), null);
    assert.equal(resolveShortcutAction(keyEvent('E', { shiftKey: true })), 'gtdDone');
    assert.deepEqual(getShortcutConflicts({}, 'superhuman'), []);
  });
});

it('Superhuman native filters and Inbox move are opt-in and obey explicit overrides', () => {
  for (const [key, action] of [['E', 'returnToInbox'], ['U', 'filterUnread'], ['S', 'filterStarred']]) {
    assert.equal(resolveShortcutAction(keyEvent(key, { shiftKey: true }), {}, 'superhuman'), action);
    assert.equal(resolveShortcutAction(keyEvent(key, { shiftKey: true }), { [action]: null }, 'superhuman'), null);
    assert.equal(resolveShortcutAction(keyEvent(key, { shiftKey: true }), { compose: `shift+${key.toLowerCase()}` }, 'superhuman'), 'compose');
  }
  assert.equal(resolveShortcutAction(keyEvent('E', { shiftKey: true })), 'gtdDone');
  assert.equal(resolveShortcutAction(keyEvent('U', { shiftKey: true })), null);
  assert.equal(resolveShortcutAction(keyEvent('S', { shiftKey: true })), null);
});

it('reader-open help describes the context only in the Superhuman layout', () => {
  const t = key => key;
  assert.equal(shortcutActionText(t, 'openMessage', 'description', 'superhuman'), 'shortcuts.actions.openOrReplyAll.description');
  assert.equal(shortcutActionText(t, 'openMessage', 'label', 'comfortable'), 'shortcuts.actions.openMessage.label');
});
