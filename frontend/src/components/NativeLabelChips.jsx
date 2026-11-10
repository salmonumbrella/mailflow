import { nativeLabelActionsBlocked } from '../utils/nativeLabelNavigation.js';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import NativeLabelPicker from './NativeLabelPicker.jsx';

export default function NativeLabelChips({ message: sourceMessage, editable = false }) {
  const [fresh, setFresh] = useState(null);
  const message = fresh?.source === sourceMessage ? { ...sourceMessage, ...fresh.metadata } : sourceMessage;
  useEffect(() => {
    if (!editable) return;
    let version = 0;
    let live = true;
    const refresh = async event => {
      const detail = event.detail || {};
      if ((detail.accountId && detail.accountId !== sourceMessage.account_id) || (detail.storageGeneration && detail.storageGeneration !== sourceMessage.storageGeneration)) return;
      const request = ++version;
      setFresh({ source: sourceMessage, metadata: { nativeLabelState: 'unavailable', nativeLabels: null } });
      try {
        const row = await api.getMessage(sourceMessage.id);
        if (!live || request !== version || row.id !== sourceMessage.id || row.account_id !== sourceMessage.account_id || row.storageGeneration !== sourceMessage.storageGeneration) return;
        setFresh({ source: sourceMessage, metadata: { nativeLabelState: row.nativeLabelState, nativeLabels: row.nativeLabels, entityId: row.entityId, metadataVersion: row.metadataVersion } });
      } catch { /* Keep the explicit unavailable state rather than displaying stale membership. */ }
    };
    const onFocus = () => refresh({ detail: {} });
    const interval = window.setInterval(() => { if (document.visibilityState !== 'hidden') onFocus(); }, 30000);
    window.addEventListener('mailflow:native-labels-changed', refresh);
    window.addEventListener('focus', onFocus);
    return () => { live = false; ++version; window.clearInterval(interval); window.removeEventListener('focus', onFocus); window.removeEventListener('mailflow:native-labels-changed', refresh); };
  }, [sourceMessage, editable]);
  const { t } = useTranslation();
  const actionsBlocked = useStore(nativeLabelActionsBlocked);
  useEffect(() => { if (actionsBlocked) setEditor(null); }, [actionsBlocked]);
  const [editor, setEditor] = useState(null);
  const opener = useRef(null);
  const dialog = useRef(null);
  const accountGeneration = useStore(state => state.accounts.find(account => account.id === message.account_id)?.storage_generation);
  const key = `${message.account_id}:${message.storageGeneration}:${message.entityId}:${accountGeneration}`;
  const previousKey = useRef(key);
  useEffect(() => { if (previousKey.current !== key) setEditor(null); previousKey.current = key; }, [key]);
  useEffect(() => {
    if (!editor) return;
    dialog.current?.showModal?.();
    return () => { if (opener.current?.isConnected) opener.current.focus(); };
  }, [editor]);
  const open = (event, remove) => { event.stopPropagation(); opener.current = event.currentTarget; setEditor({ remove, key }); };
  const available = message.nativeLabelState === 'available' && !!message.entityId && Array.isArray(message.nativeLabels) && message.storageGeneration === accountGeneration;
  const labels = available ? (message.nativeLabels || []).filter(label => label.messageVisible !== false) : [];
  return <span className="mf-native-message-labels" onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
    {!available && <span className="mf-native-label-unavailable" title={t('gmail.memberships.unverified', 'Message identity is not verified. Labels may exist but cannot be displayed or changed yet.')}>{t('gmail.memberships.unavailable', 'Labels unavailable')}</span>}
    {labels.map(label => <span className="mf-native-message-label" key={label.id} style={{ backgroundColor: label.color || undefined, color: label.textColor || undefined }}>
      <button type="button" title={label.path || label.name} aria-label={t('gmail.memberships.openFeed', 'Open label {{name}}', { name: label.path || label.name })} onClick={() => useStore.getState().setActiveLabel?.({ accountId: message.account_id, storageGeneration: message.storageGeneration, labelId: label.id })}>{label.path || label.name}</button>
      {editable && <button type="button" disabled={actionsBlocked} aria-label={t('gmail.memberships.removeOne', 'Remove {{name}} from this message', { name: label.path || label.name })} onClick={event => open(event, label.id)}>×</button>}
    </span>)}
    {editable && <button type="button" className="mf-native-label-edit" disabled={!available || actionsBlocked} title={t('gmail.memberships.singleScope', 'Change labels on this message only, not its entire conversation')} onClick={event => open(event)}>{t('gmail.memberships.edit', 'Labels')}</button>}
    {editor?.key === key && createPortal(<dialog ref={dialog} open={typeof window.HTMLDialogElement?.prototype.showModal !== 'function'} className="mf-native-label-dialog" aria-label={t('gmail.memberships.edit', 'Labels')} onCancel={event => { event.preventDefault(); setEditor(null); }}>
      <NativeLabelPicker key={key} messages={[message]} initialRemove={editor.remove} autoApply={!!editor.remove} onClose={() => setEditor(null)} />
    </dialog>, document.body)}
  </span>;
}
