import { extractHtmlSnippetText } from './messageParser.js';
import { extractImapError } from './imapError.js';

const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const READ_BYTES = 65536;
const PARTS_PER_READ = 4;
// ImapFlow exposes literal buffers, not a wire meter. Charge a conservative
// command/response allowance as well. This accounting is not wire-quota enforcement.
const COMMAND_OVERHEAD = 1024;
const STRUCTURE_BOUND = 262144;
const STRUCTURE_RESERVATION = 2 * COMMAND_OVERHEAD + STRUCTURE_BOUND;

function requiredText(structure, walkStructure) {
  const results = { textParts: [], attachments: [], inlineImages: [], calendarParts: [] };
  walkStructure(structure, results);
  const eligible = new Map((results.textParts.length ? results.textParts : results.calendarParts).map(p => [p.part, p]));
  const visit = node => {
    if (node.childNodes?.length) {
      const children = node.childNodes.map(visit).filter(parts => parts.length);
      if (node.type?.toLowerCase() !== 'multipart/alternative') return children.flat();
      const htmlSize = children.flat().reduce((size, p) => p.type === 'text/html' ? Math.max(size, p.size || 0) : size, 0);
      const rank = parts => parts.some(p => {
        const tiny = p.encoding?.toLowerCase() === 'base64' ? 4 : p.encoding?.toLowerCase() === 'quoted-printable' ? 6 : 2;
        return p.type === 'text/plain' && p.size > tiny && !(p.size < 512 && p.size * 5 < htmlSize);
      }) ? 0 : parts.some(p => p.type === 'text/html' && p.size > 2) ? 1 : 2;
      return children.sort((a, b) => rank(a) - rank(b))[0] || [];
    }
    const part = eligible.get(node.part || '1');
    return part ? [{ ...part, size: node.size }] : [];
  };
  return visit(structure);
}

/** Search reads never return publishable prefixes. Identity includes the selected
 * mailbox epoch; callers compare it to the durable job before atomic publication.
 * client, when supplied, is an exclusively leased existing background session.
 * admit performs one reservation without waiting for a future budget window.
 * reservedBodyBytes is a quotation, bound by the caller to identity/generation,
 * never prepaid credit. A retry reserves metadata and the quotation together.
 */
