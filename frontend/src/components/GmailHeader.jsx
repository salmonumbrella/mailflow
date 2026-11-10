import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import LogoMark from './LogoMark.jsx';
import GmailSupport from './GmailSupport.jsx';
import '../gmail-header-surfaces.css';

const ProfileModal = lazy(() => import('./ProfileModal.jsx'));
const GmailSettings = lazy(() => import('./GmailSettings.jsx'));
const statuses = ['Active', 'Do not disturb', 'Away'];

function HeaderIcon({ name }) {
  const paths = {
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    support: <><circle cx="12" cy="12" r="9" /><path d="M9.6 9a2.5 2.5 0 0 1 4.8 1c0 1.5-2.4 1.8-2.4 3.5M12 16.5h.01" /></>,
    settings: <><path d="m9 3-.5 2-2 .9-1.9-.6-2 3.4 1.5 1.5v2.4L2.6 14l2 3.4 1.9-.6 2 .9L9 20h4l.5-2.3 2-.9 1.9.6 2-3.4-1.5-1.4v-2.4l1.5-1.5-2-3.4-1.9.6-2-.9L13 3Z" /><circle cx="11" cy="11.5" r="3" /></>,
    contacts: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5" /></>,
    apps: <>{[5, 12, 19].flatMap(x => [5, 12, 19].map(y => <circle key={`${x}-${y}`} cx={x} cy={y} r="1" />))}</>,
  };
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">{paths[name]}</svg>;
}

function HeaderContacts({ onBack, onOpenContacts, onSearch }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    const timer = setTimeout(async () => {
      try {
        const result = await api.getContacts({ q: query, limit: 12, offset: 0 });
        if (!cancelled) setContacts(result.contacts || []);
      } catch (err) { if (!cancelled) setError(err.message || 'Unable to load contacts.'); }
      finally { if (!cancelled) setLoading(false); }
    }, query ? 180 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, attempt]);
  return <>
    <div className="mailflow-gmail-popover-heading"><button aria-label={t('gmail.header.back_to_apps', "Back to apps")} onClick={onBack}>←</button><h2>{t('gmail.header.contacts', "Contacts")}</h2></div>
    <label className="mailflow-gmail-contact-search">{t('gmail.header.search_contacts', "Search contacts")}<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <div className="mailflow-gmail-header-contact-list" aria-busy={loading}>
      {loading ? <p role="status">{t('gmail.header.loading_contacts', "Loading contacts…")}</p> : error ? <><p role="alert">{error}</p><button onClick={() => setAttempt(value => value + 1)}>{t('gmail.header.retry', "Retry")}</button></> : contacts.length ? contacts.map(contact => <button key={contact.id} disabled={!contact.primary_email} onClick={() => onSearch(`from:"${contact.primary_email.replaceAll('"', '').replaceAll('\\', '')}"`)}><span className="mailflow-gmail-contact-initial" aria-hidden="true">{(contact.display_name || contact.primary_email || '?').charAt(0).toUpperCase()}</span><span><strong>{contact.display_name || contact.primary_email || t('gmail.header.contact', 'Contact')}</strong><small>{contact.primary_email || t('gmail.header.no_email', 'No email address')}</small></span></button>) : <p>{t('gmail.header.no_contacts_found', "No contacts found.")}</p>}
    </div>
    <button className="mailflow-gmail-header-action" onClick={onOpenContacts}>{t('gmail.header.open_all_contacts', "Open all contacts")}</button>
  </>;
}

