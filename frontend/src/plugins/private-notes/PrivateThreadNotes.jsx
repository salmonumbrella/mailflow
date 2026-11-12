import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/index.js';
import { privateNotesApi } from './api.js';

const buttonStyle = { border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-tertiary)', color: 'var(--text-primary)', padding: '6px 10px', cursor: 'pointer' };

export default function PrivateThreadNotes({ message }) {
  const userId = useStore(s => s.user?.id);
  const locked = useStore(s => s.isLocked);
  const account = useStore(s => s.accounts.find(item => item.id === message?.account_id));
  if (!userId || locked || !account || account.enabled === false || !message?.id || message.is_draft) return null;
  return <Notes key={`${userId}:${message.account_id}:${message.id}`} messageId={message.id} userId={userId} accountId={message.account_id} />;
}

function Notes({ messageId, userId, accountId }) {
  const { t } = useTranslation();
  const [data, setData] = useState({ notes: [], version: null });
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(false);
  const pending = useRef(false);
  const submission = useRef(null);
  const current = () => {
    const state = useStore.getState();
    return alive.current && state.user?.id === userId && !state.isLocked
      && state.enabledPlugins.includes('private-notes') && state.accounts.some(item => item.id === accountId && item.enabled !== false);
  };

  useEffect(() => {
    let cancelled = false;
    alive.current = true;
    privateNotesApi.get(messageId).then(result => {
      if (!cancelled && current()) { setData(result); setError(''); }
    }).catch(err => { if (!cancelled && current()) setError(err.message); })
      .finally(() => { if (!cancelled && current()) setLoading(false); });
    return () => { cancelled = true; alive.current = false; };
    // Identity changes remount this component; no note state survives logout or lock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageId]);

  const perform = async operation => {
    if (pending.current || !current()) return false;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await operation();
      if (!current()) return false;
      setData(result);
      return true;
    } catch (err) {
      if (current()) {
        if (err.status === 409 && Array.isArray(err.data?.notes)) setData({ notes: err.data.notes, version: err.data.version });
        setError(err.message);
      }
      return false;
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  };
  const save = async event => {
    event?.preventDefault();
    const body = text.trim();
    if (!body || loading || busy || text.length > 4000) return;
    if (submission.current?.text !== body) submission.current = { text: body, requestId: crypto.randomUUID() };
    if (await perform(() => privateNotesApi.add(messageId, { ...submission.current, version: data.version }))) {
      setText('');
      submission.current = null;
    }
  };
  return <section aria-label={t('privateNotes.title', 'Private notes')} style={{ margin: '20px 0 6px', padding: 16, borderTop: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}>
    <h3 style={{ margin: 0, fontSize: 14 }}>{t('privateNotes.title', 'Private notes')}</h3>
    <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '6px 0 14px' }}>{t('privateNotes.privacy', 'Only you can see these notes. They are never sent with email.')}</p>
    {loading && <p role="status">{t('privateNotes.loading', 'Loading notes…')}</p>}
    {!!data.notes.length && <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>{data.notes.map(note => <li key={note.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border-subtle)' }}>
      <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 13, lineHeight: 1.6 }}>{note.text}</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
        <time dateTime={note.createdAt} style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{new Date(note.createdAt).toLocaleString()}</time>
        <button type="button" disabled={busy} style={buttonStyle} aria-label={t('privateNotes.delete', 'Delete note')} onClick={() => perform(() => privateNotesApi.remove(messageId, note.id, data.version))}>{t('common.delete', 'Delete')}</button>
      </div>
    </li>)}</ol>}
    {error && <div role="alert" style={{ color: 'var(--red, #c0392b)', marginTop: 10, fontSize: 12 }}>{error} <button type="button" disabled={busy || loading} style={buttonStyle} onClick={() => perform(() => privateNotesApi.get(messageId))}>{t('privateNotes.reload', 'Refresh notes')}</button></div>}
    <form onSubmit={save} style={{ marginTop: 12 }}>
      <textarea data-private-note-message-id={messageId} data-private-note-account-id={accountId} aria-label={t('privateNotes.add', 'Add a private note')} placeholder={t('privateNotes.placeholder', 'Add a note just for you…')} maxLength={4000} rows={3} value={text} disabled={busy || loading}
        onChange={event => setText(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); save(); } }}
        style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text-primary)', padding: 10, font: 'inherit', fontSize: 13 }} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 }}>
        <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{text.length}/4000</span>
        <button type="submit" style={buttonStyle} disabled={busy || loading || !text.trim()}>{busy ? t('privateNotes.saving', 'Saving…') : t('privateNotes.save', 'Save note')}</button>
      </div>
    </form>
  </section>;
}
