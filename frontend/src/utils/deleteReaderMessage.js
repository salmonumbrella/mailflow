import { api } from './api.js';
import { useStore } from '../store/index.js';
import { pendingDeleteMap, completedDeleteMap, setPendingDelete, setCompletedDelete, clearDeleteGuard } from './pendingDeletes.js';
import { cancelScheduledMarkReadFor } from './markRead.js';
import { holdUndoable, releaseUndoable, UNDO_COMMIT_DELAY_MS } from './undoableAction.js';

// The single reader's native Undo/guard lifecycle, scoped to one actual mailbox identity.
// A conversation card need not be a list row: restoring an unlisted child with
// restoreMessages would insert it as a second top-level row alongside its conversation.
export function deleteReaderMessage(message, { t, addNotification, beforeRemove, onRemove, onRestore }) {
  if (!message?.id || pendingDeleteMap.has(message.id) || completedDeleteMap.has(message.id)) return false;
  const store = useStore.getState();
  const wasListed = [...store.messages, ...store.searchResults].some(item => item.id === message.id);
  cancelScheduledMarkReadFor(message.id);
  beforeRemove?.();
  setPendingDelete(message.id);
  if (wasListed) store.removeMessage(message.id);
  if (!message.is_read) store.decrementUnread(message.account_id, 1, { undoable: true });
  onRemove?.(message);
  const restore = () => {
    clearDeleteGuard(message.id);
    const state = useStore.getState();
    if (wasListed) state.restoreMessages([message]);
    if (!message.is_read) state.incrementUnread(message.account_id);
    onRestore?.(message);
  };
  const timer = holdUndoable(async () => {
    try {
      // No thread lookup or bulk expansion is permitted for an individual card.
      await api.deleteMessage(message.id);
      setCompletedDelete(message.id);
      window.dispatchEvent(new CustomEvent('mailflow:refresh'));
    } catch (error) {
      restore();
      addNotification({ type: 'error', title: t('messageList.deleted.failTitle'), body: error.message || t('messageList.deleted.failBody') });
    }
  }, UNDO_COMMIT_DELAY_MS);
  addNotification({
    title: t('messageList.deleted.title'), body: t('messageList.deleted.body'),
    onUndo: () => { if (releaseUndoable(timer)) restore(); },
  });
  return true;
}
