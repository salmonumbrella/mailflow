import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';

const PAGE_SIZE = 100;

export default function GmailContactPicker({ onInsert, onClose }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [contacts, setContacts] = useState([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const dialogRef = useRef(null);
  const searchRef = useRef(null);

  useEffect(() => {
    const previous = document.activeElement;
    searchRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    const timer = setTimeout(async () => {
      try {
        const result = await api.getContacts({ q: query, limit: PAGE_SIZE, offset });
        if (cancelled) return;
        const rows = result.contacts || [];
        setContacts(previous => offset === 0 ? rows : [...previous, ...rows]);
        setTotal(result.total || 0);
      } catch (err) {
        if (!cancelled) setError(err.message || true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, query ? 180 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, offset]);

  const choices = contacts.filter(contact => contact.primary_email);
  const toggle = contact => setSelected(previous => {
    const next = new Map(previous);
    const key = contact.primary_email.toLowerCase();
    if (next.has(key)) next.delete(key);
    else next.set(key, contact);
    return next;
  });
  const allChecked = choices.length > 0 && choices.every(contact => selected.has(contact.primary_email.toLowerCase()));

  const keyDown = event => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
    if (event.key !== 'Tab') return;
    const focusable = [...dialogRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };

  return createPortal(
    <div className="mailflow-contact-picker-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="mailflow-contact-picker" role="dialog" aria-modal="true" aria-label={t('compose.selectContacts', 'Select contacts')} onKeyDown={keyDown}>
        <header>
          <h2>{t('compose.selectContacts', 'Select contacts')}</h2>
          <button type="button" onClick={onClose} aria-label={t('common.close')}>×</button>
        </header>
        <input ref={searchRef} type="search" value={query} placeholder={t('contacts.search')} aria-label={t('contacts.search')}
          onChange={event => { setQuery(event.target.value); setOffset(0); setContacts([]); }} />
        <label className="mailflow-contact-picker-select">
          <input type="checkbox" checked={allChecked} disabled={!choices.length || loading} onChange={() => setSelected(previous => {
            const next = new Map(previous);
            choices.forEach(contact => {
              const key = contact.primary_email.toLowerCase();
              if (allChecked) next.delete(key); else next.set(key, contact);
            });
            return next;
          })} />
          {t('common.selectAll', 'Select all')}
        </label>
        <div className="mailflow-contact-picker-results" aria-busy={loading}>
          {error && <p role="alert">{typeof error === 'string' ? error : t('common.error')}</p>}
          {!loading && !choices.length && !error && <p role="status">{t('contacts.noResults')}</p>}
          {choices.map(contact => <label key={contact.id || contact.primary_email}>
            <input type="checkbox" checked={selected.has(contact.primary_email.toLowerCase())} onChange={() => toggle(contact)} />
            <span><strong>{contact.display_name || contact.primary_email}</strong><small>{contact.primary_email}</small></span>
          </label>)}
          {loading && <p role="status">{t('common.loading')}</p>}
          {contacts.length < total && !loading && <button type="button" onClick={() => setOffset(value => value + PAGE_SIZE)}>{t('common.loadMore', 'Load more')}</button>}
        </div>
        <footer>
          <span aria-live="polite">{selected.size} {t('common.selected', 'selected')}</span>
          <button type="button" onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="mailflow-contact-picker-insert" disabled={!selected.size} onClick={() => onInsert([...selected.values()].map(contact => ({ name: contact.display_name || '', email: contact.primary_email })))}>{t('common.insert', 'Insert')}</button>
        </footer>
      </section>
    </div>, document.body,
  );
}