// MailFlow search remains mounted in this portal host while switching views.
export default function GmailHeader({ searchTargetRef, onShowShortcutHelp }) {
  const { t } = useTranslation();
  const {
    user, accounts = [], sidebarWidth, sidebarCollapsed, toggleSidebar,
    setSelectedAccount, selectedAccountId, setSearchQuery, setSearchAllFolders, setShowContacts, showContacts,
  } = useStore();
  const [showProfile, setShowProfile] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [supportTopic, setSupportTopic] = useState(null);
  const [popover, setPopover] = useState(null);
  const [status, setStatus] = useState('Active');
  const controls = useRef(null);
  const panel = useRef(null);
  const opener = useRef(null);
  const statusLabel = value => t(`gmail.header.status.${value.replaceAll(' ', '_').toLowerCase()}`, value);
  const enabledAccounts = accounts.filter(account => account.enabled);
  const name = user?.displayName || user?.username || t('sidebar.account', 'Account');
  const close = useCallback((restore = true) => {
    setPopover(null);
    if (restore && opener.current?.isConnected) opener.current.focus();
  }, []);
  const toggle = (next, event) => {
    if (popover === next || (next === 'apps' && popover === 'contacts')) { close(); return; }
    opener.current = event.currentTarget;
    setPopover(next);
  };
  useEffect(() => {
    if (!popover) return;
    panel.current?.querySelector('button:not(:disabled)')?.focus();
    const dismiss = event => { if (!controls.current?.contains(event.target)) close(); };
    const escape = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape, true); };
  }, [popover, close]);

  const home = () => { close(false); setShowContacts(false); setSearchQuery(''); setSelectedAccount(selectedAccountId, 'INBOX'); };
  const search = query => { close(); setShowContacts(false); setSelectedAccount(selectedAccountId, 'INBOX'); setSearchAllFolders(true); setSearchQuery(query); };
  const openContacts = () => { close(); setShowContacts(true); };
  const support = topic => { close(); setSupportTopic(topic); };
  const menuKeys = event => {
    event.stopPropagation();
    if (event.key === 'Tab' && ['support', 'status'].includes(popover)) { close(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
    const items = [...event.currentTarget.querySelectorAll('button:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    event.preventDefault(); items[next]?.focus();
  };
  const menuProps = type => ({ 'aria-haspopup': ['status', 'support'].includes(type) ? 'menu' : 'dialog', 'aria-expanded': popover === type || (type === 'apps' && popover === 'contacts'), 'aria-controls': popover === type || (type === 'apps' && popover === 'contacts') ? 'mailflow-gmail-header-popover' : undefined, onClick: event => toggle(type, event), onKeyDown: event => { if (event.key === 'ArrowDown') { event.preventDefault(); opener.current = event.currentTarget; setPopover(type); } } });

  return <header className="mailflow-gmail-header">
    <div className="mailflow-gmail-header-brand" style={{ flexBasis: Math.max(200, (sidebarWidth || 200) + 12) }}>
      <button type="button" className="mailflow-gmail-icon-button" onClick={toggleSidebar} aria-label={t('sidebar.toggleSidebar')} title={t('sidebar.toggleSidebar')} aria-expanded={!sidebarCollapsed}><HeaderIcon name="menu" /></button>
      <button type="button" className="mailflow-gmail-home" onClick={home} aria-label={t('commandPalette.actions.inbox')}><LogoMark size={30} /><span>MailFlow</span></button>
    </div>
    <div id="mailflow-gmail-search" className="mailflow-gmail-search-host" ref={searchTargetRef} />
    <div className="mailflow-gmail-header-controls" ref={controls} onBlur={event => { if (popover && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) close(false); }}>
      <button type="button" className="mailflow-gmail-status-button" aria-label={t('gmail.header.status_label', { defaultValue: 'Status: {{status}}', status: statusLabel(status) })} {...menuProps('status')}><span className="mailflow-gmail-status-dot" data-status={status} /><span>{statusLabel(status)}</span><span aria-hidden="true">⌄</span></button>
      <button type="button" className="mailflow-gmail-icon-button" aria-label={t('gmail.header.support', "Support")} title={t('gmail.header.support', "Support")} {...menuProps('support')}><HeaderIcon name="support" /></button>
      <button type="button" className="mailflow-gmail-icon-button" onClick={event => { close(false); event.currentTarget.focus(); setShowSettings(true); }} aria-label={t('sidebar.settings', 'Settings')} title={t('sidebar.settings', 'Settings')}><HeaderIcon name="settings" /></button>
      <button type="button" className="mailflow-gmail-icon-button mailflow-gmail-direct-contacts" onClick={() => { close(false); setShowContacts(!showContacts); }} aria-label={t('contacts.title')} title={t('contacts.title')} aria-pressed={showContacts}><HeaderIcon name="contacts" /></button>
      <button type="button" className="mailflow-gmail-icon-button" aria-label={t('gmail.header.apps', "Apps")} title={t('gmail.header.apps', "Apps")} {...menuProps('apps')}><HeaderIcon name="apps" /></button>
      <button type="button" className="mailflow-gmail-account" aria-label={t('gmail.header.account_label', { defaultValue: 'Account: {{name}}', name })} title={t('gmail.header.account_label', { defaultValue: 'Account: {{name}}', name })} {...menuProps('account')}>{user?.avatar ? <img src={user.avatar} alt="" /> : <span>{name.charAt(0).toUpperCase()}</span>}</button>
      {popover && <div ref={panel} id="mailflow-gmail-header-popover" className={`mailflow-gmail-header-popover is-${popover}`} role={['status', 'support'].includes(popover) ? 'menu' : 'dialog'} aria-label={t(`gmail.header.panel.${popover}`, popover === 'status' ? 'Set status' : popover === 'contacts' ? 'Contacts' : popover === 'account' ? 'Your account' : popover === 'apps' ? 'Apps' : 'Support')} onKeyDown={menuKeys}>
        {popover === 'status' && <>{statuses.map(value => <button key={value} role="menuitemradio" aria-checked={status === value} onClick={() => { setStatus(value); close(); }}><span className="mailflow-gmail-status-dot" data-status={value} />{statusLabel(value)}{status === value && <span aria-hidden="true">✓</span>}</button>)}<p className="mailflow-gmail-header-note">{t('gmail.header.local_status_only_it_is_not_shared_and', "Local status only. It is not shared and does not change notifications.")}</p></>}
        {popover === 'support' && <><button role="menuitem" onClick={() => support('help')}>{t('gmail.header.help', "Help")}</button><button role="menuitem" onClick={() => support('training')}>{t('gmail.header.training', "Training")}</button><button role="menuitem" onClick={() => { close(); onShowShortcutHelp?.(); }}>{t('gmail.header.keyboard_shortcuts', "Keyboard shortcuts")}</button><hr /><button role="menuitem" onClick={() => support('feedback')}>{t('gmail.header.send_feedback', "Send feedback")}</button></>}
        {popover === 'apps' && <><div className="mailflow-gmail-app-grid"><button onClick={home}><span aria-hidden="true">✉</span>{t('gmail.header.mail', "Mail")}</button><button onClick={() => setPopover('contacts')}><HeaderIcon name="contacts" />{t('gmail.header.contacts', "Contacts")}</button><button onClick={() => search('has:attachment')}><span aria-hidden="true">▤</span>{t('gmail.header.attachments', "Attachments")}</button></div><p className="mailflow-gmail-header-note">{t('gmail.header.available_in_mailflow_google_apps_and_services_are', "Available in MailFlow. Google apps and services are not connected by this menu.")}</p></>}
        {popover === 'contacts' && <HeaderContacts onBack={() => setPopover('apps')} onOpenContacts={openContacts} onSearch={search} />}
        {popover === 'account' && <><div className="mailflow-gmail-popover-heading"><h2>{t('gmail.header.your_account', "Your account")}</h2><button aria-label={t('gmail.header.close_account_menu', "Close account menu")} onClick={() => close()}>×</button></div><strong className="mailflow-gmail-account-name">{name}</strong>{user?.username && <p>{user.username}</p>}<p className="mailflow-gmail-header-note">{t('gmail.header.your_mailflow_profile_is_separate_from_your_mail', "Your MailFlow profile is separate from your mail provider accounts. This menu does not sign you in to Google.")}</p><button className="mailflow-gmail-header-action" onClick={() => { close(); setShowProfile(true); }}>{t('profile.editProfile', 'Edit profile')}</button><h3>{t('gmail.header.connected_mail_accounts', "Connected mail accounts")}</h3><div className="mailflow-gmail-connected-accounts">{enabledAccounts.map(account => <button key={account.id} aria-pressed={selectedAccountId === account.id} onClick={() => { close(); setShowContacts(false); setSearchQuery(''); setSelectedAccount(account.id, 'INBOX'); }}><span><strong>{account.name || account.email_address}</strong><small>{account.email_address}</small></span>{selectedAccountId === account.id && <span aria-hidden="true">✓</span>}</button>)}</div>{!enabledAccounts.length && <p>{t('gmail.header.no_enabled_mail_accounts', "No enabled mail accounts.")}</p>}</>}
      </div>}
    </div>
    {supportTopic && <GmailSupport topic={supportTopic} storageKey={`mailflow.feedback.${user?.id || user?.username || 'session'}`} onClose={() => setSupportTopic(null)} />}
    {showSettings && <Suspense fallback={<p role="status">{t('gmail.header.loading_settings', "Loading settings…")}</p>}><GmailSettings onClose={() => setShowSettings(false)} /></Suspense>}
    {showProfile && <Suspense fallback={null}><ProfileModal onClose={() => { setShowProfile(false); opener.current?.focus(); }} /></Suspense>}
  </header>;
}
