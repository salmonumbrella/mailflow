import { useTranslation } from 'react-i18next';
import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../utils/api.js';
import { useStore } from '../store/index.js';
import { SNIPPET_BODY_LIMIT, SNIPPET_TITLE_LIMIT, SNIPPET_SUBJECT_LIMIT } from '../utils/mailSnippets.js';
import { newClientKey } from '../utils/scheduledCompose.js';
import { htmlLang } from '../utils/browserLanguage.js';

const buttonStyle = { border: '1px solid var(--border)', borderRadius: 6, padding: '7px 11px', background: 'var(--bg-hover)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 13 };
const fieldStyle = { width: '100%', boxSizing: 'border-box', border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 14 };
const composing = event => event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229;

// Keying by the authenticated user prevents even one frame of the previous owner's content.
export function SnippetsPanel(props) {
  const { t } = useTranslation();
  const owner = useStore(state => state.user?.id);
  return owner ? <OwnedSnippetsPanel key={owner} {...props} owner={owner} /> : <p role="status">{t("snippets.signIn", "Sign in to use snippets.")}</p>;
}

function OwnedSnippetsPanel({ owner, onInsert, onCompose, onClose, modal = false }) {
  const { t, i18n } = useTranslation();
  const [snippets, setSnippets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const busyRef = useRef(false);
  const requestRef = useRef(0);
  const rootRef = useRef(null);
  const searchRef = useRef(null);
  const titleRef = useRef(null);
  const cancelRef = useRef(null);
  const id = useId();
  const activeOwner = () => alive.current && useStore.getState().user?.id === owner;
  const visible = snippets.filter(item => `${item.title}\n${item.body}`.toLowerCase().includes(query.trim().toLowerCase()));
  const active = visible.find(item => item.id === selected) || visible[0];

  async function load() {
    const request = ++requestRef.current;
    setLoading(true); setError(''); setConflict(false);
    try {
      const result = await api.get('/snippets');
      if (!activeOwner() || requestRef.current !== request) return;
      if (!Array.isArray(result.snippets)) throw new Error(t("snippets.invalid", "Snippets could not be read."));
      setSnippets(result.snippets);
    } catch (err) {
      if (activeOwner() && requestRef.current === request) setError(err.message || t("snippets.loadFailed", "Could not load snippets."));
    } finally {
      if (activeOwner() && requestRef.current === request) setLoading(false);
    }
  }

  useEffect(() => {
    alive.current = true;
    load();
    return () => { alive.current = false; };
  }, [owner]); // eslint-disable-line react-hooks/exhaustive-deps -- the keyed owner owns one request lifetime
  useEffect(() => {
    if (editing) titleRef.current?.focus();
    else if (deleting) cancelRef.current?.focus();
    else searchRef.current?.focus();
  }, [Boolean(editing), Boolean(deleting)]); // eslint-disable-line react-hooks/exhaustive-deps -- changing text must not refocus its field

  async function mutate(operation) {
    if (busyRef.current || !activeOwner()) return;
    busyRef.current = true; setBusy(true); setError(''); setConflict(false);
    try {
      await operation();
    } catch (err) {
      if (activeOwner()) { setError(err.message || t("snippets.saveFailed", "Could not save snippets.")); setConflict(err.status === 409); }
    } finally {
      busyRef.current = false;
      if (activeOwner()) setBusy(false);
    }
  }

  function save(event) {
    event.preventDefault();
    if (!editing.title.trim() || !editing.body.trim()) { setError(t("snippets.validation", "Add a title and message for your snippet.")); return; }
    mutate(async () => {
      const payload = { title: editing.title, subject: editing.subject || '', body: editing.body, ...(editing.id ? { version: editing.version } : {}) };
      const saved = editing.id ? await api.put(`/snippets/${encodeURIComponent(editing.id)}`, payload) : await api.post('/snippets', payload);
      if (!activeOwner()) return;
      setSnippets(current => editing.id ? current.map(item => item.id === saved.id ? saved : item) : [...current, saved]);
      setSelected(saved.id); setEditing(null); setQuery('');
    });
  }

  function remove() {
    mutate(async () => {
      await api.delete(`/snippets/${encodeURIComponent(deleting.id)}?version=${deleting.version}`);
      if (!activeOwner()) return;
      setSnippets(current => current.filter(item => item.id !== deleting.id));
      setDeleting(null);
    });
  }

  function dismiss() {
    if (busyRef.current) return;
    setError(''); setConflict(false);
    if (editing) setEditing(null);
    else if (deleting) setDeleting(null);
    else onClose?.();
  }

  async function insert(item) {
    const action = onCompose || onInsert;
    if (!item || busyRef.current || !activeOwner() || !action) return;
    busyRef.current = true; setBusy(true); setError('');
    let inserted = false;
    try {
      if (await action(item) === false) return;
      inserted = true;
      // Plain-text insertion can unmount this picker synchronously. Still record that completed
      // action, but never send a later request after the authenticated owner changes.
      if (useStore.getState().user?.id !== owner) return;
      const saved = await api.post(`/snippets/${encodeURIComponent(item.id)}/use`, { requestId: newClientKey() });
      if (activeOwner()) setSnippets(items => items.map(current => current.id === saved.id ? saved : current));
    } catch (err) {
      if (useStore.getState().user?.id !== owner) return;
      const message = inserted ? t('snippets.usageFailed', 'Snippet text was added, but usage could not be saved.')
        : err.message || t("snippets.insertFailed", "Could not insert the snippet.");
      if (activeOwner()) setError(message);
      else if (inserted) useStore.getState().addNotification({ title: t('snippets.title', 'Snippets'), body: message });
    } finally {
      busyRef.current = false;
      if (activeOwner()) setBusy(false);
    }
  }
  const dateLabel = value => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString(htmlLang(i18n.language)) : t('snippets.never', 'Never');

  function onKeyDown(event) {
    // No composer or mailbox command, especially Send, may escape this surface.
    event.stopPropagation();
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); return; }
    if (composing(event)) return;
    if (event.repeat && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); return; }
    if (event.key === 'Escape') { event.preventDefault(); dismiss(); return; }
    if (modal && event.key === 'Tab') {
      const controls = [...rootRef.current.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex="0"]')];
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !rootRef.current.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }

  function searchKey(event) {
    if (composing(event) || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!visible.length) return;
      const index = visible.findIndex(item => item.id === active?.id);
      setSelected(visible[(index + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length].id);
    } else if (event.key === 'Enter') {
      event.preventDefault(); insert(active);
    }
  }

  return (
    <section ref={rootRef} role={modal ? 'dialog' : undefined} aria-modal={modal || undefined}
      aria-label={editing ? (editing.id ? t("snippets.edit", "Edit snippet") : t("snippets.new", "New snippet")) : deleting ? t("snippets.delete", "Delete snippet") : !onCompose && onInsert ? t("snippets.insert", "Insert snippet") : t("snippets.title", "Snippets")}
      onKeyDown={onKeyDown} style={{ display: 'flex', flexDirection: 'column', minHeight: 0, width: '100%', height: onCompose ? '100%' : undefined, color: 'var(--text-primary)' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 20px', borderBottom: '1px solid var(--border-subtle)' }}>
        <h2 style={{ flex: 1, fontSize: 18, margin: 0 }}>{editing ? (editing.id ? t("snippets.edit", "Edit snippet") : t("snippets.new", "New snippet")) : deleting ? t("snippets.deleteTitle", "Delete snippet?") : t("snippets.title", "Snippets")}</h2>
        {onClose && <button type="button" style={buttonStyle} onClick={dismiss} disabled={busy} aria-label={onCompose ? t("openActivity.back", "Back to mail") : t("snippets.close", "Close snippets")}>{onCompose ? t("openActivity.back", "Back to mail") : t("snippets.closeButton", "Close")}</button>}
      </header>
      <div style={{ padding: 20, overflowY: 'auto', minHeight: 0 }}>
        {editing ? (
          <form onSubmit={save} style={{ display: 'grid', gap: 14 }}>
            <label htmlFor={`${id}-title`}>{t("snippets.titleLabel", "Title")}</label>
            <input ref={titleRef} id={`${id}-title`} aria-label={t("snippets.titleInput", "Snippet title")} maxLength={SNIPPET_TITLE_LIMIT} required disabled={busy}
              style={fieldStyle} value={editing.title} onChange={e => setEditing({ ...editing, title: e.target.value })} />
            <label htmlFor={`${id}-subject`}>{t('snippets.subject', 'Subject (optional)')}</label>
            <input id={`${id}-subject`} aria-label={t('snippets.subject', 'Subject (optional)')} maxLength={SNIPPET_SUBJECT_LIMIT} disabled={busy}
              style={fieldStyle} value={editing.subject || ''} onChange={e => setEditing({ ...editing, subject: e.target.value })} />
            <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 12 }}>{t('snippets.subjectHelp', 'Used for new messages. Inserting into an existing draft keeps its subject.')}</p>
            <label htmlFor={`${id}-body`}>{t("snippets.bodyLabel", "Message")}</label>
            <textarea id={`${id}-body`} aria-label={t("snippets.bodyInput", "Snippet body")} maxLength={SNIPPET_BODY_LIMIT} required rows={9} disabled={busy}
              style={{ ...fieldStyle, resize: 'vertical', lineHeight: 1.6 }} value={editing.body} onChange={e => setEditing({ ...editing, body: e.target.value })} />
            <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 12 }}>{t("snippets.plainTextHelp", "Saved as plain text. Line breaks are preserved, and HTML is inserted as text.")}</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" style={buttonStyle} onClick={dismiss} disabled={busy}>{t("common.cancel", "Cancel")}</button>
              <button type="submit" style={{ ...buttonStyle, background: 'var(--accent)', color: 'var(--accent-text)' }} disabled={busy}>{busy ? t("common.saving", "Saving…") : t("snippets.save", "Save snippet")}</button>
            </div>
          </form>
        ) : deleting ? (
          <div>
            <p>{t('snippets.deleteConfirm', { defaultValue: 'Delete “{{title}}”? Existing drafts will keep their inserted text.', title: deleting.title })}</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button ref={cancelRef} type="button" style={buttonStyle} disabled={busy} onClick={dismiss}>{t("common.cancel", "Cancel")}</button>
              <button type="button" style={{ ...buttonStyle, color: 'var(--red)' }} disabled={busy} onClick={remove}>{busy ? t("common.deleting", "Deleting…") : t("snippets.delete", "Delete snippet")}</button>
            </div>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
              <input ref={searchRef} type="search" aria-label={t("snippets.search", "Search snippets")} placeholder={t("snippets.search", "Search snippets")} value={query}
                role="combobox" aria-autocomplete="list" aria-expanded={!loading && visible.length > 0} aria-controls={`${id}-list`}
                aria-activedescendant={active ? `${id}-${active.id}` : undefined}
                onChange={e => { setQuery(e.target.value); setSelected(null); }} onKeyDown={searchKey} style={{ ...fieldStyle, minWidth: 0 }} />
              <button type="button" style={{ ...buttonStyle, whiteSpace: 'nowrap' }} disabled={loading || busy || !!error} onClick={() => { setError(''); setEditing({ title: '', body: '' }); }}>{t("snippets.new", "New snippet")}</button>
            </div>
            {loading ? <p role="status">{t("snippets.loading", "Loading snippets…")}</p> : !snippets.length && !error ? <p role="status">{t("snippets.empty", "No snippets yet. Save a message you use often to insert it into any draft.")}</p>
              : !visible.length && !error ? <p role="status">{t("snippets.noMatch", "No snippets match your search.")}</p> : null}
            <div id={`${id}-list`} role="listbox" aria-label={t("snippets.saved", "Saved snippets")} style={{ display: 'grid', gap: 5, maxHeight: 190, overflowY: 'auto' }}>
              {visible.map(item => (
                <button key={item.id} id={`${id}-${item.id}`} type="button" role="option" aria-selected={active?.id === item.id}
                  onClick={() => setSelected(item.id)} style={{ ...buttonStyle, textAlign: 'left', background: active?.id === item.id ? 'var(--accent-dim)' : 'var(--bg-hover)' }}>{item.title}</button>
              ))}
            </div>
            {active && !loading && (
              <div style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 16, paddingTop: 14 }}>
                <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>{active.title}</h3>
                {active.subject && <p style={{ fontSize: 13 }}><strong>{t('compose.subject', 'Subject')}:</strong> {active.subject}</p>}
                <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 180, overflowY: 'auto', lineHeight: 1.6, fontSize: 14 }}>{active.body}</div>
                <p style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{t("snippets.accountsHelp", "Available across your mail accounts.")}</p>
                <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '5px 14px', fontSize: 12, color: 'var(--text-secondary)' }}>
                  <dt>{t('snippets.uses', 'Uses')}</dt><dd style={{ margin: 0 }}>{(active.usageCount || 0).toLocaleString(htmlLang(i18n.language))}</dd>
                  <dt>{t('snippets.lastUsed', 'Last used')}</dt><dd style={{ margin: 0 }}>{dateLabel(active.lastUsedAt)}</dd>
                  <dt>{t('snippets.modified', 'Modified')}</dt><dd style={{ margin: 0 }}>{dateLabel(active.updatedAt)}</dd>
                </dl>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {(onInsert || onCompose) && <button type="button" disabled={busy} style={{ ...buttonStyle, background: 'var(--accent)', color: 'var(--accent-text)' }} onClick={() => insert(active)}>{onCompose ? t('snippets.composeFrom', 'Compose from snippet') : t("snippets.insert", "Insert snippet")}</button>}
                  <button type="button" disabled={busy} style={buttonStyle} onClick={() => { setError(''); setEditing({ ...active }); }}>{t("snippets.edit", "Edit snippet")}</button>
                  <button type="button" disabled={busy} style={buttonStyle} onClick={() => { setError(''); setDeleting(active); }}>{t("common.delete", "Delete")}</button>
                </div>
              </div>
            )}
          </>
        )}
        {error && <div style={{ marginTop: 14 }}><p role="alert" style={{ color: 'var(--red)', fontSize: 13 }}>{error}</p>
          {(!editing && !deleting || conflict) && <button type="button" style={buttonStyle} disabled={busy} onClick={() => { setEditing(null); setDeleting(null); load(); }}>{t("snippets.reload", "Reload snippets")}</button>}
        </div>}
      </div>
    </section>
  );
}

export function SnippetsDialog({ onInsert, onClose }) {
  return <div style={{ position: 'fixed', inset: 0, zIndex: 2300, background: 'rgba(0,0,0,.48)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
    <div style={{ width: 560, maxWidth: '100%', maxHeight: 'min(760px, calc(100dvh - 32px))', overflow: 'auto', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: 'var(--shadow-modal)' }}>
      <SnippetsPanel modal onInsert={onInsert} onClose={onClose} />
    </div>
  </div>;
}
