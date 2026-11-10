import i18n from '../i18n.js';
import { api } from './api.js';
import { useStore } from '../store/index.js';
import { definitiveMembershipFailure, membershipRequests, readPendingMembership, savePendingMembership } from './nativeLabelMemberships.js';

function announcePending(accountId) {
  window.dispatchEvent(new CustomEvent('mailflow:native-membership-recovery', { detail: { accountId } }));
}
export function offerNativeLabelUndo(result, original) {
  if (result?.undoSupported !== true || original.originalMutationId || result.accountId !== original.accountId
    || result.storageGeneration !== original.storageGeneration || result.mutationId !== original.mutationId) return;
  let request;
  useStore.getState().addNotification({ title: i18n.t('gmail.memberships.updated', "Message labels updated"), accountId: original.accountId,
    onUndo: () => {
      request ||= { accountId: original.accountId, storageGeneration: original.storageGeneration, originalMutationId: original.mutationId, mutationId: crypto.randomUUID() };
      return undoNativeLabelMemberships(request);
    } });
}

// Undo is a new durable, atomic, version-checked decision. The server owns its preimage;
// never invert a partial UI selection or an unverified forward outcome.
export async function undoNativeLabelMemberships(payload, recovering = false) {
  const state = useStore.getState();
  const sameSession = () => useStore.getState().user?.id === state.user?.id;
  const notify = data => { if (sameSession()) useStore.getState().addNotification(data); };
  const invalidate = () => { if (sameSession()) useStore.getState().invalidateNativeLabels?.({ accountId: payload.accountId, storageGeneration: payload.storageGeneration }); };
  if (membershipRequests.has(payload.accountId)) return;
  const pending = readPendingMembership(payload.accountId);
  if (pending && pending.mutationId !== payload.mutationId) {
    notify({ type: 'error', title: i18n.t('gmail.memberships.verifyPendingFirst', "Verify the pending label change first"), body: i18n.t('gmail.memberships.openToVerify', "Open Labels for this account before making another change.") }); return;
  }
  recovering ||= pending?.mutationId === payload.mutationId;
  if (!recovering && !state.accounts.some(account => account.id === payload.accountId && account.storage_generation === payload.storageGeneration)) {
    notify({ type: 'error', title: i18n.t('gmail.memberships.undoFailed', "Labels could not be undone"), body: i18n.t('gmail.memberships.undoAccountChanged', "The account changed. Refresh its messages.") }); return;
  }
  if (!savePendingMembership(payload.accountId, payload)) {
    notify({ type: 'error', title: i18n.t('gmail.memberships.undoNotSent', "Undo was not sent"), body: i18n.t('gmail.memberships.undoJournalFailed', "Browser session storage is required to retain the recovery token.") }); return;
  }
  membershipRequests.add(payload.accountId); announcePending(payload.accountId);
  try {
    await api.undoNativeLabelMemberships(payload);
    savePendingMembership(payload.accountId, null);
    invalidate();
    notify({ title: i18n.t('gmail.memberships.undone', "Label change undone") });
  } catch (error) {
    if (definitiveMembershipFailure(error, recovering)) {
      savePendingMembership(payload.accountId, null);
      invalidate();
      notify({ type: 'error', title: i18n.t('gmail.memberships.undoFailed', "Labels could not be undone"), body: i18n.t('gmail.memberships.undoConflict', "The labels or message metadata changed. Later changes were not overwritten. Review the refreshed messages.") });
    } else {
      notify({ type: 'error', title: i18n.t('gmail.memberships.undoNeedsVerification', "Label Undo needs verification"), body: i18n.t('gmail.memberships.undoUncertain', "Its outcome is unknown. The exact request has been retained; do not clear browser storage."),
        actionLabel: i18n.t('gmail.memberships.retryPending', "Verify pending label change"), onAction: () => undoNativeLabelMemberships(payload, true) });
    }
  } finally { membershipRequests.delete(payload.accountId); announcePending(payload.accountId); }
}
