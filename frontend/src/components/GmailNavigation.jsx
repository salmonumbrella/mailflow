import NativeLabelNavigation from './NativeLabelNavigation.jsx';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { folderRole } from '../utils/folderDisplay.js';
import { totalBadge, unreadBadge } from '../utils/unreadBadge.js';
import { SNOOZED_FOLDER } from '../utils/snoozeActions.js';
import { SCHEDULED_VIEW } from '../utils/scheduledCompose.js';

const PATHS = {
  inbox: 'M3 4h18v16H3z M3 13h5l2 3h4l2-3h5',
  starred: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z',
  snoozed: 'M12 8v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  sent: 'm3 3 19 9-19 9 4-9Z M7 12h15',
  drafts: 'M5 3h9l5 5v13H5Z M14 3v6h5',
  more: 'm7 10 5 5 5-5', less: 'm7 14 5-5 5 5',
  important: 'M4 6h11l6 6-6 6H4l5-6Z',
  scheduled: 'M3 5h12v4 M3 5l8 7 M3 5v14h7 M21 16a6 6 0 1 1-12 0 6 6 0 0 1 12 0 M15 13v3h3',
  all: 'M3 5h18v15H3Z M3 6l9 7 9-7',
  spam: 'm8 3-5 5v8l5 5h8l5-5V8l-5-5Z M12 7v6 M12 16v1',
  trash: 'M3 6h18 M8 6V3h8v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
  categories: 'M3 3h7v7H3Z M14 3h7v7h-7Z M3 14h7v7H3Z M14 14h7v7h-7Z',
  folder: 'M3 5h7l2 3h9v12H3Z',
};

function Icon({ name }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true"><path d={PATHS[name] || PATHS.folder} /></svg>;
}

function resolveRole(folders, mappings, role) {
  return folders.find(folder => !folder.no_select && mappings?.[role] === folder.path)
    || folders.find(folder => !folder.no_select && folderRole(folder, mappings) === role);
}

