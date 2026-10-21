import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useUiScale } from '../hooks/useUiScale.js';

const SIZES = [25, 50, 100, 200];

export default function PageSizeMenu({ value, onChange, label, scope }) {
  const id = useId();
  const scale = useUiScale();
  const trigger = useRef(null);
  const menu = useRef(null);
  const options = useRef([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  const toggle = () => {
    if (open) { close(true); return; }
    setActive(Math.max(0, SIZES.indexOf(value)));
    setOpen(true);
  };
  const choose = size => {
    onChange(size);
    close(true);
  };

  useLayoutEffect(() => {
    if (menu.current?.contains(document.activeElement) && trigger.current?.isConnected) trigger.current.focus();
    setOpen(false);
  }, [scope]);

  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      if (!trigger.current?.isConnected) { setOpen(false); return; }
      const popup = menu.current;
      const anchor = trigger.current.getBoundingClientRect();
      if (anchor.bottom < 0 || anchor.top > window.innerHeight) { setOpen(false); return; }
      const margin = 8;
      const below = Math.max(0, window.innerHeight - anchor.bottom - 4 - margin);
      const above = Math.max(0, anchor.top - 4 - margin);
      popup.style.maxWidth = `${Math.max(1, window.innerWidth - margin * 2) / scale}px`;
      const height = (popup.scrollHeight + popup.offsetHeight - popup.clientHeight) * scale;
      const flip = height > below && above > below;
      const available = flip ? above : below;
      popup.style.maxHeight = `${Math.max(1, available) / scale}px`;
      const width = popup.getBoundingClientRect().width;
      popup.style.left = `${Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin))}px`;
      popup.style.top = `${Math.max(margin, flip ? anchor.top - 4 - Math.min(height, available) : anchor.bottom + 4)}px`;
      popup.style.visibility = 'visible';
    };
    const outside = event => {
      if (!trigger.current?.contains(event.target) && !menu.current?.contains(event.target)) setOpen(false);
    };
    const blur = () => setOpen(false);
    position();
    const observer = new ResizeObserver(position);
    observer.observe(trigger.current);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    window.addEventListener('blur', blur);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      window.removeEventListener('blur', blur);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
    };
  }, [open, scale]);

  useLayoutEffect(() => {
    if (open) options.current[active]?.focus();
  }, [open, active]);

  return <>
    <style>{`
      .mf-page-size-trigger:focus-visible, .mf-page-size-option:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
      .mf-page-size-option:hover, .mf-page-size-option:focus { background: var(--bg-hover); }
      .mf-page-size-option { min-height: 28px; }
      @media (pointer: coarse) {
        .mf-page-size-trigger, .mf-page-size-option { min-height: ${44 / Math.min(1, scale)}px; min-width: ${44 / Math.min(1, scale)}px; }
      }
    `}</style>
    <button ref={trigger} type="button" className="mf-page-size-trigger"
      aria-label={label} title={label} aria-haspopup="listbox" aria-expanded={open}
      aria-controls={open ? id : undefined} onClick={toggle}
      onKeyDown={event => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
          event.preventDefault(); event.stopPropagation();
          if (!open) toggle();
        } else if (open && event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation(); close(true);
        }
      }}
      style={{ height: 24, boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '0 6px', fontSize: 11, lineHeight: 1, borderRadius: 6, flexShrink: 0,
        background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-tertiary)', cursor: 'pointer' }}>
      {value}<svg aria-hidden="true" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    {open && createPortal(
      <div ref={menu} id={id} role="listbox" aria-label={label}
        onKeyDown={event => {
          event.stopPropagation();
          if (event.key === 'Tab') { close(true); return; }
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape'].includes(event.key)) return;
          event.preventDefault();
          if (event.key === 'Escape') close(true);
          else if (event.key === 'Enter' || event.key === ' ') choose(SIZES[active]);
          else setActive(index => event.key === 'Home' ? 0 : event.key === 'End' ? SIZES.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : SIZES.length - 1)) % SIZES.length);
        }}
        style={{ position: 'fixed', left: 0, top: 0, visibility: 'hidden', zIndex: 4000,
          transform: `scale(${scale})`, transformOrigin: 'top left', boxSizing: 'border-box',
          width: 100, overflowY: 'auto', background: 'var(--bg-elevated)', color: 'var(--text-primary)',
          border: '1px solid var(--border)', borderRadius: 8, padding: 4, boxShadow: 'var(--shadow-modal)' }}>
        {SIZES.map((size, index) => <div key={size} id={`${id}-${size}`} role="option"
          ref={node => { options.current[index] = node; }} className="mf-page-size-option"
          tabIndex={active === index ? 0 : -1} aria-selected={value === size}
          onFocus={() => setActive(index)} onClick={() => choose(size)}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', boxSizing: 'border-box',
            padding: '6px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>
          {size}{value === size && <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2"><path d="m5 12 4 4 10-10" /></svg>}
        </div>)}
      </div>, document.body)}
  </>;
}
