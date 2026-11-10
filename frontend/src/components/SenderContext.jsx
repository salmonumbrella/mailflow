import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { resolveConversationSelection, selectListedMessage } from '../utils/conversation.js';
import { rowOwnMessage } from '../utils/composeFromMessage.js';
import { scheduleMarkRead, cancelScheduledMarkRead } from '../utils/markRead.js';

const emailKey = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const safeEmail = value => /^[^\s<>"\\]+@[^\s<>"\\]+$/.test(value) && value.length <= 320;
function emailsOf(contact) {
  let emails = contact.emails;
  if (typeof emails === 'string') { try { emails = JSON.parse(emails); } catch { emails = []; } }
  return [contact.primary_email, ...(Array.isArray(emails) ? emails.map(item => item?.value) : [])].map(emailKey);
}
export function exactSenderConversations(messages, email, accountId) {
  const seen = new Set();
  return (Array.isArray(messages) ? messages : []).map(rowOwnMessage).filter(message => {
    if (message.account_id !== accountId || emailKey(message.from_email) !== emailKey(email) || message.is_draft) return false;
    const key = message.thread_id || message.message_id || message.id;
    if (!message.id || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

export default function SenderContext({ onCollapse, toggleHint }) {
  const state = useStore();
  const readTimer = useRef(null);
  const readMessage = useRef(null);
  useEffect(() => () => cancelScheduledMarkRead(readTimer.current), []);
  useEffect(() => {
    if (state.isLocked || !state.user?.id || readMessage.current?.userId !== state.user.id
      || readMessage.current?.id !== state.selectedMessageId) cancelScheduledMarkRead(readTimer.current);
  }, [state.selectedMessageId, state.user?.id, state.isLocked]);
  const markOpened = message => {
    cancelScheduledMarkRead(readTimer.current);
    readMessage.current = { id: message.id, userId: useStore.getState().user?.id };
    readTimer.current = scheduleMarkRead(message);
  };
  const { selectedMessage } = resolveConversationSelection({ selectedMessageId: state.selectedMessageId, pool: [...state.messages, ...state.searchResults], threadMessages: state.threadMessages });
  const message = rowOwnMessage(selectedMessage);
  const account = state.accounts.find(item => item.id === message?.account_id && item.enabled !== false);
  if (!state.user?.id || state.isLocked || state.showContacts || !message || !account || message.is_draft) return null;
  const scope = [state.user.id, message.id, message.account_id, message.from_email, state.selectedAccountId, state.selectedFolder, state.searchQuery, state.messagesRefreshToken].join('\u0000');
  return <SenderDetails key={scope} message={message} account={account} userId={state.user.id} onOpened={markOpened} onCollapse={onCollapse} toggleHint={toggleHint} />;
}

function SenderDetails({ message, account, userId, onOpened, onCollapse, toggleHint }) {
  const { t } = useTranslation();
  const [contact, setContact] = useState(null);
  const [recent, setRecent] = useState([]);
  const [loading, setLoading] = useState(true);
  const [contactError, setContactError] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [openError, setOpenError] = useState(false);
  const [opening, setOpening] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const alive = useRef(false);
  const request = useRef(0);
  const email = emailKey(message.from_email);
  const canContact = safeEmail(email);
  const current = () => {
    const state = useStore.getState();
    return alive.current && !state.isLocked && state.user?.id === userId && !state.showContacts
      && state.selectedMessageId === message.id && state.accounts.some(item => item.id === account.id && item.enabled !== false);
  };
  useEffect(() => {
    let cancelled = false;
    alive.current = true;
    if (!canContact) { setLoading(false); return () => { alive.current = false; }; }
    setLoading(true);
    setContactError(false);
    setSearchError(false);
    Promise.allSettled([api.getContacts({ q: email, limit: 30 }), api.search(`from:"${email}"`, account.id, { limit: 30 })]).then(([contacts, mail]) => {
      if (cancelled || !current()) return;
      setContact(contacts.status === 'fulfilled' ? contacts.value?.contacts?.find(item => emailsOf(item).includes(email)) || null : null);
      setContactError(contacts.status === 'rejected');
      setRecent(mail.status === 'fulfilled' ? exactSenderConversations(mail.value?.messages, email, account.id) : []);
      setSearchError(mail.status === 'rejected');
      setLoading(false);
    });
    return () => { cancelled = true; alive.current = false; request.current += 1; };
    // A keyed mount captures the selected sender and navigation scope, not a pooled thread sender.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, account.id, refresh]);

  const open = async entry => {
    if (!current()) return;
    const token = ++request.current;
    const before = useStore.getState();
    const stillCurrent = () => current() && token === request.current
      && useStore.getState().selectedAccountId === before.selectedAccountId
      && useStore.getState().selectedFolder === before.selectedFolder
      && useStore.getState().searchQuery === before.searchQuery
      && useStore.getState().messagesRefreshToken === before.messagesRefreshToken;
    setOpening(entry.id);
    setOpenError(false);
    try {
      const resolved = rowOwnMessage(await api.resolveMessage(entry.id));
      if (!stillCurrent()) return;
      const state = useStore.getState();
      const draft = resolved.is_draft || account.folder_mappings?.drafts === resolved.folder
        || state.folders[account.id]?.some(folder => folder.path === resolved.folder && folder.special_use === '\\Drafts');
      if (resolved.account_id !== account.id || emailKey(resolved.from_email) !== email || draft) throw new Error('Message unavailable');
      const pool = state.searchQuery?.trim() ? state.searchResults : state.messages;
      if (pool.some(item => item.id === resolved.id)) selectListedMessage(useStore, resolved.id);
      else {
        state.setSearchQuery('');
        state.setSelectedAccount(account.id, resolved.folder || 'INBOX');
        useStore.getState().setThreadMessages(`__dl_${resolved.id}`, [resolved]);
        useStore.getState().setSelectedMessage(resolved.id);
      }
      onOpened(resolved);
    } catch {
      if (stillCurrent()) setOpenError(true);
    } finally {
      if (stillCurrent()) setOpening(null);
    }
  };
  const label = contact?.display_name || message.from_name || message.from_email || t('common.unknown', 'Unknown');
  return <aside className="superhuman-recent" aria-label={t('senderContext.title', 'Sender context')}>
    <header className="superhuman-recent-header">
      <h2>{t('senderContext.title', 'Sender context')}</h2>
      <button type="button" className="superhuman-rail-button" onClick={onCollapse} title={toggleHint || t('rightSidebar.hide', 'Hide sidebar')} aria-label={t('rightSidebar.hide', 'Hide sidebar')}>›</button>
    </header>
    <div style={{ padding: '20px 18px', borderBottom: '1px solid var(--border-subtle)' }}>
      <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'var(--bg-tertiary)', display: 'grid', placeItems: 'center', fontSize: 20, marginBottom: 12 }} aria-hidden="true">{label.slice(0, 1).toUpperCase()}</div>
      <h3 style={{ margin: '0 0 6px', fontSize: 16, overflowWrap: 'anywhere' }}>{label}</h3>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{message.from_email}</div>
      {contact?.organization && <p style={{ fontSize: 13, margin: '10px 0 0' }}>{contact.organization}</p>}
      <p style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{contact ? t('senderContext.savedContact', 'From your contacts') : t('senderContext.messageSender', 'From this message')}</p>
      <button type="button" className="superhuman-recent-message" disabled={!canContact} onClick={() => { if (current()) useStore.getState().openCompose({ accountId: account.id, to: [email] }); }}>{t('senderContext.compose', 'Write email')}</button>
    </div>
    <p className="superhuman-session-label">{t('senderContext.recent', 'Recent mail from this sender')}</p>
    <p style={{ margin: '0 18px 12px', color: 'var(--text-secondary)', fontSize: 11 }}>{account.email_address || account.name}</p>
    {loading ? <p role="status" style={{ padding: '0 18px' }}>{t('common.loading', 'Loading…')}</p> : <div className="superhuman-recent-list">{recent.map(entry => <button type="button" key={entry.id} className="superhuman-recent-message" disabled={opening !== null} onClick={() => open(entry)}>
      <span className="superhuman-recent-sender">{entry.subject || t('message.noSubject', '(no subject)')}</span>
      <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{entry.date ? new Date(entry.date).toLocaleDateString() : ''}</span>
    </button>)}</div>}
    {!loading && !searchError && !recent.length && <p style={{ padding: '0 18px', color: 'var(--text-secondary)', fontSize: 12 }}>{t('senderContext.noMail', 'No matching messages in the synced mail cache.')}</p>}
    {(contactError || searchError || openError) && <div role="alert" style={{ padding: '12px 18px', color: 'var(--text-secondary)', fontSize: 12 }}>
      {contactError && <p>{t('senderContext.contactError', 'Contacts could not be loaded.')}</p>}
      {searchError && <p>{t('senderContext.searchError', 'Recent mail could not be loaded.')}</p>}
      {openError && <p>{t('senderContext.openError', 'This message is no longer available. Open its folder to find it.')}</p>}
      {(contactError || searchError) && <button type="button" className="superhuman-recent-message" onClick={() => setRefresh(value => value + 1)}>{t('common.retry', 'Retry')}</button>}
    </div>}
  </aside>;
}
