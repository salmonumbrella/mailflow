import { focusedListMessage, selectedMessage, topOpenMessageWindow } from './messageHotkeys.js';
import { findVisibleArchiveMessage } from './threadedArchive.js';
import { folderRole } from './folderDisplay.js';
import { createUndoableCommit, UNDO_COMMIT_DELAY_MS } from './undoableAction.js';
import { setPendingDelete, clearDeleteGuard } from './pendingDeletes.js';

// A generic move cannot clear the native snooze ledger; leave these to Unsnooze.
const hasSnooze = message => Boolean(message?.snooze_until || message?.folder === 'Snoozed'
  || (message?.snoozed_folder != null && message.folder === message.snoozed_folder));
const pending = new Set();
const inboxFolder = (state, accountId) => state.folders?.[accountId]?.find(folder =>
  folder.path && !folder.no_select && folderRole(folder) === 'inbox')?.path;
const available = (state, message) => Boolean(state.user && !state.isLocked
  && state.accounts.some(account => account.id === message.account_id && account.enabled !== false)
  && (!Array.isArray(state.folders?.[message.account_id]) || inboxFolder(state, message.account_id)));

// Only a visible main-list conversation owns this move. A parked child from another
// account, a draft, and a floating reader must never lend their IDs to a hidden row.
export function selectedInboxMove(state) {
  if (state.selectedFolder === 'Snoozed' || state.loadingMessages || (state.searchQuery?.trim() && state.isSearching) || state.showContacts || state.showAdmin || state.composing || topOpenMessageWindow(state)) return null;
  const opened = selectedMessage(state);
  const pool = state.searchQuery?.trim() ? state.searchResults : state.messages;
  const message = state.selectedMessageId
    ? findVisibleArchiveMessage(pool, state.selectedMessageId, state.threadMessages)
    : focusedListMessage(state);
  if (!message || message.account_id !== opened?.account_id || !available(state, message)) return null;
  const account = state.accounts.find(account => account.id === message.account_id);
  const source = state.folders?.[account.id]?.find(folder => folder.path === message.folder) || { path: message.folder };
  if (hasSnooze(message) || hasSnooze(opened) || message.is_draft || opened.is_draft || folderRole(source, account.folder_mappings) === 'drafts'
    || folderRole(source, account.folder_mappings) === 'inbox' || message.folder === inboxFolder(state, message.account_id)) return null;
  return message;
}

export async function returnConversationToInbox(message, { store, api, t, stillMounted = () => true, viewCurrent = () => true }) {
  const before = store.getState();
  if (selectedInboxMove(before)?.id !== message.id) return false;
  let folder = inboxFolder(before, message.account_id);
  const key = `${before.user.id}:${message.account_id}:${message.thread_id || message.id}`;
  if (pending.has(key)) return false;
  pending.add(key);
  let cancelled = false;
  let resolving = true;
  const identity = state => state.user?.id === before.user.id && available(state, message)
    && (!folder || inboxFolder(state, message.account_id) === folder);
  const matchesView = state => stillMounted() && viewCurrent()
    && state.selectedAccountId === before.selectedAccountId && state.selectedFolder === before.selectedFolder
    && state.selectedMessageId === before.selectedMessageId && state.listFocusedMessageId === before.listFocusedMessageId
    && state.searchQuery === before.searchQuery && state.layout === before.layout
    && state.composing === before.composing && state.showContacts === before.showContacts && state.showAdmin === before.showAdmin
    && state.messagesRefreshToken === before.messagesRefreshToken && !topOpenMessageWindow(state)
    && selectedInboxMove(state)?.id === message.id;
  const unsubscribe = store.subscribe(state => {
    if (!identity(state) || (resolving && !matchesView(state))) cancelled = true;
  });
  const current = () => !cancelled && identity(store.getState());
  const clean = () => { unsubscribe(); pending.delete(key); };
  const notifyError = () => store.getState().addNotification({ type: 'error', title: t('message.moved.failTitle'), body: t('message.moved.failBody') });
  try {
    if (!Array.isArray(before.folders?.[message.account_id])) {
      const folders = await api.getFolders(message.account_id);
      if (!current() || !matchesView(store.getState())) { clean(); return false; }
      if (!Array.isArray(folders)) throw new Error('Missing account folders');
      if (!folders.some(item => item.path && !item.no_select && folderRole(item) === 'inbox')) {
        notifyError(); store.getState().setFolders(message.account_id, folders); clean(); return false;
      }
      store.getState().setFolders(message.account_id, folders);
      folder = inboxFolder(store.getState(), message.account_id);
      if (!folder) { clean(); return false; }
    }
    const response = message.thread_id && Number(message.message_count) > 1
      ? await api.getThread(message.thread_id, message.folder, false) : { messages: [message] };
    if (!current() || !matchesView(store.getState())) { clean(); return false; }
    if (!Array.isArray(response?.messages)) throw new Error('Missing conversation messages');
    // Only this folder's copies move, excluding drafts, snoozes and another account's mail.
    const targets = response.messages.filter(row => row?.id && row.account_id === message.account_id
      && row.folder === message.folder && !row.is_draft && !hasSnooze(row));
    const ids = [...new Set(targets.map(row => row.id))];
    if (!ids.length) throw new Error('Conversation no longer exists in this folder');
    resolving = false;
    const visible = [...new Map([message, ...targets.filter(row => (before.searchQuery?.trim() ? before.searchResults : before.messages).some(item => item.id === row.id))].map(row => [row.id, row])).values()];
    const removedIds = [...new Set([message.id, ...ids])];
    removedIds.forEach(setPendingDelete);
    const clearGuards = () => removedIds.forEach(clearDeleteGuard);
    const restore = () => {
      clearGuards();
      if (current() && stillMounted() && viewCurrent()) store.getState().restoreMessages(visible);
    };
    store.getState().removeMessages(removedIds);
    if (message.thread_id) store.getState().clearThreadMessages(message.thread_id);
    const action = createUndoableCommit({
      delayMs: UNDO_COMMIT_DELAY_MS,
      undo: () => { restore(); clean(); },
      commit: async () => {
        if (!current()) { clearGuards(); clean(); return; }
        try {
          const result = await api.bulkMove(ids, folder);
          if (!current()) return;
          const moved = new Set(result?.moved || []);
          if (ids.some(id => !moved.has(id))) { restore(); notifyError(); }
          else store.getState().recordRecentFolder({ accountId: message.account_id, path: folder });
          window.dispatchEvent(new CustomEvent('mailflow:refresh'));
          window.dispatchEvent(new CustomEvent('mailflow:counts_refresh'));
        } catch {
          if (current()) { restore(); notifyError(); }
        } finally { clearGuards(); clean(); }
      },
    });
    store.getState().addNotification({ title: t('message.moved.title'), body: folder, onUndo: action.undo });
    return true;
  } catch {
    if (current() && matchesView(store.getState())) notifyError();
    clean(); return false;
  }
}
