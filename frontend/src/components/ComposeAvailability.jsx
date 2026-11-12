import { useTranslation } from 'react-i18next';
import { htmlLang } from '../utils/browserLanguage.js';
import { useEffect, useId, useRef, useState } from 'react';
import { availabilityText } from '../utils/composeAvailability.js';
import { browserTimeZone } from '../utils/scheduleTimes.js';

const field = { width: '100%', boxSizing: 'border-box', padding: 10, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 14 };
const button = { padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-hover)', color: 'var(--text-primary)', cursor: 'pointer' };
export default function ComposeAvailability({ onInsert, onClose, initial }) {
  const { t, i18n } = useTranslation();
  const [date, setDate] = useState(() => {
    const value = initial?.date;
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
      && new Date(value).toISOString().slice(0, 10) === value ? value : '';
  });
  const [time, setTime] = useState(() => typeof initial?.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(initial.time) ? initial.time : '');
  const [zone, setZone] = useState(() => {
    const value = initial?.timeZone;
    if (typeof value === 'string' && value.trim() && value.length <= 100) {
      try { return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone; } catch { /* Fall back to the user's browser zone. */ }
    }
    return browserTimeZone() || 'UTC';
  });
  const [error, setError] = useState('');
  const root = useRef(null);
  const dateRef = useRef(null);
  const inserted = useRef(false);
  const id = useId();
  useEffect(() => { dateRef.current?.focus(); }, []);
  const result = availabilityText(date, time, zone, new Date(), t, htmlLang(i18n.language));
  function submit(event) {
    event.preventDefault();
    if (inserted.current) return;
    const next = availabilityText(date, time, zone, new Date(), t, htmlLang(i18n.language));
    if (next.error) { setError(next.error); return; }
    try { inserted.current = true; onInsert(next.text); }
    catch (err) { inserted.current = false; setError(err.message || t("compose.availability.insertFailed", "Could not insert availability.")); }
  }
  function onKeyDown(event) {
    event.stopPropagation();
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); return; }
    if (event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229) { if (event.key === 'Enter') event.preventDefault(); return; }
    if (event.repeat && event.key === 'Enter') { event.preventDefault(); return; }
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    if (event.key === 'Tab') {
      const nodes = [...root.current.querySelectorAll('input,button:not(:disabled)')];
      if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus(); }
    }
  }
  return <div style={{ position: 'fixed', inset: 0, zIndex: 2300, background: 'rgba(0,0,0,.48)', display: 'grid', placeItems: 'center', padding: 16 }}>
    <form ref={root} role="dialog" aria-modal="true" aria-label={t("compose.availability.title", "Share availability")} onSubmit={submit} onKeyDown={onKeyDown}
      style={{ width: 440, maxWidth: '100%', maxHeight: 'calc(100dvh - 32px)', overflowY: 'auto', boxSizing: 'border-box', padding: 20, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg-elevated)', color: 'var(--text-primary)', display: 'grid', gap: 12 }}>
      <h2 style={{ margin: 0, fontSize: 18 }}>{t("compose.availability.title", "Share availability")}</h2>
      <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 13 }}>{t("compose.availability.help", "Choose a time manually. Your calendar has not been checked. This only inserts text into your draft.")}</p>
      <label htmlFor={`${id}-date`}>{t("compose.scheduleSend.dateLabel", "Date")}</label><input ref={dateRef} id={`${id}-date`} aria-label={t("compose.availability.date", "Available date")} type="date" required value={date} onChange={e => setDate(e.target.value)} style={field} />
      <label htmlFor={`${id}-time`}>{t("compose.scheduleSend.timeLabel", "Time")}</label><input id={`${id}-time`} aria-label={t("compose.availability.time", "Available time")} type="time" required value={time} onChange={e => setTime(e.target.value)} style={field} />
      <label htmlFor={`${id}-zone`}>{t("compose.availability.zoneLabel", "Time zone")}</label><input id={`${id}-zone`} aria-label={t("compose.availability.zone", "Availability time zone")} required maxLength={100} value={zone} onChange={e => setZone(e.target.value)} style={field} placeholder={t("compose.availability.zoneExample", "Europe/London")} />
      {date && time && <p role="status" style={{ fontSize: 13, margin: 0 }}>{result.error || result.text}</p>}
      {error && <p role="alert" style={{ color: 'var(--red)', fontSize: 13, margin: 0 }}>{error}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" style={button} onClick={onClose}>{t("common.cancel", "Cancel")}</button>
        <button type="submit" disabled={Boolean(result.error)} style={{ ...button, background: 'var(--accent)', color: 'var(--accent-text)' }}>{t("compose.availability.insert", "Insert availability")}</button>
      </div>
    </form>
  </div>;
}
