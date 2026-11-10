// The only module that touches pdf.js. It is imported on demand, so the PDF engine (about 1.7 MB
// with its worker) is fetched the first time someone previews a PDF rather than with the app.
//
// Two settings follow from the app's Content-Security-Policy rather than from taste:
// - useWasm: false. WebAssembly needs 'wasm-unsafe-eval', which script-src does not grant, so the
//   JBIG2 and JPEG 2000 decoders that scanned documents rely on load as their pure-JavaScript
//   builds instead, from /pdfjs/wasm/ (copied there by vite.config.js).
// - No scripting. Nothing here creates pdf.js's scripting sandbox, so JavaScript inside a PDF never
//   runs, and forms and links are drawn as part of the page rather than made live.

import { printDpi, printScale } from './attachmentPreview.js';

let enginePromise = null;
// pdf.js refuses to start a document on the shared worker while an earlier one is still being torn
// down, and moving from one PDF attachment to the next (or retrying a password) does exactly that.
// Every teardown is chained here and every open waits for it.
let teardown = Promise.resolve();

const tasks = new Set();
const destroyed = new WeakMap();
let ownedWorker = null;
let engine = null;

function releaseWorker() {
  if (tasks.size || !ownedWorker) return;
  ownedWorker.terminate();
  if (engine?.GlobalWorkerOptions.workerPort === ownedWorker) engine.GlobalWorkerOptions.workerPort = null;
  ownedWorker = null;
}

function destroyTask(task) {
  if (destroyed.has(task)) return destroyed.get(task);
  teardown = teardown.then(() => task.destroy()).catch(() => {}).finally(() => {
    tasks.delete(task);
    releaseWorker();
  });
  destroyed.set(task, teardown);
  return teardown;
}

function loadEngine() {
  enginePromise ??= import('pdfjs-dist').then(pdfjs => {
    engine = pdfjs;
    return pdfjs;
  }).catch(err => {
    enginePromise = null;
    throw err;
  });
  return enginePromise;
}

const cancelledError = () => Object.assign(new Error('Attachment operation cancelled'), { name: 'AbortError' });

// Opens a PDF from its bytes. Resolves { doc, pdfjs, destroy }. An encrypted PDF rejects with
// pdf.js's PasswordException until it is given the right password.
export async function openPdf(bytes, { password, signal, isCancelled } = {}) {
  const cancelled = () => signal?.aborted || isCancelled?.();
  if (cancelled()) throw cancelledError();
  const pdfjs = await loadEngine();
  if (cancelled()) throw cancelledError();
  await teardown;
  if (cancelled()) throw cancelledError();
  if (!pdfjs.GlobalWorkerOptions.workerPort) {
    ownedWorker = new Worker(new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url), { type: 'module' });
    pdfjs.GlobalWorkerOptions.workerPort = ownedWorker;
  }
  // Versioned like the files themselves (vite.config.js), so an upgrade never reads stale ones.
  const base = `${window.location.origin}/pdfjs/${pdfjs.version}/`;
  let task;
  try { task = pdfjs.getDocument({
    // pdf.js moves the buffer it is given into its worker, which empties it on this side. The
    // viewer still needs the bytes for Download, so pdf.js gets a copy.
    data: bytes.slice(),
    useWasm: false,
    wasmUrl: `${base}wasm/`,
    standardFontDataUrl: `${base}standard_fonts/`,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    enableXfa: false,
    ...(password ? { password } : {}),
  }); } catch (err) {
    releaseWorker();
    throw err;
  }
  tasks.add(task);
  const destroy = () => {
    signal?.removeEventListener('abort', destroy);
    return destroyTask(task);
  };
  signal?.addEventListener('abort', destroy, { once: true });
  if (cancelled()) destroy();
  try {
    const doc = await task.promise;
    if (cancelled()) { await destroy(); throw cancelledError(); }
    return { doc, pdfjs, destroy };
  } catch (err) {
    await destroy();
    throw err;
  }
}

// Draws one page into `canvas`, then its text into `textContainer` as transparent, selectable
// spans laid over the drawing: that is what lets a boleto's digitable line be copied, and the
// browser's own Find reach the words on the page. Returns { done, cancel }.
export function renderPage({ doc, pdfjs }, pageNumber, { canvas, textContainer, scale, pixelRatio = 1, isCancelled }) {
  let cancelled = false;
  let renderTask = null;
  let textLayer = null;
  const current = () => !cancelled && !isCancelled?.();
  const run = async () => {
    const page = await doc.getPage(pageNumber);
    if (!current()) return;
    const viewport = page.getViewport({ scale });
    canvas.width = Math.max(1, Math.floor(viewport.width * pixelRatio));
    canvas.height = Math.max(1, Math.floor(viewport.height * pixelRatio));
    renderTask = page.render({
      canvas,
      viewport,
      transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
    });
    await renderTask.promise;
    if (!current() || !textContainer) return;
    textContainer.replaceChildren();
    textContainer.style.setProperty('--total-scale-factor', String(viewport.scale));
    textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textContainer, viewport });
    await textLayer.render();
    if (!current()) textContainer.replaceChildren();
  };
  const done = run().catch(err => {
    if (!current() || err?.name === 'RenderingCancelledException') return;
    throw err;
  });
  return {
    done,
    cancel() {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
      canvas.width = 0;
      canvas.height = 0;
      textContainer?.replaceChildren();
    },
  };
}

// Renders every page for printing and returns one image URL per page, in order. The caller
// revokes the URLs once printing is over.
export async function renderPagesForPrint({ doc }, {
  onProgress, isCancelled, signal,
  createObjectURL = blob => URL.createObjectURL(blob), revokeObjectURL = url => URL.revokeObjectURL(url),
} = {}) {
  const urls = [];
  const dpi = printDpi(doc.numPages);
  let task = null;
  let canvas = null;
  const check = () => { if (signal?.aborted || isCancelled?.()) throw cancelledError(); };
  const cancel = () => {
    task?.cancel();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      check();
      const page = await doc.getPage(n);
      try {
        check();
        const natural = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: printScale(natural.width, natural.height, dpi) });
        canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        task = page.render({ canvas, viewport, intent: 'print' });
        await task.promise;
        check();
        const blob = await new Promise((resolve, reject) => canvas.toBlob(
          b => (b ? resolve(b) : reject(new Error('Could not encode the page for printing'))), 'image/png'));
        check();
        const url = createObjectURL(blob);
        if (url) urls.push(url);
        check();
        onProgress?.(n, doc.numPages);
      } finally {
        if (canvas) { canvas.width = 0; canvas.height = 0; }
        canvas = null;
        task = null;
        page.cleanup();
      }
    }
    check();
    return urls;
  } catch (err) {
    urls.forEach(revokeObjectURL);
    throw err;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}
