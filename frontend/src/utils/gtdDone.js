import { getGtdMetadataSessionGeneration, refreshGtdMetadata } from '../plugins/gtd/metadataStore.js';
import {
  clearGtdRemovalGuard,
  setCompletedGtdRemoval,
  setPendingGtdRemoval,
} from './pendingGtdRemovals.js';

export async function doneGtdRow(thread, states, {
  gtdDone,
  removeGtdThread,
  restoreGtdThread,
  addNotification,
  scheduleGtdSectionsFetch,
  t,
}) {
  const metadataSession = getGtdMetadataSessionGeneration();
  const identity = thread.message_id || thread.id;
  const removal = setPendingGtdRemoval(identity, states);
  const snapshot = removeGtdThread(identity, states);

  try {
    const result = await gtdDone(thread.id, states);
    // A retained copy must be visible in the next authoritative sections payload.
    if (result?.threadRemains) clearGtdRemovalGuard(identity, states);
    else setCompletedGtdRemoval(identity, states, removal);
    if (result?.archiveFailed) {
      addNotification({ title: t('gtd.doneArchiveFailed'), body: thread.subject || t('common.noSubject') });
    }
    if (result?.threadRemains) {
      addNotification({ title: t('gtd.doneThreadRemains'), body: thread.subject || t('common.noSubject') });
    }
    scheduleGtdSectionsFetch();
    return result;
  } catch (err) {
    clearGtdRemovalGuard(identity, states);
    restoreGtdThread(snapshot);
    console.error('GTD done failed:', err.message);
    // 409: removing its GTD copies would delete the message's only copy.
    addNotification({ title: t('gtd.doneFailed'), body: err.status === 409 ? t('gtd.onlyCopy') : (thread.subject || t('common.noSubject')) });
    scheduleGtdSectionsFetch();
    return null;
  } finally {
    refreshGtdMetadata(thread, metadataSession);
  }
}
