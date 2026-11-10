import { Router } from 'express';
import { buildSearchConditions } from '../services/searchConditions.js';
import { SearchQueryError } from '../services/searchExpression.js';
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

// A user's API tokens share one bucket of their own, so a tool cannot spend the searches the
// person is typing in the browser, and many tokens do not add up to many budgets.
function searchLimiter(req, res, next) {
  const key = req.apiToken ? `tokens:${req.session.userId}` : req.session.userId;
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

// Keep the flat-token helper for existing callers. Requests use the bounded
// Boolean expression parser/compiler in searchConditions.js.
export { parseSearchQuery } from '../services/searchQuery.js';

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

export function trashFolderExclusionCondition() {
  return `NOT EXISTS (
        SELECT 1
        FROM folders f
        WHERE f.account_id = m.account_id
          AND f.path = m.folder
          AND (f.special_use = '\\Trash'
               OR lower(f.name) LIKE '%trash%'
               OR lower(f.name) LIKE '%deleted%')
      )`;
}

export { freeTextTermCondition, FTS_BODY_CHAR_CAP } from '../services/searchConditions.js';

router.get('/', searchLimiter, async (req, res) => {
  const { q, accountId, limit = 50, offset = 0 } = req.query;
  const trimmed = (q || '').trim();
  if (!trimmed) return res.json({ messages: [] });
  if (trimmed.length > 500) return res.status(400).json({ error: 'Search query too long' });

  const accountsResult = await query(
    'SELECT id, include_in_unified_inbox FROM email_accounts WHERE user_id = $1 AND enabled = true',
    [req.session.userId]
  );
  const { accountIds: targetIds } = resolveAccountScope(accountsResult.rows, accountId);
  if (!targetIds.length) return res.json({ messages: [] });

  const cap = Math.max(1, Math.min(parseInt(limit) || 50, 200));
  let search;
  try {
    search = buildSearchConditions(trimmed, { folder: req.query.folder || '' });
  } catch (err) {
    if (err instanceof SearchQueryError) return res.status(400).json({ error: err.message });
    throw err;
  }
  const conditions = search.conditions;
  if (!conditions.length) return res.json({ messages: [], query: q });
  if (search.excludeTrash) conditions.push(trashFolderExclusionCondition());
  const params = [targetIds, ...search.params];
  const p = params.length + 1;

  const off = Math.max(0, parseInt(offset) || 0);
  params.push(cap);
  params.push(off);

  try {
    const result = await query(`
      SELECT
        m.id, m.uid, m.folder, m.message_id, m.subject, m.from_name, m.from_email,
        m.to_addresses, m.cc_addresses, m.reply_to, m.delivery_addresses, m.thread_id,
        m.in_reply_to, m.thread_references,
        m.date, m.snippet, m.is_read, m.is_starred, m.has_attachments, m.account_id,
        a.name as account_name, a.email_address as account_email, a.color as account_color
      FROM messages m
      JOIN email_accounts a ON m.account_id = a.id
      WHERE m.account_id = ANY($1)
        AND m.is_deleted = false
        AND ${conditions.join('\n        AND ')}
      ORDER BY m.date DESC
      LIMIT $${p} OFFSET $${p + 1}
    `, params);

    res.json({ messages: result.rows, query: q });
  } catch (err) {
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
