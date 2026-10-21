import { inboxReadMembers } from './readCountScope.js';
import { beginCountIntent, countWriteTracker } from './countWriteTracker.js';
import { beginReadIntent, completeReadIntent, queueReadWrite, setReadIntentSession, pendingMarkReadMap, completedMarkReadMap } from './pendingReads.js';

// Resolve the selected row across the ordinary list, search, deep-link stash,
// and GTD rail. GTD copies may not exist in the current mailbox's messages.
export function selectedMessage(state) {
  const id = state?.selectedMessageId ?? topOpenMessageWindow(state)?.messageId;
  if (id == null) return null;
  const pool = state.searchQuery?.trim() ? state.searchResults : state.messages;
  return pool?.find(message => message.id === id)
    ?? Object.values(state.threadMessages || {}).flat().find(message => message.id === id)
    ?? Object.values(state.gtdSections || {}).flatMap(section => section?.threads || []).find(message => message.id === id)
    ?? null;
}

export function topOpenMessageWindow(state) {
  return (state?.messageWindows || []).filter(win => !win.minimized)
    .reduce((top, win) => !top || win.z > top.z ? win : top, null);
}

// Explicit unread wins over a delayed automatic read, even if the row is still
// unread at the moment the user presses u. Callers own their timer handles.
export function markMessageUnread(message, dependencies) {
  return changeMessageRead(message, false, dependencies);
}

export function changeMessageRead(message, read, {
  cancel, update, incrementUnread, decrementUnread, adjustCategoryCount, patch, onError,
  beginIntent = beginCountIntent, generation = () => countWriteTracker.generation(),
}) {
  if (!message) return false;
  message = { ...message, is_read: message.representative_is_read ?? message.is_read };
  cancel?.();
  if (message.is_read === read) return true;
  const session = generation();
  const currentSession = () => generation() === session;
  setReadIntentSession(session);
  const endIntent = beginIntent([message.account_id]);
  const intent = beginReadIntent(message, read);
  update?.(message.id, { is_read: read });
  const chargesInbox = inboxReadMembers([message]).length > 0;
  const accountCharge = chargesInbox
    ? (read ? decrementUnread?.(message.account_id) : incrementUnread?.(message.account_id)) : null;
  const categoryCharge = chargesInbox ? adjustCategoryCount?.(message.category, read ? -1 : 1) : null;
  completedMarkReadMap.delete(message.id);
  if (read) pendingMarkReadMap.set(message.id, message.account_id);
  else pendingMarkReadMap.delete(message.id);
  void queueReadWrite(intent, () => {
    if (currentSession()) return patch?.([message.id], read);
  }).then(() => {
    if (currentSession() && completeReadIntent(intent)) pendingMarkReadMap.delete(message.id);
  }, error => {
    if (!currentSession() || !completeReadIntent(intent, error)) return;
    pendingMarkReadMap.delete(message.id);
    if (intent.read !== read) {
      update?.(message.id, { is_read: intent.read });
      // Removal is operation-owned: exclusion/session pruning must never become
      // a fresh opposite delta when this late refusal arrives.
      if (accountCharge?.state() === 'live') accountCharge.revert();
      if (categoryCharge?.state() === 'live') categoryCharge.revert();
    }
    onError?.(error);
  }).finally(endIntent);
  return true;
}
