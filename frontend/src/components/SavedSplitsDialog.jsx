import { useTranslation } from 'react-i18next';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store/index.js';
import { MAX_SAVED_SPLITS, validateSavedSplits } from '../utils/savedSplits.js';

const focusable = 'button:not(:disabled), input:not(:disabled), [tabindex="0"]';

export default function SavedSplitsDialog({ onClose }) {
  const { t } = useTranslation();
  const savedSplits = useStore(s => s.savedSplits);
  const loaded = useStore(s => s.savedSplitsLoaded);
  const saving = useStore(s => s.savedSplitsSaving);
  const [draft, setDraft] = useState(() => savedSplits.map(split => ({ ...split })));
  const [hideEmpty, setHideEmpty] = useState(() => useStore.getState().hideEmptySplits);
  const [revision, setRevision] = useState(() => useStore.getState().savedSplitsRevision);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const dialogRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement;
    dialogRef.current?.querySelector(focusable)?.focus();
    const keydown = event => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); return; }
      if (event.key !== 'Tab') return;
      const nodes = [...dialogRef.current.querySelectorAll(focusable)];
      const first = nodes[0]; const last = nodes.at(-1);
      if (!first) { event.preventDefault(); dialogRef.current.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      mounted.current = false;
      document.removeEventListener('keydown', keydown, true);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const reload = async () => {
    setLoading(true); setError(null);
    try {
      await useStore.getState().loadSavedSplits();
      if (!mounted.current) return;
      const state = useStore.getState();
      setDraft(state.savedSplits.map(split => ({ ...split })));
      setHideEmpty(state.hideEmptySplits); setRevision(state.savedSplitsRevision);
    } catch (err) { if (mounted.current) setError(err.message); }
    finally { if (mounted.current) setLoading(false); }
  };
  const update = (id, field, value) => setDraft(items => items.map(item => item.id === id ? { ...item, [field]: value } : item));
  const move = (index, delta) => setDraft(items => {
    const next = [...items];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    return next;
  });
  const save = async event => {
    event.preventDefault(); setError(null);
    const clean = validateSavedSplits(draft);
    if (!clean) { setError(t("savedSplits.validation", "Use unique names (1–60 characters) and queries (1–500 characters), with no blank fields.")); return; }
    try {
      const saved = await useStore.getState().saveSavedSplits(clean, hideEmpty, revision);
      if (saved && mounted.current) onClose();
    } catch (err) { if (mounted.current) setError(err.message); }
  };
  return createPortal(<div className="sh-splits-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="sh-splits-dialog" role="dialog" aria-modal="true" aria-labelledby="saved-splits-title" tabIndex={-1} ref={dialogRef}>
      <h2 id="saved-splits-title">{t("savedSplits.title", "Split Inbox")}</h2>
      <p>{t('savedSplits.help', { defaultValue: 'Save up to {{limit}} native mail searches. Results use this account’s Inbox, or included accounts in All inboxes. An in: operator overrides the folder.', limit: MAX_SAVED_SPLITS })}</p>
      <p>{t("savedSplits.searchHelp", "Try from:alice, subject:invoice, has:attachment, is:unread, is:starred, after:2026-01-01, or text. Prefix a term with - to exclude it. Counts describe synced messages, not mail-server totals.")}</p>
      <form onSubmit={save}>
        <fieldset disabled={!loaded || saving || loading}>
          <legend className="sr-only">{t("savedSplits.saved", "Saved splits")}</legend>
          {draft.length === 0 && <p>{t("savedSplits.empty", "No saved splits yet. Add a search to get started.")}</p>}
          <ol className="sh-splits-editor">
            {draft.map((split, index) => <li key={split.id}>
              <label>{t("admin.apiTokens.nameLabel", "Name")}<input required maxLength={60} value={split.label} data-split-name={split.id} aria-label={t('savedSplits.nameLabel', { defaultValue: 'Split {{number}} name', number: index + 1 })} onChange={event => update(split.id, 'label', event.target.value)} /></label>
              <label>{t("savedSplits.query", "Search query")}<input required maxLength={500} value={split.query} aria-label={t('savedSplits.queryLabel', { defaultValue: 'Split {{number}} query', number: index + 1 })} placeholder={t("savedSplits.queryExample", "from:alice is:unread")} onChange={event => update(split.id, 'query', event.target.value)} /></label>
              <div className="sh-splits-actions">
                <button type="button" disabled={index === 0} aria-label={t('savedSplits.moveUp', { defaultValue: 'Move {{name}} up', name: split.label || t('savedSplits.fallbackName', 'split') })} onClick={() => move(index, -1)}>↑</button>
                <button type="button" disabled={index === draft.length - 1} aria-label={t('savedSplits.moveDown', { defaultValue: 'Move {{name}} down', name: split.label || t('savedSplits.fallbackName', 'split') })} onClick={() => move(index, 1)}>↓</button>
                <button type="button" aria-label={t('savedSplits.delete', { defaultValue: 'Delete {{name}}', name: split.label || t('savedSplits.fallbackName', 'split') })} onClick={() => setDraft(items => items.filter(item => item.id !== split.id))}>{t("common.delete", "Delete")}</button>
              </div>
            </li>)}
          </ol>
          <button type="button" disabled={draft.length >= MAX_SAVED_SPLITS} onClick={() => {
            const id = crypto.randomUUID();
            setDraft(items => [...items, { id, label: '', query: '' }]);
            requestAnimationFrame(() => dialogRef.current?.querySelector(`[data-split-name="${id}"]`)?.focus());
          }}>{t("savedSplits.add", "Add split")}</button>
          <label className="sh-splits-hide"><input type="checkbox" checked={hideEmpty} onChange={event => setHideEmpty(event.target.checked)} />{t("savedSplits.hideEmpty", "Hide empty splits (keep the selected split visible)")}</label>
        </fieldset>
        {error && <p role="alert">{error}</p>}
        {!loaded && <p role="status">{t("savedSplits.loadFirst", "Load your saved splits before editing.")}</p>}
        <div className="sh-splits-footer">
          <button type="button" onClick={reload} disabled={saving || loading}>{loading ? t("common.loading", "Loading…") : t("savedSplits.reload", "Reload saved splits")}</button>
          <button type="button" onClick={onClose}>{saving ? t("savedSplits.close", "Close") : t("common.cancel", "Cancel")}</button>
          <button type="submit" disabled={!loaded || saving || loading}>{saving ? t("common.saving", "Saving…") : t("savedSplits.save", "Save splits")}</button>
        </div>
      </form>
    </section>
  </div>, document.body);
}
