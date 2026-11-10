import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.includes('react-i18next')) return { format: 'module', shortCircuit: true,
      source: 'export const useTranslation = () => ({ t: (key, fallback) => typeof fallback === "string" ? fallback : key });' };
    if (url.endsWith('/utils/pdfDocument.js')) return { format: 'module', shortCircuit: true, source: `
      export const openPdf = (...args) => globalThis.__pdf.open(...args);
      export const renderPage = (...args) => globalThis.__pdf.render(...args);
      export const renderPagesForPrint = (...args) => globalThis.__pdf.print(...args);
    ` };
    if (url.endsWith('/utils/api.js')) return { format: 'module', shortCircuit: true, source: "export const API_BASE = '/api'; export const CSRF_HEADER = 'X-Requested-With'; export const CSRF_VALUE = 'XMLHttpRequest';" };
    if (url.endsWith('/store/index.js')) return { format: 'module', shortCircuit: true,
      source: 'export const useStore = globalThis.__viewerStore;' };
    if (url.endsWith('.jsx')) return { format: 'module', shortCircuit: true,
      source: transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url }).code };
    return nextLoad(url, context);
  },
});
const dom = new JSDOM('<button id="origin">Open</button><div id="root"></div>', { url: 'https://mail.test', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  MutationObserver: dom.window.MutationObserver, ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true });
const session = { user: { id: 'user' }, accounts: [] };
globalThis.__viewerStore = { getState: () => session, subscribe: () => () => {} };
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const AttachmentViewer = (await import('./AttachmentViewer.jsx')).default;
const source = Object.freeze({ messageId: '11111111-1111-4111-8111-111111111111', accountId: '22222222-2222-4222-8222-222222222222',
  storageGeneration: '33333333-3333-4333-8333-333333333333', entityId: '44444444-4444-4444-8444-444444444444', folder: 'INBOX', uidValidity: '9', uid: '3' });
const png = new Uint8Array([137,80,78,71,13,10,26,10]);
const pdfBytes = new TextEncoder().encode('%PDF-1.7');
const att = (part = '2', filename = 'photo.png') => ({ part, filename, type: 'image/png', size: 8 });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let created = [], revoked = [], clicked = [], root, scopes = [], requests = [], pending = [], currentProps;
URL.createObjectURL = blob => { const url = `blob:test-${created.length}`; created.push({ url, blob }); return url; };
URL.revokeObjectURL = url => revoked.push(url);
window.HTMLAnchorElement.prototype.click = function () { clicked.push({ filename: this.download, href: this.href }); };
globalThis.fetch = async (...args) => { requests.push(args); const next = pending.shift(); return next ? await next : { ok: true, status: 200, arrayBuffer: async () => png.buffer }; };
function scope(parent) {
  let active = true;
  const cleanups = new Set();
  const controller = new AbortController();
  const value = { source, reportAuth() {}, signal: controller.signal, current: () => active && (!parent || parent.current()),
    addCleanup(fn) { cleanups.add(fn); return () => cleanups.delete(fn); },
    fork() { return scope(value); },
    createObjectURL(blob) { if (!value.current()) return null; const url = URL.createObjectURL(blob); value.addCleanup(() => URL.revokeObjectURL(url)); return url; },
    revokeObjectURL: url => URL.revokeObjectURL(url),
    dispose() { if (!active) return; active = false; controller.abort(); cleanups.forEach(fn => fn()); cleanups.clear(); },
  };
  value.invalidate = value.dispose;
  parent?.addCleanup(value.dispose);
  scopes.push(value);
  return value;
}
async function mount(overrides = {}) {
  if (!root) root = createRoot(document.getElementById('root'));
  currentProps = { messageId: source.messageId, attachments: [att()], source, scope: scope(), onClose: () => {}, ...overrides };
  await React.act(async () => root.render(React.createElement(AttachmentViewer, currentProps)));
}
async function update(overrides) { currentProps = { ...currentProps, ...overrides }; await React.act(async () => root.render(React.createElement(AttachmentViewer, currentProps))); }
const button = key => document.querySelector(`button[aria-label="message.preview.${key}"]`);
async function click(key) { await React.act(async () => button(key).click()); }
afterEach(async () => {
  if (root) await React.act(async () => root.unmount());
  root = null; scopes.forEach(s => s.dispose()); scopes = [];
  created = []; revoked = []; clicked = []; requests = []; pending = [];
  document.getElementById('origin').focus();
});

