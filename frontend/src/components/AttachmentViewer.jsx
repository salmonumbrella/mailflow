import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  PREVIEW_MAX_BYTES, sniffPreview, nextZoom, fitScale, canvasPixelRatio, printDocumentHtml, passwordReason,
} from '../utils/attachmentPreview.js';

import { useStore } from '../store/index.js';
import { createAttachmentSessionScope } from '../utils/attachmentActions.js';
import { fetchAttachmentBytes, fetchLegacyAttachmentBytes, downloadAttachmentBytes } from '../utils/attachmentTransport.js';

// Full-screen preview of a message's PDF and image attachments, with Download and Print, so a
// boleto or a photo can be read without saving a copy to the computer first.
//
// The file is fetched through the same endpoint as a download and checked by its bytes before
// anything renders it (see attachmentPreview.js). Images go in an <img>; PDFs are drawn by pdf.js
// (pdfDocument.js), loaded only when the first PDF is opened. While the viewer is open it keeps
// every keystroke to itself, because the mail shortcuts underneath would otherwise archive or
// delete a message the user can no longer see.

const loadPdfModule = () => import('../utils/pdfDocument.js');
const LOADING_FILE = Object.freeze({ status: 'loading' });

const CHROME = {
  bar: 'rgba(18, 18, 22, 0.94)',
  text: '#f2f2f5',
  muted: 'rgba(242, 242, 245, 0.62)',
  hover: 'rgba(255, 255, 255, 0.12)',
  backdrop: 'rgba(8, 8, 12, 0.9)',
};

