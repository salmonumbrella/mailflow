import { useTranslation } from 'react-i18next';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import SavedSplitsDialog from './SavedSplitsDialog.jsx';

export default function SavedSplitBar({ accountId }) {
  const { t } = useTranslation();
  const { user, isLocked, accounts, savedSplits, hideEmptySplits, savedSplitsRevision, activeSavedSplitId, selectSavedSplit } = useStore();
  const [editing, setEditing] = useState(false);
  const [snapshot, setSnapshot] = useState({ key: '', counts: {}, error: null });
  const [reload, setReload] = useState(0);
  const currentKey = JSON.stringify([user?.id, isLocked, accountId, accounts.map(a => [a.id, a.enabled, a.include_in_unified_inbox]), savedSplitsRevision, savedSplits]);
  const keyRef = useRef(currentKey);
  keyRef.current = currentKey;
  const counts = snapshot.key === currentKey ? snapshot.counts : {};
  const error = snapshot.key === currentKey ? snapshot.error : null;
  useEffect(() => {
    if (!user || isLocked || !savedSplits.length) return;
    let cancelled = false; let sequence = 0; let timer;
    const load = async () => {
      const request = ++sequence;
      setSnapshot({ key: currentKey, counts: {}, error: null });
      try {
        const data = await api.getSavedSplitCounts(accountId);
        if (cancelled || request !== sequence || keyRef.current !== currentKey) return;
        if (data.savedSplitsRevision !== savedSplitsRevision) throw new Error(t("savedSplits.changed", "Saved splits changed in another window. Open Manage splits and reload them."));
        setSnapshot({ key: currentKey, counts: data.counts || {}, error: null });
      } catch (err) {
        if (!cancelled && request === sequence && keyRef.current === currentKey) setSnapshot({ key: currentKey, counts: {}, error: err.message || t("savedSplits.countsUnavailable", "Split counts unavailable.") });
      }
    };
    load();
    const refresh = () => { clearTimeout(timer); timer = setTimeout(load, 500); };
    window.addEventListener('mailflow:refresh', refresh);
    window.addEventListener('mailflow:counts_refresh', refresh);
    return () => { cancelled = true; clearTimeout(timer); window.removeEventListener('mailflow:refresh', refresh); window.removeEventListener('mailflow:counts_refresh', refresh); };
  }, [currentKey, reload, user, isLocked, accountId, savedSplits.length, savedSplitsRevision, t]);
  useEffect(() => { setEditing(false); }, [user?.id, isLocked]);
  const activeError = counts[activeSavedSplitId]?.error;
  if (!user || isLocked) return null;
  return <div className="sh-saved-splits">
    <div className="sh-list-tabs" role="group" aria-label={t("savedSplits.searches", "Saved Split Inbox searches")}>
      {savedSplits.length > 0 && <button type="button" className="sh-list-tab" data-saved-split-id="" aria-pressed={!activeSavedSplitId} onClick={() => selectSavedSplit(null)}>{t("folders.inbox", "Inbox")}</button>}
      {savedSplits.filter(split => !hideEmptySplits || activeSavedSplitId === split.id || counts[split.id]?.total !== 0).map(split => <button
        key={split.id} type="button" data-saved-split-id={split.id} className="sh-list-tab" aria-pressed={activeSavedSplitId === split.id}
        title={counts[split.id]?.error || `${split.query} · ${counts[split.id] ? t("savedSplits.countHint", "Matching synced messages; not a mail-server total") : t("savedSplits.pendingCount", "Count not available yet")}`}
        onClick={() => selectSavedSplit(split.id)}>
        {split.label}<span>{counts[split.id]?.total ?? '—'}</span>
        {counts[split.id]?.unread > 0 && <span className="sh-category-unread" aria-label={t('savedSplits.unread', { defaultValue: '{{count}} unread', count: counts[split.id].unread })}>{counts[split.id].unread}</span>}
      </button>)}
      <button type="button" className="sh-list-tab" onClick={() => setEditing(true)}>{t("savedSplits.manage", "Manage splits")}</button>
    </div>
    {(error || activeError) && <div role="alert" className="sh-splits-error">{error || activeError} {error && <button type="button" onClick={() => setReload(value => value + 1)}>{t("savedSplits.retryCounts", "Retry counts")}</button>}</div>}
    {editing && <SavedSplitsDialog key={user?.id} onClose={() => setEditing(false)} />}
  </div>;
}
