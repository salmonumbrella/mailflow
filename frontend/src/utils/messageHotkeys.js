// Resolve the selected row across the ordinary list, search, deep-link stash,
// and GTD rail. GTD copies may not exist in the current mailbox's messages.
export function selectedMessage(state) {
  const id = state?.selectedMessageId ?? topOpenMessageWindow(state)?.messageId ?? focusedListMessage(state)?.id;
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
export function markMessageUnread(message, { cancel, update, incrementUnread, decrementUnread, adjustCategoryCount, patch }) {
  if (!message) return false;
  cancel?.();
  if (!message.is_read) return true;
  update?.(message.id, { is_read: false });
  incrementUnread?.(message.account_id);
  adjustCategoryCount?.(message.category, 1);
  void Promise.resolve(patch?.([message.id], false)).catch(error => {
    console.error('markUnread failed:', error?.message);
    update?.(message.id, { is_read: true });
    decrementUnread?.(message.account_id);
    adjustCategoryCount?.(message.category, -1);
  });
  return true;
}

// List focus is not a reader selection: moving through the inbox must not fetch a body or mark
// mail read. Ignore it outside this desktop layout and whenever a reader/window owns actions.
export function focusedListMessage(state) {
  if (state?.layout !== 'superhuman' || state.selectedMessageId || topOpenMessageWindow(state)) return null;
  if (typeof window === 'undefined' || window.innerWidth < 768) return null;
  if (state.showContacts || state.showAdmin || state.composing) return null;
  const pool = state.searchQuery?.trim() ? state.searchResults : state.messages;
  return pool?.find(message => message.id === state.listFocusedMessageId) ?? null;
}
