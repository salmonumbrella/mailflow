import { API_BASE, CSRF_HEADER, CSRF_VALUE } from './api.js';
import { attachmentSourceKey, copyAttachmentSource, encodeAttachmentSource } from './attachmentSource.js';
import { staleAttachmentError } from './attachmentActions.js';
export { downloadAttachmentBytes } from './attachmentActions.js';

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const invalid = () => Object.assign(new Error('Invalid attachment source or part'), { status: 400, code: 'attachment_invalid' });
const tooLarge = () => Object.assign(new Error('Attachment is too large'), { status: 413, code: 'attachment_too_large' });
const assertCurrent = scope => { if (!scope?.current()) throw staleAttachmentError(); };
const validPart = part => typeof part === 'string' && part.length <= 128 && /^[1-9]\d*(?:\.[1-9]\d*)*$/.test(part);

async function readBytes(response, scope, maxBytes) {
  const length = response.headers?.get('Content-Length');
  if (length && /^\d+$/.test(length) && Number(length) > maxBytes) {
    // Do not await cancellation: a provider that ignores abort cannot delay invalidation.
    Promise.resolve(response.body?.cancel()).catch(() => {});
    throw tooLarge();
  }
  if (!response.body?.getReader) {
    const buffer = await response.arrayBuffer();
    assertCurrent(scope);
    if (buffer.byteLength > maxBytes) throw tooLarge();
    return new Uint8Array(buffer);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let cancelled = false;
  let complete = false;
  const cancel = () => {
    if (cancelled || complete) return;
    cancelled = true;
    Promise.resolve(reader.cancel()).catch(() => {});
  };
  const unregister = scope.addCleanup(cancel);
  try {
    while (true) {
      assertCurrent(scope);
      const { done, value } = await reader.read();
      assertCurrent(scope);
      if (done) { complete = true; break; }
      if (!(value instanceof Uint8Array) || size + value.byteLength > maxBytes) throw tooLarge();
      size += value.byteLength;
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    assertCurrent(scope);
    return bytes;
  } finally {
    cancel();
    unregister();
    chunks.length = 0;
    reader.releaseLock?.();
  }
}

async function requestBytes({ messageId, part, header, scope, maxBytes = MAX_ATTACHMENT_BYTES, fetchImpl = globalThis.fetch }) {
  if (!validPart(part) || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_ATTACHMENT_BYTES) throw invalid();
  assertCurrent(scope);
  try {
    const response = await fetchImpl(`${API_BASE}/mail/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part)}`, {
      credentials: 'include', cache: 'no-store', signal: scope.signal,
      headers: { [CSRF_HEADER]: CSRF_VALUE, ...(header ? { 'X-Mailflow-Message-Source': header } : {}) },
    });
    assertCurrent(scope);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      assertCurrent(scope);
      const error = Object.assign(new Error(typeof data?.error === 'string' ? data.error : 'Attachment request failed'), {
        status: response.status, ...(typeof data?.code === 'string' ? { code: data.code } : {}),
      });
      scope.reportAuth(response.status);
      throw error;
    }
    const bytes = await readBytes(response, scope, maxBytes);
    assertCurrent(scope);
    return bytes;
  } catch (error) {
    if (!scope.current()) throw staleAttachmentError();
    throw error;
  }
}

export async function fetchAttachmentBytes({ source, part, scope, ...options }) {
  const frozen = copyAttachmentSource(source);
  const header = encodeAttachmentSource(frozen);
  if (!header) throw invalid();
  if (!scope?.source || attachmentSourceKey(scope.source) !== attachmentSourceKey(frozen)) {
    throw Object.assign(new Error('Attachment source changed'), { status: 409, code: 'identity_source_changed' });
  }
  return requestBytes({ ...options, source: frozen, messageId: frozen.messageId, part, header, scope });
}

// Compatibility for the preexisting reader viewer only. Never call this because a
// verified request failed, or because a chip's source was missing or became stale.
export async function fetchLegacyAttachmentBytes({ messageId, part, scope, ...options }) {
  if (typeof messageId !== 'string' || !messageId.length || scope?.source) throw invalid();
  return requestBytes({ ...options, messageId, part, scope });
}
