import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

export default function GmailDeleteMessageConfirmation({ message, permanent, onConfirm, onCancel }) {
  const { t } = useTranslation();
  const panel = useRef(null);
  const cancel = useRef(null);
  useEffect(() => {
    const prior = document.activeElement;
    cancel.current?.focus();
    return () => { if (prior?.isConnected) prior.focus(); };
  }, []);
  const label = permanent ? t('gmailReader.deletePermanently', { defaultValue: 'Delete this message permanently' }) : t('gmailReader.deleteMessage', { defaultValue: 'Delete this message' });
  return createPortal(<div onPointerDown={event => { if (event.target === event.currentTarget) onCancel(); }}
    style={{ position: 'fixed', inset: 0, zIndex: 5000, background: 'var(--overlay-scrim)', display: 'flex', justifyContent: 'center', alignItems: 'center', padding: 16 }}>
    <div ref={panel} role="alertdialog" aria-modal="true" aria-label={label}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); }
        if (event.key === 'Tab') {
          const buttons = panel.current.querySelectorAll('button');
          if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons[1].focus(); }
          else if (!event.shiftKey && document.activeElement === buttons[1]) { event.preventDefault(); buttons[0].focus(); }
        }
      }}
      style={{ width: 440, maxWidth: '100%', padding: 20, borderRadius: 10, color: 'var(--text-primary)', background: 'var(--bg-primary)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-modal)' }}>
      <strong>{label}?</strong>
      <p style={{ overflowWrap: 'anywhere' }}>{message.subject || t('common.noSubject')}</p>
      <p>{t('gmailReader.deleteWarning', { defaultValue: 'This deletes only this message. Messages in Trash or Drafts are permanently deleted after the Undo period. They cannot be recovered after deletion is sent to the server.' })}</p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
        <button ref={cancel} type="button" onClick={onCancel} style={{ font: 'inherit', padding: '6px 12px', cursor: 'pointer', color: 'var(--text-primary)', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6 }}>{t('common.cancel', { defaultValue: 'Cancel' })}</button>
        <button type="button" onClick={onConfirm} style={{ font: 'inherit', padding: '6px 12px', cursor: 'pointer', color: 'var(--red)', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6 }}>{label}</button>
      </div>
    </div>
  </div>, document.body);
}
