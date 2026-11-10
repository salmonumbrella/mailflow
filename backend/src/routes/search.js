import { hydrateNativeLabels } from '../services/nativeLabelReadModel.js';
import { Router } from 'express';
import { buildSearchConditions } from '../services/searchConditions.js';
import { nativeLabelTerms, resolveNativeLabelSearch, nativeLabelIdentityAvailableSql } from '../services/nativeLabelSearch.js';
import { parseSearchExpression, SearchQueryError } from '../services/searchExpression.js';
import { query, withTransaction } from '../services/db.js';
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
  let { accountIds: targetIds } = resolveAccountScope(accountsResult.rows, accountId);

  const cap = Math.max(1, Math.min(parseInt(limit) || 50, 200));
  try {
    const tree = parseSearchExpression(trimmed);
    const requiresLabels = nativeLabelTerms(tree).length > 0;
    // Keep new definition-resolution criteria closed until native-label query
    // scopes have an explicit contract. Existing mail enrichment stays unchanged.
    if (requiresLabels && req.apiToken) return res.status(403).json({
      error: 'Native label search requires a browser session.', code: 'native_label_scope_required',
    });
    const run = async execute => {
      if (requiresLabels) {
        const accounts = await execute('SELECT id, include_in_unified_inbox FROM email_accounts WHERE user_id = $1 AND enabled = true', [req.session.userId]);
        targetIds = resolveAccountScope(accounts.rows, accountId).accountIds;
      }
      const nativeLabels = requiresLabels ? await resolveNativeLabelSearch(req.session.userId, targetIds, tree, execute) : null;
      const search = buildSearchConditions(trimmed, { folder: req.query.folder || '', nativeLabels });
      if (!targetIds.length) return { messages: [] };
      const conditions = search.conditions;
      if (!conditions.length) return { messages: [], query: q };
      if (search.excludeTrash) conditions.push(trashFolderExclusionCondition());
      const params = [targetIds, ...search.params];
      const p = params.length + 1;
      params.push(cap, Math.max(0, parseInt(offset) || 0));
      const result = await execute(`
        SELECT
          m.id, m.uid, m.folder, m.entity_id, m.storage_generation, m.uid_validity, m.message_id, m.subject, m.from_name, m.from_email,
          m.to_addresses, m.cc_addresses, m.reply_to, m.delivery_addresses, m.thread_id,
          m.in_reply_to, m.thread_references,
          m.date, m.snippet, m.is_read, m.is_starred, m.has_attachments, m.account_id,
          a.name as account_name, a.email_address as account_email, a.color as account_color
        FROM messages m
        JOIN email_accounts a ON m.account_id = a.id
        WHERE m.account_id = ANY($1)
          AND m.is_deleted = false
          AND ${conditions.join('\n        AND ')}
        ORDER BY m.date DESC, m.id DESC
        LIMIT $${p} OFFSET $${p + 1}
      `, params);

      let sizeIndex;
      if (search.requiresSize) {
        // Coverage describes this authorized synchronized cache, not matching
        // messages or all provider mail. EXISTS stops at the first unknown row.
        const coverageParams = [targetIds];
        const coverageScope = ['m.account_id = ANY($1)', 'm.is_deleted = false', 'm.rfc822_size_bytes IS NULL'];
        if (search.effectiveFolder) { coverageParams.push(search.effectiveFolder); coverageScope.push('m.folder = $2'); }
        if (search.excludeTrash) coverageScope.push(trashFolderExclusionCondition());
        const coverage = await execute(`SELECT EXISTS (SELECT 1 FROM messages m WHERE ${coverageScope.join(' AND ')}) AS has_unknown`, coverageParams);
        sizeIndex = {
          state: coverage.rows[0]?.has_unknown === false ? 'complete-for-cache' : 'partial',
          scope: search.effectiveFolder ? 'selected-folder-synchronized-cache' : 'selected-accounts-synchronized-cache',
          providerComplete: false,
        };
      }

      let labelIndex;
      if (requiresLabels) {
        const coverageParams = [targetIds];
        const coverageScope = ['m.account_id = ANY($1)', 'm.is_deleted = false'];
        if (search.effectiveFolder) { coverageParams.push(search.effectiveFolder); coverageScope.push('m.folder = $2'); }
        if (search.excludeTrash) coverageScope.push(trashFolderExclusionCondition());
        const { rows: [coverage] } = await execute(`SELECT count(*)::int AS total,
          count(*) FILTER (WHERE ${nativeLabelIdentityAvailableSql()})::int AS known
          FROM messages m WHERE ${coverageScope.join(' AND ')}`, coverageParams);
        const total = coverage.total, known = coverage.known;
        labelIndex = { state: total === known ? 'complete-for-cache' : 'partial',
          scope: search.effectiveFolder ? 'selected-folder-synchronized-cache' : 'selected-accounts-synchronized-cache',
          providerComplete: false, directMembershipOnly: true,
          total, known, unavailable: total - known,
          accounts: nativeLabels.accounts, resolvedReferences: nativeLabels.resolvedReferences };
      }
      const messages = await hydrateNativeLabels(req.session.userId, result.rows, execute);
      return { messages, query: q, ...(sizeIndex ? { sizeIndex } : {}), ...(labelIndex ? { labelIndex } : {}) };
    };
    // Definition resolution, membership predicates, coverage, and hydration all
    // observe one snapshot. A rename/delete/replacement cannot split this response.
    const response = requiresLabels ? await withTransaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      return run(client.query.bind(client));
    }) : await run(query);
    res.json(response);
  } catch (err) {
    if (err instanceof SearchQueryError) return res.status(400).json({ error: err.message,
      ...(err.code ? { code: err.code } : {}), ...(err.candidates ? { candidates: err.candidates } : {}) });
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
