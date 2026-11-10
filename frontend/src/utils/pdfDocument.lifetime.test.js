import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { setImmediate } from 'node:timers';
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('/pdfjs-dist/build/pdf.mjs')) return { format: 'module', shortCircuit: true, source: `
    export const version = 'test';
    export const GlobalWorkerOptions = { workerPort: null };
    export const getDocument = params => globalThis.__getDocument(params);
  ` };
  return nextLoad(url, context);
} });
const { openPdf, renderPage, renderPagesForPrint } = await import('./pdfDocument.js');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let workers = 0, terminated = 0, destroyed = 0, calls = 0, created = [], revoked = [], canvases = [];
globalThis.window = { location: { origin: 'https://mail.test' } };
globalThis.Worker = class { constructor() { workers++; } terminate() { terminated++; } };
globalThis.__getDocument = () => { calls++; return { promise: Promise.resolve({ numPages: 1 }), destroy() { destroyed++; } }; };
globalThis.document = { createElement() { const canvas = { width: 0, height: 0, toBlob(fn) { fn(new Blob(['page'])); } }; canvases.push(canvas); return canvas; } };
URL.createObjectURL = () => { const url = `blob:page-${created.length}`; created.push(url); return url; };
URL.revokeObjectURL = url => revoked.push(url);
const bytes = new TextEncoder().encode('%PDF-1.7');
afterEach(() => { created = []; revoked = []; canvases = []; });

test('a cancelled PDF engine import never starts a worker or document', async () => {
  const before = { workers, calls }; const controller = new AbortController();
  const opening = openPdf(bytes, { signal: controller.signal }); controller.abort();
  await assert.rejects(opening, { name: 'AbortError' });
  assert.equal(workers, before.workers); assert.equal(calls, before.calls);
});

test('abort destroys a pending PDF task, late completion never escapes, and the last worker terminates', async () => {
  const openingDoc = deferred(), started = deferred(); const controller = new AbortController();
  globalThis.__getDocument = () => { started.resolve(); return { promise: openingDoc.promise, destroy() { destroyed++; } }; };
  const before = { destroyed, terminated }; const opening = openPdf(bytes, { signal: controller.signal });
  await started.promise; controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(destroyed, before.destroyed + 1);
  openingDoc.resolve({ numPages: 1 });
  await assert.rejects(opening, { name: 'AbortError' });
  assert.equal(destroyed, before.destroyed + 1, 'destruction is idempotent');
  assert.equal(terminated, before.terminated + 1);
});

test('normal PDF close terminates its worker exactly once', async () => {
  globalThis.__getDocument = () => ({ promise: Promise.resolve({ numPages: 1 }), destroy() { destroyed++; } });
  const before = { destroyed, terminated }; const pdf = await openPdf(bytes);
  await Promise.all([pdf.destroy(), pdf.destroy()]);
  assert.equal(destroyed, before.destroyed + 1); assert.equal(terminated, before.terminated + 1);
});

test('cancelled page lookup cannot allocate a print canvas or render', async () => {
  const lookup = deferred(); let rendered = 0, cleaned = 0; const controller = new AbortController();
  const work = renderPagesForPrint({ doc: { numPages: 1, getPage: () => lookup.promise } }, { signal: controller.signal });
  controller.abort(); lookup.resolve({ render() { rendered++; }, cleanup() { cleaned++; } });
  await assert.rejects(work, { name: 'AbortError' });
  assert.equal(rendered, 0); assert.equal(canvases.length, 0); assert.equal(cleaned, 1);
});

test('cancelled print render cancels its task and frees canvas before the renderer settles', async () => {
  const render = deferred(), started = deferred(); let cancelled = 0, cleaned = 0; const controller = new AbortController();
  const page = { getViewport: () => ({ width: 30, height: 40 }), render() { started.resolve(); return { promise: render.promise, cancel() { cancelled++; } }; }, cleanup() { cleaned++; } };
  const work = renderPagesForPrint({ doc: { numPages: 1, getPage: async () => page } }, { signal: controller.signal });
  await started.promise; controller.abort();
  assert.equal(cancelled, 1); assert.equal(canvases[0].width, 0); assert.equal(canvases[0].height, 0);
  render.resolve(); await assert.rejects(work, { name: 'AbortError' });
  assert.equal(created.length, 0); assert.equal(cleaned, 1);
});

test('cancelled print blob cannot create a URL or report progress', async () => {
  const encoding = deferred(); let encode, cleaned = 0, progress = 0; const controller = new AbortController();
  globalThis.document.createElement = () => { const canvas = { width: 0, height: 0, toBlob(fn) { encode = fn; encoding.resolve(); } }; canvases.push(canvas); return canvas; };
  const page = { getViewport: () => ({ width: 30, height: 40 }), render: () => ({ promise: Promise.resolve(), cancel() {} }), cleanup() { cleaned++; } };
  const work = renderPagesForPrint({ doc: { numPages: 1, getPage: async () => page } }, { signal: controller.signal, onProgress() { progress++; } });
  await encoding.promise; controller.abort(); encode(new Blob(['late']));
  await assert.rejects(work, { name: 'AbortError' });
  assert.equal(created.length, 0); assert.equal(progress, 0); assert.equal(cleaned, 1);
  assert.equal(canvases[0].width, 0);
});

test('cancellation between print pages revokes earlier page URLs instead of returning a partial print', async () => {
  let cancelled = false;
  globalThis.document.createElement = () => { const canvas = { width: 0, height: 0, toBlob(fn) { fn(new Blob(['page'])); } }; canvases.push(canvas); return canvas; };
  const page = { getViewport: () => ({ width: 30, height: 40 }), render: () => ({ promise: Promise.resolve() }), cleanup() {} };
  const work = renderPagesForPrint({ doc: { numPages: 2, getPage: async () => page } }, { isCancelled: () => cancelled, onProgress() { cancelled = true; } });
  await assert.rejects(work, { name: 'AbortError' }); assert.deepEqual(revoked, created); assert.equal(created.length, 1);
});

test('cancelled display render frees scratch canvas and never creates a late text layer', async () => {
  const draw = deferred(), started = deferred(); let layers = 0;
  const canvas = { width: 0, height: 0 }; const text = { replaceChildren() {}, style: { setProperty() {} } };
  const page = { getViewport: () => ({ width: 30, height: 40 }), render() { started.resolve(); return { promise: draw.promise, cancel() {} }; } };
  const job = renderPage({ doc: { getPage: async () => page }, pdfjs: { TextLayer: class { constructor() { layers++; } } } }, 1, { canvas, textContainer: text, scale: 1 });
  await started.promise; job.cancel(); draw.resolve(); await job.done;
  assert.equal(canvas.width, 0); assert.equal(canvas.height, 0); assert.equal(layers, 0);
});
