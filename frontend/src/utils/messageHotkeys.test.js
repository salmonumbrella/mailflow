import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as hotkeys from './messageHotkeys.js';

const selectedMessage = hotkeys.selectedMessage ?? (() => null);
const markMessageUnread = hotkeys.markMessageUnread ?? (() => false);

describe('selected message hotkeys', () => {
  const inbox = { id: 'inbox', account_id: 'acct', is_read: true, category: 'primary' };
  const rail = { id: 'rail', account_id: 'acct', is_read: true };

  it('resolves normal, search, thread, and GTD rail selections; no selection is a no-op', () => {
    assert.equal(selectedMessage({ selectedMessageId: 'inbox', messages: [inbox], searchResults: [], searchQuery: '', threadMessages: {} }), inbox);
    assert.equal(selectedMessage({ selectedMessageId: 'rail', messages: [inbox], searchResults: [], searchQuery: '', threadMessages: {}, gtdSections: { todo: { threads: [rail] } } }), rail);
    assert.equal(selectedMessage({ selectedMessageId: 'rail', messages: [], searchResults: [rail], searchQuery: 'q', threadMessages: {} }), rail);
    assert.equal(selectedMessage({ selectedMessageId: null, messages: [inbox] }), null);
  });

  it('uses the frontmost open message window when the main list has no selection', () => {
    const behind = { id: 'behind', account_id: 'acct' };
    const front = { id: 'front', account_id: 'acct' };
    const state = {
      selectedMessageId: null, messages: [behind, front],
      messageWindows: [
        { messageId: 'behind', z: 3, minimized: false },
        { messageId: 'front', z: 5, minimized: false },
      ],
    };
    assert.equal(selectedMessage(state), front);
    assert.equal(selectedMessage({ ...state, messageWindows: state.messageWindows.map(w => ({ ...w, minimized: true })) }), null);
  });

  it('explicit unread cancels a pending auto-read, even if row is still unread', async () => {
    const calls = [];
    const cancel = () => calls.push('cancel');
    const patch = async (ids, read) => calls.push(['patch', ids, read]);
    assert.equal(markMessageUnread({ ...inbox, is_read: false }, { cancel, patch }), true);
    assert.deepEqual(calls, ['cancel']);
    assert.equal(markMessageUnread(inbox, {
      cancel,
      update: (id, data) => calls.push(['update', id, data]),
      incrementUnread: () => calls.push('increment'),
      adjustCategoryCount: () => calls.push('category'),
      patch,
    }), true);
    await Promise.resolve();
    assert.deepEqual(calls.slice(1), ['cancel', ['update', 'inbox', { is_read: false }], 'increment', 'category', ['patch', ['inbox'], false]]);
  });
});

describe('Superhuman focused list target', () => {
  it('resolves only a real visible desktop row, without stealing reader/window actions', () => {
    const previousWindow = globalThis.window;
    globalThis.window = { innerWidth: 1200 };
    try {
      const row = { id: 'focus', account_id: 'acct' };
      const reader = { id: 'reader', account_id: 'acct' };
      const state = { layout: 'superhuman', listFocusedMessageId: row.id, messages: [row, reader] };
      assert.equal(hotkeys.focusedListMessage(state), row);
      assert.equal(selectedMessage(state), row);
      assert.equal(selectedMessage({ ...state, selectedMessageId: reader.id }), reader);
      assert.equal(hotkeys.focusedListMessage({ ...state, selectedMessageId: reader.id }), null);
      assert.equal(hotkeys.focusedListMessage({ ...state, messageWindows: [{ messageId: reader.id, z: 1 }] }), null);
      for (const override of [{ layout: 'comfortable' }, { composing: true }, { showContacts: true }, { showAdmin: true }, { listFocusedMessageId: 'stale' }, { searchQuery: 'q', searchResults: [] }]) {
        assert.equal(hotkeys.focusedListMessage({ ...state, ...override }), null);
      }
      globalThis.window.innerWidth = 390;
      assert.equal(hotkeys.focusedListMessage(state), null);
    } finally {
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    }
  });
});
