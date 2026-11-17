import { useRef, useEffect, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { LAYOUTS } from '../layouts.js';
import ListSortMenu from './ListSortMenu.jsx';
import { hasStarredSearch } from '../utils/mailListFilters.js';

export default function SuperhumanListHeader({
  label, count, countTitle, categories, activeCategory, onCategory, searchQuery, setSearchQuery,
  searchInputRef, syncing, onSync, syncTitle, unreadOnly, onToggleUnread, onToggleStarred, selectionMode, onToggleSelection,
  layout, onLayout, pageSize, onPageSize, sortable, accountId, folder,
  gtdTabs = [], activeGtdTab, onGtdTab, tabScrollRef, tabScrollEdges, onTabScroll,
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
  useLayoutEffect(() => {
    const strip = tabScrollRef?.current;
    if (!strip || !onTabScroll) return;
    onTabScroll();
    const observer = new ResizeObserver(onTabScroll);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [tabScrollRef, onTabScroll, gtdTabs.length, categories.length, searchQuery]);
  return <header className="sh-list-header">
    <div className="sh-list-heading">
      {(gtdTabs.length > 0 || categories.length > 0) && !searchQuery.trim() ? <div className="sh-list-tabs-wrap">
        {tabScrollEdges?.left && <button type="button" className="sh-tab-scroll sh-tab-scroll--left"
          aria-label={t('messageList.scrollTabsLeft', 'Scroll tabs left')}
          onClick={() => tabScrollRef.current?.scrollBy({ left: -120, behavior: 'smooth' })}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
        </button>}
        <div className="sh-list-tabs" ref={tabScrollRef} onScroll={onTabScroll} role="group"
          aria-label={gtdTabs.length ? t('gtd.title') : t('messageList.categoriesLabel', 'Inbox categories')}>
          {gtdTabs.map(tab => <button type="button" key={`gtd-${tab.key}`} className="sh-list-tab"
            aria-pressed={activeGtdTab === tab.key && (tab.key !== null || !categories.length || activeCategory == null)} onClick={() => onGtdTab(tab.key)}>
            {tab.label}
            {tab.unread > 0 && <span className="sh-gtd-unread" aria-label={`${tab.unread} ${t('messageList.unread')}`}>{tab.unread > 99 ? '99+' : tab.unread}</span>}
          </button>)}
          {categories.map(category => <button type="button" key={category.key} className="sh-list-tab"
            aria-pressed={activeCategory === category.key} onClick={() => onCategory(category.key)}
            title={t('messageList.categoryCountTitle', { total: category.total || 0, unread: category.unread })}>
            {category.label}
            {category.total != null && <span>{category.total}</span>}
            {category.unread > 0 && <span className="sh-category-unread" aria-label={`${category.unread} ${t('messageList.unread')}`}>{category.unread}</span>}
          </button>)}
        </div>
        {tabScrollEdges?.right && <button type="button" className="sh-tab-scroll sh-tab-scroll--right"
          aria-label={t('messageList.scrollTabsRight', 'Scroll tabs right')}
          onClick={() => tabScrollRef.current?.scrollBy({ left: 120, behavior: 'smooth' })}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>
        </button>}
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
            {onToggleStarred && <button type="button" aria-pressed={hasStarredSearch(searchQuery)} onClick={onToggleStarred}>{t('shortcuts.actions.filterStarred.label')}</button>}
            {onToggleSelection && <button type="button" aria-pressed={selectionMode} onClick={() => { onToggleSelection(); optionsRef.current.open = false; }}>{selectionMode ? t('common.cancel') : t('messageList.selectMessages')}</button>}
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
    {hasStarredSearch(searchQuery) && onToggleStarred && <div className="sh-list-filter"><button type="button" onClick={onToggleStarred}>{t('shortcuts.actions.filterStarred.label')} <span aria-hidden="true">×</span></button></div>}
    {unreadOnly && <div className="sh-list-filter"><button type="button" onClick={onToggleUnread}>{t('messageList.unreadOnly')} <span aria-hidden="true">×</span></button></div>}
  </header>;
}
