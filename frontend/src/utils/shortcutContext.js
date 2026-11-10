// The event may originate from a descendant of an editor, rather than the editor
// itself. Keep native control activation separate from configurable mail actions.
export function shortcutEventBlocked(event, doc = document) {
  const target = event.target?.nodeType === 3 ? event.target.parentElement : event.target;
  if (event.isComposing || event.keyCode === 229 || ['Process', 'Dead', 'Unidentified'].includes(event.key)) return true;
  if (doc.querySelector('[aria-modal="true"], [role="menu"], [role="listbox"], [data-mailflow-context-menu]')) return true;
  // Nonmodal settings may stay open beside mail. Only their own controls own
  // normal keys; the reader's separate Escape handler still protects all dialogs.
  if (target?.closest?.('[role="dialog"]')) return true;
  if (target?.isContentEditable || target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return true;
  return ['Enter', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
    && Boolean(target?.closest?.('button, a[href], summary, [role="button"], [role="checkbox"], [role="switch"], [role="radio"], [role="tab"]'));
}

// Snapshot only identity/navigation, not read/star flags or asynchronous list
// refreshes. Any intervening transition cancels a partially typed sequence, even
// if React batches a change away and back into a single render.
export function shortcutContextKey(state) {
  return JSON.stringify([
    state.user?.id, state.isLocked, state.layout, state.selectedAccountId, state.selectedFolder,
    state.selectedMessageId, state.searchQuery, state.activeLabel, state.nativeLabelFeed?.key,
    state.nativeLabelFeed?.status, state.expandedThreadId, state.composing, state.showAdmin,
    state.showContacts, state.shortcuts,
    (state.accounts || []).map(account => [account.id, account.storage_generation, account.enabled, account.email_address]),
  ]);
}
