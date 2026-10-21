import { Router } from 'express';
import { createHash } from 'node:crypto';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { resolveAccountScope } from '../services/unifiedInbox.js';

const router = Router();
router.use(requireAuth);

// Simple in-memory rate limiter: 60 searches per minute per user. Typed search
// fires a debounced request per pause, so a user exploring several queries can
// legitimately issue dozens of requests in a minute.
const searchBuckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of searchBuckets) {
    if (now > b.resetAt) searchBuckets.delete(k);
  }
}, 60_000);

function searchLimiter(req, res, next) {
  const key = req.session.userId;
  const now = Date.now();
  const b = searchBuckets.get(key);
  if (!b || now > b.resetAt) {
    searchBuckets.set(key, { count: 1, resetAt: now + 60_000 });
    return next();
  }
  if (b.count >= 60) {
    res.setHeader('Retry-After', Math.ceil((b.resetAt - now) / 1000));
    return res.status(429).json({ error: 'Too many search requests. Try again shortly.' });
  }
  b.count++;
  next();
}

// Parses a raw search string into structured operator filters and free-text
// terms. Supports from: to: subject: has: is: after: before: in:, quoted values
// (from:"John Smith"), and a leading '-' that negates either an operator
// (-from:smith) or a bare word (-invoice). Filters are a list (not a map) so
// repeated/negated operators like `from:a -from:b` are all preserved.
export function parseSearchQuery(raw) {
  const filters = [];
  const terms = [];

  // The leading (-?) captures optional negation. \b sits between an optional '-'
  // and the operator name, so both `from:` and `-from:` match.
  const opPattern = /(-?)\b(from|to|subject|has|is|after|before|in):("([^"]*)"|([\S]+))/gi;
  const remaining = raw.replace(opPattern, (_, neg, key, _v, quoted, unquoted) => {
    const k = key.toLowerCase();
    const v = (quoted !== undefined ? quoted : (unquoted || '')).toLowerCase().trim();
    if (v) filters.push({ key: k, value: v, negate: neg === '-' });
    return ' ';
  }).trim();

  for (const word of remaining.split(/\s+/)) {
    let w = word.trim();
    if (!w || w === '-') continue; // skip blanks and a lone '-' (nothing to negate)
    let negate = false;
    if (w[0] === '-' && w.length > 1) { negate = true; w = w.slice(1); }
    terms.push({ value: w, negate });
  }

  return { filters, terms };
}

// Wraps a positive condition so that when negated it also matches rows where the
// underlying columns are NULL (COALESCE(..., false) treats NULL as "not a match",
// which NOT then flips to a match — the intuitive meaning of exclusion).
function negateCond(sql) {
  return `NOT COALESCE((${sql}), false)`;
}

export function resolveSearchFolderScope(filters, folderParam = '') {
  let folderScope;
  let folderFuzzy = false; // in:<name> matches loosely; the folder param is exact

  for (const f of filters) {
    if (f.key !== 'in') continue;
    if (f.value === 'all') { folderScope = null; }
    else { folderScope = f.value; folderFuzzy = true; }
  }

  if (folderScope === undefined) {
    folderScope = (folderParam || '').trim() || null;
    folderFuzzy = false;
  }

  return { folderScope, folderFuzzy };
}

export function shouldExcludeTrashFromSearch(folderScope) {
  return folderScope === null;
}

export function trashFolderExclusionCondition(alias = 'm') {
  if (alias !== 'm' && alias !== 's') throw new Error('Invalid search message alias');
  return `NOT EXISTS (
        SELECT 1
        FROM folders f
        WHERE f.account_id = ${alias}.account_id
          AND f.path = ${alias}.folder
          AND (f.special_use = '\\Trash'
               OR lower(f.name) LIKE '%trash%'
               OR lower(f.name) LIKE '%deleted%')
      )`;
}

// Postgres refuses to build a tsvector larger than ~1MB of packed lexemes
// (SQLSTATE 54000), so an oversized body would 500 the whole search. Cap the
// text fed to to_tsvector at 600k chars — matching msgvault's maxFTSBodyChars
// (internal/store/dialect_pg.go) — so one huge email can't crash the query.
// Exported because slice 02's search_fts trigger caps the same way.
export const FTS_BODY_CHAR_CAP = 600000;