test('same-part metadata replacement cannot render or download prior bytes under a new name', async () => {
  await mount(); assert.equal(document.querySelector('img').alt, 'photo.png');
  const bytes = deferred(); pending.push(Promise.resolve({ ok: true, status: 200, arrayBuffer: () => bytes.promise }));
  await update({ attachments: [att('2', 'replacement.png')] });
  assert.equal(Boolean(document.querySelector('img')), false);
  await click('download'); assert.equal(clicked.length, 0);
  assert.ok(revoked.includes('blob:test-0'));
  await React.act(async () => bytes.resolve(png.buffer));
  assert.equal(document.querySelector('img').alt, 'replacement.png');
});

test('scope invalidation while bytes resolve cannot allocate or display a late raster URL', async () => {
  const bytes = deferred(); pending.push(Promise.resolve({ ok: true, status: 200, arrayBuffer: () => bytes.promise }));
  const owner = scope(); await mount({ scope: owner });
  await React.act(async () => { owner.dispose(); bytes.resolve(png.buffer); });
  assert.equal(created.length, 0); assert.equal(Boolean(document.querySelector('img')), false);
});

test('actual bytes over 30 MiB are download-only even when metadata understates the size', async () => {
  const large = new Uint8Array(30 * 1024 * 1024 + 1); large.set(png);
  pending.push(Promise.resolve({ ok: true, status: 200, arrayBuffer: async () => large.buffer }));
  await mount();
  assert.equal(Boolean(document.querySelector('img')), false); assert.equal(created.length, 0);
  await click('download'); assert.equal(clicked.length, 1); assert.equal(created[0].blob.size, large.length);
});

test('closing revokes raster and downloaded URLs without waiting for the download timer', async () => {
  await mount(); await click('download'); assert.equal(created.length, 2);
  await React.act(async () => root.unmount()); root = null;
  assert.ok(created.every(({ url }) => revoked.includes(url)));
});

test('a cancelled hidden print frame never prints from a delayed load event', async () => {
  await mount();
  const createElement = document.createElement.bind(document);
  let loaded, frame, prints = 0;
  document.createElement = (...args) => {
    const el = createElement(...args);
    if (args[0] === 'iframe') {
      frame = el;
      el.addEventListener = (name, fn) => { if (name === 'load') loaded = fn; };
      Object.defineProperty(el, 'contentWindow', { value: { addEventListener() {}, focus() {}, print() { prints++; } } });
    }
    return el;
  };
  try {
    await click('print'); assert.ok(frame); assert.equal(prints, 0);
    await React.act(async () => root.unmount()); root = null;
    loaded();
    assert.equal(prints, 0); assert.equal(frame.isConnected, false);
  } finally { document.createElement = createElement; }
});

test('PDF opened after close is destroyed and never publishes pages', async () => {
  const opened = deferred(); let destroyed = 0, pages = 0;
  globalThis.__pdf = { open: () => opened.promise };
  pending.push(Promise.resolve({ ok: true, status: 200, arrayBuffer: async () => pdfBytes.buffer }));
  await mount({ attachments: [att('2', 'file.pdf')] });
  await React.act(async () => root.unmount()); root = null;
  await React.act(async () => opened.resolve({ doc: { numPages: 1, getPage() { pages++; } }, destroy() { destroyed++; } }));
  assert.equal(destroyed, 1); assert.equal(pages, 0);
});

test('deferred PDF print cannot create a frame after scope invalidation and revokes its pages', async () => {
  const pages = deferred(); let printingOptions, destroyed = 0;
  globalThis.__pdf = {
    open: async () => ({ doc: { numPages: 1, getPage: async () => ({ getViewport: () => ({ width: 100, height: 150 }) }) }, destroy() { destroyed++; } }),
    print: (_pdf, options) => { printingOptions = options; return pages.promise; },
  };
  pending.push(Promise.resolve({ ok: true, status: 200, arrayBuffer: async () => pdfBytes.buffer }));
  const owner = scope(); await mount({ attachments: [att('2', 'file.pdf')], scope: owner });
  await click('print'); assert.ok(printingOptions);
  await React.act(async () => owner.dispose());
  assert.equal(printingOptions.isCancelled(), true);
  await React.act(async () => pages.resolve(['blob:late-print']));
  assert.equal(Boolean(document.querySelector('iframe')), false);
  assert.ok(revoked.includes('blob:late-print')); assert.equal(destroyed, 1);
});

test('legacy reader stays headerless, supports download, and restores focus only on a normal close', async () => {
  const origin = document.getElementById('origin'); origin.focus();
  await mount({ source: null, scope: null, onClose: () => { root.unmount(); root = null; } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0][1].headers['X-Mailflow-Message-Source'], undefined);
  await click('download'); assert.equal(clicked[0].filename, 'photo.png');
  await click('close'); assert.equal(document.activeElement === origin, true);
  assert.equal(document.getElementById('root').hasAttribute('inert'), false);
});
