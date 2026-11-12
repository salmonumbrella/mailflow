import { useTranslation } from 'react-i18next';
import RowHoverActions from './RowHoverActions.jsx';
import ReplyDraftIndicator from './ReplyDraftIndicator.jsx';
import SpamBadge from './SpamBadge.jsx';
import { PluginSlot } from '../plugins/PluginSlot.jsx';
import { isSelectedRow } from '../utils/gtd.js';
import { formatDate, formatDateTime, formatSnoozeUntil } from '../utils/formatDate.js';

export default function SuperhumanMessageRow({
  message, selected, lastViewed, selectedMessageId, selectedMid, selectedAcct, lastViewedMessageId,
  isChecked = false, selectionMode, onToggleSelect, onRangeSelect, onModifierSelect,
  onSelect, onHighlight, onOpenWindow, onThreadClick, onThreadToggle, isExpanded, threadMsgs, isLoadingThread,
  showMessagePreviews, onMarkRead, onStar, onDelete, onArchive, onSnooze, onMove, onDragStart,
  onContextMenu, onExplainSpam, hoverQuickActions, hoverActionSet, nested = false,
}) {
  const { t } = useTranslation();
  const threaded = !!onThreadClick;
  const unread = threaded ? Number(message.unread_count) > 0 : !message.is_read;
  const isSelected = threaded
    ? isSelectedRow(message, selectedMessageId, selectedMid, selectedAcct)
      || !!threadMsgs?.some(msg => isSelectedRow(msg, selectedMessageId, selectedMid, selectedAcct))
    : selected;
  const isLastViewed = threaded
    ? lastViewedMessageId === message.id || !!threadMsgs?.some(msg => msg.id === lastViewedMessageId)
    : lastViewed;
  const sender = message.from_name || message.from_email || t('common.unknown', 'Unknown');
  const subject = message.subject || t('common.noSubject');
  const count = Number(message.message_count) || 1;
  const open = () => { onHighlight?.(message.id); if (onThreadClick) onThreadClick(); else onSelect(message); };
  const select = event => {
    event.stopPropagation();
    if (event.shiftKey && onRangeSelect) onRangeSelect(message.id);
    else onToggleSelect?.(message.id);
  };
  const activate = event => {
    if (nested && selectionMode) return;
    if (selectionMode) select(event);
    else if ((event.ctrlKey || event.metaKey || event.shiftKey) && onModifierSelect) {
      event.preventDefault();
      onModifierSelect(message.id, event.shiftKey);
    } else open();
  };

  return (
    <div className={`sh-mail-row${nested ? ' sh-mail-row--nested' : ''}`} data-msgid={message.id}
      data-unread={unread} data-selected={!!isSelected} data-last-viewed={!!isLastViewed} data-checked={isChecked}
      data-selection-mode={!!selectionMode}>
      <div className="sh-mail-row-content" role="listitem" tabIndex={0}
        aria-description={nested ? t('messageList.openThreadMessageHint', 'Press Enter to open this message before using message shortcuts.') : undefined}
        aria-current={isSelected ? 'true' : undefined} aria-label={`${sender}, ${subject}${unread ? `, ${t('messageList.unread')}` : ''}`}
        draggable={!!onDragStart}
        onDragStart={onDragStart ? event => onDragStart(event, message) : undefined}
        onFocus={() => onHighlight?.(message.id)}
        onClick={activate}
        onDoubleClick={!selectionMode && onOpenWindow ? () => onOpenWindow(message) : undefined}
        onKeyDown={event => {
          // Expanded children open concrete messages. Thread-level shortcuts belong to the head,
          // so never let a key aimed at a focused child mutate its parent conversation.
          if (nested && !['Tab', 'Escape'].includes(event.key)) event.stopPropagation();
          if (event.target !== event.currentTarget) return;
          if (nested && event.key === ' ') { event.preventDefault(); activate(event); return; }
          if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); activate(event); }
          if (event.key === ' ' && onToggleSelect) { event.preventDefault(); event.stopPropagation(); select(event); }
        }}
        onContextMenu={onContextMenu ? event => onContextMenu(event, message) : undefined}>
        <span className="sh-mail-indicator">
          {unread && <span className="unread-dot sh-mail-unread" aria-hidden="true" />}
          {!nested && onToggleSelect && <input className="sh-mail-checkbox" type="checkbox" checked={isChecked}
            aria-label={`${t('messageList.selectMessages')}: ${sender}, ${subject}`}
            onChange={() => {}} onClick={select} />}
        </span>
        <span className="sh-mail-sender-cell">
          <span className="sh-mail-sender" title={message.from_email || sender}>{sender}</span>
          {threaded && count > 1 && <button type="button" className="sh-mail-thread-count"
            aria-expanded={!!isExpanded}
            aria-label={`${isExpanded ? t('message.aiCollapse') : t('messageList.showAll')} (${count})`}
            onClick={event => { event.stopPropagation(); onThreadToggle(); }}>
            {count}<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d={isExpanded ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} />
            </svg>
          </button>}
        </span>
        <span className="sh-mail-summary">
          <span className="sh-mail-subject">{subject}</span>
          <span className="sh-mail-meta" onClick={event => event.stopPropagation()}>
            <PluginSlot name="message-row-meta" ctx={{ message }} />
            <ReplyDraftIndicator message={message} listRow />
            <SpamBadge message={message} onClick={onExplainSpam} />
          </span>
          {showMessagePreviews && message.snippet && <span className="sh-mail-snippet">{message.snippet}</span>}
        </span>
        <span className="sh-mail-tail">
          {message.has_attachments && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
            role="img" aria-label={t('message.attachments', 'Attachments')}>
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
          </svg>}
          {message.is_starred && <button type="button" className="sh-mail-star" title={t('contextMenu.unstar')}
            aria-label={t('contextMenu.unstar')}
            onClick={event => { event.stopPropagation(); onStar?.(event, message); }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          </button>}
          <span className="sh-mail-date" title={message.snooze_until
            ? t('messageList.snoozedUntil', { when: formatDateTime(message.snooze_until) })
            : formatDateTime(message.date)}>
            {message.snooze_until && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
            </svg>}
            {message.snooze_until ? formatSnoozeUntil(message.snooze_until) : formatDate(message.date)}
          </span>
        </span>
        {hoverQuickActions && !selectionMode && <span className="sh-mail-actions" onClick={event => event.stopPropagation()}>
          <RowHoverActions message={message} isRead={!unread} background="var(--sh-row-active, var(--bg-tertiary))"
            onMarkRead={onMarkRead} onStar={onStar} onArchive={onArchive} onSnooze={onSnooze}
            onDelete={onDelete} onMove={onMove} actions={hoverActionSet} rowActionCtx={{ message }} />
        </span>}
      </div>
      {threaded && isExpanded && <div className="sh-mail-thread-children" role="list">
        {isLoadingThread ? <div className="sh-mail-thread-loading" role="status">{t('common.loading')}</div>
          : (threadMsgs || []).map(msg => <SuperhumanMessageRow key={msg.id} message={msg} nested
            selected={isSelectedRow(msg, selectedMessageId, selectedMid, selectedAcct)}
            lastViewed={lastViewedMessageId === msg.id} selectionMode={selectionMode}
            showMessagePreviews={showMessagePreviews} onSelect={onSelect} onOpenWindow={onOpenWindow}
            onStar={onStar} onContextMenu={onContextMenu} onExplainSpam={onExplainSpam} />)}
      </div>}
    </div>
  );
}
