import { useTranslation } from 'react-i18next';
import { htmlLang } from '../utils/browserLanguage.js';
import { useEffect, useRef, useState } from 'react';
import { api } from '../utils/api.js';
import { useStore } from '../store/index.js';
import { topOpenMessageWindow } from '../utils/messageHotkeys.js';
import { OPEN_ACTIVITY_NOTICE, openActivityStatus } from '../utils/openActivity.js';

const button = { padding: '7px 11px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)', cursor: 'pointer' };
const dateLabel = (value, locale) => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString(locale) : '';

export default function OpenActivityPanel({ accountId = null, onBack }) {
  const owner = useStore(state => state.user?.id);
  return owner ? <OwnedActivity key={`${owner}:${accountId || 'all'}`} owner={owner} accountId={accountId} onBack={onBack} /> : null;
}

function OwnedActivity({ owner, accountId, onBack }) {
  const { t, i18n } = useTranslation();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(null);
  const navigation = useRef(0);
  const alive = useRef(true);
  const request = useRef(0);
  const active = () => alive.current && useStore.getState().user?.id === owner;
  async function load() {
    const version = ++request.current;
    setLoading(true); setError('');
    try {
      const result = await api.get(`/open-activity${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ''}`);
      if (!active() || request.current !== version) return;
      if (!Array.isArray(result.activity)) throw new Error(t("openActivity.invalid", "Activity could not be read."));
      setItems(result.activity);
    } catch (err) { if (active() && request.current === version) setError(err.message || t("openActivity.loadFailed", "Could not load activity.")); }
    finally { if (active() && request.current === version) setLoading(false); }
  }
  async function openMessage(item) {
    if (!active() || !item.messageId) return;
    const version = ++navigation.current;
    const before = useStore.getState();
    const current = () => active() && navigation.current === version
      && useStore.getState().selectedAccountId === before.selectedAccountId
      && useStore.getState().selectedMessageId === before.selectedMessageId;
    setOpening(item.id); setError('');
    try {
      const message = await api.resolveMessage(item.messageId);
      if (!current()) return;
      if (message.account_id !== item.accountId
        || !useStore.getState().accounts.some(account => account.id === message.account_id && account.enabled !== false)) {
        throw new Error(t("openActivity.unavailable", "This message is no longer available in this account."));
      }
      onBack?.();
      useStore.getState().setSearchQuery('');
      useStore.getState().setSelectedAccount(message.account_id, message.folder || 'Sent');
      useStore.getState().setThreadMessages(`__dl_${message.id}`, [message]);
      useStore.getState().setSelectedMessage(message.id);
    } catch (err) { if (current()) setError(err.message || t("openActivity.openFailed", "Could not open this message.")); }
    finally { if (active() && navigation.current === version) setOpening(null); }
  }
  useEffect(() => {
    alive.current = true; load();
    return () => { alive.current = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- keyed by owner and account
  useEffect(() => {
    const key = event => {
      const state = useStore.getState();
      if (state.composing || state.showAdmin || topOpenMessageWindow(state)) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing
        || event.target?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      event.preventDefault(); onBack?.();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onBack]);
  return <section aria-label={t("openActivity.title", "Email open activity")} style={{ padding: '24px 28px', overflow: 'auto', height: '100%', boxSizing: 'border-box', color: 'var(--text-primary)' }}>
    <header style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      {onBack && <button type="button" style={button} onClick={onBack}>{t("openActivity.back", "Back to mail")}</button>}
      <h2 style={{ margin: 0, fontSize: 21, flex: 1 }}>{t("openActivity.title", "Email open activity")}</h2>
      <button type="button" style={button} onClick={load} disabled={loading}>{t("scheduled.refresh", "Refresh")}</button>
    </header>
    <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6, maxWidth: 780 }}>{t('openActivity.notice', OPEN_ACTIVITY_NOTICE)}</p>
    <p style={{ fontSize: 13 }}>{t("openActivity.help", "Off by default. Enable “Record image loads” separately for a message before sending. Your recently viewed mail is separate.")}</p>
    {loading && <p role="status">{t("openActivity.loading", "Loading activity…")}</p>}
    {error && <p role="alert">{error}</p>}
    {!loading && !error && !items.length && <p>{t("openActivity.empty", "No tracked messages in the last 30 days.")}</p>}
    <ol style={{ listStyle: 'none', padding: 0 }}>
      {items.map(item => <li key={item.id} style={{ padding: '15px 0', borderTop: '1px solid var(--border)' }}>
        {item.messageId ? <button type="button" style={{ ...button, textAlign: 'left', fontWeight: 600 }} disabled={opening === item.id} onClick={() => openMessage(item)}>{opening === item.id ? t("openActivity.opening", "Opening…") : item.subject || t("openActivity.openMessage", "Open outgoing message")}</button> : <strong>{item.subject || t("openActivity.outgoingMessage", "Outgoing message")}</strong>}
        <div style={{ marginTop: 6 }}>{openActivityStatus(item, t)}</div>
        <small style={{ color: 'var(--text-secondary)' }}>
          {item.sentAt ? t('openActivity.sentDate', "Sent {{date}}", { date: dateLabel(item.sentAt, htmlLang(i18n.language)) }) : t('openActivity.preparedDate', "Prepared {{date}}", { date: dateLabel(item.createdAt, htmlLang(i18n.language)) })}
          {item.lastLoadedAt ? t('openActivity.lastLoadDate', " · Last image load {{date}}", { date: dateLabel(item.lastLoadedAt, htmlLang(i18n.language)) }) : ''}
          {t('openActivity.expiryDate', " · Expires {{date}}", { date: dateLabel(item.expiresAt, htmlLang(i18n.language)) })}
        </small>
      </li>)}
    </ol>
    {items.length === 50 && <p>{t("openActivity.limit", "Showing the 50 most recent tracked messages.")}</p>}
  </section>;
}
