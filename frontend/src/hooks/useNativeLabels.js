import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { useStore } from '../store/index.js';
import { NATIVE_LABELS_CHANGED } from '../utils/nativeLabelNavigation.js';

export function useNativeLabels(accountId) {
  const { t } = useTranslation();
  const translate = useRef(t);
  translate.current = t;
  const snapshot = useStore(state => state.nativeLabelSnapshots[accountId]);
  const generation = useStore(state => state.accounts.find(account => account.id === accountId)?.storage_generation);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    if (!accountId) return;
    const request = ++sequence.current;
    const userId = useStore.getState().user?.id;
    const current = () => request === sequence.current && useStore.getState().user?.id === userId && !useStore.getState().isLocked && (!generation || useStore.getState().accounts.find(account => account.id === accountId)?.storage_generation === generation);
    setStatus('loading'); setError('');
    try {
      const definitions = await api.getNativeLabels(accountId);
      if (!current()) return;
      if (!Array.isArray(definitions.labels) || !definitions.storageGeneration || definitions.accountId !== accountId || generation && definitions.storageGeneration !== generation) throw new Error(translate.current('gmail.labelNavigation.unverifiedLabels', "Label identities could not be verified. Reload accounts and try again."));
      const counts = await api.getNativeLabelCounts(accountId, definitions.storageGeneration);
      if (!current()) return;
      if (counts.accountId !== accountId || counts.storageGeneration !== definitions.storageGeneration || !Array.isArray(counts.counts)) throw new Error(translate.current('gmail.labelNavigation.wrongCountMailbox', "Label counts belong to a different mailbox. Try again."));
      useStore.getState().setNativeLabelSnapshot(accountId, { ...definitions, counts: counts.counts, coverage: counts.coverage });
      const active = useStore.getState().activeLabel;
      if (active?.accountId === accountId && (active.storageGeneration !== definitions.storageGeneration || !definitions.labels.some(label => label.id === active.labelId))) {
        useStore.getState().setSelectedAccount(accountId, 'INBOX', { replaceHistory: true });
        useStore.getState().addNotification({ title: translate.current('gmail.labelNavigation.unavailable', "This label is no longer available. Inbox opened.") });
      }
      setStatus('ready');
    } catch (err) { if (current()) { setStatus('error'); setError(err.message || translate.current('gmail.labelNavigation.loadFailed', "Labels could not be loaded.")); } }
  }, [accountId, generation]);
  useEffect(() => {
    const lifecycle = sequence;
    refresh();
    const changed = event => { if (!event.detail?.accountId || event.detail.accountId === accountId) refresh(); };
    const focus = () => refresh();
    window.addEventListener(NATIVE_LABELS_CHANGED, changed);
    window.addEventListener('focus', focus);
    window.addEventListener('mailflow:refresh', focus);
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') refresh(); }, 30000);
    return () => { lifecycle.current++; window.clearInterval(timer); window.removeEventListener(NATIVE_LABELS_CHANGED, changed); window.removeEventListener('focus', focus); window.removeEventListener('mailflow:refresh', focus); };
  }, [refresh, accountId]);
  return { snapshot: snapshot?.storageGeneration && (!generation || snapshot.storageGeneration === generation) ? snapshot : null, status, error, refresh };
}
