import { useStore } from '../store/index.js';
import { NATIVE_LABELS_CHANGED } from '../utils/nativeLabelNavigation.js';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { definitiveLabelFailure, labelDraft, labelParentOptions, labelTree, readPendingLabelMutation, savePendingLabelMutation } from '../utils/nativeLabels.js';
import './GmailLabelManager.css';

export default function GmailLabelManager({ accountId, onLockChange, initialCreate = false }) {
  const { t } = useTranslation();
  const uid = useId();
  const translate = useRef(t);
  translate.current = t;
  const region = useRef(null);
  const opener = useRef(null);
  const restoreFocus = useRef(false);
  const inFlight = useRef(false);
  const initialCreateConsumed = useRef(false);
  const mounted = useRef(false);
  const readVersion = useRef(0);
  const [snapshot, setSnapshot] = useState(null);
  const [counts, setCounts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState(null);
  const [preview, setPreview] = useState(null);
  const [pending, setPending] = useState(() => readPendingLabelMutation(accountId));
  const locked = busy || !!pending;
  const labels = snapshot?.labels || [];

  const refresh = useCallback(async () => {
    const version = ++readVersion.current;
    setLoading(true);
    try {
      const data = await api.getNativeLabels(accountId);
      if (!Array.isArray(data.labels) || typeof data.treeRevision !== 'string') throw new Error(translate.current('gmail.nativeLabels.invalidResponse', 'The label list could not be verified. Retry loading it.'));
      if (mounted.current && version === readVersion.current) {
        setSnapshot(data); setCounts(null);
        // Count failure never blocks definition recovery or turns an acknowledged save into failure.
        if (data.storageGeneration) api.getNativeLabelCounts(accountId, data.storageGeneration).then(result => {
          if (mounted.current && version === readVersion.current && result.accountId === accountId && result.storageGeneration === data.storageGeneration && Array.isArray(result.counts)) setCounts(result.counts);
        }).catch(() => {});
      }
    } catch (err) {
      if (mounted.current && version === readVersion.current) {
        setSnapshot(null); setError(err.message || translate.current('gmail.nativeLabels.loadFailed', 'Labels could not be loaded. Retry.'));
      }
    } finally { if (mounted.current && version === readVersion.current) setLoading(false); }
  }, [accountId]);

  useEffect(() => {
    mounted.current = true;
    const generation = readVersion;
    refresh();
    const onFocus = () => { if (!inFlight.current) refresh(); };
    const changed = event => { if ((!event.detail?.accountId || event.detail.accountId === accountId) && !inFlight.current) refresh(); };
    window.addEventListener(NATIVE_LABELS_CHANGED, changed);
    window.addEventListener('focus', onFocus);
    const interval = window.setInterval(() => { if (document.visibilityState !== 'hidden' && !inFlight.current) refresh(); }, 30000);
    return () => { mounted.current = false; ++generation.current; window.removeEventListener(NATIVE_LABELS_CHANGED, changed); window.removeEventListener('focus', onFocus); window.clearInterval(interval); };
  }, [refresh, accountId]);
  useEffect(() => { onLockChange?.(locked); return () => onLockChange?.(false); }, [locked, onLockChange]);
  useEffect(() => {
    if (!initialCreate || initialCreateConsumed.current || !snapshot || loading) return;
    initialCreateConsumed.current = true;
    if (locked) return; // A pending request must be settled before offering a different mutation.
    opener.current = region.current?.querySelector('[data-create-label]');
    setEditor({ draft: labelDraft() });
  }, [initialCreate, snapshot, loading, locked]);
  const editing = !!editor;
  const confirming = !!preview;
  const editingId = editor?.id;
  useEffect(() => {
    if (editing || confirming) region.current?.querySelector(confirming ? '[data-keep-labels]' : '[data-label-editor] input')?.focus();
  }, [editingId, editing, confirming]);

  useEffect(() => {
    if (!editing && !confirming && !locked && restoreFocus.current) {
      restoreFocus.current = false;
      if (opener.current?.isConnected) opener.current.focus();
      else region.current?.querySelector('[data-create-label]')?.focus();
    }
  }, [editing, confirming, locked]);

  function closeEditor() {
    if (inFlight.current || pending) return;
    restoreFocus.current = true; setEditor(null); setPreview(null);
  }
  function edit(label, button) {
    opener.current = button; setError(''); setNotice(''); setPreview(null);
    setEditor({ id: label?.id, expectedRevision: label?.revision, draft: labelDraft(label) });
  }
  async function openPreview(label, button) {
    if (inFlight.current || pending) return;
    opener.current = button; inFlight.current = true; setBusy(true); setError(''); setNotice(''); setEditor(null); setPreview(null);
    try { const data = await api.previewNativeLabelDelete(label.id, accountId); if (mounted.current) setPreview(data); }
    catch (err) { if (mounted.current) setError(err.message || t('gmail.nativeLabels.previewFailed', 'The labels to remove could not be checked. Try again.')); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  async function mutate(operation) {
    if (inFlight.current) return;
    const recovering = !!pending;
    if (!savePendingLabelMutation(accountId, operation)) {
      setError(t('gmail.nativeLabels.journalFailed', 'The request was not sent because browser session storage is unavailable. Allow session storage so pending changes can be retried safely after a reload.'));
      return;
    }
    inFlight.current = true; ++readVersion.current; setLoading(false); setBusy(true); setError(''); setNotice('');
    setPending(operation);
    try {
      if (operation.kind === 'create') await api.createNativeLabel(operation.payload);
      else if (operation.kind === 'update') await api.updateNativeLabel(operation.id, operation.payload);
      else await api.deleteNativeLabel(operation.id, operation.payload);
      savePendingLabelMutation(accountId, null);
      useStore.getState().invalidateNativeLabels({ accountId, storageGeneration: snapshot?.storageGeneration });
      if (!mounted.current) return;
      restoreFocus.current = true; setPending(null); setEditor(null); setPreview(null);
      setNotice(t('gmail.nativeLabels.saved', 'Label changes saved in MailFlow. No messages or mail-server folders were deleted.'));
      await refresh();
    } catch (err) {
      if (!mounted.current) return;
      if (definitiveLabelFailure(err, recovering)) {
        savePendingLabelMutation(accountId, null); setPending(null);
        if (err.status === 409) {
          restoreFocus.current = true; setEditor(null); setPreview(null);
          await refresh();
          if (['mutation_conflict', 'mutation_expired'].includes(err.code)) setError(t('gmail.nativeLabels.replayUnavailable', 'This request cannot be replayed: {{error}}. Review the refreshed labels before making a new change. Nothing was retried automatically.', { error: err.message }));
          else setError(t('gmail.nativeLabels.stale', 'The label tree changed or this request conflicts with a saved change. Review the refreshed labels and open the editor or deletion preview again. Nothing was retried automatically.'));
        } else setError(err.message || t('gmail.nativeLabels.refused', 'The label change was refused. Check the values and try again.'));
      } else if (recovering) {
        setError(t('gmail.nativeLabels.recoveryGate', 'The earlier save outcome is still unknown. This retry did not verify it: {{error}}. Restore access or resolve the error, then retry the pending request. Its recovery token has been kept.', { error: err.message || t('gmail.nativeLabels.retryFailed', 'Request failed') }));
      } else {
        setError(t('gmail.nativeLabels.uncertain', 'The save outcome is unknown. Retry the same request below to verify it safely before making another change. Do not clear browser storage while this request is pending.'));
      }
    } finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  function save(event) {
    event.preventDefault();
    if (locked || !editor || !snapshot) return;
    const name = editor.draft.name.trim().normalize('NFC');
    if (!name || [...name].length > 100 || /[/\p{Cc}]/u.test(name)) {
      setError(t('gmail.nativeLabels.invalidName', 'Use 1–100 characters for the label name, without slashes or control characters.')); return;
    }
    const payload = { ...editor.draft, name, parentId: editor.draft.parentId || null, accountId, mutationId: crypto.randomUUID() };
    if (editor.id) payload.expectedRevision = editor.expectedRevision;
    mutate({ kind: editor.id ? 'update' : 'create', id: editor.id, payload });
  }
  const patch = (field, value) => setEditor(current => ({ ...current, draft: { ...current.draft, [field]: value } }));
  const visibilityText = value => value === 'hide' ? t('gmail.nativeLabels.hide', 'Hide') : value === 'unread' ? t('gmail.nativeLabels.unread', 'Show if unread') : t('gmail.nativeLabels.show', 'Show');

  return <section ref={region} className="mf-native-labels" aria-labelledby={`${uid}-title`} onKeyDown={event => {
    if (event.key === 'Escape' && (editor || preview || pending || busy)) { event.preventDefault(); event.stopPropagation(); closeEditor(); }
  }}>
    <h2 id={`${uid}-title`}>{t('gmail.nativeLabels.title', 'MailFlow labels')}</h2>
    <p>{t('gmail.nativeLabels.scope', 'These labels are saved in MailFlow for this account. They are separate from IMAP folders and do not sync to Google or other mail apps.')}</p>
    <p>{t('gmail.nativeLabels.cacheScope', 'Apply labels to verified individual messages. Label lists and counts cover synchronized mail only, excluding Spam and Trash. Search, filter rules and compose-time assignments are not supported yet.')}</p>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {pending && <div role="status" data-label-editor className="mf-native-labels-recovery"><p>{t('gmail.nativeLabels.pending', 'A label request is pending verification. Other label changes are paused.')}</p><button type="button" disabled={busy} onClick={() => mutate(pending)}>{t('gmail.nativeLabels.retryMutation', 'Retry pending label request')}</button></div>}
    <div className="mf-native-labels-toolbar">
      <button type="button" data-create-label disabled={locked || !snapshot || loading || !!editor || !!preview} onClick={event => edit(null, event.currentTarget)}>{t('gmail.nativeLabels.create', 'Create MailFlow label')}</button>
      <button type="button" disabled={locked || loading} onClick={() => { setError(''); refresh(); }}>{t('gmail.nativeLabels.refresh', 'Refresh labels')}</button>
      {loading && <span role="status">{t('gmail.nativeLabels.loading', 'Loading MailFlow labels…')}</span>}
    </div>
    {snapshot && !labels.length && <p>{t('gmail.nativeLabels.empty', 'No MailFlow labels yet.')}</p>}
    {!!labels.length && <ul className="mf-native-labels-tree" aria-label={t('gmail.nativeLabels.tree', 'MailFlow label hierarchy')}>
      {labelTree(labels).map(label => <li key={label.id} style={{ '--label-depth': label.depth }}>
        <div className="mf-native-labels-definition"><span className="mf-native-labels-chip" style={{ backgroundColor: label.color || undefined, color: label.textColor || undefined }}>{label.name}</span><small>{label.path}</small><small>{counts ? (() => { const count = counts.find(item => item.labelId === label.id); return count ? `${t('gmail.labelNavigation.counts', 'Synchronized messages: {{total}}; unread: {{unread}}', { total: count.total, unread: count.unread })}${count.unresolvedMemberships ? ` · ${t('gmail.labelNavigation.awaitingLocations', 'Memberships awaiting verified locations: {{memberships}}', { memberships: count.unresolvedMemberships })}` : ''}` : t('gmail.labelNavigation.countsUnavailable', "Counts unavailable"); })() : t('gmail.labelNavigation.countsUnavailable', "Counts unavailable")}</small>
          <small>{t('gmail.nativeLabels.sidebar', 'Sidebar visibility')}: {visibilityText(label.visibility)} · {t('gmail.nativeLabels.messages', 'Message-list visibility')}: {label.messageVisible ? t('gmail.nativeLabels.show', 'Show') : t('gmail.nativeLabels.hide', 'Hide')}</small></div>
        <div><button type="button" disabled={locked || !!editor || !!preview} aria-label={t('gmail.nativeLabels.editNamed', 'Edit MailFlow label {{name}}', { name: label.path })} onClick={event => edit(label, event.currentTarget)}>{t('gmail.nativeLabels.edit', 'Edit label')}</button><button type="button" disabled={locked || !!editor || !!preview} aria-label={t('gmail.nativeLabels.removeNamed', 'Remove MailFlow label {{name}}', { name: label.path })} onClick={event => openPreview(label, event.currentTarget)}>{t('gmail.nativeLabels.remove', 'Remove label')}</button></div>
      </li>)}
    </ul>}
    {editor && <form data-label-editor className="mf-native-labels-editor" onSubmit={save} aria-labelledby={`${uid}-edit-title`}>
      <h3 id={`${uid}-edit-title`}>{editor.id ? t('gmail.nativeLabels.edit', 'Edit label') : t('gmail.nativeLabels.create', 'Create MailFlow label')}</h3>
      <fieldset disabled={locked}>
        <label>{t('gmail.nativeLabels.name', 'Label name')}<input required value={editor.draft.name} onChange={event => patch('name', event.target.value)} /></label>
        <label>{t('gmail.nativeLabels.parent', 'Nest under')}<select value={editor.draft.parentId} onChange={event => patch('parentId', event.target.value)}><option value="">{t('gmail.nativeLabels.noParent', 'No parent label')}</option>{labelParentOptions(labels, editor.id).map(label => <option key={label.id} value={label.id}>{label.path}</option>)}</select></label>
        <div className="mf-native-labels-colors">
          <label>{t('gmail.nativeLabels.background', 'Background color')}<input type="color" value={editor.draft.color || '#e8eaed'} onChange={event => patch('color', event.target.value)} /></label>
          <label>{t('gmail.nativeLabels.foreground', 'Text color')}<input type="color" value={editor.draft.textColor || '#202124'} onChange={event => patch('textColor', event.target.value)} /></label>
          <button type="button" onClick={() => setEditor(current => ({ ...current, draft: { ...current.draft, color: null, textColor: null } }))}>{t('gmail.nativeLabels.reset', 'Reset both colors')}</button>
          <span className="mf-native-labels-chip" style={{ backgroundColor: editor.draft.color || undefined, color: editor.draft.textColor || undefined }}>{editor.draft.name || t('gmail.nativeLabels.sample', 'Label preview')}</span>
        </div>
        <label>{t('gmail.nativeLabels.sidebar', 'Sidebar visibility')}<select value={editor.draft.visibility} onChange={event => patch('visibility', event.target.value)}>{['show', 'hide', 'unread'].map(value => <option key={value} value={value}>{visibilityText(value)}</option>)}</select></label>
        <label className="mf-native-labels-checkbox"><input type="checkbox" checked={editor.draft.messageVisible} onChange={event => patch('messageVisible', event.target.checked)} />{t('gmail.nativeLabels.messageVisible', 'Show in the message list')}</label>
        <div className="mf-native-labels-toolbar"><button type="submit" disabled={!snapshot}>{t('gmail.nativeLabels.save', 'Save MailFlow label')}</button><button type="button" onClick={closeEditor}>{t('gmail.nativeLabels.cancel', 'Cancel label edit')}</button></div>
      </fieldset>
    </form>}
    {preview && <section data-label-editor className="mf-native-labels-editor" role="region" aria-labelledby={`${uid}-delete-title`}>
      <h3 id={`${uid}-delete-title`}>{t('gmail.nativeLabels.confirmTitle', 'Remove this label and its nested labels?')}</h3>
      <p>{t('gmail.nativeLabels.deleteScope', 'The listed labels and their message associations will be removed from MailFlow, including retained associations from earlier mailbox generations. No messages or IMAP folders will be deleted.')}</p>
      {Array.isArray(preview.associations) && <ul aria-label={t('gmail.nativeLabels.associationsToRemove', "Message associations to remove")}>{preview.associations.map(association => <li key={association.storageGeneration}>{association.currentGeneration ? t('gmail.nativeLabels.currentMailbox', "Current mailbox") : t('gmail.nativeLabels.retainedMailbox', "Retained earlier mailbox")}: {t('gmail.nativeLabels.associationCounts', 'Associations: {{memberships}}; message entities: {{entities}}.', { memberships: association.memberships, entities: association.entities })}</li>)}</ul>}
      <ul>{[preview.label, ...preview.descendants].map(label => <li key={label.id}>{label.path}</li>)}</ul>
      <div className="mf-native-labels-toolbar"><button type="button" disabled={locked} onClick={() => mutate({ kind: 'delete', id: preview.label.id, payload: { accountId, expectedTreeRevision: preview.treeRevision, confirmSubtree: true, mutationId: crypto.randomUUID() } })}>{t('gmail.nativeLabels.confirmDelete', 'Remove listed labels')}</button><button type="button" data-keep-labels disabled={locked} onClick={closeEditor}>{t('gmail.nativeLabels.cancelDelete', 'Keep labels')}</button></div>
    </section>}
  </section>;
}
