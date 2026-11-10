import { useTranslation } from 'react-i18next';
import { htmlLang } from '../../utils/browserLanguage.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/index.js';
import { api } from '../../utils/api.js';
import { addDays, dateLabel, wallTime, timeLabel, toInstant, visibleDays, navigateDate, eventOnDay, timedSegments } from './dates.js';
import './calendar.css';

const colors = ['#7b87e8', '#a87bd7', '#5baf99', '#c69b52', '#cf7f97'];
const freshCatalog = { calendars: [], templates: [], timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', weekStart: 1, timeFormat: '24h', revision: null };

function Dialog({ title, onClose, children, busy }) {
  const { t } = useTranslation();
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.querySelector('input, button')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="mf-calendar-overlay" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <section className="mf-calendar-dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref} onKeyDown={e => {
      if (e.isComposing || e.nativeEvent?.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!busy) onClose(); }
      if (e.key === 'Tab') {
        const controls = [...ref.current.querySelectorAll('input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled)')];
        if (e.shiftKey && document.activeElement === controls[0]) { e.preventDefault(); controls.at(-1)?.focus(); }
        if (!e.shiftKey && document.activeElement === controls.at(-1)) { e.preventDefault(); controls[0]?.focus(); }
      }
    }}><header><h2>{title}</h2><button type="button" aria-label={t("localCalendar.close", "Close dialog")} disabled={busy} onClick={onClose}>×</button></header>{children}</section>
  </div>;
}