export default function GmailNavigation({ collapsed, onManageFolders }) {
  const { t } = useTranslation();
  const state = useStore();
  const { accounts, folders, selectedAccountId, selectedFolder, searchQuery, showContacts,
    unreadCounts, snoozedCount, scheduledCount, scheduledAttention, hiddenFolders,
    setSelectedAccount, setSearchQuery, setSearchAllFolders } = state;
  const [more, setMore] = useState(false);
  const [categories, setCategories] = useState(false);
  const enabled = accounts.filter(account => account.enabled);
  const account = enabled.find(item => item.id === selectedAccountId);
  const accountFolders = folders[selectedAccountId] || [];
  const scope = account?.email_address || t('gmail.navigation.unifiedAccounts', 'Unified inbox accounts');
  const translate = (key, label) => t(key, label);
  const navigate = (folder, query = '', accountId = selectedAccountId) => {
    // Native navigation intentionally preserves global searches. A mailbox shortcut must not.
    setSearchQuery('');
    setSelectedAccount(accountId, folder);
    if (query) { setSearchAllFolders(true); setSearchQuery(query); }
  };
  const folderEntry = (id, role, label, fallback) => {
    const folder = resolveRole(accountFolders, account?.folder_mappings, role);
    const counts = { known: folder?.counts_known !== false, stale: folder?.counts_stale };
    return {
      id, label, folder: folder?.path, query: folder ? '' : fallback,
      available: selectedAccountId === null || !!folder,
      badge: role === 'drafts'
        ? totalBadge({ count: folder?.total_count, ...counts })
        : unreadBadge({ count: folder?.unread_count, ...counts, observedAt: folder?.server_counts_at }),
    };
  };
  const inbox = resolveRole(accountFolders, account?.folder_mappings, 'inbox');
  const entries = [
    { ...folderEntry('inbox', 'inbox', translate('folders.inbox', 'Inbox')), folder: 'INBOX', available: true,
      badge: selectedAccountId === null ? unreadBadge({ count: unreadCounts.total, stale: !unreadCounts.complete })
        : unreadBadge({ count: inbox?.unread_count,
          known: inbox?.counts_known !== false,
          stale: inbox?.counts_stale, observedAt: inbox?.server_counts_at }) },
    { id: 'starred', label: translate('gmail.navigation.starred', 'Starred'), query: 'is:starred', available: true },
    { id: 'snoozed', label: translate('sidebar.snoozed', 'Snoozed'), folder: SNOOZED_FOLDER, unified: true,
      badge: totalBadge({ count: snoozedCount }), available: true },
    folderEntry('sent', 'sent', translate('folders.sent', 'Sent'), 'in:sent'),
    folderEntry('drafts', 'drafts', translate('folders.drafts', 'Drafts'), 'in:drafts'),
  ];
  const important = accountFolders.find(folder => !folder.no_select && String(folder.special_use).toLowerCase() === '\\important');
  const all = accountFolders.find(folder => !folder.no_select && String(folder.special_use).toLowerCase() === '\\all');
  const extras = [
    ...(important ? [{ id: 'important', label: translate('gmail.navigation.important', 'Important'), folder: important.path, available: true }] : []),
    { id: 'scheduled', label: translate('sidebar.scheduled', 'Scheduled'), folder: SCHEDULED_VIEW, unified: true,
      badge: totalBadge({ count: scheduledCount }), alert: scheduledAttention > 0, available: true },
    { id: 'all', label: translate('gmail.navigation.allMail', 'All mail'), folder: all?.path, query: all ? '' : 'in:all', available: true },
    folderEntry('spam', 'spam', translate('folders.spam', 'Spam'), 'in:spam'),
    folderEntry('trash', 'trash', translate('folders.trash', 'Trash'), 'in:trash'),
  ];
  const active = entry => !state.activeLabel && !showContacts && (entry.query ? searchQuery === entry.query : !searchQuery && selectedFolder === entry.folder)
    && (!entry.unified || selectedAccountId === null);
  const hidden = entry => selectedAccountId !== null && !entry.unified && entry.folder
    && (hiddenFolders?.[selectedAccountId] || []).includes(entry.folder);
  const visibleEntries = entries.filter(entry => !hidden(entry) || active(entry));
  const hiddenEntries = entries.filter(entry => hidden(entry) && !active(entry));
  // Keep the current mailbox identifiable even when its persisted visibility is hidden.
  const activeHiddenExtras = extras.filter(entry => hidden(entry) && active(entry));
  const moreEntries = [...hiddenEntries, ...extras.filter(entry => !activeHiddenExtras.includes(entry))];
  const row = entry => {
    const selected = active(entry);
    const rowScope = entry.unified ? translate('gmail.navigation.allAccounts', 'All accounts')
      : entry.id === 'inbox' && selectedAccountId === null ? translate('sidebar.allInboxes', 'All inboxes') : scope;
    const title = `${entry.label} · ${rowScope}${!entry.available ? ` · ${translate('gmail.navigation.unavailable', 'Folder unavailable')}` : ''}${entry.badge ? ` · ${entry.badge.text} ${entry.badge.total ? translate('gmail.navigation.messages', 'messages') : translate('gmail.navigation.unread', 'unread')}` : ''}${entry.alert ? ` · ${translate('gmail.navigation.needsAttention', 'Needs attention')}` : ''}`;
    return <button key={entry.id} type="button" data-gmail-nav={entry.id} data-mailbox-row={entry.available ? '' : undefined}
      data-active={selected ? 'true' : undefined} aria-current={selected ? 'page' : undefined}
      className={`gmail-native-nav-row${selected ? ' gmail-native-nav-active' : ''}`} disabled={!entry.available}
      title={title} aria-label={title}
      onClick={() => navigate(entry.folder || 'INBOX', entry.query, entry.unified ? null : selectedAccountId)}>
      <Icon name={entry.id} />{!collapsed && <><span>{entry.label}</span>{entry.badge && <span className="gmail-native-nav-count" title={entry.badge.title}>{entry.badge.text}</span>}{entry.alert && <span aria-hidden="true">!</span>}</>}
    </button>;
  };
  return <section className="gmail-native-navigation" data-collapsed={collapsed ? 'true' : 'false'} aria-label={translate('gmail.navigation.mailboxes', 'Mailboxes')}>
    <style>{`
      .gmail-native-navigation { padding: 0 0 12px; }
      .gmail-native-navigation .gmail-native-nav-row { display: flex; align-items: center; gap: 18px; width: 100%; height: 32px; padding: 0 16px; border: 0; border-radius: 0 20px 20px 0; background: transparent; color: var(--text-primary); font: inherit; font-size: 14px; text-align: left; cursor: pointer; }
      .gmail-native-navigation .gmail-native-nav-row svg { flex-shrink: 0; }
      .gmail-native-navigation .gmail-native-nav-row:hover { background: var(--bg-hover); }
      .gmail-native-navigation .gmail-native-nav-active { background: var(--accent-dim); font-weight: 600; }
      .gmail-native-navigation .gmail-native-nav-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
      .gmail-native-navigation .gmail-native-nav-row:disabled { opacity: .45; cursor: default; }
      .gmail-native-navigation .gmail-native-nav-count { margin-left: auto; font-size: 12px; }
      .gmail-native-navigation[data-collapsed="true"] .gmail-native-nav-row { padding: 0; justify-content: center; border-radius: 16px; }
      .gmail-native-navigation .gmail-native-scope { width: calc(100% - 16px); margin: 0 8px 8px; padding: 5px; background: var(--bg-secondary); color: var(--text-secondary); border: 1px solid var(--border-subtle); border-radius: 6px; font-size: 12px; }
      .gmail-native-categories { padding-left: 12px; }
      .gmail-native-folders-heading { margin: 12px 16px 4px; font-size: 14px; font-weight: 500; }
    `}</style>
    {!collapsed && <select className="gmail-native-scope" aria-label={translate('gmail.navigation.accountScope', 'Mailbox account')} value={selectedAccountId || ''}
      onChange={event => navigate('INBOX', '', event.target.value || null)}>
      <option value="">{translate('gmail.navigation.unifiedAccounts', 'Unified inbox accounts')}</option>
      {enabled.map(item => <option key={item.id} value={item.id}>{item.email_address}</option>)}
    </select>}
    {visibleEntries.map(row)}
    <button type="button" className="gmail-native-nav-row" data-gmail-nav="categories" aria-expanded={categories}
      title={translate('gmail.navigation.categories', 'MailFlow categories')} aria-label={translate('gmail.navigation.categories', 'MailFlow categories')}
      onClick={() => setCategories(value => !value)}><Icon name="categories" />{!collapsed && <span>{translate('gmail.navigation.categories', 'MailFlow categories')}</span>}</button>
    {categories && <div className="gmail-native-categories">{['primary', 'newsletter', 'promotion', 'automated', 'social'].map(category => row({ id: category, label: translate(`categories.${category}`, category[0].toUpperCase() + category.slice(1)), query: `category:${category}`, available: true }))}</div>}
    {activeHiddenExtras.map(row)}
    <button type="button" className="gmail-native-nav-row" data-gmail-nav="more" aria-expanded={more}
      title={more ? translate('gmail.navigation.less', 'Less') : translate('gmail.navigation.more', 'More')} aria-label={more ? translate('gmail.navigation.less', 'Less') : translate('gmail.navigation.more', 'More')} onClick={() => setMore(value => !value)}>
      <Icon name={more ? 'less' : 'more'} />{!collapsed && <span>{more ? translate('gmail.navigation.less', 'Less') : translate('gmail.navigation.more', 'More')}</span>}
    </button>
    {more && moreEntries.map(row)}
    {more && <button type="button" className="gmail-native-nav-row" data-gmail-nav="manage" title={translate('gmail.navigation.manageFolders', 'Manage folders')} aria-label={translate('gmail.navigation.manageFolders', 'Manage folders')} onClick={onManageFolders}><Icon name="folder" />{!collapsed && <span>{translate('gmail.navigation.manageFolders', 'Manage folders')}</span>}</button>}
    <NativeLabelNavigation accountId={selectedAccountId} collapsed={collapsed} more={more} />
    {!collapsed && <div className="gmail-native-folders-heading">{translate('gmail.navigation.folders', 'Folders')}</div>}
  </section>;
}
