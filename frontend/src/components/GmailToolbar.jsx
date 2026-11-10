import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import GmailSelectionMenu from './GmailSelectionMenu.jsx';
import { useUiScale, descale } from '../hooks/useUiScale.js';

const paths = {
  archive: 'M3 3h18v5H3z M5 8v13h14V8 M9 12h6', spam: 'M8 3h8l5 5v8l-5 5H8l-5-5V8z M12 7v6 M12 16v1',
  delete: 'M3 6h18 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7', read: 'M3 9l9-6 9 6v12H3z M3 9l9 7 9-7',
  unread: 'M3 5h18v14H3z M3 5l9 7 9-7', snooze: 'M12 7v5l4 2', move: 'M3 5h6l2 3h10v13H3z M9 14h8 M14 11l3 3-3 3',
  labels: 'M3 3h9l9 9-9 9-9-9z M7 7h1', task: 'M4 12l5 5L20 6', refresh: 'M20 10a8 8 0 10-1 8 M20 3v7h-7',
  more: 'M12 4v1 M12 11v1 M12 18v1', newer: 'M15 6l-6 6 6 6', older: 'M9 6l6 6-6 6',
};
function Icon({ name }) { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">{name === 'snooze' && <circle cx="12" cy="12" r="9" />}<path d={paths[name]} /></svg>; }

export function snoozePresets(now = new Date(), t = (_key, fallback) => fallback) {
  const at = (days, hour) => { const date = new Date(now); date.setDate(date.getDate() + days); date.setHours(hour, 0, 0, 0); return date; };
  return [ [t("gmailToolbar.laterToday", "Later today"), new Date(now.getTime() + 3 * 3600000)], [t("gmailToolbar.tomorrow", "Tomorrow"), at(1, 8)], [t("gmailToolbar.thisWeekend", "This weekend"), at((6 - now.getDay() + 7) % 7 || 7, 8)], [t("gmailToolbar.nextWeek", "Next week"), at((8 - now.getDay()) % 7 || 7, 8)] ];
}
export function validSnooze(value, now = new Date()) {
  const date = new Date(value); const max = new Date(now); max.setDate(max.getDate() + 30);
  return Number.isFinite(date.getTime()) && date > now && date <= max;
}

function SnoozeCalendar({ value, onChange }) {
  const { t } = useTranslation();
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const first = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const stamp = day => `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const last = new Date(today); last.setDate(last.getDate() + 30);
  return <div className="gmail-snooze-calendar" aria-label={t("gmailToolbar.snoozeCalendar", "Snooze calendar")}>
    <div className="gmail-snooze-month"><button type="button" aria-label={t("gmailToolbar.previousMonth", "Previous month")} disabled={month.getFullYear() === today.getFullYear() && month.getMonth() === today.getMonth()}
      onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button>
      <span aria-live="polite">{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
      <button type="button" aria-label={t("gmailToolbar.nextMonth", "Next month")} disabled={month.getFullYear() === last.getFullYear() && month.getMonth() === last.getMonth()}
        onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button></div>
    <div className="gmail-snooze-days">{Array.from({ length: 7 }, (_, index) => new Date(2026, 10, 8 + index).toLocaleDateString(undefined, { weekday: 'narrow' })).map((day, index) => <span key={index} aria-hidden="true">{day}</span>)}
      {Array.from({ length: first }, (_, index) => <span key={`empty-${index}`} />)}
      {Array.from({ length: days }, (_, index) => {
        const day = index + 1, date = new Date(month.getFullYear(), month.getMonth(), day);
        return <button type="button" key={day} aria-label={date.toLocaleDateString(undefined, { dateStyle: 'full' })} aria-pressed={value.startsWith(stamp(day))}
          disabled={date < today || date > last} onClick={() => onChange(`${stamp(day)}T${value.split('T')[1] || '08:00'}`)}>{day}</button>;
      })}</div>
  </div>;
}

// Only native MailFlow capabilities are actionable. The reference's Google-only simulations
// stay explanatory rather than inventing persisted state or silently doing something else.
export default function GmailToolbar({ messages, selectedIds, onSelect, onAction, onRefresh, busy = false, syncing = false,
  folders = [], loadFolders, canMove = false, count, page = 1, pageSize, paginated = false, totalKnown = true, onPage, contextKey, snoozed = false, permanentDelete = false, order = { sort: 'date', dir: 'desc' }, sortControl }) {
  const { t } = useTranslation();
  const scale = useUiScale();
  const selected = messages.filter(message => selectedIds.has(message.id));
  const selectionKey = selected.map(message => message.id).join('|');
  const [menu, setMenu] = useState(null);
  const [query, setQuery] = useState('');
  const [destinations, setDestinations] = useState(folders);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [custom, setCustom] = useState(false);
  const [date, setDate] = useState('');
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const popup = useRef(null); const anchor = useRef(null); const request = useRef(0);
  const close = (focus = true) => { request.current++; setMenu(null); if (focus) anchor.current?.focus(); };
  useEffect(() => { request.current++; setMenu(null); setError(''); }, [contextKey, selectionKey]);
  useEffect(() => () => { request.current++; }, []);
  const open = async (kind, event) => {
    if (menu === kind) { close(); return; }
    anchor.current = event.currentTarget; setQuery(''); setError(''); setCustom(false); setMenu(kind);
    const generation = ++request.current;
    if (kind === 'move') {
      setDestinations([]); setLoading(true);
      try { const result = await loadFolders(); if (request.current === generation) setDestinations(result); }
      catch { if (request.current === generation) setError(t("gmailToolbar.couldNotLoadFoldersCloseAndTryAgain", "Could not load folders. Close and try again.")); }
      finally { if (request.current === generation) setLoading(false); }
    }
  };
  useLayoutEffect(() => {
    if (!menu || !popup.current) return;
    const a = anchor.current.getBoundingClientRect(), box = popup.current.getBoundingClientRect();
    setPosition({ left: descale(Math.max(8, Math.min(a.left, window.innerWidth - box.width - 8)), scale), top: descale(Math.max(8, Math.min(a.bottom + 3, window.innerHeight - box.height - 8)), scale) });
  }, [menu, custom, loading, destinations, query, error, scale]);
  useEffect(() => {
    if (!menu) return;
    popup.current?.querySelector('input, button:not(:disabled)')?.focus();
    const outside = event => { if (!popup.current?.contains(event.target) && !anchor.current?.contains(event.target)) close(); };
    const scroll = event => { if (!(event.target instanceof Node) || !popup.current?.contains(event.target)) close(); };
    document.addEventListener('pointerdown', outside); window.addEventListener('scroll', scroll, true); window.addEventListener('resize', scroll);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', scroll); };
  }, [menu]);
  const keyDown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'ArrowLeft' && custom && event.target.tagName !== 'INPUT') { event.preventDefault(); event.stopPropagation(); setCustom(false); popup.current?.querySelector('[data-custom-snooze]')?.focus(); }
    else if (event.key === 'ArrowRight' && event.target.hasAttribute('data-custom-snooze')) { event.preventDefault(); setCustom(true); }
    else if (event.key === 'Tab') {
      const form = event.target.closest('form');
      const controls = form ? [...form.querySelectorAll('input, button:not(:disabled)')] : [];
      if (!form || (event.shiftKey ? event.target === controls[0] : event.target === controls.at(-1))) close(false);
    }
    else if (event.target.type !== 'datetime-local' && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && !(event.target.tagName === 'INPUT' && ['Home', 'End'].includes(event.key))) {
      event.preventDefault(); event.stopPropagation();
      const items = [...popup.current.querySelectorAll('button:not(:disabled), input')]; const index = items.indexOf(document.activeElement);
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }
  };
  const act = (action, value) => { close(); onAction(action, selected, value); };
  const item = (label, action, value, disabled = false) => <button type="button" role="menuitem" disabled={disabled || busy} onClick={() => act(action, value)}>{label}</button>;
  const trigger = (name, label, kind, action, disabled = false) => <button type="button" className="gmail-toolbar-icon" aria-label={label} title={label} disabled={disabled || busy}
    aria-haspopup={kind ? 'menu' : undefined} aria-expanded={kind ? menu === kind : undefined}
    onKeyDown={event => { if (kind && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); open(kind, event); } }}
    onClick={event => kind ? open(kind, event) : act(action)}><Icon name={name} /></button>;
  const chronological = order?.sort === 'date' && !order.starredFirst && !snoozed;
  const oldestFirst = chronological && order.dir === 'asc';
  const previousLabel = chronological ? (oldestFirst ? t("gmailToolbar.older", "Older") : t("gmailToolbar.newer", "Newer")) : t("gmailToolbar.previousPage", "Previous page");
  const nextLabel = chronological ? (oldestFirst ? t("gmailToolbar.newer", "Newer") : t("gmailToolbar.older", "Older")) : t("gmailToolbar.nextPage", "Next page");
  const firstLabel = chronological ? (oldestFirst ? t("gmailToolbar.oldest", "Oldest") : t("gmailToolbar.newest", "Newest")) : t("gmailToolbar.firstPage", "First page");
  const lastLabel = chronological ? (oldestFirst ? t("gmailToolbar.newest", "Newest") : t("gmailToolbar.oldest", "Oldest")) : t("gmailToolbar.lastPage", "Last page");
  const lastPage = Math.max(1, Math.ceil(count / pageSize));
  const start = messages.length ? (paginated ? (page - 1) * pageSize : 0) + 1 : 0;
  const end = messages.length ? start + messages.length - 1 : 0;
  return <div className="gmail-toolbar" role="toolbar" aria-label={t("gmailToolbar.mailboxToolbar", "Mailbox toolbar")} aria-busy={busy}>
    <div className="gmail-toolbar-actions">
      <GmailSelectionMenu messages={messages} selectedIds={selectedIds} onSelect={rows => { if (!busy) onSelect(rows); }} />
      {selected.length > 0 ? <>
        {trigger('archive', t("gmailToolbar.archive", "Archive"), null, 'archive')}{trigger('spam', t("gmailToolbar.reportSpam", "Report spam"), null, 'spam')}{trigger('delete', permanentDelete ? t("gmailToolbar.deletePermanently", "Delete permanently") : t("gmailToolbar.delete", "Delete"), permanentDelete ? 'delete' : null, 'delete')}
        <span className="gmail-toolbar-divider" />
        {trigger(selected.some(m => !m.is_read) ? 'read' : 'unread', selected.some(m => !m.is_read) ? t("gmailToolbar.markAsRead", "Mark as read") : t("gmailToolbar.markAsUnread", "Mark as unread"), null, selected.some(m => !m.is_read) ? 'read' : 'unread')}
        {trigger('snooze', t("gmailToolbar.snooze", "Snooze"), 'snooze')}{trigger('task', t("gmailToolbar.addToTasks", "Add to Tasks"), 'tasks')}
        <span className="gmail-toolbar-divider" />{trigger('move', t("gmailToolbar.moveTo", "Move to"), 'move', null, !canMove)}{trigger('labels', t("gmailToolbar.labels", "Labels"), 'labels')}
      </> : <button type="button" className="gmail-toolbar-icon" aria-label={t("gmailToolbar.refresh", "Refresh")} title={t("gmailToolbar.refresh", "Refresh")} disabled={busy || syncing} onClick={onRefresh}><Icon name="refresh" /></button>}
      {trigger('more', t("gmailToolbar.more", "More"), 'more')}
    </div>
    <div className="gmail-toolbar-pagination">{sortControl}
      <button type="button" className="gmail-toolbar-range" title={paginated ? t("gmailToolbar.pageNavigation", "Page navigation") : t("gmailToolbar.loadedMessagesUseLoadMoreBelowForAdditionalResults", "Loaded messages; use Load more below for additional results")} aria-haspopup={paginated ? 'menu' : undefined} aria-expanded={paginated ? menu === 'pagination' : undefined} onClick={event => paginated && open('pagination', event)}>{t('gmailToolbar.range', { defaultValue: '{{start}}–{{end}} of {{count}}', start: start.toLocaleString(), end: end.toLocaleString(), count: `${count.toLocaleString()}${!totalKnown ? '+' : ''}` })}</button>
      {trigger('newer', previousLabel, null, 'newer', !paginated || page <= 1)}{trigger('older', nextLabel, null, 'older', !paginated || page >= lastPage)}
    </div>
    {menu && createPortal(<div ref={popup} className="gmail-toolbar-menu" style={position} role="menu" aria-label={t("gmailToolbar.actionMenu", "Mail actions")} onKeyDown={keyDown}>
      {menu === 'more' && (selected.length ? <>
        {item(t("gmailToolbar.markAsRead", "Mark as read"), 'read')}{item(t("gmailToolbar.markAsUnread", "Mark as unread"), 'unread')}{item(t("gmailToolbar.addStar", "Add star"), 'star')}{item(t("gmailToolbar.removeStar", "Remove star"), 'unstar')}
        {item(t("gmailToolbar.markAsImportant", "Mark as important"), 'important', null, true)}{item(t("gmailToolbar.mute", "Mute"), 'mute', null, true)}
        {item(t("gmailToolbar.findMessagesFromThisSender", "Find messages from this sender"), 'findSender', null, selected.length !== 1)}
        {item(t("gmailToolbar.filterMessagesLikeThis", "Filter messages like this"), 'filterSender', null, selected.length !== 1)}
        {item(t("gmailToolbar.forwardAsAttachment", "Forward as attachment"), 'forwardAsAttachment', null, selected.length !== 1)}
        <p>{t("gmailToolbar.importanceAndMuteAreNotSupportedByMailFlowSenderSearchDoesNotCreateAFilterRuleUseFilterMessagesLikeThisToReviewANewRuleBeforeSaving", "Importance and mute are not supported by MailFlow. Sender search does not create a filter rule. Use Filter messages like this to review a new rule before saving.")}</p>
      </> : <p>{t("gmailToolbar.selectMessagesToSeeMoreActions", "Select messages to see more actions.")}</p>)}
      {menu === 'move' && <><label>{t("gmailToolbar.moveTo", "Move to")}<input aria-label={t("gmailToolbar.searchFolders", "Search folders")} value={query} onChange={event => setQuery(event.target.value)} /></label>
        {loading && <p role="status">{t("gmailToolbar.loadingFolders", "Loading folders…")}</p>}{error && <p role="alert">{error}</p>}
        {!loading && !error && destinations.filter(folder => !folder.no_select && !folder.attributes?.includes('\\Noselect') && folder.path.toLowerCase().includes(query.toLowerCase())).map(folder => <button type="button" role="menuitem" key={folder.path} onClick={() => act('move', folder.path)}>{folder.name || folder.path}</button>)}
        {!loading && !error && !destinations.some(folder => !folder.no_select && folder.path.toLowerCase().includes(query.toLowerCase())) && <p>{t("gmailToolbar.noMatchingFolders", "No matching folders.")}</p>}
        <p>{t("gmailToolbar.movesUseThisAccountSMailFoldersManageFoldersInMailFlowSettings", "Moves use this account’s mail folders. Manage folders in MailFlow Settings.")}</p></>}
      {menu === 'delete' && <><p>{t("gmailToolbar.messagesAlreadyInTrashWillBePermanentlyDeletedAfterTheUndoPeriodTheyCannotBeRecoveredAfterDeletionIsSentToTheServer", "Messages already in Trash will be permanently deleted after the Undo period. They cannot be recovered after deletion is sent to the server.")}</p>{item(t("gmailToolbar.deletePermanently", "Delete permanently"), 'delete')}<button type="button" role="menuitem" onClick={() => close()}>{t("gmailToolbar.cancel", "Cancel")}</button></>}
      {menu === 'labels' && <p>{t("gmailToolbar.gmailLabelAssignmentIsNotSupportedByMailFlowUseMoveToForNativeMailFoldersOrTheKlingerGTDControlsToOrganizeWork", "Gmail label assignment is not supported by MailFlow. Use Move to for native mail folders, or the Klinger GTD controls to organize work.")}</p>}
      {menu === 'tasks' && <p>{t("gmailToolbar.googleTasksIsNotConnectedUseMailFlowSKlingerGTDControlsToOrganizeWork", "Google Tasks is not connected. Use MailFlow’s Klinger GTD controls to organize work.")}</p>}
      {menu === 'snooze' && <><p>{t("gmailToolbar.snoozeTheSelectedMessagesReplyChainsMailFlowSupportsUpTo30Days", "Snooze the selected messages’ reply chains. MailFlow supports up to 30 days.")}</p>{snoozed && item(t("gmailToolbar.unsnooze", "Unsnooze"), 'unsnooze')}
        {snoozePresets(new Date(), t).map(([label, when]) => <button type="button" role="menuitem" key={label} onClick={() => act(snoozed ? 'changeSnooze' : 'snooze', when.toISOString())}>{label}<small>{when.toLocaleString()}</small></button>)}
        <button data-custom-snooze="" type="button" role="menuitem" aria-expanded={custom} onClick={() => setCustom(true)}>{t("gmailToolbar.pickDateTime", "Pick date & time")}</button>
        {custom && <><SnoozeCalendar value={date} onChange={setDate} /><form onSubmit={event => { event.preventDefault(); if (validSnooze(date)) act(snoozed ? 'changeSnooze' : 'snooze', new Date(date).toISOString()); else setError(t("gmailToolbar.chooseAFutureTimeWithin30Days", "Choose a future time within 30 days.")); }}><label>{t("gmailToolbar.dateAndTime", "Date and time")}<input type="datetime-local" aria-label={t("gmailToolbar.snoozeDateAndTime", "Snooze date and time")} value={date} onChange={event => setDate(event.target.value)} /></label>{error && <p role="alert">{error}</p>}<button type="submit">{t("gmailToolbar.save", "Save")}</button><button type="button" onClick={() => close()}>{t("gmailToolbar.cancel", "Cancel")}</button></form></>}</>}
      {menu === 'pagination' && <><button type="button" role="menuitem" disabled={page <= 1 || busy} onClick={() => { close(); onPage(1); }}>{firstLabel}</button><button type="button" role="menuitem" disabled={page >= lastPage || busy} onClick={() => { close(); onPage(lastPage); }}>{lastLabel}</button></>}
    </div>, document.body)}
  </div>;
}
