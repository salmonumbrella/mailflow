import test from 'node:test';
import assert from 'node:assert/strict';
import { accountForShortcut, runAccountShortcut } from './accountShortcuts.js';
import { getEffectiveShortcuts, getShortcutConflicts } from './defaultShortcuts.js';

test('numbered account actions are independent of drawer rows and skip disabled accounts', () => {
  const calls = [];
  const state = { accounts: [{ id: 'one' }, { id: 'disabled', enabled: false }, { id: 'two', enabled: true }],
    setShowContacts: value => calls.push(['contacts', value]), setSearchQuery: value => calls.push(['search', value]),
    setSelectedAccount: (...args) => calls.push(['account', ...args]) };
  assert.equal(accountForShortcut('goAccount2', state).id, 'two');
  assert.equal(accountForShortcut('goAccount3', state), null);
  assert.equal(accountForShortcut('goVisibleMailbox1', state), null);
  assert.equal(runAccountShortcut('goAccount2', state), true);
  assert.deepEqual(calls, [['contacts', false], ['search', ''], ['account', 'two', 'INBOX']]);
  assert.equal(runAccountShortcut('goAccount9', state), false);
  assert.equal(calls.length, 3);
});

test('Superhuman account bindings preserve native layout and custom shortcuts without conflicts', () => {
  const native = getEffectiveShortcuts();
  const workspace = getEffectiveShortcuts({}, 'superhuman');
  for (let n = 1; n <= 9; n++) {
    assert.equal(native[`goVisibleMailbox${n}`], `ctrl+${n}`);
    assert.equal(native[`goAccount${n}`], null);
    assert.equal(workspace[`goVisibleMailbox${n}`], null);
    assert.equal(workspace[`goAccount${n}`], `ctrl+${n}`);
  }
  assert.deepEqual(getShortcutConflicts({}, 'superhuman'), []);
  const custom = getEffectiveShortcuts({ goVisibleMailbox2: 'ctrl+2', goAccount3: 'alt+3', archive: 'ctrl+4' }, 'superhuman');
  assert.equal(custom.goVisibleMailbox2, 'ctrl+2');
  assert.equal(custom.goAccount2, null);
  assert.equal(custom.goAccount3, 'alt+3');
  assert.equal(custom.goAccount4, null);
});
