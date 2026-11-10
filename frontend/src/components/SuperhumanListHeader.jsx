import { useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { LAYOUTS } from '../layouts.js';
import ListSortMenu from './ListSortMenu.jsx';
import SavedSplitBar from './SavedSplitBar.jsx';

export default function SuperhumanListHeader({
  label, count, countTitle, categories, activeCategory, onCategory, searchQuery, setSearchQuery,
  searchInputRef, syncing, onSync, syncTitle, unreadOnly, onToggleUnread, selectionMode, onToggleSelection,
  layout, onLayout, pageSize, onPageSize, sortable, accountId, folder,
}) {
  const { t } = useTranslation();
  const optionsRef = useRef(null);
  useEffect(() => {
    const close = event => {
      if (optionsRef.current && !optionsRef.current.contains(event.target)) optionsRef.current.open = false;
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  return <header className="sh-list-header">
    <div className="sh-list-heading">
      {categories.length > 0 && !searchQuery.trim() ? <div className="sh-list-tabs" role="group" aria-label={t('messageList.categoriesLabel', 'Inbox categories')}>
        {categories.map(category => <button type="button" key={category.key} className="sh-list-tab"
          aria-pressed={activeCategory === category.key} onClick={() => onCategory(category.key)}
          title={t('messageList.categoryCountTitle', { total: category.total || 0, unread: category.unread })}>
          {category.label}
          {category.total != null && <span>{category.total}</span>}
          {category.unread > 0 && <span className="sh-category-unread" aria-label={`${category.unread} ${t('messageList.unread')}`}>{category.unread}</span>}
        </button>)}
      </div> : <h2 className="sh-list-title">{label}<span title={countTitle}>{count}</span></h2>}
      <div className="sh-list-controls">
        <button className="sh-icon-button" type="button" title={syncTitle} aria-label={syncTitle} disabled={syncing} onClick={onSync}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" className={syncing ? 'sh-syncing' : undefined}>
            <path d="M20 7a9 9 0 00-15-2L2 8m0-6v6h6M4 17a9 9 0 0015 2l3-3m0 6v-6h-6" />
          </svg>
        </button>
        <label className="sh-list-search" title={t('messageList.search')}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            <circle cx="10.8" cy="10.8" r="7.4" /><path d="m16.5 16.5 4.5 4.5" />
          </svg>
          <input ref={searchInputRef} type="search" aria-label={t('messageList.search')} placeholder={t('messageList.search')}
            value={searchQuery} onChange={event => setSearchQuery(event.target.value)}
            onKeyDown={event => { if (event.key === 'Escape') { setSearchQuery(''); event.currentTarget.blur(); } }} />
        </label>
        <details className="sh-list-options" ref={optionsRef} onKeyDown={event => { if (event.key === 'Escape') { optionsRef.current.open = false; optionsRef.current.querySelector('summary')?.focus(); } }}>
          <summary className="sh-icon-button" aria-label={t('messageList.listOptions', 'List options')} title={t('messageList.listOptions', 'List options')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>
          </summary>
          <div className="sh-list-options-panel">
            <button type="button" aria-pressed={unreadOnly} onClick={onToggleUnread}>{unreadOnly ? t('messageList.showAll') : t('messageList.unreadOnly')}</button>
            <button type="button" aria-pressed={selectionMode} onClick={() => { onToggleSelection(); optionsRef.current.open = false; }}>{selectionMode ? t('common.cancel') : t('messageList.selectMessages')}</button>
            {sortable && <ListSortMenu accountId={accountId} folder={folder} />}
            <label>{t('messageList.messagesPerPage')}<select value={pageSize} onChange={event => onPageSize(Number(event.target.value))}>
              {[25, 50, 100, 200].map(size => <option key={size} value={size}>{size}</option>)}
            </select></label>
            <label>{t('messageList.layout', 'Layout')}<select value={layout} onChange={event => onLayout(event.target.value)}>
              {Object.entries(LAYOUTS).map(([key, definition]) => <option key={key} value={key}>{t(definition.labelKey, definition.label)}</option>)}
            </select></label>
          </div>
        </details>
      </div>
    </div>
    {folder === 'INBOX' && <SavedSplitBar accountId={accountId} />}
    {unreadOnly && <div className="sh-list-filter"><button type="button" onClick={onToggleUnread}>{t('messageList.unreadOnly')} <span aria-hidden="true">×</span></button></div>}
  </header>;
}
