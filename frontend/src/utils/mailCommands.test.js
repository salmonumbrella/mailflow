import test from 'node:test';
import assert from 'node:assert/strict';
import { canRunMailCommand, mailCommandDefinitions, commandShortcutLabel } from './mailCommands.js';

const selected = {
  layout: 'superhuman', selectedMessageId: 'm', messages: [{ id: 'm', account_id: 'a', folder: 'INBOX', is_read: true }],
  accounts: [{ id: 'a', enabled: true }], folders: { a: [{ path: 'Projects' }, { path: 'Archive' }] },
};
const t = (_key, options) => options.defaultValue;

test('commands resolve to native mail actions and name Archive accurately', () => {
  const commands = mailCommandDefinitions(selected, t);
  assert.equal(commands.find(item => item.action === 'archive').label, 'Archive');
  assert.equal(commands.find(item => item.action === 'archive').shortcut, 'E');
  assert.equal(commands.find(item => item.action === 'snooze').shortcut, 'H');
  assert.equal(commands.find(item => item.action === 'replyAll').shortcut, '⇧ R');
  assert.ok(commands.some(item => item.action === 'markUnread'));
  assert.ok(!commands.find(item => item.action === 'moveMessage').disabled);
  assert.ok(commands.find(item => item.action === 'undoAction').disabled);
});

test('mail actions require a live enabled-account target and respect modal context', () => {
  const actions = ['archive', 'snooze', 'reply', 'replyAll', 'forward', 'toggleStar', 'markUnread', 'toggleRead', 'delete', 'openLabelPicker', 'moveMessage'];
  for (const action of actions) {
    assert.equal(canRunMailCommand(action, selected), true, action);
    for (const changes of [{ selectedMessageId: null }, { messages: [] }, { accounts: [{ id: 'a', enabled: false }] }, { composing: true }, { showAdmin: true }]) {
      assert.equal(canRunMailCommand(action, { ...selected, ...changes }), false, `${action}: ${JSON.stringify(changes)}`);
    }
  }
  assert.equal(canRunMailCommand('focusSearch', { ...selected, selectedMessageId: null }), true);
  assert.equal(canRunMailCommand('focusSearch', { ...selected, composing: true }), false);
});

test('folders and undo reflect real availability rather than placeholder actions', () => {
  const withoutFolders = { ...selected, folders: { a: [{ path: 'INBOX' }, { path: 'Hidden', no_select: true }] } };
  assert.equal(canRunMailCommand('moveMessage', withoutFolders), false);
  assert.equal(canRunMailCommand('openLabelPicker', withoutFolders), false);
  assert.equal(canRunMailCommand('openLabelPicker', { ...selected, folders: {} }), true);
  assert.equal(canRunMailCommand('moveMessage', { ...selected, folders: {} }), true, 'the native picker fetches unknown folders');
  assert.equal(canRunMailCommand('openLabelPicker', { ...selected, folders: { a: [] } }), false);
  assert.equal(canRunMailCommand('undoAction', { notifications: [] }), false);
  assert.equal(canRunMailCommand('undoAction', { notifications: [{ onUndo() {} }] }), true);
  assert.equal(commandShortcutLabel(null), '');
  assert.equal(commandShortcutLabel('Enter'), '↵');
});

test('read/star labels and displayed shortcuts reflect current state and overrides', () => {
  const state = { ...selected, messages: [{ ...selected.messages[0], is_read: false, is_starred: true }], shortcuts: { snooze: 'q', replyAll: null } };
  const commands = mailCommandDefinitions(state, t);
  assert.equal(commands.find(item => item.action === 'toggleRead').label, 'Mark read');
  assert.equal(commands.find(item => item.action === 'toggleStar').label, 'Remove star');
  assert.equal(commands.find(item => item.action === 'snooze').shortcut, 'Q');
  assert.equal(commands.find(item => item.action === 'replyAll').shortcut, '');
});

test('desktop list focus is usable but stale, mobile, and pop-out list targets are not', () => {
  const previousWindow = globalThis.window;
  globalThis.window = { innerWidth: 1024 };
  const focused = { ...selected, selectedMessageId: null, listFocusedMessageId: 'm' };
  try {
    for (const action of ['archive', 'delete', 'snooze', 'moveMessage', 'toggleRead']) {
      assert.equal(canRunMailCommand(action, focused), true, action);
      assert.equal(canRunMailCommand(action, { ...focused, listFocusedMessageId: 'gone' }), false, action);
      assert.equal(canRunMailCommand(action, { ...focused, messageWindows: [{ messageId: 'm', z: 1 }] }), false, action);
    }
    globalThis.window.innerWidth = 500;
    assert.equal(canRunMailCommand('archive', focused), false);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
