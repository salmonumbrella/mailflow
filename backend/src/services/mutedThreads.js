import { createHash } from 'node:crypto';
import { query, withTransaction } from './db.js';
import { findOwnedAccount, findOwnedMessage, findOwnedMessages } from './ownership.js';

export class MutedThreadError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const MAX_MEMBERS = 100;
const MAX_IDENTIFIERS = 512;
const MAX_RECORDS = 5000;
const PAGE_SIZE = 100;
const pool = { query };
const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

// Case is significant in RFC Message-IDs. Never use subject/sender matching to mute mail.
export function muteIdentifiers(rows) {
  const ids = new Set();
  for (const row of rows) {
    for (const field of ['message_id', 'thread_id', 'in_reply_to', 'thread_references']) {
      const value = row[field];
      if (!value) continue;
      if (typeof value !== 'string' || value.length > (field === 'thread_references' ? 16384 : 4096)) throw new MutedThreadError(413, 'This conversation has too much identity data to mute safely.');
      const tokens = value.match(/<[^<>\s]{1,998}>/g) || [];
      // MailFlow also retains some valid provider IDs without surrounding brackets.
      if (!tokens.length && field !== 'thread_references' && /^[^<>\s]{1,998}@[^<>\s]{1,998}$/.test(value)) tokens.push(value);
      for (const token of tokens) {
        if (token.length > 1024) throw new MutedThreadError(413, 'Conversation identity is too long.');
        ids.add(token);
        if (ids.size > MAX_IDENTIFIERS) throw new MutedThreadError(413, 'This conversation is too large to mute safely.');
      }
    }
  }
  if (!ids.size) throw new MutedThreadError(422, 'This conversation has no stable message identity.');
  return [...ids].sort();
}
async function context(userId, messageId, client = pool) {
  if (!isUuid(messageId)) throw new MutedThreadError(404, 'Message not found');
  const target = await findOwnedMessage(userId, messageId, { live: true, enabledAccount: true, columns: 'm.id, m.account_id, m.thread_key', client });
  if (!target) throw new MutedThreadError(404, 'Message not found');
  const { rows } = await client.query(`SELECT message_id, thread_id, in_reply_to, thread_references
    FROM messages WHERE account_id=$1 AND (thread_key=$2 OR id=$3) LIMIT $4`, [target.account_id, target.thread_key, target.id, MAX_MEMBERS + 1]);
  if (rows.length > MAX_MEMBERS) throw new MutedThreadError(413, 'This conversation is too large to mute safely.');
  return { target, identifiers: muteIdentifiers(rows) };
}
async function matches(userId, accountId, identifiers, client = pool) {
  const { rows } = await client.query('SELECT id, muted, revision, identifiers FROM muted_threads WHERE user_id=$1 AND account_id=$2 AND identifiers && $3::text[] ORDER BY id', [userId, accountId, identifiers]);
  return rows;
}
function state(rows) {
  return { muted: rows.some(row => row.muted), revision: rows.length ? createHash('sha256').update(rows.map(row => `${row.id}:${row.revision}`).join('|')).digest('hex') : null };
}
export async function getMutedThread(userId, messageId) {
  const { target, identifiers } = await context(userId, messageId);
  return { ...state(await matches(userId, target.account_id, identifiers)), threadKey: target.thread_key };
}
export async function setMutedThread(userId, messageId, input) {
  if (!isUuid(messageId)) throw new MutedThreadError(404, 'Message not found');
  if (!input || typeof input.muted !== 'boolean' || !(input.revision === null || (typeof input.revision === 'string' && /^[a-f0-9]{64}$/.test(input.revision)))) throw new MutedThreadError(400, 'A mute choice and current revision are required.');
  return withTransaction(async client => {
    const initial = await findOwnedMessage(userId, messageId, { live: true, enabledAccount: true, columns: 'm.id, m.account_id, m.thread_key', client });
    if (!initial) throw new MutedThreadError(404, 'Message not found');
    // Serialize even absent records and overlapping/healed thread groups in this account.
    await client.query('SELECT id FROM email_accounts WHERE id=$1 AND user_id=$2 FOR UPDATE', [initial.account_id, userId]);
    const { target, identifiers } = await context(userId, messageId, client);
    const rows = await matches(userId, target.account_id, identifiers, client);
    if (state(rows).revision !== input.revision) throw new MutedThreadError(409, 'The mute preference changed. Reload before retrying.');
    const union = [...new Set([...identifiers, ...rows.flatMap(row => row.identifiers)])].sort();
    if (union.length > MAX_IDENTIFIERS) throw new MutedThreadError(413, 'This merged conversation is too large to mute safely.');
    if (rows.length) {
      await client.query('UPDATE muted_threads SET muted=$1, identifiers=$2, revision=gen_random_uuid(), updated_at=NOW() WHERE id=ANY($3::uuid[]) AND user_id=$4 AND account_id=$5', [input.muted, union, rows.map(row => row.id), userId, target.account_id]);
    } else {
      const count = await client.query('SELECT COUNT(*)::int AS n FROM muted_threads WHERE account_id=$1', [target.account_id]);
      if (count.rows[0].n >= MAX_RECORDS) throw new MutedThreadError(413, 'This account has reached its local mute preference limit.');
      await client.query('INSERT INTO muted_threads(user_id,account_id,identifiers,muted) VALUES($1,$2,$3,$4)', [userId, target.account_id, union, input.muted]);
    }
    return { ...state(await matches(userId, target.account_id, union, client)), threadKey: target.thread_key };
  });
}
export async function listMutedThreads(userId, { accountId = null, offset = 0 } = {}) {
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_RECORDS * 100) throw new MutedThreadError(400, 'Invalid page');
  if (accountId && (!isUuid(accountId) || !await findOwnedAccount(userId, accountId, { enabled: true }))) throw new MutedThreadError(404, 'Account not found');
  // A representative cache row is resolved afresh. Moves preserve identifiers; deleted cache
  // rows are never exposed. Deduplicate merged mute groups by the current native thread key.
  const { rows } = await query(`SELECT * FROM (
    SELECT DISTINCT ON (m.account_id, m.thread_key) m.* FROM muted_threads t
    JOIN email_accounts a ON a.id=t.account_id AND a.user_id=t.user_id AND a.enabled=true
    JOIN LATERAL (SELECT m.id,m.account_id,m.folder,m.thread_key,m.message_id,m.from_email,m.from_name,m.subject,m.snippet,m.date,m.is_read,m.is_starred,m.has_attachments FROM messages m WHERE m.account_id=t.account_id AND m.is_deleted=false
      AND (m.message_id=ANY(t.identifiers) OR m.thread_id=ANY(t.identifiers) OR m.in_reply_to=ANY(t.identifiers) OR EXISTS (
        SELECT 1 FROM regexp_matches(CASE WHEN length(m.thread_references) <= 16384 THEN m.thread_references ELSE '' END,
          '<[^<>[:space:]]+>', 'g') AS refs(token)
        WHERE length(refs.token[1]) <= 1000 AND refs.token[1]=ANY(t.identifiers)))
      ORDER BY m.date DESC, m.id LIMIT 1) m ON true
    WHERE t.user_id=$1 AND t.muted=true AND ($2::uuid IS NULL OR t.account_id=$2)
    ORDER BY m.account_id,m.thread_key,m.date DESC,m.id
    ) representatives ORDER BY date DESC,id LIMIT $3 OFFSET $4`, [userId, accountId, PAGE_SIZE + 1, offset]);
  // Reuse native summary rows, but never return bodies/attachments to this list endpoint.
  const messages = rows.slice(0, PAGE_SIZE).map(({ id, account_id, folder, thread_key, message_id, from_email, from_name, subject, snippet, date, is_read, is_starred, has_attachments }) => ({ id, account_id, folder, thread_key, message_id, from_email, from_name, subject, snippet, date, is_read, is_starred, has_attachments }));
  return { messages, hasMore: rows.length > PAGE_SIZE, nextOffset: rows.length > PAGE_SIZE ? offset + PAGE_SIZE : null };
}

