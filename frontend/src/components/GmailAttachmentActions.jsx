import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { attachmentSourceMatchesRow } from '../utils/attachmentSource.js';
import { createAttachmentActionScope, downloadAttachmentBytes } from '../utils/attachmentActions.js';
import { fetchAttachmentBytes } from '../utils/attachmentTransport.js';
import { gmailAttachmentMetadata } from '../utils/gmailAttachmentMetadata.js';
import { classifyAttachmentRisk } from '../utils/attachmentRisk.js';
import { previewKind } from '../utils/attachmentPreview.js';
import { labelViewKey, nativeLabelActionsBlocked } from '../utils/nativeLabelNavigation.js';
import AttachmentViewer from './AttachmentViewer.jsx';
import { GmailAttachmentContext } from './GmailAttachmentContext.js';

function visibleOpener(opener, list) {
  if (!opener?.isConnected || !list?.contains(opener)) return false;
  for (let node = opener; node instanceof Element; node = node.parentElement) {
    // The attachment modal makes the app inert itself; that is not a source change.
    if (node.hidden || node.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

function listScopeKey(state) {
  return JSON.stringify([state.layout, state.gmailDensity, state.selectedAccountId,
    state.selectedFolder, state.searchQuery, state.searchAllFolders, state.selectedMessageId,
    state.activeGtdTab, state.listFilter, state.threadedView, state.scrollMode, state.pageSize,
    state.showContacts, state.showAdmin, state.composing,
    state.messageWindows?.map(item => [item.winId, item.messageId, item.minimized, item.z]),
    labelViewKey(state.activeLabel), state.nativeLabelFeed?.key, state.nativeLabelFeed?.status]);
}

const freezeItem = item => Object.freeze({ part: item.part, filename: item.filename, type: item.type, size: item.size });

// A single interaction owner lives above the list rows. Neither a portal event nor
// a late byte response can act through a row's open/select handler.
export function GmailAttachmentActionsProvider({ children, listRef, viewKey }) {
  const [interaction, setInteraction] = useState(null);
  const active = useRef(null);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const view = useRef(viewKey);
  view.current = viewKey;

  const finish = useCallback((session, restore = false) => {
    if (active.current !== session) return;
    session.restore = restore && session.scope.current();
    active.current = null;
    session.scope.dispose();
    if (mounted.current) setInteraction(null);
  }, []);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const session = active.current;
      active.current = null;
      session?.scope.dispose();
    };
  }, []);
  // Local filters can remove an opener without changing its physical store row.
  useLayoutEffect(() => { active.current?.scope.current(); });

  const activate = useCallback((message, metadata, item, opener) => {
    const state = useStore.getState();
    if (state.layout !== 'gmail' || state.gmailDensity !== 'default' || nativeLabelActionsBlocked(state)
      || !visibleOpener(opener, listRef.current)) return;
    const verified = gmailAttachmentMetadata(message);
    if (!verified || !attachmentSourceMatchesRow(metadata.source, message)
      || !verified.items.some(candidate => JSON.stringify(candidate) === JSON.stringify(item))) return;
    // A held key / second click cannot turn a risk prompt into confirmation.
    if (active.current?.opener === opener && active.current.mode !== 'done') return;
    if (active.current) finish(active.current);
    const source = verified.source;
    const items = Object.freeze(verified.items.map(freezeItem));
    const chosen = items.find(candidate => candidate.part === item.part);
    if (!chosen) return;
    const parent = opener.closest('.mailflow-thread-message-row') ? state.expandedThreadId : null;
    const ownerKey = current => JSON.stringify([listScopeKey(current), view.current]);
    const scopeKey = ownerKey(state);
    const sourceCurrent = current => {
      if (!mounted.current || current.layout !== 'gmail' || current.gmailDensity !== 'default'
        || nativeLabelActionsBlocked(current) || !visibleOpener(opener, listRef.current)) return false;
      const pool = current.searchQuery.trim() ? current.searchResults : current.messages;
      const candidates = parent
        ? current.expandedThreadId === parent && pool.some(row => (row.thread_id || row.id) === parent)
          ? current.threadMessages?.[parent] || [] : []
        : pool;
      return candidates.some(row => attachmentSourceMatchesRow(source, row));
    };
    const session = { id: ++sequence.current, source, item: chosen, items,
      previewable: Object.freeze(items.filter(candidate => previewKind(candidate))), opener, sourceCurrent, restore: false };
    const scope = createAttachmentActionScope({
      store: useStore, source, sourceCurrent, scopeKey: ownerKey,
      onInvalidate: () => { if (active.current === session) finish(session); },
    });
    session.scope = scope;
    session.restoreFocus = () => {
      if (session.restore && !active.current && ownerKey(useStore.getState()) === scopeKey
        && sourceCurrent(useStore.getState()) && !opener.closest('[inert]')) opener.focus({ preventScroll: true });
    };
    if (!scope.current()) { scope.dispose(); return; }
    const risk = classifyAttachmentRisk(chosen.filename, chosen.type);
    session.mode = ['block', 'warn'].includes(risk.level) ? 'risk' : previewKind(chosen) ? 'preview' : 'download';
    session.risk = risk;
    active.current = session;
    setInteraction({ ...session });
  }, [finish, listRef]);

  const download = useCallback(async session => {
    if (active.current !== session || !session.scope.current() || session.downloading) return;
    session.downloading = true;
    session.mode = 'download';
    session.error = null;
    setInteraction({ ...session });
    const operation = session.scope.fork();
    try {
      const bytes = await fetchAttachmentBytes({ source: session.source, part: session.item.part, scope: operation });
      if (active.current !== session || !operation.current()) return;
      // The root scope retains the download URL until its delayed cleanup or invalidation.
      if (downloadAttachmentBytes(session.scope, bytes, session.item.filename, session.item.type)) {
        session.restore = true;
        session.mode = 'done';
        setInteraction({ ...session });
      }
    } catch (error) {
      if (active.current !== session || !operation.current() || error?.name === 'AbortError') return;
      session.mode = 'error';
      session.error = error;
      setInteraction({ ...session });
    } finally {
      operation.dispose();
      if (active.current === session) session.downloading = false;
    }
  }, []);

  useEffect(() => {
    const session = active.current;
    if (session?.mode === 'download' && !session.downloading) download(session);
  }, [interaction, download]);

  const session = active.current;
  return <GmailAttachmentContext.Provider value={activate}>
    {children}
    {interaction && session && interaction.id === session.id && (session.mode === 'preview'
      ? <AttachmentViewer key={session.id} messageId={session.source.messageId} source={session.source} scope={session.scope}
        attachments={session.previewable}
        startIndex={session.previewable.findIndex(candidate => candidate.part === session.item.part)}
        onClose={() => finish(session, true)} restoreFocus={session.restoreFocus} />
      : session.mode !== 'done' && <AttachmentDownloadDialog session={session}
        onClose={() => finish(session, true)} onConfirm={() => download(session)} />)}
  </GmailAttachmentContext.Provider>;
}

