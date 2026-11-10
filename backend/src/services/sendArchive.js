import { getSendStatus } from './sendHold.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const refuse = (status, message) => Object.assign(new Error(message), { status });

// Send + Archive is deliberately narrower than manual Archive: a durable confirmed send,
// and only the pinned reply's still-present INBOX rows. New mail is never added to the IDs.
export async function selectSendArchiveTargets(userId, context, owned, statusOf = getSendStatus) {
  if (!context || typeof context !== 'object' || Array.isArray(context)
    || !UUID.test(context.pendingId || '') || !UUID.test(context.accountId || '')
    || typeof context.threadId !== 'string' || !context.threadId || context.threadId.length > 1000
    || typeof context.inReplyTo !== 'string' || !context.inReplyTo || context.inReplyTo.length > 1000) {
    throw refuse(400, 'Invalid send archive context');
  }
  const receipt = await statusOf(userId, context.pendingId);
  if (receipt?.status !== 'sent' || receipt.result?.ok !== true || receipt.result?.rejected?.length
    || receipt.result?.sentCopySaved === false) throw refuse(409, 'Send is not confirmed complete; nothing was archived');
  return owned.filter(message => message.account_id === context.accountId && message.thread_id === context.threadId
    && message.folder?.toUpperCase() === 'INBOX' && !message.is_deleted);
}
