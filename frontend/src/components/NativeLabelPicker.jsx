import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { nativeLabelActionsBlocked } from '../utils/nativeLabelNavigation.js';
import { membershipScope } from '../utils/nativeLabelMemberships.js';
import { useNativeLabelMemberships } from '../hooks/useNativeLabelMemberships.js';
import { offerNativeLabelUndo } from '../utils/nativeLabelUndo.js';
import { folderRole } from '../utils/folderDisplay.js';

export function currentNativeLabelScope(scope) {
  const account = useStore.getState().accounts.find(item => item.id === scope.accountId);
  return !nativeLabelActionsBlocked(useStore.getState()) && !!account && account.storage_generation === scope.storageGeneration;
}
export function invalidateNativeMemberships(payload, result) {
  useStore.getState().invalidateNativeLabels?.({ accountId: payload.accountId, storageGeneration: payload.storageGeneration });
  offerNativeLabelUndo(result, payload);
}
export default function NativeLabelPicker({ messages, initialRemove, autoApply = false, onClose, onSaved = invalidateNativeMemberships, isCurrent = currentNativeLabelScope }) {
  const { t } = useTranslation();
  const actionsBlocked = useStore(nativeLabelActionsBlocked);
  const accounts = useStore(state => state.accounts);
  const folders = useStore(state => state.folders);
  const scope = membershipScope(messages.map(message => {
    const account = accounts.find(item => item.id === message.account_id);
    const folder = folders[message.account_id]?.find(item => item.path === message.folder) || { path: message.folder };
    return { ...message, is_draft: message.is_draft || folderRole(folder, account?.folder_mappings) === 'drafts' };
  }), t);
  if (actionsBlocked) scope.error = t('gmail.memberships.readerPaused', 'Message actions are paused until this label view is verified. Refresh the label view to try again.');
  if (!scope.error && !isCurrent(scope)) scope.error = t('gmail.memberships.accountChanged', "The account changed. Refresh the messages before editing labels.");
  const state = useNativeLabelMemberships(scope, { initialRemove, onSaved: (payload, result, context) => {
    onSaved(payload, result);
    if (context?.active) onClose?.();
  }, isCurrent });
  const autoApplied = useRef(false);
  useEffect(() => {
    if (!autoApply || !initialRemove || autoApplied.current || !state.snapshot || state.loading || state.pending || state.busy) return;
    autoApplied.current = true;
    if (state.delta.removeLabelIds.includes(initialRemove)) state.apply();
  }, [autoApply, initialRemove, state]);
  const [query, setQuery] = useState('');
  const region = useRef(null);
  useEffect(() => { region.current?.querySelector('input')?.focus(); }, []);
  const locked = state.busy || !!state.pending;
  const changed = state.delta.addLabelIds.length + state.delta.removeLabelIds.length;
  const labels = state.labels.filter(label => (label.path || label.name).toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .sort((a, b) => Number(state.staged[b.id] !== false) - Number(state.staged[a.id] !== false) || (a.path || a.name).localeCompare(b.path || b.name));
  return <section ref={region} className="mf-membership-picker" aria-label={t('gmail.memberships.labelAs', 'Label as')} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose?.(); }
    if (event.key === 'Tab') {
      const controls = [...region.current.querySelectorAll('input:not(:disabled),button:not(:disabled)')];
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
    }
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const controls = [...region.current.querySelectorAll('input:not(:disabled),button:not(:disabled)')];
      const index = controls.indexOf(document.activeElement);
      controls[(index + (event.key === 'ArrowDown' ? 1 : -1) + controls.length) % controls.length]?.focus();
    }
  }}>
    <strong>{t('gmail.memberships.labelAs', 'Label as')}</strong>
    <p>{t('gmail.memberships.scope', '{{count}} selected message(s), not entire conversations.', { count: scope.targets?.length || messages.length })}</p>
    <p>{t('gmail.memberships.local', 'MailFlow labels only. Mail-server folders and Klinger GTD are unchanged.')}</p>
    <input aria-label={t('gmail.memberships.search', 'Search labels')} value={query} onChange={event => setQuery(event.target.value)} disabled={locked || !!scope.error} />
    {state.loading && <p role="status">{t('gmail.memberships.loading', 'Loading message labels…')}</p>}
    {state.error && <p role="alert">{state.error}</p>}
    {state.notice && <p role="status">{state.notice}</p>}
    {state.pending && <div role="status"><p>{t('gmail.memberships.pending', 'A label change for this account needs verification. It may cover an earlier selection.')}</p><button type="button" disabled={state.busy} onClick={state.retry}>{t('gmail.memberships.retryPending', 'Verify pending label change')}</button></div>}
    {!scope.error && state.snapshot && <div className="mf-membership-options" role="group" aria-label={t('gmail.memberships.choices', 'Available labels')}>
      {labels.map(label => <label key={label.id} title={label.path || label.name}>
        <input type="checkbox" disabled={locked || state.loading || !!scope.error} checked={state.staged[label.id] === true} aria-checked={state.staged[label.id] === 'mixed' ? 'mixed' : state.staged[label.id] === true}
          ref={node => { if (node) node.indeterminate = state.staged[label.id] === 'mixed'; }}
          onChange={() => state.setStaged(values => ({ ...values, [label.id]: values[label.id] !== true }))} />
        <span style={{ backgroundColor: label.color || undefined, color: label.textColor || undefined }}>{label.path || label.name}</span>
      </label>)}
      {!labels.length && <p>{t('gmail.memberships.noMatches', 'No matching labels. Create labels in Settings → Labels.')}</p>}
    </div>}
    <div className="mf-membership-footer">
      {scope.accountId && <>
        <button type="button" disabled={locked} onClick={() => { onClose?.(); window.dispatchEvent(new CustomEvent('mailflow:manage-native-labels', { detail: { accountId: scope.accountId, create: true } })); }}>{t('gmail.memberships.create', 'Create new')}</button>
        <button type="button" disabled={locked} onClick={() => { onClose?.(); window.dispatchEvent(new CustomEvent('mailflow:manage-native-labels', { detail: { accountId: scope.accountId } })); }}>{t('gmail.memberships.manage', 'Manage labels')}</button>
      </>}

      <button type="button" disabled={locked || state.loading || !!scope.error || !state.snapshot || !changed} onClick={state.apply}>{state.busy ? t('gmail.memberships.saving', 'Saving…') : t('gmail.memberships.apply', 'Apply')}</button>
      <button type="button" onClick={onClose}>{locked ? t('gmail.memberships.close', 'Close') : t('gmail.memberships.cancel', 'Cancel')}</button>
      {!scope.error && <button type="button" disabled={locked || state.loading} onClick={state.refresh}>{t('gmail.memberships.refresh', 'Refresh labels')}</button>}
    </div>
  </section>;
}
