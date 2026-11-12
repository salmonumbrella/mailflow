import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { htmlLang } from '../utils/browserLanguage.js';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { resolveConversationSelection, selectListedMessage } from '../utils/conversation.js';
import { scheduleMarkRead, cancelScheduledMarkRead } from '../utils/markRead.js';
import { getEffectiveShortcuts, modLabel, SPECIAL_KEY_LABELS } from '../utils/defaultShortcuts.js';

function Icon({ name }) {
  const paths = {
    inbox: <><path d="M4 4h16l2 10v6H2v-6L4 4Z" /><path d="M2 14h6l2 3h4l2-3h6" /></>,
    folders: <path d="M3 6h7l2 3h9v11H3V6Z" />,
    compose: <><path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z" /><path d="M13 20h8" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    accounts: <><circle cx="12" cy="8" r="4" /><path d="M4 22v-3a8 8 0 0 1 16 0v3" /></>,
    settings: <><path d="m9 3 1-2h4l1 2 3 2 2 1 2 4-1 2-1 3v3l-3 3-3-1h-4l-3 1-3-3v-3l-1-3-1-2 2-4 2-1 3-2Z" /><circle cx="12" cy="12" r="3" /></>,
    commands: <path d="m13 2-9 12h7l-1 8 10-12h-8l1-8Z" />,
    close: <path d="m9 6 6 6-6 6" />,
  };
  return <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

export function SuperhumanRail({ foldersOpen, onToggleFolders, onSearch, onCommands, onHelp }) {
  const { t } = useTranslation();
  const { selectedAccountId, selectedFolder, showContacts, setSelectedAccount, openCompose, setAdminTab, setShowAdmin } = useStore();
  const settings = (tab) => { setAdminTab(tab); setShowAdmin(true); };
  const button = (name, label, onClick, props = {}) => <button type="button" className="superhuman-rail-button" aria-label={label} title={label} onClick={onClick} {...props}><Icon name={name} /></button>;
  return <nav className="superhuman-rail" aria-label={t('superhuman.navigation', 'Mail navigation')}>
    {button('commands', t('superhuman.commands', 'Commands'), onCommands, { className: 'superhuman-rail-button superhuman-brand' })}
    <div className="superhuman-rail-main">
      {button('inbox', t('sidebar.allInboxes', 'All inboxes'), () => setSelectedAccount(null, 'INBOX'), { 'aria-current': !selectedAccountId && selectedFolder === 'INBOX' && !showContacts ? 'page' : undefined })}
      {button('folders', t('superhuman.folders', 'Folders and accounts'), onToggleFolders, { 'aria-expanded': foldersOpen, 'aria-controls': 'superhuman-folders' })}
      {button('compose', t('sidebar.compose', 'Compose'), () => openCompose({}))}
      {button('search', t('superhuman.search', 'Search mail'), onSearch)}
    </div>
    <div className="superhuman-rail-bottom">
      {button('accounts', t('superhuman.accounts', 'Manage accounts'), () => settings('accounts'))}
      <button type="button" className="superhuman-rail-button" aria-label={t('superhuman.shortcuts', 'Keyboard shortcuts')} title={t('superhuman.shortcuts', 'Keyboard shortcuts')} onClick={onHelp}>?</button>
      {button('settings', t('superhuman.settings', 'Settings'), () => settings('appearance'))}
    </div>
  </nav>;
}

export function SuperhumanFolderDrawer({ children, onClose }) {
  const { t } = useTranslation();
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.querySelector('button')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  const onKeyDown = event => {
    if (event.defaultPrevented || event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && ['ArrowDown', 'ArrowUp', 'ArrowRight'].includes(event.key) && !event.target.isContentEditable && !event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) {
      const rows = [...ref.current.querySelectorAll('[data-mailbox-row]')].filter(row => row.dataset.mailboxAvailable !== 'false');
      const index = rows.findIndex(row => row === document.activeElement || row.contains(document.activeElement));
      if (event.key === 'ArrowRight') {
        if (index >= 0) { event.preventDefault(); event.stopPropagation(); rows[index].click(); onClose(); }
      } else if (rows.length) {
        event.preventDefault(); event.stopPropagation();
        const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : rows.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
        rows[next].setAttribute('tabindex', '0'); rows[next].focus(); rows[next].scrollIntoView({ block: 'nearest' });
      }
      return;
    }
    // Expanded account rows contain their own buttons, so they cannot have a button role.
    // Arrow navigation may focus the row itself; activate only that container, never its controls.
    if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && ['Enter', ' '].includes(event.key)
      && event.target.matches('[data-mailbox-row]:not([data-mailbox-available="false"])')
      && !event.target.matches('button, a[href], input, textarea, select, [contenteditable], [role="button"], [role="link"]')) {
      event.preventDefault(); event.stopPropagation(); event.target.click(); onClose(); return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...ref.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')]
      .filter(node => node.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  return <>
    <button type="button" tabIndex={-1} className="superhuman-folder-backdrop" aria-label={t('superhuman.closeFolders', 'Close folders')} onClick={onClose} />
    <div id="superhuman-folders" className="superhuman-folder-drawer" role="dialog" aria-modal="true" aria-label={t('superhuman.folders', 'Folders and accounts')} ref={ref} onKeyDown={onKeyDown}>{children}</div>
  </>;
}

const MAX_RECENT = 12;

function isDraft(message, state) {
  const account = state.accounts.find(a => a.id === message.account_id);
  return Boolean(message.is_draft || (account?.folder_mappings?.drafts && account.folder_mappings.drafts === message.folder)
    || state.folders[message.account_id]?.some(folder => folder.path === message.folder && folder.special_use === '\\Drafts'));
}

export function SuperhumanRecent({ onCollapse, toggleHint }) {
  const { t, i18n } = useTranslation();
  const { selectedMessageId, messages, searchResults, threadMessages, accounts, user } = useStore();
  const [recent, setRecent] = useState([]);
  const [opening, setOpening] = useState(null);
  const recorded = useRef(null);
  const request = useRef(0);
  const timer = useRef(null);
  const timerMessageId = useRef(null);
  const userId = user?.id;

  useEffect(() => {
    // No persistence: message subjects disappear on lock, logout and workspace exit.
    setRecent([]);
    setOpening(null);
    recorded.current = null;
    return () => { request.current += 1; cancelScheduledMarkRead(timer.current); };
  }, [userId]);

  useEffect(() => {
    if (recorded.current === selectedMessageId) return;
    if (timerMessageId.current !== selectedMessageId) cancelScheduledMarkRead(timer.current);
    if (!selectedMessageId) { recorded.current = null; return; }
    const { selectedMessage } = resolveConversationSelection({ selectedMessageId, pool: [...messages, ...searchResults], threadMessages });
    if (!selectedMessage || isDraft(selectedMessage, useStore.getState())) return;
    recorded.current = selectedMessageId;
    const { id, account_id, from_name, from_email, subject } = selectedMessage;
    setRecent(previous => [{ id, account_id, from_name, from_email, subject, openedAt: Date.now() }, ...previous.filter(m => m.id !== id)].slice(0, MAX_RECENT));
  }, [selectedMessageId, messages, searchResults, threadMessages, userId]);

  const open = async (entry) => {
    const token = ++request.current;
    const before = useStore.getState();
    const stillCurrent = () => {
      const now = useStore.getState();
      return request.current === token && now.user?.id === before.user?.id
        && now.messagesRefreshToken === before.messagesRefreshToken && now.selectedMessageId === before.selectedMessageId
        && now.searchQuery === before.searchQuery && now.showContacts === before.showContacts;
    };
    setOpening(entry.id);
    try {
      const row = (before.searchQuery.trim() ? before.searchResults : before.messages).find(m => m.id === entry.id);
      // Re-resolve messages outside the visible list: a move may have replaced its cached ID.
      const message = row || await api.resolveMessage(entry.id);
      if (!stillCurrent()) return;
      if (message.account_id !== entry.account_id || !useStore.getState().accounts.some(a => a.id === message.account_id && a.enabled !== false)) throw new Error('Account unavailable');
      if (isDraft(message, useStore.getState())) throw new Error('Open drafts from the Drafts folder');
      if (row) selectListedMessage(useStore, message.id);
      else {
        const state = useStore.getState();
        state.setSearchQuery('');
        state.setSelectedAccount(message.account_id, message.folder || 'INBOX');
        useStore.getState().setThreadMessages(`__dl_${message.id}`, [message]);
        useStore.getState().setSelectedMessage(message.id);
      }
      cancelScheduledMarkRead(timer.current);
      timerMessageId.current = message.id;
      timer.current = scheduleMarkRead(message);
    } catch {
      if (!stillCurrent()) return;
      useStore.getState().addNotification({ type: 'error', title: t('superhuman.recentUnavailable', 'This message is no longer available. Open its folder to find it.') });
    } finally {
      if (request.current === token) setOpening(null);
    }
  };

  const visible = recent.filter(m => accounts.some(a => a.id === m.account_id && a.enabled !== false));
  return <aside className="superhuman-recent" aria-label={t('superhuman.recentlyViewed', 'Recently viewed')}>
    <header className="superhuman-recent-header">
      <h2>{t('superhuman.recentlyViewed', 'Recently viewed')}</h2>
      <button type="button" className="superhuman-rail-button" onClick={onCollapse} aria-label={t('rightSidebar.hide', 'Hide sidebar')} title={toggleHint || t('rightSidebar.hide', 'Hide sidebar')}><Icon name="close" /></button>
    </header>
    <p className="superhuman-session-label">{t('superhuman.thisSession', 'This session')}</p>
    {visible.length ? <div className="superhuman-recent-list">{visible.map(message => <button type="button" className="superhuman-recent-message" key={message.id} disabled={opening === message.id} onClick={() => open(message)}>
      <span className="superhuman-recent-sender">{message.from_name || message.from_email || t('common.unknown', 'Unknown')}<time dateTime={new Date(message.openedAt).toISOString()}>{new Date(message.openedAt).toLocaleTimeString(htmlLang(i18n.language), { hour: 'numeric', minute: '2-digit' })}</time></span>
      <span className="superhuman-recent-subject">{message.subject || t('common.noSubject', '(No subject)')}</span>
    </button>)}</div> : <p className="superhuman-recent-empty">{t('superhuman.recentEmpty', 'Messages you open will appear here. Your history stays in this session.')}</p>}
  </aside>;
}

function keyLabel(key) {
  return key.split('+').map(part => SPECIAL_KEY_LABELS[part] || (part === 'ctrl' ? modLabel(part) : part)).join(' + ');
}

export function SuperhumanFooter({ onCommands, onHelp }) {
  const { t } = useTranslation();
  const shortcuts = useStore(s => s.shortcuts);
  const selectedMessageId = useStore(s => s.selectedMessageId);
  const keys = getEffectiveShortcuts(shortcuts, 'superhuman');
  const hints = selectedMessageId
    ? [['replyAll', 'Reply all'], ['archive', 'Archive'], ['snooze', 'Snooze']]
    : [['nextMessage', 'Next'], ['prevMessage', 'Previous'], ['openMessage', 'Open'], ['compose', 'Compose']];
  return <footer className="superhuman-footer" aria-label={t('superhuman.keyboardHints', 'Keyboard hints')}>
    <div className="superhuman-key-hints">{hints.filter(([action]) => keys[action]).map(([action, fallback]) => <span key={action}><kbd>{keyLabel(keys[action])}</kbd>{t(`shortcuts.actions.${action}.label`, fallback)}</span>)}</div>
    <div className="superhuman-footer-actions"><button type="button" onClick={onCommands}>{t('superhuman.commands', 'Commands')}</button><button type="button" onClick={onHelp}>{t('superhuman.shortcuts', 'Keyboard shortcuts')}{keys.showHelp && <kbd>{keyLabel(keys.showHelp)}</kbd>}</button></div>
  </footer>;
}
