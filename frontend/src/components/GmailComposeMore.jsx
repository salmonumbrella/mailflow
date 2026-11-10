import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useUiScale, descale } from '../hooks/useUiScale.js';

export default function GmailComposeMore({ plainText, onPlainText, spellcheck, onSpellcheck, fullscreen, onFullscreen, onPrint, busy }) {
  const { t } = useTranslation();
  const scale = useUiScale();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const trigger = useRef(null);
  const menu = useRef(null);
  const close = () => { setOpen(false); setConfirm(false); trigger.current?.focus({ preventScroll: true }); };
  useEffect(() => {
    if (!open && !confirm) return;
    menu.current?.querySelector('button')?.focus();
    const outside = event => { if (!menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) close(); };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open, confirm]);
  const rect = trigger.current?.getBoundingClientRect();
  const item = { display: 'block', width: '100%', border: 0, background: 'transparent', color: 'var(--text-primary)', padding: '10px 14px', textAlign: 'left', cursor: 'pointer', font: 'inherit' };
  const choose = fn => { close(); fn(); };
  return <>
    <button type="button" ref={trigger} aria-label={t('compose.more.options', 'More compose options')} title={t('compose.more.title', 'More options')} aria-haspopup="menu" aria-expanded={open} disabled={busy}
      onClick={() => setOpen(value => !value)} style={{ border: 0, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 22, padding: '2px 8px' }}>⋮</button>
    {(open || confirm) && createPortal(<div ref={menu} role={confirm ? 'dialog' : 'menu'} aria-label={confirm ? t('compose.more.removeFormatting', 'Remove formatting') : t('compose.more.options', 'More compose options')} aria-modal={confirm || undefined}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        if (event.key === 'Tab') {
          if (!confirm) { close(); return; }
          const buttons = [...menu.current.querySelectorAll('button')];
          const next = (buttons.indexOf(document.activeElement) + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
          event.preventDefault(); buttons[next]?.focus();
        }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const buttons = [...menu.current.querySelectorAll('button')];
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (buttons.indexOf(document.activeElement) + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }
      }} style={{ position: 'fixed', zIndex: 10000, width: 260, maxWidth: 'calc(100vw - 16px)', maxHeight: 'calc(100vh - 16px)', overflow: 'auto', left: descale(Math.max(8, Math.min(rect?.left || 8, window.innerWidth - 268)), scale), top: descale(Math.max(8, Math.min((rect?.top || 228) - 220, window.innerHeight - 228)), scale), background: 'var(--bg-elevated, var(--bg-secondary))', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 8px 28px #0003', fontSize: 13 }}>
      {confirm ? <>
        <p style={{ padding: '0 14px' }}>{t('compose.more.plainTextConfirm', 'Remove formatting and inline images from this draft? Switching back before editing restores the rich text.')}</p>
        <button type="button" style={item} onClick={close}>{t('compose.more.cancel', 'Cancel')}</button>
        <button type="button" style={item} onClick={() => choose(onPlainText)}>{t('compose.more.usePlainText', 'Use plain text')}</button>
      </> : <>
        <button type="button" role="menuitemcheckbox" aria-checked={fullscreen} style={item} onClick={() => choose(onFullscreen)}>{t('compose.more.defaultFullscreen', 'Default to full screen')}</button>
        <button type="button" role="menuitemcheckbox" aria-checked={plainText} style={item} onClick={() => { if (plainText) choose(onPlainText); else { setOpen(false); setConfirm(true); } }}>{t('compose.more.plainTextMode', 'Plain text mode')}</button>
        <button type="button" role="menuitemcheckbox" aria-checked={spellcheck} style={item} onClick={() => choose(onSpellcheck)}>{t('compose.more.browserSpellcheck', 'Browser spellcheck')}</button>
        <button type="button" role="menuitem" style={item} onClick={() => choose(onPrint)}>{t('compose.more.printDraft', 'Print draft')}</button>
      </>}
    </div>, document.body)}
  </>;
}