export async function fetchSearchText(account, uid, folder, options, { acquire, walkStructure, decodeBody, isConnectionRefusal, isAuthFailure }) {
  let downloadBytes = 0;
  let requiredParts = [];
  const quoted = options.admit && options.reservedBodyBytes != null;
  let bodyBytes = quoted ? options.reservedBodyBytes : null;
  let structureOverrunBytes = 0;
  let identity = options.admit ? { accountId: account.id, folder, uid: Number(uid), uidValidity: options.uidValidity?.toString() ?? null } : null;
  const incomplete = (status, reason) => ({ status, reason, complete: false, textParts: [], requiredParts, downloadBytes, identity, bodyBytes, structureOverrunBytes });
  try {
    options.signal?.throwIfAborted();
    if (options.admit) {
      if (quoted && (!Number.isSafeInteger(bodyBytes) || bodyBytes < 0 || !Number.isSafeInteger(STRUCTURE_RESERVATION + bodyBytes))) {
        return incomplete('retry', 'bound-changed');
      }
      let admission;
      try { admission = await options.admit({ messages: 1, bytes: STRUCTURE_RESERVATION + (quoted ? bodyBytes : 0) }); }
      catch (err) {
        if (options.signal?.aborted || err?.name === 'AbortError') throw err;
        return { ...incomplete('retry', 'budget-failed'), detail: err.message };
      }
      options.signal?.throwIfAborted();
      if (admission?.allowed !== true) return { ...incomplete('deferred', 'budget'), deferAt: admission?.deferAt };
    }
    const read = async client => {
      downloadBytes += COMMAND_OVERHEAD; // Selection/EXAMINE allowance, including a failed attempt.
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        const epoch = client.mailbox?.uidValidity?.toString();
        identity = { accountId: account.id, folder, uid: Number(uid), uidValidity: epoch };
        const current = () => {
          options.signal?.throwIfAborted();
          return epoch && client.mailbox?.path === folder && client.mailbox?.uidValidity?.toString() === epoch
            && (options.uidValidity == null || String(options.uidValidity) === epoch);
        };
        if (!current()) return incomplete('retry', 'stale-identity');
        let structure;
        let structureBytes = 0;
        downloadBytes += COMMAND_OVERHEAD;
        for await (const msg of client.fetch(String(uid), { uid: true, bodyStructure: true }, { uid: true, binary: false })) {
          if (msg.bodyStructure) {
            const bytes = Buffer.byteLength(JSON.stringify(msg.bodyStructure));
            downloadBytes += bytes;
            structureBytes += bytes;
          }
          if (Number(msg.uid) !== Number(uid)) return incomplete('retry', 'stale-identity');
          if (options.admit && structureBytes > STRUCTURE_BOUND) {
            // Measured after FETCH: preserve the overrun. The worker persists this
            // terminal identity/generation so it never repeatedly incurs this cost.
            structureOverrunBytes = structureBytes - STRUCTURE_BOUND;
            if (!current()) return incomplete('retry', 'stale-identity');
            return incomplete('unsupported', 'structure-too-large');
          }
          structure = msg.bodyStructure;
        }
        if (!current()) return incomplete('retry', 'stale-identity');
        if (!structure) return incomplete('retry', 'missing-structure');
        const parts = requiredText(structure, walkStructure);
        requiredParts = parts.map(p => p.part);
        if (parts.some(p => !Number.isSafeInteger(p.size) || p.size < 0)) return incomplete('retry', 'missing-part-size');
        if (parts.reduce((sum, p) => sum + p.size, 0) > MAX_TEXT_BYTES) return incomplete('unsupported', 'text-too-large');
        bodyBytes = parts.reduce((sum, p) => sum + p.size + (COMMAND_OVERHEAD + 64) * Math.max(1, Math.ceil(p.size / READ_BYTES)), 0);
        if (options.admit) {
          if (quoted) {
            if (bodyBytes > options.reservedBodyBytes) return incomplete('retry', 'bound-changed');
          } else {
            let admission;
            try { admission = await options.admit({ messages: 0, bytes: bodyBytes }); }
            catch (err) {
              if (options.signal?.aborted || err?.name === 'AbortError') throw err;
              // Budget storage failure is not a broken IMAP session: retain the pool lease.
              return { ...incomplete('retry', 'budget-failed'), detail: err.message };
            }
            if (!current()) return incomplete('retry', 'stale-identity');
            if (admission?.allowed !== true) return { ...incomplete('deferred', 'budget'), deferAt: admission?.deferAt };
          }
        }
        const buffers = new Map(parts.map(p => [p.part, []]));
        const offsets = new Map();
        while (parts.some(p => !offsets.has(p.part) || offsets.get(p.part) < p.size)) {
          if (!current()) return incomplete('retry', 'stale-identity');
          const batch = parts.filter(p => !offsets.has(p.part) || offsets.get(p.part) < p.size).slice(0, PARTS_PER_READ);
          const requests = batch.map(p => ({ key: p.part, start: offsets.get(p.part) || 0,
            maxLength: Math.min(READ_BYTES, Math.max(1, p.size - (offsets.get(p.part) || 0))) }));
          const received = new Map();
          downloadBytes += COMMAND_OVERHEAD + batch.length * 64;
          for await (const msg of client.fetch(String(uid), { uid: true, bodyParts: requests }, { uid: true, binary: false })) {
            for (const buf of msg.bodyParts?.values() || []) downloadBytes += buf?.length || 0;
            if (Number(msg.uid) !== Number(uid)) return incomplete('retry', 'stale-identity');
            for (const p of batch) {
              const buf = msg.bodyParts?.get(p.part);
              if (Buffer.isBuffer(buf)) received.set(p.part, buf);
            }
          }
          if (!current()) return incomplete('retry', 'stale-identity');
          for (const p of batch) {
            const buf = received.get(p.part);
            const offset = offsets.get(p.part) || 0;
            const expected = Math.min(READ_BYTES, p.size - offset);
            if (!buf || buf.length !== expected) return incomplete('retry', 'incomplete-part');
            buffers.get(p.part).push(buf);
            offsets.set(p.part, offset + buf.length);
          }
        }
        const textParts = [];
        const diagnostics = { lossyDecode: false };
        for (const p of parts) {
          let decoded;
          try { decoded = decodeBody(Buffer.concat(buffers.get(p.part)), p.encoding, p.charset, { diagnostics }); }
          catch (err) { return { ...incomplete('unsupported', err.code === 'decoder-discarded-input' ? err.code : 'text-decode-failed'), detail: err.message }; }
          const text = p.type === 'text/html'
            ? await extractHtmlSnippetText(decoded, Infinity, { yieldBetweenChunks: true, signal: options.signal }) : decoded;
          textParts.push({ part: p.part, text: text.replaceAll('\0', '') });
        }
        if (!current()) return incomplete('retry', 'stale-identity');
        if (textParts.reduce((sum, p) => sum + Buffer.byteLength(p.text), 0) > MAX_TEXT_BYTES) return incomplete('unsupported', 'text-too-large');
        return { textParts, requiredParts, complete: true, downloadBytes, identity, bodyBytes, structureOverrunBytes, ...diagnostics };
      } catch (err) {
        if (options.signal?.aborted || err?.name === 'AbortError') return incomplete('cancelled', 'cancelled');
        throw err;
      } finally { lock.release(); }
    };
    return options.client ? await read(options.client) : await acquire(account, read);
  } catch (err) {
    if (options.signal?.aborted || err?.name === 'AbortError') return incomplete('cancelled', 'cancelled');
    const detail = extractImapError(err);
    const classification = [err?.code, detail].filter(Boolean).join(' ');
    const status = err?.providerRefusing || isConnectionRefusal(classification) ? 'provider-refused'
      : isAuthFailure(classification) || /quota/i.test(classification) ? 'backoff' : 'retry';
    return { ...incomplete(status, 'fetch-failed'), detail, ...(err?.retryAfterMs != null ? { retryAfterMs: err.retryAfterMs } : {}) };
  }
}
