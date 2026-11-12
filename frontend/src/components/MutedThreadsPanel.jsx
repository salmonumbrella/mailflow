import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { topOpenMessageWindow } from '../utils/messageHotkeys.js';
import { api } from '../utils/api.js';
import MessageMuteAction from './MessageMuteAction.jsx';

const buttonStyle = { padding: '7px 11px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)', cursor: 'pointer' };

export default function MutedThreadsPanel({ accountId = null, onBack }) {
  const owner = useStore(state => state.user?.id);
  const locked = useStore(state => state.isLocked);
  return owner && !locked ? <OwnedMutedThreads key={`${owner}:${accountId || 'all'}`} owner={owner} accountId={accountId} onBack={onBack} /> : null;
}

function OwnedMutedThreads({ owner, accountId, onBack }) {
  const { t } = useTranslation();
  const accounts = useStore(state => state.accounts);
  const [items, setItems] = useState([]);
  const [nextOffset, setNextOffset] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(null);
  const alive = useRef(false);
  const request = useRef(0);
  const navigating = useRef(0);
  const loadingRef = useRef(false);
  const current = () => alive.current && useStore.getState().user?.id === owner && !useStore.getState().isLocked
    && useStore.getState().selectedAccountId === accountId
    && (!accountId || useStore.getState().accounts.some(account => account.id === accountId && account.enabled !== false));
  const load = async (offset = 0) => {
    if (!current() || (offset && loadingRef.current)) return;
    const token = ++request.current;
    loadingRef.current = true; setLoading(true); setError('');
    try {
      const query = new URLSearchParams({ offset: String(offset) });
      if (accountId) query.set('account_id', accountId);
      const result = await api.get(`/mail/muted?${query}`);
      if (!current() || token !== request.current) return;
      if (!Array.isArray(result.messages)) throw new Error(t('mutedThreads.loadFailed', 'Could not load muted conversations.'));
      const eligible = result.messages.filter(message => (!accountId || message.account_id === accountId)
        && useStore.getState().accounts.some(account => account.id === message.account_id && account.enabled !== false));
      setItems(previous => offset ? [...new Map([...previous, ...eligible].map(message => [message.id, message])).values()] : eligible);
      setNextOffset(result.hasMore && Number.isInteger(result.nextOffset) && result.nextOffset > offset ? result.nextOffset : null);
    } catch (err) { if (current() && token === request.current) setError(err.message || t('mutedThreads.loadFailed', 'Could not load muted conversations.')); }
    finally { if (current() && token === request.current) { loadingRef.current = false; setLoading(false); } }
  };
  useEffect(() => {
    alive.current = true;
    load();
    const refresh = () => load();
    const unsubscribe = useStore.subscribe(state => {
      if (state.user?.id !== owner || state.isLocked || state.selectedAccountId !== accountId) {
        request.current++; navigating.current++; alive.current = false;
      }
    });
    window.addEventListener('mailflow:mute_changed', refresh);
    return () => { alive.current = false; unsubscribe(); window.removeEventListener('mailflow:mute_changed', refresh); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- keyed to owner/account
  useEffect(() => {
    const back = event => {
      const state = useStore.getState();
      if (state.composing || state.showAdmin || topOpenMessageWindow(state)) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229
        || event.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="dialog"]')) return;
      event.preventDefault(); onBack?.();
    };
    document.addEventListener('keydown', back);
    return () => document.removeEventListener('keydown', back);
  }, [onBack]);
  const open = async item => {
    if (!current()) return;
    const token = ++navigating.current;
    setOpening(item.id); setError('');
    try {
      const message = await api.resolveMessage(item.id);
      if (!current() || token !== navigating.current) return;
      if (message.account_id !== item.account_id || !useStore.getState().accounts.some(account => account.id === message.account_id && account.enabled !== false)) throw new Error(t('mutedThreads.unavailable', 'This conversation is no longer available in this account.'));
      onBack?.();
      const state = useStore.getState();
      state.setSearchQuery(''); state.setSelectedAccount(message.account_id, message.folder || 'INBOX');
      state.setThreadMessages(`__dl_${message.id}`, [message]); state.setSelectedMessage(message.id);
    } catch (err) { if (current() && token === navigating.current) setError(err.message); }
    finally { if (current() && token === navigating.current) setOpening(null); }
  };
  return <section aria-label={t('mutedThreads.title', 'Muted conversations')} style={{ padding: '24px 28px', overflow: 'auto', height: '100%', boxSizing: 'border-box', color: 'var(--text-primary)' }}>
    <header style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <button type="button" style={buttonStyle} onClick={onBack}>{t('openActivity.back', 'Back to mail')}</button>
      <h2 style={{ margin: 0, flex: 1 }}>{t('mutedThreads.title', 'Muted conversations')}</h2>
      <button type="button" style={buttonStyle} disabled={loading} onClick={() => load()}>{t('scheduled.refresh', 'Refresh')}</button>
    </header>
    <p style={{ maxWidth: 780, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>{t('mutedThreads.description', 'Muted conversations stay in MailFlow. New-mail alerts for matching messages are silenced. Muting archives the current inbox conversation; unmuting does not move it back.')}</p>
    <label style={{ fontSize: 13 }}>{t('shortcuts.groups.navigation', 'Navigation')} <select aria-label={t('superhuman.accounts', 'Manage accounts')} value={accountId || ''} onChange={event => useStore.getState().setSelectedAccount(event.target.value || null, 'INBOX')} style={buttonStyle}>
      <option value="">{t('sidebar.allInboxes', 'All inboxes')}</option>
      {accounts.filter(account => account.enabled !== false).map(account => <option key={account.id} value={account.id}>{account.display_name || account.name || account.email_address}</option>)}
    </select></label>
    {error && <p role="alert">{error}</p>}
    {loading && <p role="status">{t('mutedThreads.loading', 'Loading muted conversations…')}</p>}
    {!loading && !error && !items.length && <p>{t('mutedThreads.empty', 'No muted conversations.')}</p>}
    <ol style={{ padding: 0, listStyle: 'none' }}>{items.filter(item => accounts.some(account => account.id === item.account_id && account.enabled !== false)).map(item => <li key={item.id} style={{ padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
      <button type="button" style={{ ...buttonStyle, textAlign: 'left', fontWeight: 600 }} disabled={opening === item.id} onClick={() => open(item)}>{item.subject || t('common.noSubject', '(No subject)')}</button>
      <p style={{ margin: '6px 0', fontSize: 12 }}>{item.from_name || item.from_email}</p>
      <MessageMuteAction message={item} />
    </li>)}</ol>
    {nextOffset !== null && <button type="button" style={buttonStyle} disabled={loading} onClick={() => load(nextOffset)}>{t('mutedThreads.more', 'Load more')}</button>}
  </section>;
}
