import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { gmailMessageDetails } from '../utils/gmailMessageDetails.js';
import { formatDateTime } from '../utils/formatDate.js';

export default function GmailMessageDetails(props) {
  return <MessageDetails key={props.message.id} {...props} />;
}

function MessageDetails({ message, body }) {
  const { t } = useTranslation();
  const label = (key, defaultValue) => t(`gmailReader.${key}`, { defaultValue });
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef(null);
  const panel = useRef(null);
  const closeButton = useRef(null);
  const id = useId();
  const close = () => { setOpen(false); trigger.current?.focus(); };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.getMessageHeaders(message.id)
      .then(data => { if (!cancelled) setResult(data); })
      .catch(err => { if (!cancelled) setError(err.message || 'Could not load headers.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, message.id, retry]);

  useEffect(() => {
    if (!open) return;
    const reposition = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - Math.min(440, window.innerWidth - 16) - 8)), top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - Math.min(420, window.innerHeight - 16) - 8)) });
    };
    reposition();
    closeButton.current?.focus();
    const outside = event => { if (!panel.current?.contains(event.target) && !trigger.current?.contains(event.target)) close(); };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', reposition);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', reposition); };
  }, [open]);

  const facts = gmailMessageDetails(message, body, result);
  const date = new Date(facts.date);
  const rows = [
    [label('from', 'From'), facts.from], [label('to', 'To'), facts.to],
    [label('cc', 'Cc'), facts.cc], [label('bcc', 'Bcc'), facts.bcc],
    [label('date', 'Date'), Number.isNaN(+date) ? facts.date : formatDateTime(facts.date)],
    [label('subject', 'Subject'), facts.subject],
  ].filter(([, value]) => value);

  return <>
    <button ref={trigger} type="button" aria-label={label('showDetails', 'Show message details')} aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? id : undefined}
      onClick={() => open ? close() : setOpen(true)}
      style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', font: 'inherit', fontSize: 12, cursor: 'pointer', padding: '4px 0' }}>
      {label('details', 'Details')} <span aria-hidden="true">▾</span>
    </button>
    {open && createPortal(<div style={{ position: 'fixed', inset: 0, zIndex: 5000 }}>
      <div id={id} ref={panel} role="dialog" aria-modal="true" aria-label={label('messageDetails', 'Message details')}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); close(); }
          if (event.key === 'Tab') {
            const buttons = panel.current.querySelectorAll('button:not([disabled])');
            const first = buttons[0], last = buttons[buttons.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
          }
        }}
        style={{ position: 'absolute', ...position, width: 440, maxWidth: 'calc(100vw - 16px)', maxHeight: 'min(420px, calc(100vh - 16px))', boxSizing: 'border-box', overflowY: 'auto', padding: 16, border: '1px solid var(--border)', borderRadius: 8, boxShadow: 'var(--shadow-modal)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 13 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <strong>{label('messageDetails', 'Message details')}</strong>
          <button ref={closeButton} type="button" aria-label={label('closeDetails', 'Close message details')} onClick={close} style={{ color: 'inherit', background: 'none', border: 'none', cursor: 'pointer', font: 'inherit' }}>×</button>
        </div>
        <dl style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: '8px 16px', marginBottom: 0 }}>
          {rows.map(([name, value]) => <div key={name} style={{ display: 'contents' }}><dt style={{ color: 'var(--text-secondary)' }}>{name}</dt><dd style={{ margin: 0, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{value}</dd></div>)}
        </dl>
        {loading && <p role="status">{label('loadingDetails', 'Loading details…')}</p>}
        {error && <div role="alert" style={{ marginTop: 12 }}>{error} <button type="button" onClick={() => setRetry(value => value + 1)}>{label('retry', 'Retry')}</button></div>}
      </div>
    </div>, document.body)}
  </>;
}
