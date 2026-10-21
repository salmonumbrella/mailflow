import { useStore } from '../store/index.js';
import { api } from './api.js';
import { pendingMarkReadMap, completedMarkReadMap, setReadIntentSession } from './pendingReads.js';
import { changeMessageRead } from './messageHotkeys.js';

const scheduledByMessage = new Map();
const scheduledMessageByTimer = new Map();

export function cancelScheduledMarkRead(timer) {
  if (!timer) return;
  clearTimeout(timer);
  const id = scheduledMessageByTimer.get(timer);
  if (id == null) return;
  scheduledMessageByTimer.delete(timer);
  const timers = scheduledByMessage.get(id);
  timers?.delete(timer);
  if (timers?.size === 0) scheduledByMessage.delete(id);
}

export function cancelScheduledMarkReadFor(id) {
  const timers = scheduledByMessage.get(id);
  if (!timers) return;
  for (const timer of timers) {
    clearTimeout(timer);
    scheduledMessageByTimer.delete(timer);
  }
  scheduledByMessage.delete(id);
}

// The mark-read protocol, in one place.
//
// Three callers need it: MessagePane (opening a message in the reading pane),
// ConversationPane (expanding a card in a thread) and MailApp (the deep-link and
// notification-tap path). It is not a one-liner worth copying: the optimistic flag,
// the unread badge, the category count and the pending-read guard have to be set
// together and rolled back together, or a failed PATCH leaves the badge drifting
// away from the list it is supposed to be counting.
//
// Idempotent: an already-read message is a no-op, so callers do not have to guard.

export function applyMarkRead(msg) {
  if (!msg || msg.is_read) return;
  const st = useStore.getState();
  return changeMessageRead(msg, true, {
    update: st.updateMessage, decrementUnread: st.decrementUnread,
    incrementUnread: st.incrementUnread, adjustCategoryCount: st.adjustCategoryCount,
    patch: api.bulkRead,
    onError: error => st.addNotification({ type: 'error', title: error.message }),
  });
}

setReadIntentSession(useStore.getState().countGeneration);
useStore.subscribe((state, previous) => {
  if (state.countGeneration === previous.countGeneration) return;
  setReadIntentSession(state.countGeneration);
  for (const timer of scheduledMessageByTimer.keys()) cancelScheduledMarkRead(timer);
  pendingMarkReadMap.clear();
  completedMarkReadMap.clear();
});

// Honors the user's markReadBehavior preference. Returns a timer handle when the
// mark was deferred, so the caller can cancelScheduledMarkRead it if the reader
// moves on first, and null when there is nothing to cancel.
export function scheduleMarkRead(msg) {
  if (!msg || msg.is_read) return null;
  const { markReadBehavior, markReadDelay, countGeneration } = useStore.getState();
  if (markReadBehavior === 'manual') return null;
  if (markReadBehavior === 'delay') {
    const timer = setTimeout(() => {
      const timers = scheduledByMessage.get(msg.id);
      timers?.delete(timer);
      scheduledMessageByTimer.delete(timer);
      if (timers?.size === 0) scheduledByMessage.delete(msg.id);
      if (useStore.getState().countGeneration === countGeneration) applyMarkRead(msg);
    }, (markReadDelay || 1) * 1000);
    if (!scheduledByMessage.has(msg.id)) scheduledByMessage.set(msg.id, new Set());
    scheduledByMessage.get(msg.id).add(timer);
    scheduledMessageByTimer.set(timer, msg.id);
    return timer;
  }
  applyMarkRead(msg);
  return null;
}
