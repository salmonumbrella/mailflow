import { copyAttachmentSource } from './attachmentSource.js';

export const staleAttachmentError = () => Object.assign(new Error('Attachment action is no longer current'), {
  name: 'AbortError', code: 'attachment_stale',
});
const accountKey = account => account ? JSON.stringify([
  account.id, account.user_id, account.storage_generation, account.enabled !== false,
  account.email_address, account.imap_host, account.imap_username,
]) : null;

function createScope({ source, check, onInvalidate, eventTarget, parent }) {
  const controller = new AbortController();
  const cleanups = new Set();
  const urls = new Set();
  let ended = false;
  let authReported = false;
  const invalidate = () => {
    if (ended) return;
    ended = true;
    controller.abort();
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
    for (const cleanup of [...cleanups]) {
      try { cleanup(); } catch { /* One failed cleanup must not retain another resource. */ }
    }
    cleanups.clear();
    onInvalidate?.();
  };
  const current = (...args) => {
    if (!ended) {
      try { if (!check(...args)) invalidate(); } catch { invalidate(); }
    }
    return !ended;
  };
  const assertCurrent = () => { if (!current()) throw staleAttachmentError(); };
  const addCleanup = cleanup => {
    if (ended) cleanup();
    else cleanups.add(cleanup);
    return () => cleanups.delete(cleanup);
  };
  const scope = {
    source, signal: controller.signal, current, assertCurrent, invalidate, dispose: invalidate, addCleanup,
    fork() {
      const child = createScope({ source, check: current, eventTarget, parent: scope });
      const unregister = addCleanup(child.dispose);
      child.addCleanup(unregister);
      child.current();
      return child;
    },
    createObjectURL(blob) {
      assertCurrent();
      const url = URL.createObjectURL(blob);
      // URL creation itself can run an injected/native callback that ends the owner.
      if (!current()) { URL.revokeObjectURL(url); throw staleAttachmentError(); }
      urls.add(url);
      return url;
    },
    revokeObjectURL(url) {
      if (urls.delete(url)) URL.revokeObjectURL(url);
    },
    reportAuth(status) {
      if (!current() || authReported || (status !== 401 && status !== 423)) return;
      if (parent) { parent.reportAuth(status); return; }
      authReported = true;
      eventTarget?.dispatchEvent(new CustomEvent(status === 423 ? 'mailflow:locked' : 'mailflow:session_expired'));
    },
  };
  return scope;
}

function ownerScope({ store, source, sourceCurrent, scopeKey, onInvalidate, eventTarget = globalThis.window }, verified) {
  const frozen = copyAttachmentSource(source);
  const initial = store.getState();
  const userId = initial.user?.id;
  const epoch = initial.attachmentSessionEpoch;
  const account = frozen && initial.accounts?.find(item => item.id === frozen.accountId);
  const originalAccount = accountKey(account);
  let originalScope;
  try { originalScope = scopeKey?.(initial); } catch { originalScope = null; }
  const check = (state = store.getState()) => {
    if (!userId || state.user?.id !== userId || state.isLocked || state.attachmentSignOutPending
      || state.attachmentSessionEpoch !== epoch) return false;
    if (verified) {
      if (!frozen || typeof sourceCurrent !== 'function') return false;
      const currentAccount = state.accounts?.find(item => item.id === frozen.accountId);
      if (!currentAccount || currentAccount.enabled === false || currentAccount.storage_generation !== frozen.storageGeneration
        || (currentAccount.user_id != null && currentAccount.user_id !== userId)
        || accountKey(currentAccount) !== originalAccount) return false;
    }
    return (!sourceCurrent || sourceCurrent(state) === true)
      && (!scopeKey || (originalScope != null && scopeKey(state) === originalScope));
  };
  const scope = createScope({ source: frozen, check, onInvalidate, eventTarget });
  scope.addCleanup(store.subscribe((state, previous) => {
    // Zustand listeners can synchronously restore state before later listeners run.
    // The transition's previous state still exposes that interrupted lifetime.
    if (previous) scope.current(previous);
    scope.current(state);
  }));
  for (const type of ['mailflow:will-lock', 'pagehide', 'popstate']) {
    eventTarget?.addEventListener(type, scope.invalidate);
    scope.addCleanup(() => eventTarget?.removeEventListener(type, scope.invalidate));
  }
  scope.current();
  return scope;
}

// The caller proves its mounted/visible owner on every synchronous store transition.
export function createAttachmentActionScope(options) {
  return ownerScope(options, true);
}

// Existing reader viewers have no verified metadata envelope yet. This explicit path
// provides cancellation only and must never be used as a missing-proof fallback.
export function createAttachmentSessionScope(options) {
  return ownerScope(options, false);
}

export function downloadAttachmentBytes(scope, bytes, filename, type = 'application/octet-stream') {
  if (!scope.current()) return false;
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: type || 'application/octet-stream' });
  let url;
  let anchor;
  let clicked = false;
  try {
    url = scope.createObjectURL(blob);
    anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename || 'attachment';
    document.body.appendChild(anchor);
    if (!scope.current()) return false;
    anchor.click();
    clicked = true;
    const timer = setTimeout(() => { scope.revokeObjectURL(url); unregister(); }, 10000);
    const unregister = scope.addCleanup(() => clearTimeout(timer));
    return true;
  } catch (error) {
    if (!scope.current()) return false;
    throw error;
  } finally {
    anchor?.remove();
    if (url && !clicked) scope.revokeObjectURL(url);
  }
}
