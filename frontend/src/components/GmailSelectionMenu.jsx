import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

const PRESETS = ['All', 'None', 'Read', 'Unread', 'Starred', 'Unstarred'];

export default function GmailSelectionMenu({ messages, selectedIds, hasOtherSelection = false, onSelect }) {
  const { t } = useTranslation();
  const root = useRef(null);
  const trigger = useRef(null);
  const checkbox = useRef(null);
  const menu = useRef(null);
  const [open, setOpen] = useState(false);
  const selected = messages.filter(message => selectedIds.has(message.id)).length;
  const all = messages.length > 0 && selected === messages.length;
  const mixed = (selected > 0 || hasOtherSelection) && !all;
  useEffect(() => { if (checkbox.current) checkbox.current.indeterminate = mixed; }, [mixed]);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector('button')?.focus();
    const outside = event => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const choose = preset => {
    const matches = messages.filter(message => preset === 'All'
      || (preset === 'Read' && message.is_read)
      || (preset === 'Unread' && !message.is_read)
      || (preset === 'Starred' && message.is_starred)
      || (preset === 'Unstarred' && !message.is_starred));
    onSelect(matches);
    setOpen(false);
    trigger.current?.focus();
  };
  const keyDown = event => {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const buttons = [...menu.current.querySelectorAll('button')];
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (event.key === 'Tab') setOpen(false);
  };
  return <div ref={root} onKeyDown={keyDown} style={{ position: 'relative', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
    <input ref={checkbox} data-gmail-select-all="" type="checkbox" checked={all} aria-checked={mixed ? 'mixed' : all}
      aria-label={all ? t('messageList.deselectAll', 'Deselect all messages') : t('messageList.selectAll', 'Select all messages')} disabled={!messages.length}
      onChange={() => onSelect(all ? [] : messages)} style={{ width: 16, height: 16, accentColor: 'var(--accent)', cursor: 'pointer' }} />
    <button ref={trigger} type="button" aria-label={t('gmail.selection.options', 'Selection options')} aria-haspopup="menu" aria-expanded={open}
      onClick={() => setOpen(value => !value)} style={{ background: 'none', border: 0, color: 'var(--text-secondary)', padding: '6px 4px', cursor: 'pointer' }}>▾</button>
    {open && <div ref={menu} role="menu" aria-label={t('messageList.selectMessages', 'Select messages')} style={{ position: 'absolute', top: '100%', left: 0, zIndex: 50,
      minWidth: 150, padding: '5px 0', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-popover)' }}>
      {PRESETS.map(preset => <button key={preset} type="button" role="menuitem" onClick={() => choose(preset)}
        style={{ display: 'block', width: '100%', padding: '8px 16px', textAlign: 'left', background: 'none', color: 'var(--text-primary)', border: 0, font: 'inherit', cursor: 'pointer' }}>{t(`gmail.selection.${preset.toLowerCase()}`, preset)}</button>)}
    </div>}
  </div>;
}
