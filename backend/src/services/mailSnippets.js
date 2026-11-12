import { randomUUID } from 'node:crypto';
import { query, withTransaction } from './db.js';

export const SNIPPET_LIMITS = { count: 50, title: 120, subject: 200, body: 20000 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SnippetError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function validateSnippet(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SnippetError(400, 'A snippet must contain a title and plain-text body.');
  if (input.format !== undefined && input.format !== 'text') throw new SnippetError(400, 'Snippets support plain text only.');
  const { title, body, subject = '' } = input;
  if (typeof title !== 'string' || !title.trim() || title.length > SNIPPET_LIMITS.title) throw new SnippetError(400, `Add a title of at most ${SNIPPET_LIMITS.title} characters.`);
  if (typeof body !== 'string' || !body.trim() || body.length > SNIPPET_LIMITS.body) throw new SnippetError(400, `Add a message of at most ${SNIPPET_LIMITS.body} characters.`);
  if (typeof subject !== 'string' || subject.length > SNIPPET_LIMITS.subject) throw new SnippetError(400, `Use a subject of at most ${SNIPPET_LIMITS.subject} characters.`);
  // PostgreSQL JSONB cannot represent NUL. Other controls are not useful in a reusable message.
  const invalidControl = value => [...value].some(c => (c.charCodeAt(0) < 32 && !'\n\r\t'.includes(c)) || c.charCodeAt(0) === 127);
  if (!title.isWellFormed() || !body.isWellFormed() || !subject.isWellFormed()) throw new SnippetError(400, 'The snippet contains invalid Unicode text.');
  if (invalidControl(title) || invalidControl(body) || invalidControl(subject) || /[\r\n\t]/.test(title) || /[\r\n\t]/.test(subject)) throw new SnippetError(400, 'The snippet contains unsupported control characters.');
  return { title: title.trim(), subject: subject.trim(), body: body.replace(/\r\n?/g, '\n'), format: 'text' };
}

function readItems(row) {
  if (!row) throw new SnippetError(401, 'Not authenticated');
  if (row.snippets == null) return [];
  if (!Array.isArray(row.snippets)) throw new SnippetError(500, 'Saved snippets could not be read.');
  return row.snippets;
}

function publicSnippet(item) {
  const result = { ...item };
  delete result.usageRequestIds;
  return result;
}

export async function listSnippets(userId) {
  const { rows } = await query("SELECT preferences->'snippets' AS snippets FROM users WHERE id = $1", [userId]);
  return readItems(rows[0]).map(publicSnippet);
}

export async function changeSnippet(userId, operation, id, input) {
  const content = operation === 'delete' ? null : validateSnippet(input);
  if (operation !== 'create' && (!UUID.test(id) || !Number.isSafeInteger(input?.version) || input.version < 1)) {
    throw new SnippetError(400, 'A valid snippet ID and version are required.');
  }
  return withTransaction(async client => {
    // The owner row serializes mutations, including the count limit, across all tabs.
    const { rows } = await client.query("SELECT preferences->'snippets' AS snippets FROM users WHERE id = $1 FOR UPDATE", [userId]);
    const items = readItems(rows[0]);
    const index = operation === 'create' ? -1 : items.findIndex(item => item.id === id);
    if (operation !== 'create' && index < 0) throw new SnippetError(404, 'Snippet not found.');
    if (index >= 0 && items[index].version !== input.version) throw new SnippetError(409, 'This snippet changed in another window. Reload snippets before trying again.');
    if (operation === 'create' && items.length >= SNIPPET_LIMITS.count) throw new SnippetError(409, `You can save up to ${SNIPPET_LIMITS.count} snippets.`);
    const now = new Date().toISOString();
    const saved = operation === 'delete' ? null : {
      ...(index >= 0 ? items[index] : { usageCount: 0, lastUsedAt: null }),
      id: index >= 0 ? id : randomUUID(), ...content,
      version: index >= 0 ? items[index].version + 1 : 1,
      createdAt: index >= 0 ? items[index].createdAt : now, updatedAt: now,
    };
    const next = operation === 'delete' ? items.filter(item => item.id !== id)
      : index >= 0 ? items.map(item => item.id === id ? saved : item) : [...items, saved];
    await client.query("UPDATE users SET preferences = jsonb_set(COALESCE(preferences, '{}'::jsonb), '{snippets}', $2::jsonb) WHERE id = $1", [userId, JSON.stringify(next)]);
    return saved ? publicSnippet(saved) : null;
  });
}


export async function recordSnippetUse(userId, id, requestId) {
  if (!UUID.test(id) || typeof requestId !== 'string' || !UUID.test(requestId)) throw new SnippetError(400, 'A valid snippet ID and usage request ID are required.');
  return withTransaction(async client => {
    const { rows } = await client.query("SELECT preferences->'snippets' AS snippets FROM users WHERE id = $1 FOR UPDATE", [userId]);
    const items = readItems(rows[0]);
    const item = items.find(item => item.id === id);
    if (!item) throw new SnippetError(404, 'Snippet not found.');
    const requests = item.usageRequestIds || [];
    if (requests.includes(requestId)) return publicSnippet(item);
    // Usage does not change the content revision or invalidate an editor already open in another tab.
    const used = { ...item, usageCount: Math.min(Number.MAX_SAFE_INTEGER, (item.usageCount || 0) + 1),
      lastUsedAt: new Date().toISOString(), usageRequestIds: [...requests, requestId].slice(-64) };
    await client.query("UPDATE users SET preferences = jsonb_set(COALESCE(preferences, '{}'::jsonb), '{snippets}', $2::jsonb) WHERE id = $1", [userId, JSON.stringify(items.map(item => item.id === id ? used : item))]);
    return publicSnippet(used);
  });
}