export default function CalendarView({ onBack }) {
  const { t, i18n } = useTranslation();
  const [catalog, setCatalog] = useState(freshCatalog);
  const [events, setEvents] = useState([]);
  const [day, setDay] = useState(() => wallTime(new Date().toISOString(), Intl.DateTimeFormat().resolvedOptions().timeZone).slice(0, 10));
  const [view, setView] = useState('week');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sharingAvailability, setSharingAvailability] = useState(false);
  const availabilityRequest = useRef(false);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState(null);
  const [settings, setSettings] = useState(null);
  const [reload, setReload] = useState(0);
  const serial = useRef(0);
  const alive = useRef(true);
  const mutation = useRef(false);
  const root = useRef(null);
  const scroller = useRef(null);
  const timezone = catalog.timezone;
  const timeFormat = catalog.timeFormat || '24h';
  const displayTime = wall => timeLabel(wall, timeFormat, htmlLang(i18n.language));
  const days = visibleDays(day, view, catalog.weekStart);
  const first = days[0], last = days.at(-1);
  const refresh = useCallback(() => setReload(n => n + 1), []);
  useEffect(() => { alive.current = true; root.current?.focus(); return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const token = ++serial.current;
    setLoading(true); setError(''); setEvents([]);
    (async () => {
      const nextCatalog = await api.get('/local-calendar/catalog');
      if (token !== serial.current) return;
      if (nextCatalog.revision === null) nextCatalog.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      setCatalog(nextCatalog);
      // UTC padding covers date-only events and zones on either side of the date line.
      const params = new URLSearchParams({ start: `${addDays(first, -2)}T00:00:00.000Z`, end: `${addDays(last, 3)}T00:00:00.000Z` });
      const all = [];
      let after = null;
      let pages = 0;
      do {
        if (after) params.set('after', after);
        const page = await api.get(`/local-calendar/events?${params}`);
        if (token !== serial.current) return;
        all.push(...page.items); after = page.nextCursor;
        if (++pages > 60 || all.length > 10000) throw new Error(t("localCalendar.rangeTooLarge", "This date range contains too many events. Choose Day view."));
      } while (after);
      setEvents(all);
    })().catch(err => { if (token === serial.current) setError(err.message); }).finally(() => { if (token === serial.current) setLoading(false); });
    return () => { serial.current = token + 1; };
  }, [first, last, reload, t]);
  useEffect(() => {
    const focus = () => { if (!mutation.current) refresh(); };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [refresh]);
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = view === 'month' ? 0 : 6 * 44; }, [view]);

  const mutate = async fn => {
    if (mutation.current) return;
    mutation.current = true; setBusy(true); setError('');
    try { await fn(); if (alive.current) { setEditor(null); setSettings(null); refresh(); } }
    catch (err) { if (alive.current) setError(err.status === 409 ? t('localCalendar.conflict', "{{message}} Your unsaved edits are still here. Close the editor and reload to see the latest version.", { message: err.message }) : err.message); }
    finally { mutation.current = false; if (alive.current) setBusy(false); }
  };
  const shareAvailability = useCallback(async () => {
    if (availabilityRequest.current) return;
    availabilityRequest.current = true; setSharingAvailability(true); setError('');
    const owner = useStore.getState().user?.id;
    try {
      const opened = await useStore.getState().openCompose({ availability: { date: day, time: '09:00', timeZone: timezone } });
      if (!opened && alive.current && useStore.getState().user?.id === owner) setError(t('localCalendar.availabilityBlocked', 'Your current draft could not be safely saved. Finish or close it before sharing availability.'));
    } catch {
      if (alive.current && useStore.getState().user?.id === owner) setError(t('localCalendar.availabilityBlocked', 'Your current draft could not be safely saved. Finish or close it before sharing availability.'));
    } finally {
      availabilityRequest.current = false;
      if (alive.current) setSharingAvailability(false);
    }
  }, [day, timezone, t]);
  const openSettings = fields => { setError(''); setSettings({ ...fields, catalogSnapshot: catalog }); };
  const createEvent = (date = day, hour = 9, allDay = false, template = null) => {
    if (!catalog.calendars.length) { openSettings({ kind: 'calendar', name: '', color: colors[0] }); return; }
    const start = `${date}T${String(hour).padStart(2, '0')}:00`;
    const endWall = new Date(Date.parse(`${start}Z`) + (template?.duration || 60) * 60000).toISOString().slice(0, 16);
    setError('');
    setEditor({ title: template?.title || '', start: allDay ? date : start, end: allDay ? addDays(date, 1) : endWall, allDay, calendarId: catalog.calendars[0].id, timezone, location: template?.location || '', description: template?.description || '' });
  };
  const openEvent = event => { setError(''); setEditor({ ...event, start: event.allDay ? event.start : wallTime(event.start, event.timezone), end: event.allDay ? event.end : wallTime(event.end, event.timezone) }); };
  useEffect(() => {
    const handler = e => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || editor || settings || document.querySelector('[role="dialog"], [role="menu"]')) return;
      if (e.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      if ((e.metaKey || e.ctrlKey) && !(e.metaKey && e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
        if (loading || busy || e.repeat) return;
        e.preventDefault(); e.stopImmediatePropagation(); shareAvailability(); return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') onBack();
      else if (e.target?.closest?.('button, a')) return;
      else if (['ArrowLeft', '-'].includes(e.key)) setDay(d => navigateDate(d, view, -1));
      else if (['ArrowRight', '='].includes(e.key)) setDay(d => navigateDate(d, view, 1));
      else if (e.key === '0' || e.key === 'd') setView('day');
      else if (e.key === '2' || e.key === 'w') setView('week');
      else if (e.key === 'm') setView('month');
      else if (e.key === 't') setDay(wallTime(new Date().toISOString(), timezone).slice(0, 10));
      else if (e.key === 'b' || e.key === 'n') root.current?.querySelector('[data-new-event]')?.click();
      else return;
      e.preventDefault(); e.stopImmediatePropagation();
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [editor, settings, onBack, view, timezone, shareAvailability, loading, busy]);
  const saveCatalog = next => api.put('/local-calendar/catalog', next);
  const visible = events.filter(e => catalog.calendars.some(c => c.id === e.calendarId && c.visible)
    && (e.allDay ? e.start < addDays(last, 1) && e.end > first
      : wallTime(e.start, timezone) < `${addDays(last, 1)}T00:00` && wallTime(e.end, timezone) > `${first}T00:00`));
  const eventButton = (event, style = {}) => <button type="button" className="mf-calendar-event" style={{ borderLeftColor: catalog.calendars.find(c => c.id === event.calendarId)?.color, ...style }} onClick={() => openEvent(event)} title={`${event.title}${event.location ? ` · ${event.location}` : ''}`}>{!event.allDay && <time>{displayTime(wallTime(event.start, timezone))}</time>} {event.title}</button>;

  return <section className="mf-calendar" aria-label={t("localCalendar.title", "MailFlow calendar")} tabIndex={-1} ref={root}>
    <header className="mf-calendar-toolbar"><button type="button" onClick={onBack}>{t("localCalendar.back", "← Mail")}</button><h1>{t("localCalendar.title", "MailFlow calendar")}</h1><button type="button" disabled={loading} data-new-event onClick={() => createEvent()}>{t("localCalendar.newEventButton", "＋ New event")}</button><button type="button" disabled={loading || busy || sharingAvailability} onClick={shareAvailability} title={t('compose.availability.help', 'Choose a time manually. Your calendar has not been checked. This only inserts text into your draft.')}>{t('localCalendar.availabilityManual', 'Share availability (manual)')}</button><button type="button" onClick={() => openSettings({ kind: 'preferences', timezone, weekStart: catalog.weekStart, timeFormat })} disabled={loading}>{t("sidebar.settings", "Settings")}</button></header>
    <div className="mf-calendar-body"><aside className="mf-calendar-sidebar">
      <p className="mf-calendar-local">{t("localCalendar.privacy", "Private to your MailFlow account. No external calendar connection.")}</p>
      <input type="date" aria-label={t("localCalendar.goToDate", "Go to date")} value={day} onChange={e => { if (e.target.value) setDay(e.target.value); }} />
      <div className="mf-calendar-mini" aria-label={t("localCalendar.chooseDay", "Choose a calendar day")}>{visibleDays(day, 'month', catalog.weekStart).map(date => <button type="button" key={date} aria-label={t('localCalendar.goToDay', "Go to {{date}}", { date })} aria-current={date === day ? 'date' : undefined} className={date.slice(0, 7) !== day.slice(0, 7) ? 'mf-calendar-muted' : ''} onClick={() => setDay(date)}>{Number(date.slice(8))}</button>)}</div>
      <h2>{t("localCalendar.myCalendars", "My calendars")} <button type="button" aria-label={t("localCalendar.addCalendar", "Add calendar")} disabled={loading || busy} onClick={() => openSettings({ kind: 'calendar', name: '', color: colors[catalog.calendars.length % colors.length] })}>＋</button></h2>
      {catalog.calendars.map(calendar => <div className="mf-calendar-source" key={calendar.id}><label><input type="checkbox" checked={calendar.visible} disabled={busy || loading} onChange={() => mutate(() => saveCatalog({ ...catalog, calendars: catalog.calendars.map(c => c.id === calendar.id ? { ...c, visible: !c.visible } : c) }))} /><span style={{ color: calendar.color }}>●</span>{calendar.name}</label><button type="button" aria-label={t('localCalendar.editNamedCalendar', "Edit {{name}}", { name: calendar.name })} disabled={loading || busy} onClick={() => openSettings({ kind: 'calendar', ...calendar })}>•••</button></div>)}
      {!catalog.calendars.length && !loading && <p>{t("localCalendar.emptyCalendars", "No calendars yet. Add one to create your first event.")}</p>}
      <h2>{t("localCalendar.templates", "Event templates")} <button type="button" aria-label={t("localCalendar.addTemplate", "Add event template")} disabled={loading || busy} onClick={() => openSettings({ kind: 'template', title: '', duration: 30, location: '', description: '' })}>＋</button></h2>
      <p className="mf-calendar-local">{t("localCalendar.templateHelp", "Reusable event details, not public booking pages.")}</p>
      {catalog.templates.map(template => <div className="mf-calendar-source" key={template.id}><button type="button" disabled={loading || busy} onClick={() => createEvent(day, 9, false, template)}>{template.title}<small>{t('localCalendar.minutes', "{{duration}} min", { duration: template.duration })}</small></button><button type="button" aria-label={t('localCalendar.editNamedTemplate', "Edit template {{title}}", { title: template.title })} disabled={loading || busy} onClick={() => openSettings({ kind: 'template', ...template })}>•••</button></div>)}
    </aside><main className="mf-calendar-main"><div className="mf-calendar-datebar"><button type="button" aria-label={t("localCalendar.previous", "Previous period")} onClick={() => setDay(d => navigateDate(d, view, -1))}>‹</button><button type="button" aria-label={t("localCalendar.next", "Next period")} onClick={() => setDay(d => navigateDate(d, view, 1))}>›</button><button type="button" onClick={() => setDay(wallTime(new Date().toISOString(), timezone).slice(0, 10))}>{t("localCalendar.today", "Today")}</button><h2>{dateLabel(day, { month: 'long', year: 'numeric' }, htmlLang(i18n.language))}</h2><select aria-label={t("localCalendar.view", "Calendar view")} value={view} onChange={e => setView(e.target.value)}><option value="day">{t("localCalendar.day", "Day")}</option><option value="week">{t("localCalendar.week", "Week")}</option><option value="month">{t("localCalendar.month", "Month")}</option></select><button type="button" onClick={refresh} disabled={busy}>{t("localCalendar.reload", "Reload")}</button></div>
      {error && <p role="alert" className="mf-calendar-error">{error}</p>}
      {catalog.pendingCleanupIds?.length > 0 && <div role="status" className="mf-calendar-error">{t("localCalendar.cleanupNotice", "Removed calendars still have saved event data awaiting deletion.")} <button type="button" disabled={busy || loading} onClick={() => mutate(async () => { const result = await api.post('/local-calendar/cleanup', {}); if (result.cleanupError) throw new Error(result.cleanupError); })}>{t("localCalendar.cleanup", "Finish cleanup")}</button></div>}
      <p className="mf-calendar-status" role="status">{loading ? t("localCalendar.loading", "Loading calendar…") : visible.length ? (visible.length === 1 ? t('localCalendar.rangeEvent', "{{timezone}} · {{count}} event in this range", { timezone, count: visible.length }) : t('localCalendar.rangeEvents', "{{timezone}} · {{count}} events in this range", { timezone, count: visible.length })) : t('localCalendar.emptyRange', "{{timezone}} · No events in this range", { timezone })}</p>
      <div className="mf-calendar-scroll" ref={scroller}>
        {view === 'month' ? <div className="mf-calendar-month">{days.map(date => <section key={date} className={date.slice(0, 7) === day.slice(0, 7) ? '' : 'mf-calendar-muted'}><button type="button" className="mf-calendar-daytitle" aria-label={t('localCalendar.newEventOn', "New event on {{date}}", { date })} disabled={loading} onClick={() => createEvent(date)}>{dateLabel(date, { weekday: 'short', day: 'numeric' }, htmlLang(i18n.language))}</button>{visible.filter(e => eventOnDay(e, date, timezone)).map(event => <div key={event.id}>{eventButton(event)}</div>)}</section>)}</div>
          : <div className="mf-calendar-grid" style={{ gridTemplateColumns: `52px repeat(${days.length}, minmax(95px, 1fr))` }}><div className="mf-calendar-corner">{timezone}</div>{days.map(date => <header key={date}><button type="button" onClick={() => { setDay(date); setView('day'); }}>{dateLabel(date, { weekday: 'short', day: 'numeric' }, htmlLang(i18n.language))}</button></header>)}<div className="mf-calendar-allday-label">{t("localCalendar.allDay", "All day")}</div>{days.map(date => <div className="mf-calendar-allday" key={date}><button type="button" aria-label={t('localCalendar.newAllDayOn', "New all-day event on {{date}}", { date })} disabled={loading} onClick={() => createEvent(date, 9, true)}>＋</button>{visible.filter(e => e.allDay && eventOnDay(e, date, timezone)).map(event => <div key={event.id}>{eventButton(event)}</div>)}</div>)}
            <div className="mf-calendar-hours">{Array.from({ length: 24 }, (_, hour) => <div key={hour}>{displayTime(`2000-01-01T${String(hour).padStart(2, '0')}:00`)}</div>)}</div>{days.map(date => <div className="mf-calendar-timed" key={date}>{Array.from({ length: 24 }, (_, hour) => <button type="button" className="mf-calendar-hour" key={hour} aria-label={t('localCalendar.newEventAtTime', 'New event on {{date}} at {{time}}', { date, time: displayTime(`${date}T${String(hour).padStart(2, '0')}:00`) })} disabled={loading} onClick={() => createEvent(date, hour)} />)}{timedSegments(visible, date, timezone).map(({ event, from, to, lane, lanes }) => <div key={event.id} className="mf-calendar-positioned" style={{ top: from / 60 * 44, height: Math.max(22, (to - from) / 60 * 44), left: `${lane / lanes * 100}%`, width: `${100 / lanes}%` }}>{eventButton(event)}</div>)}</div>)}</div>}
      </div><footer className="mf-calendar-hints">{t("localCalendar.shortcuts", "B New event · 0 Day · 2 Week · M Month · ← → Navigate · T Today · Esc Back")}</footer>
    </main></div>
    {editor && <Dialog title={editor.id ? t("localCalendar.editEvent", "Edit event") : t("localCalendar.newEvent", "New event")} busy={busy} onClose={() => setEditor(null)}><form onSubmit={e => { e.preventDefault(); mutate(async () => {
      const value = { ...editor, start: editor.allDay ? editor.start : toInstant(editor.start, editor.timezone, t), end: editor.allDay ? editor.end : toInstant(editor.end, editor.timezone, t) };
      if (value.end <= value.start) throw new Error(t("localCalendar.endAfterStart", "End must be after start."));
      await (editor.id ? api.put(`/local-calendar/events/${editor.id}`, value) : api.post('/local-calendar/events', value));
    }); }}>
      <fieldset disabled={busy}><label>{t("localCalendar.titleLabel", "Title")}<input autoComplete="off" required maxLength={300} value={editor.title} onChange={e => setEditor({ ...editor, title: e.target.value })} /></label><label>{t("localCalendar.calendarLabel", "Calendar")}<select value={editor.calendarId} onChange={e => setEditor({ ...editor, calendarId: e.target.value })}>{catalog.calendars.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label className="mf-calendar-check"><input type="checkbox" checked={editor.allDay} onChange={e => setEditor({ ...editor, allDay: e.target.checked, start: e.target.checked ? editor.start.slice(0, 10) : `${editor.start}T09:00`, end: e.target.checked ? addDays(editor.start.slice(0, 10), 1) : `${editor.start}T10:00` })} />{t("localCalendar.allDay", "All day")}</label>
      <div className="mf-calendar-fields"><label>{t("localCalendar.start", "Start")}<input required type={editor.allDay ? 'date' : 'datetime-local'} value={editor.start} onChange={e => setEditor({ ...editor, start: e.target.value })} /></label><label>{editor.allDay ? t("localCalendar.endExclusive", "End (exclusive)") : t("localCalendar.end", "End")}<input required type={editor.allDay ? 'date' : 'datetime-local'} value={editor.end} onChange={e => setEditor({ ...editor, end: e.target.value })} /></label></div>
      <label>{t("localCalendar.timezone", "Time zone")}<input required value={editor.timezone} onChange={e => setEditor({ ...editor, timezone: e.target.value })} /></label><label>{t("localCalendar.location", "Location")}<input maxLength={1000} value={editor.location} onChange={e => setEditor({ ...editor, location: e.target.value })} /></label><label>{t("localCalendar.description", "Description")}<textarea maxLength={10000} rows={3} value={editor.description} onChange={e => setEditor({ ...editor, description: e.target.value })} /></label></fieldset>
      {error && <p role="alert" className="mf-calendar-error">{error}</p>}<div className="mf-calendar-actions">{editor.id && <button type="button" disabled={busy} onClick={() => { if (window.confirm(t("localCalendar.deleteEventConfirm", "Delete this local event?"))) mutate(() => api.delete(`/local-calendar/events/${editor.id}?revision=${encodeURIComponent(editor.revision)}`)); }}>{t("localCalendar.deleteEvent", "Delete event")}</button>}<button type="button" disabled={busy} onClick={() => setEditor(null)}>{t("common.cancel", "Cancel")}</button><button type="submit" disabled={busy}>{busy ? t("common.saving", "Saving…") : t("localCalendar.saveEvent", "Save event")}</button></div>
    </form></Dialog>}
    {settings && <Dialog title={settings.kind === 'calendar' ? (settings.id ? t("localCalendar.editCalendar", "Edit calendar") : t("localCalendar.newCalendar", "New calendar")) : settings.kind === 'template' ? (settings.id ? t("localCalendar.editTemplate", "Edit event template") : t("localCalendar.newTemplate", "New event template")) : t("localCalendar.settings", "Calendar settings")} busy={busy} onClose={() => setSettings(null)}><form onSubmit={e => { e.preventDefault(); mutate(() => {
      if (settings.kind === 'preferences') return saveCatalog({ ...settings.catalogSnapshot, timezone: settings.timezone, weekStart: Number(settings.weekStart), timeFormat: settings.timeFormat });
      const collection = settings.kind === 'calendar' ? 'calendars' : 'templates';
      const fields = Object.fromEntries(Object.entries(settings).filter(([key]) => key !== 'catalogSnapshot'));
      const value = { ...fields, id: settings.id || crypto.randomUUID(), ...(settings.kind === 'calendar' ? { visible: settings.visible ?? true } : { duration: Number(settings.duration) }) };
      return saveCatalog({ ...settings.catalogSnapshot, [collection]: settings.id ? settings.catalogSnapshot[collection].map(item => item.id === settings.id ? value : item) : [...settings.catalogSnapshot[collection], value] });
    }); }}><fieldset disabled={busy}>
      {settings.kind === 'calendar' && <><label>{t("admin.apiTokens.nameLabel", "Name")}<input required maxLength={100} value={settings.name} onChange={e => setSettings({ ...settings, name: e.target.value })} /></label><label>{t("localCalendar.color", "Color")}<input type="color" value={settings.color} onChange={e => setSettings({ ...settings, color: e.target.value })} /></label></>}
      {settings.kind === 'template' && <><p>{t("localCalendar.templateDetailsHelp", "Templates fill a new local event. They do not publish booking links.")}</p><label>{t("localCalendar.titleLabel", "Title")}<input required maxLength={300} value={settings.title} onChange={e => setSettings({ ...settings, title: e.target.value })} /></label><label>{t("localCalendar.duration", "Duration (minutes)")}<input required type="number" min={5} max={1440} value={settings.duration} onChange={e => setSettings({ ...settings, duration: e.target.value })} /></label><label>{t("localCalendar.location", "Location")}<input maxLength={1000} value={settings.location} onChange={e => setSettings({ ...settings, location: e.target.value })} /></label><label>{t("localCalendar.description", "Description")}<textarea maxLength={10000} value={settings.description} onChange={e => setSettings({ ...settings, description: e.target.value })} /></label></>}
      {settings.kind === 'preferences' && <><label>{t("localCalendar.timezone", "Time zone")}<input required value={settings.timezone} list="mf-calendar-zones" onChange={e => setSettings({ ...settings, timezone: e.target.value })} /><datalist id="mf-calendar-zones">{['UTC', Intl.DateTimeFormat().resolvedOptions().timeZone, 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Tokyo', 'Australia/Sydney'].map((zone, i) => <option key={`${zone}${i}`} value={zone} />)}</datalist></label><label>{t('localCalendar.timeFormat', 'Time format')}<select value={settings.timeFormat} onChange={e => setSettings({ ...settings, timeFormat: e.target.value })}><option value="12h">{t('localCalendar.timeFormat12', '12-hour')}</option><option value="24h">{t('localCalendar.timeFormat24', '24-hour')}</option></select></label><label>{t("localCalendar.weekStart", "Start week on")}<select value={settings.weekStart} onChange={e => setSettings({ ...settings, weekStart: e.target.value })}><option value={0}>{t("localCalendar.sunday", "Sunday")}</option><option value={1}>{t("localCalendar.monday", "Monday")}</option><option value={6}>{t("localCalendar.saturday", "Saturday")}</option></select></label></>}
    </fieldset>{error && <p role="alert" className="mf-calendar-error">{error}</p>}<div className="mf-calendar-actions">{settings.id && <button type="button" disabled={busy} onClick={() => {
      const collection = settings.kind === 'calendar' ? 'calendars' : 'templates';
      if (window.confirm(settings.kind === 'calendar' ? t("localCalendar.deleteCalendarConfirm", "Remove this calendar and all of its local events? This cannot be undone.") : t("localCalendar.deleteTemplateConfirm", "Delete this event template?"))) mutate(() => saveCatalog({ ...settings.catalogSnapshot, [collection]: settings.catalogSnapshot[collection].filter(item => item.id !== settings.id) }));
    }}>{t("common.delete", "Delete")}</button>}<button type="button" disabled={busy} onClick={() => setSettings(null)}>{t("common.cancel", "Cancel")}</button><button type="submit" disabled={busy}>{busy ? t("common.saving", "Saving…") : t("common.save", "Save")}</button></div></form></Dialog>}
  </section>;
}