// Builds the per-term free-text OR-condition: a term matches if it appears in
// the sender, subject, stored metadata vector, or published body chunks. Legacy
// cached bodies are considered only until a verified generation is available.
// Extracted so the body cap is a single, testable source of truth.
export function freeTextTermCondition(likeIdx, ftsIdx, alias = 'm') {
  if (alias !== 'm' && alias !== 's') throw new Error('Invalid search message alias');
  const verified = (dictionary, column) => `(numnode(plainto_tsquery('${dictionary}', $${ftsIdx})) > 0
            AND NOT EXISTS (
              SELECT 1 FROM unnest(tsvector_to_array(to_tsvector('${dictionary}', $${ftsIdx}))) AS q(lexeme)
              WHERE NOT EXISTS (SELECT 1 FROM search_text_chunks c WHERE c.generation_id=${alias}.search_generation_id
                AND c.${column} @@ quote_literal(q.lexeme)::tsquery)))`;
  return `(
        ${alias}.from_name ILIKE $${likeIdx}
        OR ${alias}.from_email ILIKE $${likeIdx}
        OR ${alias}.subject ILIKE $${likeIdx}
        OR ${alias}.search_vector @@ plainto_tsquery('english', $${ftsIdx})
        OR CASE WHEN ${alias}.search_generation_id IS NOT NULL THEN
          CASE WHEN numnode(plainto_tsquery('english', $${ftsIdx})) > 0
            THEN ${verified('english', 'en_tsv')}
            ELSE ${verified('simple', 'simple_tsv')}
          END
        ELSE CASE WHEN numnode(plainto_tsquery('english', $${ftsIdx})) > 0
          THEN to_tsvector('english', LEFT(coalesce(${alias}.body_text,''), ${FTS_BODY_CHAR_CAP})) @@ plainto_tsquery('english', $${ftsIdx})
          ELSE to_tsvector('simple', LEFT(coalesce(${alias}.body_text,''), ${FTS_BODY_CHAR_CAP})) @@ plainto_tsquery('simple', $${ftsIdx})
        END END
      )`;
}

function validSearchSnapshot(snapshot) {
  if (typeof snapshot !== 'string' || Buffer.byteLength(snapshot) > 4096 ||
      !/^\d+:\d+:(?:\d+(?:,\d+)*)?$/.test(snapshot)) return false;
  const [min, max, active] = snapshot.split(':');
  const xmin = BigInt(min), xmax = BigInt(max);
  if (xmin < 1n || xmin > xmax || xmax > 18446744073709551615n) return false;
  return !active || active.split(',').every(xid => {
    const value = BigInt(xid);
    return value >= xmin && value < xmax;
  });
}

export function decodeSearchCursor(raw, scope, { mode = 'flat' } = {}) {
  if (raw === undefined || raw === '') return null;
  try {
    if (typeof raw !== 'string' || raw.length > 6144 || !/^[\w-]+$/.test(raw)) throw new Error();
    const bytes = Buffer.from(raw, 'base64url');
    if (bytes.toString('base64url') !== raw) throw new Error();
    const cursor = JSON.parse(bytes.toString());
    const grouped = cursor?.v === 2 && cursor.type === 'grouped';
    if (mode === 'grouped' ? !grouped : mode !== 'flat' || cursor?.v !== 1 || cursor.type !== undefined) throw new Error();
    if (raw.length > (grouped ? 6144 : 2048) || cursor.scope !== scope) throw new Error();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (typeof cursor.accountId !== 'string' || !uuid.test(cursor.accountId) ||
        typeof cursor.id !== 'string' || !uuid.test(cursor.id)) throw new Error();
    if (grouped) {
      if (typeof cursor.threadKey !== 'string' || !cursor.threadKey || cursor.threadKey.includes('\u0000') ||
          !validSearchSnapshot(cursor.snapshot)) throw new Error();
    }
    if (cursor.bucket === 'dated') {
      if (typeof cursor.date !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursor.date) ||
          new Date(cursor.date).toISOString() !== `${cursor.date.slice(0, 23)}Z`) throw new Error();
    } else if (cursor.bucket !== 'undated' || cursor.date !== null) throw new Error();
    return cursor;
  } catch {
    throw new Error(mode === 'grouped' ? 'Invalid search cursor; refresh required' : 'Invalid search cursor');
  }
}

