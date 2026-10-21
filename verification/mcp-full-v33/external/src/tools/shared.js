import { z } from 'zod';
import { MailflowError } from '../mailflowClient.js';
import { RecipientError } from '../replies.js';
import { ToolError } from '../errors.js';
import { mapSettled } from '../concurrency.js';
import { displayAddress, formatDate, oneLine } from '../format.js';
import { pathLabel } from '../folders.js';

// MailFlow's ids are Postgres UUIDs in any hex form; zod's uuid() would also demand RFC version
// nibbles, which MailFlow does not. Both cases are spelled out because JSON Schema has no /i.
export const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const CATEGORIES = ['primary', 'newsletter', 'promotion', 'automated', 'social'];
export const LOOKUP_CONCURRENCY = 4;

export function uuidField(what) {
  return z.string().regex(UUID_PATTERN, `${what} must be a MailFlow id (a UUID such as 1b4e28ba-2fa1-11d2-883f-0016d3cca427)`);
}

export function idsField(max) {
  return z.array(uuidField('Each id')).min(1).max(max);
}

export const messageIdField = z.string().min(3).max(998)
  .regex(/^\s*<?[^<>\s]+>?\s*$/, 'messageId must be one RFC Message-ID, such as <abc@example.com>');

// resolve-message matches the stored Message-ID exactly, angle brackets included.
export function normalizeMessageId(value) {
  return `<${String(value).trim().replace(/^</, '').replace(/>$/, '')}>`;
}

export function uniqueIds(ids) {
  return [...new Set(ids.map(id => id.toLowerCase()))];
}

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function textResult(text, { isError = false } = {}) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function describeError(err, tool) {
  if (err instanceof MailflowError || err instanceof ToolError || err instanceof RecipientError) return err.message;
  console.error(`[mailflow-mcp] ${tool} failed: ${err?.name || 'Error'}: ${err?.message || err}`);
  return `mailflow-mcp hit an internal error in ${tool}: ${err?.message || err}`;
}

/**
 * Registers a tool. Its handler gets the call's arguments and the call's own MailFlow client
 * (MailflowClient.forCall), which sends nothing more once the call is cancelled or its connection
 * closes; `calls` counts the call while it runs.
 * @param {{ client: import('../mailflowClient.js').MailflowClient, calls?: import('../concurrency.js').InFlight|null }} context
 */
export function registerTool(server, { client, calls = null }, name, config, handler) {
  server.registerTool(name, config, async (args, extra) => {
    const run = async () => {
      try {
        return await handler(args, client.forCall(extra?.signal));
      } catch (err) {
        return textResult(describeError(err, name), { isError: true });
      }
    };
    return calls ? calls.track(run) : run();
  });
}

export function isNotFound(err) {
  return err instanceof MailflowError && err.status === 404;
}

export const NOT_FOUND_REASON = 'not found in MailFlow (it may have been moved or deleted; message ids change after a move or archive — re-find it with search_mail or by its Message-ID)';

const lower = value => String(value ?? '').toLowerCase();
// MailFlow's conversation key is COALESCE(thread_id, id).
export const threadKey = row => row.thread_id || row.id;

// Loads each id's full row, at most four at a time, and whether MailFlow counts it as a draft.
// MailFlow refuses a whole archive or move that includes a draft, by its own definition (the
// \Draft flag, the Drafts folder rules or the account's drafts mapping), and only its conversation
// listing says which rows that is. A row the listing leaves out (it shows one copy per account and
// Message-ID) has no isDraft, and only its folder tells.
export async function loadRows(client, ids) {
  const results = await mapSettled(ids, LOOKUP_CONCURRENCY, id => client.resolveMessage(id));
  const entries = ids.map((id, i) => {
    const result = results[i];
    if (result.ok) return { id, row: result.value };
    if (isNotFound(result.error)) return { id, missing: true };
    return { id, error: result.error };
  });
  const keys = [...new Set(entries.filter(entry => entry.row).map(entry => threadKey(entry.row)))];
  const threads = await mapSettled(keys, LOOKUP_CONCURRENCY, key => client.getThread(key));
  const listings = new Map(keys.map((key, i) => [key, threads[i]]));
  for (const entry of entries) {
    if (!entry.row) continue;
    const listing = listings.get(threadKey(entry.row));
    if (!listing.ok) {
      entry.draftCheckError = listing.error;
      continue;
    }
    const listed = (Array.isArray(listing.value?.messages) ? listing.value.messages : [])
      .find(message => lower(message.id) === lower(entry.row.id));
    if (listed) entry.isDraft = listed.is_draft === true;
  }
  return entries;
}

// One line of facts MailFlow itself produced (ids, folder, date, flags); never email text.
export function messageFacts(message, { folder = true } = {}) {
  const facts = [`id=${message.id}`, `account_id=${message.account_id}`];
  if (folder) facts.push(`folder=${pathLabel(message.folder)}`);
  facts.push(`date=${formatDate(message.date)}`);
  facts.push(message.is_read ? 'read' : 'unread');
  if (message.is_starred) facts.push('starred');
  if (message.has_attachments) facts.push('attachments');
  if (message.is_draft) facts.push('draft');
  if (message.category && message.category !== 'primary' && CATEGORIES.includes(message.category)) facts.push(`category=${message.category}`);
  if (message.snooze_until) facts.push(`snoozed until ${formatDate(message.snooze_until)}`);
  return facts.join(' ');
}

// The email-derived part of a list entry; it belongs inside the untrusted block.
export function messageSummary(message, { snippet = true } = {}) {
  const parts = [
    `From: ${oneLine(displayAddress({ name: message.from_name, email: message.from_email }), 160) || '(unknown sender)'}`,
    `Subject: ${oneLine(message.subject, 160) || '(no subject)'}`,
  ];
  if (message.message_id) {
    const id = oneLine(message.message_id, 1000);
    parts.push(id.length <= 250 ? `Message-ID: ${id}` : 'Message-ID: (over 250 characters; use the id)');
  }
  if (snippet && message.snippet) parts.push(`Snippet: ${oneLine(message.snippet, 140)}`);
  return parts.join(' | ');
}

// Claude Code moves a tool result over 50,000 characters into a file, so results stay under this.
export const RESULT_LIMIT = 45000;

// Lines for an untrusted block, cut at a line boundary when they would not fit.
export function fitLines(lines, budget) {
  const text = lines.join('\n');
  if (text.length <= budget) return { text, cut: false };
  const room = Math.max(0, budget - 80);
  const end = text.lastIndexOf('\n', room);
  return { text: `${text.slice(0, end > 0 ? end : room)}\n[cut here to keep the result small]`, cut: true };
}

// The untrusted block of a message list: summaries, without snippets when that is what fits.
export function listBlock(messages, numberOf, budget) {
  const build = snippet => messages.map(message => `[${numberOf(message)}] ${messageSummary(message, { snippet })}`);
  let lines = build(true);
  if (lines.join('\n').length > budget) lines = build(false);
  return fitLines(lines, budget);
}