// New-mail alert filtering uses current server-owned thread membership, never client IDs.
// It does not move future mail or mark it read. Rule-driven explicit notifications are also
// suppressed for a muted thread, while the ordinary mail refresh still reaches the client.
export async function mutedAlertIds(accountId, messageIds) {
  if (!messageIds.length) return new Set();
  if (!isUuid(accountId)) throw new MutedThreadError(400, 'Invalid account');
  const muted = new Set();
  for (let start = 0; start < messageIds.length; start += 200) {
    const ids = messageIds.slice(start, start + 200).filter(isUuid);
    const { rows } = await query(`SELECT DISTINCT target.id FROM messages target
      JOIN email_accounts a ON a.id=target.account_id
      JOIN messages member ON member.account_id=target.account_id AND member.thread_key=target.thread_key
      JOIN muted_threads t ON t.account_id=a.id AND t.user_id=a.user_id AND t.muted=true
        AND (member.message_id=ANY(t.identifiers) OR member.thread_id=ANY(t.identifiers) OR member.in_reply_to=ANY(t.identifiers) OR EXISTS (
        SELECT 1 FROM regexp_matches(CASE WHEN length(member.thread_references) <= 16384 THEN member.thread_references ELSE '' END,
          '<[^<>[:space:]]+>', 'g') AS refs(token)
        WHERE length(refs.token[1]) <= 1000 AND refs.token[1]=ANY(t.identifiers)))
      WHERE target.account_id=$1 AND target.id=ANY($2::uuid[]) AND target.is_deleted=false`, [accountId, ids]);
    for (const row of rows) muted.add(row.id);
  }
  return muted;
}

// An archive after muting is optional and must still target the exact original Inbox thread.
// The endpoint invokes this before any provider operation; it never trusts current UI selection.
export async function verifyMutedArchive(userId, ids, guard) {
  if (!guard || !isUuid(guard.messageId) || !isUuid(guard.accountId)
    || typeof guard.threadKey !== 'string' || !guard.threadKey || guard.threadKey.length > 4096
    || typeof guard.revision !== 'string' || !/^[a-f0-9]{64}$/.test(guard.revision)
    || !Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => !isUuid(id)) || new Set(ids).size !== ids.length) {
    throw new MutedThreadError(400, 'Invalid mute archive guard');
  }
  const { target } = await context(userId, guard.messageId);
  const current = await getMutedThread(userId, guard.messageId);
  if (target.account_id !== guard.accountId || current.threadKey !== guard.threadKey
    || !current.muted || current.revision !== guard.revision) throw new MutedThreadError(409, 'The muted conversation changed before archiving.');
  const rows = await findOwnedMessages(userId, ids, { live: true, columns: 'm.id, m.account_id, m.thread_key, m.folder' });
  if (rows.length !== ids.length || rows.some(row => row.account_id !== guard.accountId || row.thread_key !== guard.threadKey || row.folder !== 'INBOX')) {
    throw new MutedThreadError(409, 'The original inbox messages changed before archiving.');
  }
  return true;
}