export function encodeSearchCursor(row, scope, { mode = 'flat', snapshot } = {}) {
  const boundary = { scope, bucket: row._cursor_date === null ? 'undated' : 'dated',
    date: row._cursor_date, accountId: row.account_id };
  const cursor = mode === 'grouped'
    ? { v: 2, type: 'grouped', ...boundary, threadKey: row.thread_key, id: row.id, snapshot }
    : { v: 1, ...boundary, id: row.id };
  const raw = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  decodeSearchCursor(raw, scope, { mode });
  return raw;
}

// Candidates arrive in newest-match cursor order; the route owns matching and bounded refills.
export function collectGroupedSearchPage(candidates, { limit, exhausted }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid search page limit');
  const messages = [];
  const groups = new Set();
  let consumed = 0;
  let lastConsumed = null;
  while (consumed < candidates.length && consumed < 4 * (limit + 1)) {
    const candidate = candidates[consumed];
    const key = JSON.stringify([candidate.account_id, candidate.thread_key]);
    if (!groups.has(key)) {
      // Lookahead proves continuation, but must remain before the next page's cursor.
      if (messages.length === limit) break;
      groups.add(key);
      messages.push(candidate);
    }
    lastConsumed = candidate;
    consumed++;
  }
  return { messages, lastConsumed, hasMore: consumed < candidates.length || !exhausted };
}

// The cursor names a physical candidate, not a group: unstable siblings can tie.
async function groupedSearchPage({ select, params, siblingConditions, cap, cursor, scope }) {
  let snapshot = cursor?.snapshot || null;
  const budget = 4 * (cap + 1);
  const bucket = async (undated, position, count) => {
    const values = [...params, snapshot];
    const snapshotIdx = values.length;
    let boundary = '';
    if (position) {
      values.push(position.accountId, position.threadKey, position.id);
      const account = `$${values.length - 2}::uuid`, thread = `$${values.length - 1}`, id = `$${values.length}::uuid`;
      const keys = `(m.account_id > ${account} OR (m.account_id = ${account} AND
        (m.thread_key > ${thread} OR (m.thread_key = ${thread} AND m.id > ${id}))))`;
      if (undated) boundary = ` AND ${keys}`;
      else {
        values.push(position.date);
        boundary = ` AND (m.date < $${values.length}::timestamptz OR
          (m.date = $${values.length}::timestamptz AND ${keys}))`;
      }
    }
    values.push(count);
    const result = await query(`WITH fence AS MATERIALIZED (
      SELECT COALESCE($${snapshotIdx}::pg_snapshot, pg_current_snapshot()) AS snapshot
    ) SELECT candidate.*, fence.snapshot::text AS _snapshot FROM fence
      LEFT JOIN LATERAL (${select}
        AND m.date IS ${undated ? '' : 'NOT '}NULL${boundary}
        AND (
          SELECT s.id FROM messages s
          WHERE s.account_id = m.account_id AND s.thread_key = m.thread_key AND s.is_deleted = false
            AND ((m.date IS NULL AND s.date IS NOT NULL) OR s.date > m.date
              OR (s.date IS NOT DISTINCT FROM m.date AND s.id < m.id))
            AND COALESCE(pg_visible_in_snapshot(s.search_changed_xid, fence.snapshot), true)
            AND ${siblingConditions.join('\n            AND ')}
          ORDER BY s.date DESC NULLS LAST, s.id LIMIT 1
        ) IS NULL
        ORDER BY ${undated ? '' : 'm.date DESC, '}m.account_id, m.thread_key, m.id
        LIMIT $${values.length}
      ) candidate ON true
      ORDER BY candidate.date DESC NULLS LAST, candidate.account_id, candidate.thread_key, candidate.id`, values);
    // LEFT JOIN returns the captured snapshot even when the dated bucket is empty.
    snapshot = result.rows[0]._snapshot;
    if (!validSearchSnapshot(snapshot)) throw new Error('Invalid search cursor; refresh required');
    return result.rows.filter(row => row.id !== null);
  };
  const rows = cursor?.bucket === 'undated' ? [] : await bucket(false, cursor, budget);
  if (rows.length < budget) rows.push(...await bucket(true, cursor?.bucket === 'undated' ? cursor : null, budget - rows.length));
  const page = collectGroupedSearchPage(rows, { limit: cap, exhausted: rows.length < budget });
  const nextCursor = page.hasMore ? encodeSearchCursor(page.lastConsumed, scope, { mode: 'grouped', snapshot }) : null;
  const messages = page.messages.map(({ _cursor_date, _snapshot, thread_key, ...message }) => ({
    ...message, matched_message_id: message.id, newest_match_date: _cursor_date,
    reply_thread_id: message.thread_id, thread_id: JSON.stringify([message.account_id, thread_key]),
  }));
  return { messages, nextCursor, hasMore: page.hasMore };
}

