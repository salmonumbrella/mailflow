import { useState } from 'react';
import { GTD_COLORS, isSelectedRow } from '../utils/gtd.js';
import { GMAIL_GTD_SYMBOLS, getGmailGtdPage } from '../utils/gmailGtd.js';
import GtdTriageRow from './GtdTriageRow.jsx';

const LABEL_KEYS = { todo: 'gtd.gmail.action', watch: 'gtd.gmail.awaiting', reference: 'gtd.gmail.reference' };

export default function GmailGtdSection({ section, collapsed, onToggle, onOpenRow, rowActions, selectedMessageId, selectedMid, selectedAcct, t, loaded }) {
  const [requestedPage, setPage] = useState(0);
  const page = getGmailGtdPage(section, requestedPage);
  const label = t(LABEL_KEYS[section.key] || `gtd.state.${section.key}`);
  const pageButton = { border: 0, background: 'transparent', color: 'var(--text-secondary)', padding: '4px 6px', cursor: 'pointer', borderRadius: 4 };

  return (
    <section data-gmail-gtd-section={section.key} aria-label={label} style={{ borderBottom: '1px solid var(--border)', paddingBottom: collapsed ? 0 : 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 3, minHeight: 42, position: 'sticky', top: 'var(--right-sidebar-header-height, 50px)', background: 'var(--bg-secondary)', zIndex: 2 }}>
        <button type="button" onClick={onToggle} aria-expanded={!collapsed} aria-label={t('gtd.toggleSection', { section: label })}
          style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, flex: 1, padding: '10px 8px', border: 0, background: 'transparent', textAlign: 'left', color: 'var(--text-primary)', cursor: 'pointer' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ flexShrink: 0 }}><polyline points={collapsed ? '9 18 15 12 9 6' : '6 9 12 15 18 9'} /></svg>
          <span aria-hidden="true" style={{ color: GTD_COLORS[section.key], fontWeight: 700 }}>{GMAIL_GTD_SYMBOLS[section.key]}</span>
          <span style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        </button>
        <span aria-live="polite" style={{ fontSize: 10, color: 'var(--text-tertiary)', whiteSpace: 'nowrap', paddingRight: 6 }}>{loaded ? `${page.first}–${page.last} / ${page.total}` : '…'}</span>
        {!collapsed && page.pageCount > 1 && <>
          <button type="button" style={pageButton} disabled={page.page === 0} aria-label={`${t('message.find.previous')}: ${label}`} onClick={() => setPage(page.page - 1)}>‹</button>
          <button type="button" style={pageButton} disabled={page.page === page.pageCount - 1} aria-label={`${t('message.find.next')}: ${label}`} onClick={() => setPage(page.page + 1)}>›</button>
        </>}
      </div>
      {!collapsed && <div>
        {page.rows.map(thread => <GtdTriageRow key={thread.id ?? thread.message_id} thread={thread} sectionKey={section.key} variant="sidebar" compact
          onOpen={() => onOpenRow(thread)} rowActions={rowActions} selected={isSelectedRow(thread, selectedMessageId, selectedMid, selectedAcct)} t={t} />)}
        {page.rows.length === 0 && <div role="status" style={{ padding: '10px 20px', fontSize: 11, color: 'var(--text-tertiary)' }}>{t(loaded ? 'gtd.tabEmpty' : 'common.loading')}</div>}
        {page.bounded && <div style={{ padding: '5px 12px', fontSize: 10, color: 'var(--text-tertiary)' }}>{t('gtd.gmail.bounded', { available: page.available, total: page.total })}</div>}
      </div>}
    </section>
  );
}
