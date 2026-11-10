import { topOpenMessageWindow, selectedMessage } from './messageHotkeys.js';

const pending = new Set();
export const mutePath = id => `/mail/messages/${encodeURIComponent(id)}/mute`;
export function muteEligible(message, state) {
  return Boolean(message?.id && message.account_id && !message.is_draft && state.user && !state.isLocked
    && state.accounts.some(account => account.id === message.account_id && account.enabled !== false));
}

export function selectedMuteMessage(state) {
  if (state.showContacts || state.showAdmin || state.composing || topOpenMessageWindow(state)) return null;
  const message = selectedMessage(state);
  return muteEligible(message, state) ? message : null;
}

// Capture both identity and view before the first read. A navigation away and back also
// cancels work, so an old response cannot mutate a newer visit to the same conversation.
export async function toggleThreadMute(message, { store, api, t, stillMounted = () => true, onChanged = () => {} }) {
  const before = store.getState();
  if (!muteEligible(message, before)) return null;
  const key = `${before.user.id}:${message.account_id}:${message.thread_id || message.id}`;
  if (pending.has(key)) return null;
  pending.add(key);
  let cancelled = false;
  const matches = state => state.user?.id === before.user.id && !state.isLocked
    && state.selectedAccountId === before.selectedAccountId && state.selectedFolder === before.selectedFolder
    && state.selectedMessageId === before.selectedMessageId && state.listFocusedMessageId === before.listFocusedMessageId
    && state.searchQuery === before.searchQuery && state.layout === before.layout
    && state.composing === before.composing && state.showContacts === before.showContacts && state.showAdmin === before.showAdmin
    && state.messagesRefreshToken === before.messagesRefreshToken && !topOpenMessageWindow(state)
    && muteEligible(message, state);
  const unsubscribe = store.subscribe(state => { if (!matches(state)) cancelled = true; });
  const current = () => !cancelled && stillMounted() && matches(store.getState());
  try {
    const status = await api.get(mutePath(message.id));
    if (!current()) return null;
    if (typeof status.muted !== 'boolean' || !('revision' in status)) throw new Error(t('mutedThreads.failed', 'Could not update mute state.'));
    let targets = [];
    if (!status.muted && message.folder === 'INBOX') {
      const response = message.thread_id ? await api.getThread(message.thread_id, 'INBOX', false) : { messages: [message] };
      if (!current()) return null;
      // A thread can contain copies from other accounts and Sent; muting one account
      // never authorizes archiving those copies or any draft.
      targets = (response.messages || []).filter(row => row.account_id === message.account_id && row.folder === 'INBOX' && !row.is_draft);
      if (!targets.some(row => row.id === message.id)) targets.push(message);
    }
    const next = await api.patch(mutePath(message.id), { muted: !status.muted, revision: status.revision });
    if (!current()) {
      if (store.getState().user?.id === before.user.id && !store.getState().isLocked) window.dispatchEvent(new CustomEvent('mailflow:mute_changed'));
      return null;
    }
    onChanged(next);
    let archiveError = false;
    if (next.muted && targets.length) {
      try {
        const ids = [...new Set(targets.map(row => row.id))];
        if (!next.revision || !next.threadKey) throw new Error('Missing mute archive guard');
        const result = await api.bulkArchive(ids, undefined, { messageId: message.id, revision: next.revision, accountId: message.account_id, threadKey: next.threadKey });
        if (!current()) return next;
        const archived = new Set((result.archived || []).filter(id => ids.includes(id)));
        archiveError = archived.size !== ids.length || Boolean(result.noArchiveFolder?.length);
        const state = store.getState();
        targets.filter(row => archived.has(row.id) && !row.is_read).forEach(row => state.decrementUnread(row.account_id));
        // This is our own completed mutation, not a reason to cancel its notification.
        unsubscribe();
        state.removeMessages([...archived]);
        if (message.thread_id) state.clearThreadMessages(message.thread_id);
      } catch {
        if (!current()) return next;
        archiveError = true;
      }
    }
    if (store.getState().user?.id === before.user.id && !store.getState().isLocked) {
      store.getState().addNotification({ type: archiveError ? 'error' : 'success', title: archiveError
        ? t('mutedThreads.archiveFailed', 'The conversation is muted, but could not be archived.')
        : next.muted ? t('mutedThreads.muted', 'Conversation muted') : t('mutedThreads.unmuted', 'Conversation unmuted') });
      window.dispatchEvent(new CustomEvent('mailflow:mute_changed'));
      window.dispatchEvent(new CustomEvent('mailflow:refresh'));
      window.dispatchEvent(new CustomEvent('mailflow:counts_refresh'));
    }
    return next;
  } catch (error) {
    if (!current()) return null;
    if (error.status === 409) throw new Error(t('mutedThreads.changed', 'Mute state changed. Refresh and try again.'), { cause: error });
    throw error;
  } finally {
    unsubscribe(); pending.delete(key);
  }
}