router.get('/', searchLimiter, async (req, res) => {
  const { q, accountId, limit = 50, offset = 0 } = req.query;
  const grouped = req.query.threaded === 'true';
  const cursorMode = grouped ? 'grouped' : 'flat';
  const cursorError = grouped ? 'Invalid search cursor; refresh required' : 'Invalid search cursor';
  const trimmed = (q || '').trim();
  if (!trimmed) return req.query.cursor ? res.status(400).json({ error: cursorError }) : res.json({ messages: [], nextCursor: null, ...(grouped ? { hasMore: false } : {}) });
  if (trimmed.length > 500) return res.status(400).json({ error: 'Search query too long' });

  const accountsResult = await query(
    'SELECT id, include_in_unified_inbox FROM email_accounts WHERE user_id = $1 AND enabled = true',
    [req.session.userId]
  );
  if (grouped && accountId && !accountsResult.rows.some(account => account.id === accountId)) {
    return res.status(403).json({ error: 'Account unavailable' });
  }
  const { accountIds: targetIds } = resolveAccountScope(accountsResult.rows, accountId);
  const cap = Math.max(1, Math.min(parseInt(limit) || 50, 200));
  const { filters, terms } = parseSearchQuery(trimmed);
  const { folderScope, folderFuzzy } = resolveSearchFolderScope(filters, req.query.folder || '');
  const folderPolicy = grouped ? (await query(
    'SELECT account_id, path, special_use, name FROM folders WHERE account_id = ANY($1) ORDER BY account_id, path, special_use, name',
    [targetIds]
  )).rows : [];
  const scope = createHash('sha256').update(JSON.stringify([req.session.userId, trimmed, accountId || null,
    [...targetIds].sort(), folderScope, folderFuzzy, req.query.mode || 'flat', ...(grouped ? ['grouped', folderPolicy] : [])])).digest('hex');
  let cursor;
  try {
    cursor = decodeSearchCursor(req.query.cursor, scope, { mode: cursorMode });
    if ((grouped && req.query.offset !== undefined) || (req.query.cursor !== undefined && Number(offset) !== 0)) throw new Error('Invalid search cursor');
  } catch {
    return res.status(400).json({ error: cursorError });
  }
  if (!targetIds.length) return res.json({ messages: [], nextCursor: null, ...(grouped ? { hasMore: false } : {}) });

  const conditions = [];
  const siblingConditions = [];
  const addCondition = (condition, negate = false) => {
    const render = alias => negate ? negateCond(condition(alias)) : condition(alias);
    conditions.push(render('m'));
    if (grouped) siblingConditions.push(render('s'));
  };
  const params = [targetIds];
  let p = 2;

  // Folder scope. `in:` in the query wins; otherwise the client-supplied `folder`
  // param (the folder the user is currently viewing) applies. `undefined` means
  // no in: operator was given, so we fall back to the param below.
  //   folderScope === null   → search all folders
  //   folderScope === string → restrict to that folder

  // ── Operator filters ──────────────────────────────────────────────────────

  for (const f of filters) {
    // in: controls scope rather than adding a row condition; negation is
    // meaningless here so it's ignored.
    if (f.key === 'in') {
      continue;
    }

    let cond = null;
    const idx = p;

    if (f.key === 'from') {
      params.push(`%${f.value}%`);
      cond = alias => `(${alias}.from_email ILIKE $${idx} OR ${alias}.from_name ILIKE $${idx})`;
      p++;
    } else if (f.key === 'subject') {
      params.push(`%${f.value}%`);
      cond = alias => `${alias}.subject ILIKE $${idx}`;
      p++;
    } else if (f.key === 'to') {
      // to: searches the to/cc address JSON — cast to text covers name and email
      params.push(`%${f.value}%`);
      cond = alias => `(${alias}.to_addresses::text ILIKE $${idx} OR ${alias}.cc_addresses::text ILIKE $${idx})`;
      p++;
    } else if (f.key === 'has') {
      if (f.value === 'attachment' || f.value === 'attachments') cond = alias => `${alias}.has_attachments = true`;
    } else if (f.key === 'is') {
      if (f.value === 'unread')  cond = alias => `${alias}.is_read = false`;
      else if (f.value === 'read')    cond = alias => `${alias}.is_read = true`;
      else if (f.value === 'starred') cond = alias => `${alias}.is_starred = true`;
    } else if (f.key === 'after') {
      const d = new Date(f.value);
      if (!isNaN(d)) { params.push(d.toISOString()); cond = alias => `${alias}.date >= $${idx}`; p++; }
    } else if (f.key === 'before') {
      const d = new Date(f.value);
      if (!isNaN(d)) { params.push(d.toISOString()); cond = alias => `${alias}.date < $${idx}`; p++; }
    }

    if (cond) addCondition(cond, f.negate);
  }

  // ── Free-text terms ───────────────────────────────────────────────────────
  // Each term must match at least one of: from, subject (ILIKE — good for names
  // and partial words), or body content (FTS — good for large text with stemming).
  // AND between all terms: every word must appear somewhere in the email.
  // A negated term (-word) must appear nowhere.

  for (const term of terms.slice(0, 10)) {
    if (term.value.length < 2) continue; // single-char terms are too broad and expensive
    params.push(`%${term.value}%`); // ILIKE pattern
    const likeIdx = p++;

    params.push(term.value); // raw term for plainto_tsquery
    const ftsIdx = p++;

    addCondition(alias => freeTextTermCondition(likeIdx, ftsIdx, alias), term.negate);
  }

  // Require at least one real search condition before applying folder scope, so a
  // bare `in:inbox` (or a lone folder param) never dumps an entire folder.
  if (!conditions.length) return res.json({ messages: [], query: q, nextCursor: null, ...(grouped ? { hasMore: false } : {}) });

  // Resolve folder scope: in: operator wins; otherwise use the param.
  const folderIdx = p;
  if (folderScope) {
    if (folderFuzzy) {
      // in:<name> — case-insensitive match on a folder named exactly that, or a
      // nested folder whose path ends in it (in:sent → "Sent" or "Personal/Sent").
      // A multi-word leaf like "[Gmail]/Sent Mail" needs the quoted form in:"sent mail".
      params.push(folderScope);
      params.push(`%/${folderScope}`);
      addCondition(alias => `(${alias}.folder ILIKE $${folderIdx} OR ${alias}.folder ILIKE $${folderIdx + 1})`);
      p += 2;
    } else {
      params.push(folderScope);
      addCondition(alias => `${alias}.folder = $${folderIdx}`);
      p++;
    }
  } else if (shouldExcludeTrashFromSearch(folderScope)) {
    // Deleting moves mail into Trash, where it remains searchable by explicit
    // folder queries like in:trash. Keep ordinary all-folder searches from
    // resurfacing freshly-deleted messages after the optimistic UI guard expires.
    addCondition(alias => trashFolderExclusionCondition(alias));
  }

  const off = Math.max(0, parseInt(offset) || 0);

  try {
    const select = `
      SELECT
        ${grouped ? 'm.thread_key, ' : ''}m.id, m.uid, m.folder, m.message_id, m.subject, m.from_name, m.from_email,
        m.to_addresses, m.cc_addresses, m.reply_to, m.delivery_addresses, m.thread_id,
        m.in_reply_to, m.thread_references,
        m.date, to_char(m.date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS _cursor_date,
        m.snippet, m.is_read, m.is_starred, m.has_attachments, m.account_id,
        a.name as account_name, a.email_address as account_email, a.color as account_color
      FROM messages m
      JOIN email_accounts a ON m.account_id = a.id
      WHERE m.account_id = ANY($1)
        AND m.is_deleted = false
        AND ${conditions.join('\n        AND ')}`;
    if (grouped) {
      const result = await groupedSearchPage({ select, params, siblingConditions, cap, cursor, scope });
      return res.json({ ...result, query: q });
    }
    let rows;
    if (req.query.cursor === undefined) {
      rows = (await query(`${select} ORDER BY m.date DESC NULLS LAST, m.account_id, m.id
        LIMIT $${p} OFFSET $${p + 1}`, [...params, cap + 1, off])).rows;
    } else {
      const bucket = async (undated, position, count) => {
        const values = [...params];
        let boundary = '';
        if (position) {
          if (!undated) {
            values.push(position.date);
            boundary = ` AND m.date <= $${values.length}::timestamptz AND NOT (m.date = $${values.length}::timestamptz AND`;
          } else boundary = ' AND';
          values.push(position.accountId, position.id);
          boundary += ` (m.account_id, m.id) ${undated ? '>' : '<='} ($${values.length - 1}::uuid, $${values.length}::uuid)${undated ? '' : ')'}`;
        }
        values.push(count);
        return (await query(`${select} AND m.date IS ${undated ? '' : 'NOT '}NULL${boundary}
          ORDER BY ${undated ? '' : 'm.date DESC, '}m.account_id, m.id LIMIT $${values.length}`, values)).rows;
      };
      rows = cursor?.bucket === 'undated' ? [] : await bucket(false, cursor, cap + 1);
      if (rows.length < cap + 1) rows.push(...await bucket(true, cursor?.bucket === 'undated' ? cursor : null, cap + 1 - rows.length));
    }
    const nextCursor = rows.length > cap ? encodeSearchCursor(rows[cap - 1], scope) : null;
    const messages = rows.slice(0, cap);
    for (const message of messages) delete message._cursor_date;
    res.json({ messages, query: q, nextCursor });
  } catch (err) {
    if (grouped && (err.code === '22P02' || /refresh required/.test(err.message))) {
      return res.status(400).json({ error: cursorError });
    }
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Contact autocomplete — returns up to 10 addresses matching the query.
// Priority: addresses the user has sent to (contacts table, ranked by send_count)
// come first; inbound-only senders from messages fill remaining slots, with
// obvious bulk/no-reply addresses filtered out.
router.get('/contacts', searchLimiter, async (req, res) => {
  const { q } = req.query;
  const trimmed = (q || '').trim();
  if (!trimmed || trimmed.length < 2) return res.json({ contacts: [] });
  if (trimmed.length > 100) return res.status(400).json({ error: 'Query too long' });

  const accountsResult = await query(
    'SELECT id FROM email_accounts WHERE user_id = $1 AND enabled = true',
    [req.session.userId]
  );
  const userAccountIds = accountsResult.rows.map(r => r.id);
  if (!userAccountIds.length) return res.json({ contacts: [] });

  const pattern = `%${trimmed}%`;

  try {
    const result = await query(`
      WITH known AS (
        -- Contacts the user explicitly sent to or manually created (is_auto = false)
        SELECT primary_email AS email, display_name AS name, send_count, last_sent
        FROM contacts
        WHERE user_id = $1
          AND is_auto = false
          AND primary_email IS NOT NULL
          AND (display_name ILIKE $2 OR primary_email ILIKE $2)
      ),
      auto AS (
        -- Auto-discovered inbound contacts not already in known
        SELECT primary_email AS email, display_name AS name, 0 AS send_count, last_sent
        FROM contacts
        WHERE user_id = $1
          AND is_auto = true
          AND primary_email IS NOT NULL
          AND (display_name ILIKE $2 OR primary_email ILIKE $2)
          AND lower(primary_email) NOT IN (SELECT lower(email) FROM known)
      ),
      inbound AS (
        -- Fallback: senders not yet in contacts table, excluding bulk/robot
        SELECT email, name, send_count, last_sent
        FROM (
          SELECT DISTINCT ON (from_email)
            from_email AS email,
            from_name  AS name,
            0          AS send_count,
            date       AS last_sent,
            is_bulk
          FROM messages
          WHERE account_id = ANY($3)
            AND is_deleted = false
            AND from_email IS NOT NULL AND from_email != ''
            AND (from_email ILIKE $2 OR from_name ILIKE $2)
            AND lower(from_email) NOT IN (
              SELECT lower(primary_email) FROM contacts WHERE user_id = $1 AND primary_email IS NOT NULL
            )
            AND from_email !~* '^(noreply|no-reply|donotreply|mailer-daemon|notifications?|bounce[^@]*)@'
          ORDER BY from_email, date DESC
        ) latest
        WHERE is_bulk IS NOT TRUE
      )
      SELECT email, name
      FROM (
        SELECT email, name, 1 AS priority, send_count, last_sent FROM known
        UNION ALL
        SELECT email, name, 2 AS priority, 0, last_sent FROM auto
        UNION ALL
        SELECT email, name, 3 AS priority, 0, last_sent FROM inbound
      ) combined
      ORDER BY priority, send_count DESC, last_sent DESC NULLS LAST
      LIMIT 10
    `, [req.session.userId, pattern, userAccountIds]);

    res.json({ contacts: result.rows });
  } catch (err) {
    console.error('Contact suggest error:', err);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

export default router;
