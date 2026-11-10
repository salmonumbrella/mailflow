import { useStore } from '../store/index.js';

export const GMAIL_SENDER_FILTER_EVENT = 'mailflow:gmail-sender-filter';

// A thread can contain copies from several accounts. Never substitute its selected account
// (or unified scope) for the actual message the user acted on.
export function gmailSenderFilterDetails(message, state) {
  if (state.layout !== 'gmail' || !message?.account_id || !state.user?.id) return null;
  const account = state.accounts.find(item => item.id === message.account_id && item.enabled !== false);
  const sender = typeof message.from_email === 'string' ? message.from_email.trim() : '';
  if (!account || !sender) return null;
  return { accountId: account.id, sender, userId: state.user.id };
}

/** Open an editable filter, without changing the search, selection, or saving a rule. */
export function openGmailSenderFilter(message) {
  const detail = gmailSenderFilterDetails(message, useStore.getState());
  if (!detail || typeof window === 'undefined') return false;
  // The mounted Gmail search acknowledges the request. No listener means no successful open.
  return !window.dispatchEvent(new CustomEvent(GMAIL_SENDER_FILTER_EVENT, { detail, cancelable: true }));
}