export default function AttachmentViewer({ messageId, attachments, startIndex = 0, onClose, source = null, scope = null, restoreFocus }) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(() => Math.min(Math.max(startIndex, 0), Math.max(attachments.length - 1, 0)));
  const att = attachments[index];
  const part = att?.part;
  const [loaded, setFile] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [printing, setPrinting] = useState(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [openedPdf, setPdf] = useState(null);
  const [unlock, setUnlock] = useState({ password: null, prompt: null, attempt: 0 });
  const [retry, setRetry] = useState(0);
  const [legacyOwner, setLegacyOwner] = useState(null);
  const [invalidated, setInvalidated] = useState(false);
  const contentRef = useRef(null);
  const dialogRef = useRef(null);
  const activeResource = useRef(null);
  const closing = useRef(false);
  const allowRestore = useRef(false);
  const printBusy = useRef(null);
  const cancelPrint = useRef(null);
  const callbacks = useRef({});
  callbacks.current = { onClose, restoreFocus };

  // Legacy readers have not yet associated their body attachment list with a source envelope.
  // They keep their headerless API, but no longer outlive the session which opened this viewer.
  useEffect(() => {
    const owner = scope || createAttachmentSessionScope({ store: useStore });
    setLegacyOwner({ owner, messageId, scope });
    setInvalidated(false);
    const remove = owner.addCleanup(() => {
      closing.current = true;
      allowRestore.current = false;
      setInvalidated(true);
      callbacks.current.onClose?.();
    });
    return () => {
      remove();
      if (!scope) owner.dispose();
    };
  }, [scope, messageId]);
  const owner = scope || (legacyOwner?.messageId === messageId && legacyOwner.scope === scope ? legacyOwner.owner : null);
  const sourceKey = JSON.stringify(source);
  const itemKey = JSON.stringify([part, att?.filename, att?.type, att?.size]);
  // This is checked during render and by every callback, before effects can reset old state.
  const resourceKey = useMemo(() => ({ messageId, sourceKey, itemKey, scope, index, retry }), [messageId, sourceKey, itemKey, scope, index, retry]);
  const currentKey = useRef(resourceKey);
  currentKey.current = resourceKey;
  const file = loaded?.key === resourceKey && loaded.resource.current() && !closing.current
    ? loaded : LOADING_FILE;
  const pdf = openedPdf?.key === resourceKey ? openedPdf.handle : null;

  useEffect(() => {
    if (part === undefined || !owner?.current() || closing.current) return undefined;
    const operation = owner.fork();
    const resource = {
      ...operation,
      current: () => operation.current() && currentKey.current === resourceKey && !closing.current,
    };
    activeResource.current = resource;
    let mounted = true;
    const remove = resource.addCleanup(() => {
      if (mounted && currentKey.current === resourceKey) {
        setFile(null);
        setPdf(null);
        setUnlock({ password: null, prompt: null, attempt: 0 });
        setPrinting(null);
      }
    });
    setPdf(null);
    setUnlock({ password: null, prompt: null, attempt: 0 });
    setFile(null);
    setZoom(1);
    (async () => {
      try {
        const bytes = await (source != null
          ? fetchAttachmentBytes({ source, part, scope: resource })
          : fetchLegacyAttachmentBytes({ messageId, part, scope: resource }));
        if (!resource.current()) return;
        if (bytes.byteLength > PREVIEW_MAX_BYTES) {
          setFile({ key: resourceKey, resource, status: 'error', reason: 'too-large', bytes });
          return;
        }
        const preview = sniffPreview(bytes);
        if (!preview) { setFile({ key: resourceKey, resource, status: 'error', reason: 'unsupported', bytes }); return; }
        const url = preview.kind === 'image' ? resource.createObjectURL(new Blob([bytes], { type: preview.type })) : null;
        if (!resource.current()) { if (url) resource.revokeObjectURL(url); return; }
        setFile({ key: resourceKey, resource, status: 'ready', bytes, preview, url });
      } catch (error) {
        if (resource.current() && error?.name !== 'AbortError') {
          setFile({ key: resourceKey, resource, status: 'error', reason: 'failed', error });
        }
      }
    })();
    return () => {
      mounted = false;
      remove();
      resource.dispose();
      if (activeResource.current === resource) activeResource.current = null;
    };
  }, [resourceKey, owner, messageId, part, source]);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return undefined;
    const measure = () => setArea({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // aria-modal only tells assistive technology. The rest of the page is made inert while the viewer
  // is open, so Tab cannot reach the app behind it, where Enter on a focused Delete would still act.
  // Nodes added to <body> meanwhile (menus, toasts) are made inert as they arrive.
  useEffect(() => {
    const dialog = dialogRef.current;
    const quieted = [];
    const quiet = node => {
      if (node.nodeType !== 1 || node === dialog || node.contains(dialog) || node.hasAttribute('inert')) return;
      node.setAttribute('inert', '');
      quieted.push(node);
    };
    [...document.body.children].forEach(quiet);
    const observer = new MutationObserver(records => records.forEach(r => r.addedNodes.forEach(quiet)));
    observer.observe(document.body, { childList: true });
    const returnTo = document.activeElement;
    contentRef.current?.focus({ preventScroll: true });
    return () => {
      observer.disconnect();
      quieted.forEach(node => node.removeAttribute('inert'));
      cancelPrint.current?.();
      if (callbacks.current.restoreFocus) callbacks.current.restoreFocus();
      else if (returnTo?.isConnected && allowRestore.current) returnTo.focus?.({ preventScroll: true });
    };
  }, []);

  const close = useCallback(() => {
    allowRestore.current = !!activeResource.current?.current();
    closing.current = true;
    activeResource.current?.dispose();
    cancelPrint.current?.();
    callbacks.current.onClose?.();
  }, []);

  const go = useCallback(step => {
    const target = index + step;
    if (target < 0 || target >= attachments.length || !owner?.current() || closing.current) return false;
    activeResource.current?.dispose();
    setIndex(target);
    return true;
  }, [index, attachments.length, owner]);

  const download = useCallback(() => {
    if (!att || file.key !== resourceKey || !file.resource?.current() || !file.bytes) return;
    downloadAttachmentBytes(file.resource, file.bytes, att.filename, file.preview?.type);
  }, [att, file, resourceKey]);

  const print = useCallback(async () => {
    if (file.key !== resourceKey || file.status !== 'ready' || !file.resource.current() || printBusy.current || !att) return;
    if (file.preview.kind === 'pdf' && !pdf) return;
    const operation = file.resource.fork();
    const current = () => operation.current() && file.resource.current();
    printBusy.current = operation;
    const stop = operation.addCleanup(() => {
      if (printBusy.current === operation) {
        printBusy.current = null;
        setPrinting(null);
      }
    });
    const toPaper = urls => {
      if (!current() || !dialogRef.current?.isConnected) return Promise.resolve();
      const job = printImages(urls, att.filename, dialogRef.current, current);
      cancelPrint.current = job.cancel;
      operation.addCleanup(job.cancel);
      return job.done;
    };
    try {
      if (file.preview.kind === 'image') {
        await toPaper([file.url]);
        return;
      }
      setPrinting({ done: 0, total: pdf.doc.numPages });
      const { renderPagesForPrint } = await loadPdfModule();
      if (!current()) return;
      const urls = await renderPagesForPrint(pdf, {
        isCancelled: () => !current(),
        signal: operation.signal,
        createObjectURL: blob => operation.createObjectURL(blob),
        revokeObjectURL: url => operation.revokeObjectURL(url),
        onProgress: (done, total) => { if (current()) setPrinting({ done, total }); },
      });
      if (!current()) { urls.forEach(url => operation.revokeObjectURL(url)); return; }
      await toPaper(urls);
    } catch (err) {
      if (current()) console.error('Print failed:', err);
    } finally {
      if (printBusy.current === operation) {
        cancelPrint.current = null;
        printBusy.current = null;
        if (file.resource.current()) setPrinting(null);
      }
      stop();
      operation.dispose();
    }
  }, [att, file, pdf, resourceKey]);

  // Refs keep the capture-phase listener installed once for the viewer's lifetime.
  const actions = useRef({});
  actions.current = { onClose: close, go, print };
  useEffect(() => {
    const onKey = e => {
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
      // In the password field the arrows move the caret, not to another attachment.
      const typing = e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA';
      if (e.key === 'Escape') {
        e.preventDefault();
        actions.current.onClose();
      } else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        actions.current.print();
      } else if (plain && !typing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        if (actions.current.go(e.key === 'ArrowLeft' ? -1 : 1)) e.preventDefault();
      }
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const narrow = area.width > 0 && area.width < 640;
  const ready = file.status === 'ready';
  const errorText = previewErrorText(t, file);
  const canDownload = !!file.bytes && file.key === resourceKey && !!file.resource?.current();
  const canRetry = file.reason === 'failed' && ![400, 404, 409].includes(file.error?.status);

  if (invalidated) return null;

  return createPortal(
    <div
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      onMouseDown={e => e.stopPropagation()}
      onContextMenu={e => e.stopPropagation()}
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('message.preview.label', { name: att?.filename ?? '' })}
      style={{
        position: 'fixed', inset: 0, zIndex: 3000, display: 'flex', flexDirection: 'column',
        background: CHROME.backdrop, color: CHROME.text,
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        // The viewer covers the whole screen, so its bar pads itself by --sat like the app's
        // other top bars (index.css): in a standalone PWA the status bar is drawn over the
        // page, and the bar's own color fills that strip (--sat-trim off the bottom, per
        // convention). Desktop keeps its old padding, where both variables are 0.
        paddingTop: `calc(var(--sat) + ${narrow ? 8 : 10}px)`,
        paddingBottom: `calc(${narrow ? 8 : 10}px - var(--sat-trim))`,
        paddingLeft: narrow ? 12 : 18, paddingRight: narrow ? 8 : 12,
        background: CHROME.bar, borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div title={att?.filename} style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {att?.filename}
          </div>
          {attachments.length > 1 && (
            <div style={{ fontSize: 11, color: CHROME.muted }}>
              {t('message.preview.position', { current: index + 1, total: attachments.length })}
            </div>
          )}
        </div>
        {ready && (
          <>
            <ToolbarButton label={t('message.preview.zoomOut')} onClick={() => setZoom(z => nextZoom(z, -1))}>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </ToolbarButton>
            <button
              type="button"
              onClick={() => setZoom(1)}
              title={t('message.preview.fit')}
              aria-label={t('message.preview.fit')}
              style={{ ...buttonStyle, minWidth: 48, fontSize: 12, fontVariantNumeric: 'tabular-nums' }}
              onMouseEnter={hoverIn} onMouseLeave={hoverOut}
            >
              {Math.round(zoom * 100)}%
            </button>
            <ToolbarButton label={t('message.preview.zoomIn')} onClick={() => setZoom(z => nextZoom(z, 1))}>
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </ToolbarButton>
            <div style={{ width: 1, height: 22, background: 'rgba(255,255,255,0.14)', margin: '0 4px' }} />
            <ToolbarButton
              label={printing ? t('message.preview.preparingPrint', printing) : t('message.preview.print')}
              text={narrow ? null : (printing ? t('message.preview.preparingPrint', printing) : t('message.preview.print'))}
              onClick={print}
              disabled={!!printing || (file.preview.kind === 'pdf' && !pdf)}
            >
              <polyline points="6 9 6 2 18 2 18 9"/>
              <path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/>
              <rect x="6" y="14" width="12" height="8"/>
            </ToolbarButton>
          </>
        )}
        <ToolbarButton label={t('message.preview.download')} text={narrow ? null : t('message.preview.download')} onClick={download} disabled={!canDownload}>
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </ToolbarButton>
        <ToolbarButton label={t('message.preview.close')} onClick={close}>
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </ToolbarButton>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex' }}>
        <div ref={contentRef} tabIndex={0} style={{ flex: 1, minWidth: 0, overflow: 'auto', outline: 'none' }}>
          {file.status === 'loading' && <Centered>{t('common.loading')}</Centered>}
          {file.status === 'error' && (
            <Centered>
              <div style={{
                maxWidth: 380, textAlign: 'center', padding: '20px 22px', borderRadius: 12,
                background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)',
              }}>
                <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 14 }}>{errorText}</div>
                <button type="button" onClick={canDownload ? download : canRetry ? () => setRetry(n => n + 1) : close} style={{
                  padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
                  background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 500,
                }}>
                  {canDownload ? t('message.preview.download') : canRetry ? t('gmail.attachments.retry', 'Try again') : t('message.preview.close')}
                </button>
              </div>
            </Centered>
          )}
          {ready && file.preview.kind === 'image' && (
            <ImageView
              key={itemKey}
              url={file.url}
              alt={att?.filename ?? ''}
              zoom={zoom}
              area={area}
              padding={narrow ? 12 : 28}
              onToggleZoom={() => setZoom(z => (z === 1 ? 2 : 1))}
              onError={() => { if (file.resource.current()) setFile(f => f?.key === resourceKey ? { ...f, status: 'error', reason: 'unsupported' } : f); }}
            />
          )}
          {ready && file.preview.kind === 'pdf' && unlock.prompt && (
            <PasswordPrompt
              key={unlock.attempt}
              incorrect={unlock.prompt === 'incorrect'}
              onSubmit={password => { if (file.resource.current()) setUnlock(u => ({ password, prompt: null, attempt: u.attempt + 1 })); }}
              onDownload={download}
            />
          )}
          {ready && file.preview.kind === 'pdf' && !unlock.prompt && (
            <PdfView
              key={`${itemKey}:${unlock.attempt}`}
              scope={file.resource}
              bytes={file.bytes}
              password={unlock.password}
              zoom={zoom}
              area={area}
              padding={narrow ? 8 : 24}
              scrollRoot={contentRef}
              loadingLabel={t('common.loading')}
              onOpen={handle => { if (file.resource.current()) setPdf({ key: resourceKey, handle }); else handle.destroy(); }}
              onError={err => {
                if (!file.resource.current()) return;
                const reason = passwordReason(err);
                if (reason) setUnlock(u => ({ ...u, prompt: reason }));
                else setFile(f => f?.key === resourceKey ? { ...f, status: 'error', reason: 'failed' } : f);
              }}
            />
          )}
        </div>
        {attachments.length > 1 && (
          <>
            <SideButton side="left" label={t('message.preview.previous')} disabled={index === 0} onClick={() => go(-1)} />
            <SideButton side="right" label={t('message.preview.next')} disabled={index === attachments.length - 1} onClick={() => go(1)} />
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

const buttonStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  height: 34, padding: '0 9px', borderRadius: 8, border: 'none', cursor: 'pointer',
  background: 'transparent', color: CHROME.text, fontSize: 13, flexShrink: 0,
};
const hoverIn = e => { if (!e.currentTarget.disabled) e.currentTarget.style.background = CHROME.hover; };
const hoverOut = e => { e.currentTarget.style.background = 'transparent'; };

function ToolbarButton({ label, text = null, onClick, disabled = false, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      style={{ ...buttonStyle, opacity: disabled ? 0.45 : 1, cursor: disabled ? 'default' : 'pointer' }}
      onMouseEnter={hoverIn}
      onMouseLeave={hoverOut}
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
      {text && <span>{text}</span>}
    </button>
  );
}

function SideButton({ side, label, disabled, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      style={{
        position: 'absolute', top: '50%', [side]: 12, transform: 'translateY(-50%)',
        width: 40, height: 40, borderRadius: '50%', border: 'none',
        display: disabled ? 'none' : 'flex', alignItems: 'center', justifyContent: 'center',
        background: CHROME.bar, color: CHROME.text, cursor: 'pointer', boxShadow: '0 2px 10px rgba(0,0,0,0.4)',
      }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        {side === 'left' ? <polyline points="15 18 9 12 15 6"/> : <polyline points="9 18 15 12 9 6"/>}
      </svg>
    </button>
  );
}

function Centered({ children }) {
  return (
    <div style={{ minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, boxSizing: 'border-box', fontSize: 13, color: CHROME.muted }}>
      {children}
    </div>
  );
}

// The bytes passed the check but the browser may still fail to decode them (a truncated JPEG):
// onError swaps in the same message as bytes that are not an image, instead of a broken icon.
function ImageView({ url, alt, zoom, area, padding, onToggleZoom, onError }) {
  const [natural, setNatural] = useState(null);
  const fit = natural
    ? Math.min((area.width - 2 * padding) / natural.width, (area.height - 2 * padding) / natural.height, 1)
    : 1;
  const sized = natural && fit > 0;
  return (
    <div style={{ minHeight: '100%', display: 'flex', padding, boxSizing: 'border-box' }}>
      <img
        src={url}
        alt={alt}
        draggable={false}
        onLoad={e => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
        onError={onError}
        onDoubleClick={onToggleZoom}
        style={{
          margin: 'auto', display: 'block', flexShrink: 0,
          width: sized ? natural.width * fit * zoom : undefined,
          height: sized ? natural.height * fit * zoom : undefined,
          maxWidth: sized ? 'none' : '100%',
          maxHeight: sized ? 'none' : '100%',
          boxShadow: '0 4px 28px rgba(0,0,0,0.45)',
          cursor: zoom === 1 ? 'zoom-in' : 'zoom-out',
        }}
      />
    </div>
  );
}

function PdfView({ scope, bytes, password, zoom, area, padding, scrollRoot, loadingLabel, onOpen, onError }) {
  const [pdf, setPdf] = useState(null);
  const [sizes, setSizes] = useState(null);
  const callbacks = useRef({});
  callbacks.current = { onOpen, onError };

  useEffect(() => {
    const operation = scope.fork();
    const current = () => operation.current() && scope.current();
    let handle = null;
    const destroy = () => { handle?.destroy(); handle = null; };
    const remove = operation.addCleanup(destroy);
    (async () => {
      try {
        const { openPdf } = await loadPdfModule();
        if (!current()) return;
        const opened = await openPdf(bytes, { password, signal: operation.signal, isCancelled: () => !current() });
        if (!current()) { opened.destroy(); return; }
        handle = opened;
        const list = [];
        for (let n = 1; n <= opened.doc.numPages; n++) {
          const page = await opened.doc.getPage(n);
          if (!current()) { page.cleanup?.(); return; }
          const viewport = page.getViewport({ scale: 1 });
          list.push({ width: viewport.width, height: viewport.height });
        }
        setPdf(opened);
        setSizes(list);
        callbacks.current.onOpen(opened);
      } catch (err) {
        if (current() && err?.name !== 'AbortError') callbacks.current.onError(err);
      }
    })();
    return () => {
      remove();
      operation.dispose();
      destroy();
    };
  }, [bytes, password, scope]);

  // Waits for the first measurement too, or every page would be drawn once at the wrong size.
  if (!pdf || !sizes || !(area.width > 0)) return <Centered>{loadingLabel}</Centered>;
  const widest = Math.max(...sizes.map(s => s.width));
  const scale = fitScale(area.width - 2 * padding, widest) * zoom;
  return (
    <div style={{
      width: 'fit-content', minWidth: '100%', margin: '0 auto', padding, boxSizing: 'border-box',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
    }}>
      {sizes.map((size, i) => (
        <PdfPage key={i} scope={scope} pdf={pdf} number={i + 1} size={size} scale={scale} scrollRoot={scrollRoot} />
      ))}
    </div>
  );
}

function PasswordPrompt({ incorrect, onSubmit, onDownload }) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const secondary = {
    padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
    background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border)',
  };
  return (
    <Centered>
      {/* autoComplete off: this is the document's password, not one the browser should offer to
          save for MailFlow. */}
      <form
        autoComplete="off"
        onSubmit={e => { e.preventDefault(); if (value) onSubmit(value); }}
        style={{
          width: '100%', maxWidth: 360, padding: '20px 22px', borderRadius: 12, boxSizing: 'border-box',
          background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)',
        }}
      >
        <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 12 }}>{t('message.preview.password')}</div>
        <input
          ref={inputRef}
          type="password"
          autoComplete="off"
          value={value}
          onChange={e => setValue(e.target.value)}
          aria-label={t('message.preview.passwordLabel')}
          placeholder={t('message.preview.passwordLabel')}
          aria-invalid={incorrect || undefined}
          style={{
            width: '100%', boxSizing: 'border-box', padding: '9px 11px', borderRadius: 8, fontSize: 14,
            background: 'var(--bg-primary)', color: 'var(--text-primary)',
            border: `1px solid ${incorrect ? 'var(--red)' : 'var(--border)'}`, outline: 'none',
          }}
        />
        {incorrect && (
          <div role="alert" style={{ fontSize: 12, color: 'var(--red)', marginTop: 8 }}>
            {t('message.preview.passwordIncorrect')}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button type="button" onClick={onDownload} style={secondary}>{t('message.preview.download')}</button>
          <button type="submit" disabled={!value} style={{
            padding: '8px 16px', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 500,
            background: 'var(--accent)', color: '#fff', cursor: value ? 'pointer' : 'default', opacity: value ? 1 : 0.5,
          }}>
            {t('message.preview.passwordSubmit')}
          </button>
        </div>
      </form>
    </Centered>
  );
}

function PdfPage({ scope, pdf, number, size, scale, scrollRoot }) {
  const pageRef = useRef(null);
  const canvasHostRef = useRef(null);
  const textRef = useRef(null);
  const [near, setNear] = useState(number <= 2);

  // Only the pages in a window around the viewport hold a drawing. They are drawn as they come
  // into it, so a long PDF opens as fast as a short one, and released as they leave it: at the
  // fitted size on a 2x display an A4 page is about 20 MB of canvas, so keeping every page scrolled
  // past would reach gigabytes, and a zoom would redraw all of them.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') { setNear(true); return undefined; }
    const observer = new IntersectionObserver(entries => {
      setNear(entries[entries.length - 1].isIntersecting);
    }, { root: scrollRoot.current, rootMargin: PAGE_WINDOW_MARGIN });
    observer.observe(pageRef.current);
    return () => observer.disconnect();
  }, [scrollRoot]);

  useEffect(() => {
    if (!near) {
      releasePage(canvasHostRef.current, textRef.current);
      return undefined;
    }
    const operation = scope.fork();
    const current = () => operation.current() && scope.current();
    const cssWidth = size.width * scale;
    const cssHeight = size.height * scale;
    const canvasHost = canvasHostRef.current;
    const textHost = textRef.current;
    const canvas = document.createElement('canvas');
    const textContainer = document.createElement('div');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
    let task = null;
    const remove = operation.addCleanup(() => {
      task?.cancel();
      canvas.width = 0;
      canvas.height = 0;
      textContainer.replaceChildren();
      releasePage(canvasHost, textHost);
    });
    (async () => {
      const { renderPage } = await loadPdfModule();
      if (!current()) return;
      task = renderPage(pdf, number, {
        canvas, textContainer, scale, isCancelled: () => !current(),
        pixelRatio: canvasPixelRatio(cssWidth, cssHeight, window.devicePixelRatio),
      });
      await task.done;
      if (!current()) return;
      releasePage(canvasHost, textHost);
      canvasHost?.replaceChildren(canvas);
      textHost?.style.setProperty('--total-scale-factor', textContainer.style.getPropertyValue('--total-scale-factor'));
      textHost?.replaceChildren(...textContainer.childNodes);
    })().catch(err => { if (current()) console.warn(`PDF page ${number} failed to render:`, err); });
    return () => {
      operation.dispose();
      remove();
    };
  }, [pdf, number, near, scale, size.width, size.height, scope]);

  return (
    <div
      ref={pageRef}
      className="mf-pdf-page"
      style={{
        position: 'relative', flexShrink: 0, width: size.width * scale, height: size.height * scale,
        background: '#fff', boxShadow: '0 2px 14px rgba(0,0,0,0.45)',
      }}
    >
      <div ref={canvasHostRef} style={{ position: 'absolute', inset: 0 }} />
      <div ref={textRef} className="textLayer" />
    </div>
  );
}

// How far above and below the viewport pages keep their drawing: a page or two either way at the
// fitted size, so scrolling rarely meets a blank one.
const PAGE_WINDOW_MARGIN = '1000px 0px';

function releasePage(canvasHost, textLayer) {
  for (const canvas of canvasHost?.querySelectorAll('canvas') ?? []) {
    // Zero size frees the bitmap now rather than whenever the collector gets to it.
    canvas.width = 0;
    canvas.height = 0;
  }
  canvasHost?.replaceChildren();
  textLayer?.replaceChildren();
}

// Prints the given images, one per sheet, from a hidden same-origin frame: no pop-up to be
// blocked, and nothing of the app around them on paper. The frame goes inside the viewer, which is
// the one part of the page that is not inert. Returns { done, cancel }.
export function printImages(urls, title, container, isCurrent = () => true) {
  let cancel = () => {};
  const done = new Promise(resolve => {
    if (!isCurrent() || !container?.isConnected) { resolve(); return; }
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    // Moved off-screen rather than display:none, which some browsers decline to print.
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;opacity:0';
    let finished = false;
    let fallback = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(fallback);
      frame.remove();
      resolve();
    };
    cancel = finish;
    frame.addEventListener('load', () => {
      if (finished || !isCurrent() || !container.isConnected || !frame.isConnected) { finish(); return; }
      const win = frame.contentWindow;
      if (!win) { finish(); return; }
      win.addEventListener('afterprint', () => setTimeout(finish, 0), { once: true });
      win.focus();
      if (finished || !isCurrent() || !container.isConnected) { finish(); return; }
      win.print();
      if (finished) return;
      // Chrome blocks inside print() until the dialog closes; a browser that never fires
      // afterprint still gets its frame removed.
      fallback = setTimeout(finish, 60_000);
    }, { once: true });
    frame.srcdoc = printDocumentHtml(title, urls);
    container.appendChild(frame);
  });
  return { done, cancel };
}

function previewErrorText(t, file) {
  if (file.reason === 'unsupported') return t('message.preview.unsupported');
  if (file.reason === 'too-large') return t('gmail.attachments.previewTooLarge', 'This file is too large to preview. You can download it instead.');
  if ([400, 404, 409].includes(file.error?.status)) return t('gmail.attachments.unavailable', 'This attachment changed or is no longer available. Refresh the list and review it before trying again.');
  if (file.error?.status === 413) return t('gmail.attachments.tooLarge', 'This attachment is too large to download.');
  return t('message.preview.failed');
}