function AttachmentDownloadDialog({ session, onClose, onConfirm }) {
  const { t } = useTranslation();
  const dialog = useRef(null);
  const actions = useRef({});
  actions.current = { onClose };
  useEffect(() => {
    const element = dialog.current;
    const quieted = [];
    const quiet = node => {
      if (node.nodeType !== 1 || node === element || node.contains(element) || node.hasAttribute('inert')) return;
      node.setAttribute('inert', ''); quieted.push(node);
    };
    [...document.body.children].forEach(quiet);
    const observer = new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(quiet)));
    observer.observe(document.body, { childList: true });
    element.querySelector('button')?.focus({ preventScroll: true });
    const key = event => {
      if (event.key === 'Escape') { event.preventDefault(); actions.current.onClose(); }
      else if (event.key === 'Tab') {
        event.preventDefault();
        const buttons = [...element.querySelectorAll('button:not([disabled])')];
        const current = buttons.indexOf(document.activeElement);
        buttons[(current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', key, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('keydown', key, true);
      quieted.forEach(node => node.removeAttribute('inert'));
      if (session.mode === 'done' && session.scope.current()) {
        session.opener?.focus({ preventScroll: true });
      } else session.restoreFocus();
    };
  }, [session]);
  const { mode, item, risk, error } = session;
  const unavailable = error?.status === 400 || error?.status === 404 || error?.status === 409;
  const errorText = unavailable
    ? t('gmail.attachments.unavailable', 'This attachment changed or is no longer available. Refresh the list and review it before trying again.')
    : error?.status === 413
      ? t('gmail.attachments.tooLarge', 'This attachment is too large to download.')
      : t('gmail.attachments.failed', 'Could not download this attachment. Try again.');
  const riskText = risk.doubleExt
    ? t('message.attachmentRisk.doubleExt', { ext: risk.doubleExt })
    : t(`message.attachmentRisk.${risk.level}`, { ext: risk.ext });
  return createPortal(<div ref={dialog} role="dialog" aria-modal="true" aria-label={item.filename}
    onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
    style={{ position: 'fixed', inset: 0, zIndex: 3000, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,0.5)' }}>
    <div style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', borderRadius: 12, padding: 24, maxWidth: 440, margin: 16 }}>
      <bdi dir="auto" style={{ overflowWrap: 'anywhere', fontWeight: 600 }}>{item.filename}</bdi>
      <p role={mode === 'error' ? 'alert' : 'status'}>
        {mode === 'risk' ? riskText : mode === 'error' ? errorText : t('message.downloading')}
      </p>
      <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
        <button type="button" onClick={onClose}>{t('common.close', 'Close')}</button>
        {mode === 'risk' && <button type="button" data-attachment-confirm onClick={onConfirm}>
          {t('message.attachmentRisk.armed', { label: t('message.download', 'Download') })}
        </button>}
        {mode === 'error' && !unavailable && <button type="button" data-attachment-retry onClick={onConfirm}>
          {t('gmail.attachments.retry', 'Try again')}
        </button>}
      </div>
    </div>
  </div>, document.body);
}
