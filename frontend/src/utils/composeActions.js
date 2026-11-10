import { bareAddress } from './autoRecipients.js';

export function introRecipients(to, bcc) {
  const seen = new Set();
  return [...bcc, ...to].filter(chip => {
    const key = bareAddress(chip);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function isInstantIntroShortcut(event, layout, overrides = {}) {
  if (layout !== 'superhuman' || event?.defaultPrevented || event?.repeat || event?.isComposing
    || event?.nativeEvent?.isComposing || event?.keyCode === 229) return false;
  if (String(event?.key).toLowerCase() !== 'i' || !event.shiftKey || event.altKey || (!!event.ctrlKey === !!event.metaKey)) return false;
  return !Object.values(overrides).some(value => {
    const parts = typeof value === 'string' ? value.toLowerCase().split('+').map(part => part.trim()) : [];
    return parts.length === 3 && parts.includes('ctrl') && parts.includes('shift') && parts.includes('i');
  });
}

export function replyArchiveContext(data) {
  if (!(data?.isReply || data?.isReplyAll) || data?.isForward) return null;
  const { accountId, threadId, inReplyTo } = data.replyArchiveContext || data;
  return accountId && threadId && inReplyTo ? { accountId, threadId, inReplyTo } : null;
}

export async function captureReplyArchive(context, getThread) {
  if (!context) throw new Error('Reply identity unavailable');
  const data = await getThread(context.threadId);
  const messages = (data?.messages || []).filter(message => message.account_id === context.accountId && message.thread_id === context.threadId);
  if (!messages.some(message => message.message_id === context.inReplyTo)) throw new Error('Reply parent unavailable');
  const ids = [...new Set(messages.filter(message => message.folder?.toUpperCase() === 'INBOX' && !message.is_deleted).map(message => message.id).filter(Boolean))];
  if (!ids.length || ids.length > 500) throw new Error('Reply archive unavailable');
  return ids;
}

// Called only by the held-send's confirmed-success callback. The server independently reads
// its durable send receipt and rechecks the original account/thread/INBOX for these exact IDs.
// Never retry a failed archive response: the IMAP move may have happened already.
export async function finishReplyArchive({ context, ids, pendingId, result }, { stillOwner, archive }) {
  if (!stillOwner()) return { status: 'abandoned', archived: [] };
  if (!pendingId || !context || !ids?.length || result?.ok !== true || result.pending
    || result.rejected?.length || result.sentCopySaved === false) return { status: 'unavailable', archived: [] };
  try {
    const answer = await archive(ids, { ...context, pendingId });
    if (!stillOwner()) return { status: 'abandoned', archived: [] };
    const archived = [...new Set((answer?.archived || []).filter(id => ids.includes(id)))];
    return { status: archived.length === ids.length ? 'archived' : 'incomplete', archived };
  } catch {
    return { status: stillOwner() ? 'unconfirmed' : 'abandoned', archived: [] };
  }
}
