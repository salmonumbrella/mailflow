export const NATIVE_LABELS_CHANGED = 'mailflow:native-labels-changed';
export const labelViewKey = view => view ? JSON.stringify([view.accountId, view.storageGeneration, view.labelId]) : '';
export const validLabelView = view => !!view && ['accountId', 'storageGeneration', 'labelId'].every(key => typeof view[key] === 'string' && view[key].length > 0);
export function labelViewUrl(view) {
  return `/#label/${[view.accountId, view.storageGeneration, view.labelId].map(encodeURIComponent).join('/')}`;
}
export function parseLabelView(hash) {
  const parts = String(hash).match(/^#label\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!parts) return null;
  try { const [accountId, storageGeneration, labelId] = parts.slice(1).map(decodeURIComponent); const view = { accountId, storageGeneration, labelId }; return validLabelView(view) ? view : null; } catch { return null; }
}

// History stores the discriminator, never a synthetic IMAP path. Install once per mail app.
export function installLabelHistory(store, win = window) {
  let applying = false;
  const apply = () => {
    const label = parseLabelView(win.location.hash);
    const saved = win.history.state?.nativeMailView;
    applying = true;
    if (label) store.getState().setActiveLabel(label);
    else if (saved?.kind === 'folder') store.getState().setSelectedAccount(saved.accountId, saved.folder);
    else if (store.getState().activeLabel) store.getState().setSelectedAccount(store.getState().selectedAccountId, 'INBOX');
    applying = false;
  };
  const snapshot = state => state.activeLabel ? { kind: 'label', ...state.activeLabel } : { kind: 'folder', accountId: state.selectedAccountId, folder: state.selectedFolder || 'INBOX' };
  const initial = parseLabelView(win.location.hash);
  if (initial) apply();
  win.history.replaceState({ ...win.history.state, nativeMailView: snapshot(store.getState()) }, '', win.location.href);
  const unsubscribe = store.subscribe((state, previous) => {
    if (applying || labelViewKey(state.activeLabel) === labelViewKey(previous.activeLabel) && state.selectedAccountId === previous.selectedAccountId && state.selectedFolder === previous.selectedFolder) return;
    // Leave existing folder history behavior alone unless crossing the native-label boundary.
    if (!state.activeLabel && !previous.activeLabel) {
      win.history.replaceState({ ...win.history.state, nativeMailView: snapshot(state) }, '', win.location.href);
      return;
    }
    const method = state.labelNavigationReplace ? 'replaceState' : 'pushState';
    win.history[method]({ nativeMailView: snapshot(state) }, '', state.activeLabel ? labelViewUrl(state.activeLabel) : '/');
  });
  win.addEventListener('popstate', apply);
  return () => { unsubscribe(); win.removeEventListener('popstate', apply); };
}

export function dedupeNativeMessages(messages, view) {
  const seen = new Set();
  return messages.filter(message => {
    if (!message.entityId || message.account_id !== view.accountId || message.storageGeneration !== view.storageGeneration) return false;
    if (seen.has(message.entityId)) return false;
    seen.add(message.entityId); return true;
  });
}

export function nativeLabelActionsBlocked(state) {
  return Boolean(state?.activeLabel && (state.nativeLabelFeed?.key !== labelViewKey(state.activeLabel) || state.nativeLabelFeed?.status !== 'ready'));
}
