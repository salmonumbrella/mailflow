import { hydrateCachedAttachmentMetadata } from '../services/messageAttachmentReadModel.js';
import { assertAttachmentRequestSource, assertAttachmentSource, captureAttachmentSource } from '../services/attachmentReadScope.js';
import { hydrateNativeLabels } from '../services/nativeLabelReadModel.js';
import { LIVE_SNOOZE_SQL } from '../services/snoozeIdentity.js';
import { STATUS_STALE_MS } from '../services/folderStatus.js';
import { Router } from 'express';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const archiver = require('archiver');
import { query } from '../services/db.js';
import { resolveCanonicalEntity, withAccountIdentity, withMailboxIdentity } from '../services/messageIdentity.js';
import { applyConfirmedMoveCache } from '../services/messageMoveCache.js';
import { assertReadSourceIdentity, withReadSourceIdentity, MESSAGE_FLAG_COLUMNS } from '../services/messageReadScope.js';
import { requireAuth } from '../middleware/auth.js';
import { imapManager } from '../index.js';
import { isConnectionRefusal } from '../services/imapManager.js';
import { CARRIED_COLUMNS, rememberDroppedRows } from '../services/movedRowCarry.js';
import { stripEmailHead, blockRemoteImages, rewriteEbayImageserUrls, rewriteAnchorHrefs, splitDarkScheme, proxyRemoteImages, remoteImageRefs } from '../services/emailSanitizer.js';
import { imageProxyPath, proxyWidth, fetchProxiedImage, createUserLimiter } from '../services/imageProxy.js';
import { imageCache, imageCacheKey } from '../services/imageCache.js';
import { shrinkImage } from '../services/imageShrink.js';
import { fitInlineImages } from '../services/inlineImageFit.js';
import { needsCidRefetch, needsImageRefetch, settleCids, settledEarlier, withoutCidMarker } from '../utils/cidRefs.js';
import { sanitizeDbText, storeFetchedBody } from '../services/messageBodyStore.js';
import { snippetFromBody, decodeMimeWords, parseRawHeaders, parseMailboxList, buildHeadersFromMessage } from '../services/messageParser.js';
import { draftMessageSql, trashMessageSql, resolveTrashFolder, resolveAllTrashPaths, resolveAllDraftsPaths, resolveArchiveFolder, isAllMailFolder, resolveSpamFolder, resolveAllSpamPaths, getDeleteStrategy, adjustFolderCounts, fanOutReadToSiblings, fanOutStarToSiblings, readCopyTargets, pushSeen } from '../utils/mailUtils.js';
import { pluginRegistry } from '../plugins/registry.js';
import { listMessages, LIST_SORTS, LIST_SORT_DIRS, NOT_PLACEHOLDER_SQL } from '../services/messageService.js';
import { recordSyncSignal } from '../services/diagnosticsRing.js';
import { resolveAccountScope } from '../services/unifiedInbox.js';
import { validateHost } from '../services/hostValidation.js';
import { safeFetch } from '../services/safeFetch.js';
import { safeFilename, attachmentDisposition, truncateFilename } from '../utils/contentDisposition.js';
import { tokenize, extractFlagFeatures } from '../services/spamTokenizer.js';
import { updateIncrementalForUser } from '../services/spamModelStore.js';
import { findOwnedAccount, findOwnedMessage, findOwnedMessages, SIBLING_COUNT } from '../services/ownership.js';

const router = Router();
router.use(requireAuth);

// Whether an account-scoped plugin that maintains label sibling rows (currently GTD) is active for
// this account — the modern replacement for the former email_accounts.gtd_enabled gate on the
// read/star sibling fan-out. Core stays plugin-agnostic: it asks the registry, never GTD directly.
// Folds plugin activation in (strictly safer than the old raw column — a deactivated plugin no
// longer triggers fan-out). The fan-out itself is still additionally gated on the message actually
// having siblings, so a non-plugin account stays byte-identical to pre-GTD.
const accountMaintainsLabelSiblings = (accountId) =>
  pluginRegistry.hasActiveAsync('inboxIngest', { account: { id: accountId } });

// Validate a folder name / path component: no control chars, max 255 chars.
// Exported with areValidUUIDs for middleware/apiTokenGuards.js, which leaves to these routes
// whatever input they refuse.
export function isValidFolderName(name) {
  // eslint-disable-next-line no-control-regex -- intentionally rejecting control characters
  return typeof name === 'string' && name.length > 0 && name.length <= 255 && !/[\x00-\x1f\x7f]/.test(name);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function areValidUUIDs(ids) {
  return ids.every(id => typeof id === 'string' && UUID_RE.test(id));
}

// Process IMAP operations in bounded batches so a 500-message bulk action
// does not spawn hundreds of parallel temporary IMAP connections.
async function runInBatches(items, concurrency, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

// Columns copied verbatim when a message row is relocated to a new folder/UID via the
// DELETE + reinsert CTE used by the bulk trash / move / archive paths on UIDPLUS servers.
// The destination uid comes from the UIDPLUS map (u.new_uid) and the destination folder is
// always bound as $4; everything else is carried over from the deleted row (d.*).
//
// Excluded on purpose:
//   - id, synced_at        -> use their column defaults (a fresh UUID and timestamp), which
//                             preserves the historical "row gets a new id on move" behavior.
//   - normalized_subject,
//     search_vector,
//     thread_key           -> GENERATED ALWAYS columns; Postgres computes them, and inserting
//                             an explicit value (even NULL) errors.
//   - is_deleted,
//     snippet_attempted_at -> never carried; left at their defaults. The reasons are with the
//                             exclusion list in mail.relocate.test.js.
//
// IMPORTANT: when a migration adds a data column to `messages`, add it to RELOCATE_COPY_COLS
// or a relocate will silently reset it to its default. This list has gone stale twice, dropping
// delivery_addresses (0037), plugin_annotations (0044) and sender_name/sender_email (0050), and
// then forwarded_from_name/forwarded_from_email/forwarded_via (0059). mail.relocate.test.js now
// reads every migration and fails on any messages column that is neither here nor excluded.
const RELOCATE_COPY_COLS = [
  // The database guard translates these only through persisted MOVE proof; otherwise clears them.
  'entity_id', 'storage_generation', 'uid_validity',
  'message_id', 'provider_msgid', 'rfc822_size_bytes', 'subject', 'from_name', 'from_email', 'to_addresses', 'cc_addresses',
  'reply_to', 'in_reply_to', 'date', 'snippet', 'is_read', 'is_starred', 'has_attachments',
  'flags', 'body_html', 'body_text', 'attachments', 'thread_references', 'thread_id', 'is_bulk',
  'read_changed_at', 'star_changed_at', 'spam_score_sa', 'spam_score_ml', 'spam_verdict',
  'spam_analyzed_at', 'spam_details', 'spam_user_override', 'category', 'list_unsubscribe',
  'list_unsubscribe_post', 'unsubscribed_at', 'delivery_addresses', 'plugin_annotations',
  'sender_name', 'sender_email', 'forwarded_from_name', 'forwarded_from_email', 'forwarded_via',
  'bcc_addresses',
];
// INSERT target list and the matching SELECT projection. account_id + the carried columns come
// from the deleted row; uid is the UIDPLUS-mapped new uid; folder is the destination ($4).
export const RELOCATE_INSERT_COLS = ['account_id', 'uid', 'folder', ...RELOCATE_COPY_COLS].join(', ');
export const RELOCATE_SELECT_COLS = ['d.account_id', 'u.new_uid', '$4', ...RELOCATE_COPY_COLS.map(c => `d.${c}`)].join(', ');

// On a uid a sync already filed, the synced row is kept with what it read from the server, and
// takes from the moved row what only MailFlow knew (a "Not spam" decision, the category, an
// unsubscribe), which the sync had no carry to restore from. A column the moved row never had
// keeps the synced row's value.
const RELOCATE_CONFLICT_SET = CARRIED_COLUMNS.map(c => `${c} = COALESCE(EXCLUDED.${c}, messages.${c})`).join(', ');

// Move rows to `folder` in one statement: each row whose new uid the server named is re-inserted
// there with every carried column; if a sync already inserted that uid, its row is kept (above). A row
// without a new uid is dropped for the folder's sync to file again (#665), and kept in
// movedRowCarry for that sync to give back what only MailFlow knew about it.
export async function relocateRows(ids, newUids, folder) {
  const withUid = ids.filter(id => newUids.has(id));
  const result = await query(`
    WITH deleted AS (
      DELETE FROM messages WHERE id = ANY($1::uuid[]) RETURNING *
    ),
    uid_map(src_id, new_uid) AS (
      SELECT * FROM unnest($2::uuid[], $3::bigint[])
    ),
    relocated AS (
      INSERT INTO messages (${RELOCATE_INSERT_COLS})
      SELECT ${RELOCATE_SELECT_COLS}
      FROM deleted d
      JOIN uid_map u ON d.id = u.src_id
      ON CONFLICT (account_id, uid, folder) DO UPDATE SET ${RELOCATE_CONFLICT_SET}
    )
    SELECT d.* FROM deleted d WHERE NOT (d.id = ANY($2::uuid[]))
  `, [ids, withUid, withUid.map(id => newUids.get(id)), folder]);
  rememberDroppedRows(folder, result?.rows);
}


// Returns true if a snippet contains content that should never appear in plain-text
// preview, indicating it was generated from unclean HTML and needs regeneration:
//   - &entity; — undecoded HTML entities from before the entity-stripping fix
//   - ##marker## — unexpanded template placeholders (UPS, Epsilon marketing mail)
//   - --> — dangling HTML comment end leaked by comment-stripping gap
function snippetIsGarbled(s) {
  return s && (
    /&[a-z][a-z0-9]*;/i.test(s) ||   // undecoded HTML entity
    /##[^#]*##/.test(s) ||             // unexpanded template placeholder
    /-->/.test(s) ||                   // dangling HTML comment fragment
    /\{[^}]*[:;][^}]*\}/.test(s) ||   // stored CSS rule block
    /<[a-z][^>]*>/i.test(s) ||         // raw HTML tag
    /<\/[a-z][a-z0-9:-]*\s*>/i.test(s) || // stray closing HTML tag
    /([=_*#~-])\1{3,}/.test(s) ||      // decorative divider run
    /\[[^\]]+\]\(https?:\/\//.test(s)  // Markdown link syntax from ESP text/plain generators
  );
}

// Fire-and-forget notification to label plugins after an ordinary mail mutation. Groups the
// acted rows by account and dispatches the generic `onMailMutation` hook per account; a label
// plugin (GTD) decides whether the mutation touched one of its labelled threads and broadcasts
// its own scoped refresh — either a live sibling post-mutation, or one of the acted rows sitting
// in a label folder pre-mutation (covers removing the last label copy of a thread, which leaves
// no post-mutation sibling to find). Rows are the pre-mutation message rows so their message_id
// and folder are captured before a move/delete can drop them; the hook swallows per-plugin
// errors, so a completed mutation is never turned into a 500.
function notifyMailMutation(rows, userId) {
  for (const accountId of new Set(rows.map(m => m.account_id).filter(Boolean))) {
    imapManager.scheduleCountRefresh?.(accountId, rows.filter(m => m.account_id === accountId).map(m => m.folder));
  }
  const byAccount = new Map();
  for (const m of rows) {
    if (!m.message_id) continue;
    if (!byAccount.has(m.account_id)) byAccount.set(m.account_id, { mids: new Set(), folders: new Set() });
    const entry = byAccount.get(m.account_id);
    entry.mids.add(m.message_id);
    if (m.folder) entry.folders.add(m.folder);
  }
  for (const [accountId, { mids, folders }] of byAccount) {
    pluginRegistry.runHook('onMailMutation', {
      imapManager: imapManager.pluginFacade, accountId, userId, messageIds: [...mids], actedFolders: [...folders],
    }).catch(err => console.warn('onMailMutation hook failed:', err.message));
  }
}

// Get messages (unified or per-account/folder)
router.get('/messages', async (req, res) => {
  const { accountId, folder = 'INBOX', limit = 50, offset = 0, unreadOnly, threaded, category, sort, dir, starredFirst } = req.query;

  if (!isValidFolderName(folder)) return res.status(400).json({ error: 'Invalid folder name' });
  if (sort !== undefined && !LIST_SORTS.includes(sort)) return res.status(400).json({ error: 'Invalid sort' });
  if (dir !== undefined && !LIST_SORT_DIRS.includes(dir)) return res.status(400).json({ error: 'Invalid sort direction' });

  // Validate category param — only allow known values to prevent SQL injection via the
  // WHERE clause in listMessages (even though it uses parameterised queries, belt-and-suspenders).
  const VALID_CATEGORIES = new Set(['primary', 'newsletter', 'promotion', 'automated', 'social']);
  const safeCategory = VALID_CATEGORIES.has(category) ? category : undefined;

  const { messages, total, threaded: isThreaded, resolvedAccountId } = await listMessages({
    userId: req.session.userId,
    accountId,
    folder,
    limit,
    offset,
    unreadOnly,
    threaded,
    category: safeCategory,
    sort,
    dir,
    starredFirst,
  });

  if (resolvedAccountId && messages.length) {
    imapManager.prefetchFolderBodies(resolvedAccountId, messages.map(r => r.id))
      .catch(err => console.warn('Folder body prefetch error:', err.message));
  }

  // Phase 1 reliability instrumentation: count "ghost" rows served — a UID is known but
  // its envelope hasn't been fetched, so the row renders as Unknown / (no subject). This is
  // the visible #407 symptom; measuring it turns "sometimes there are ghost rows" into a rate.
  if (resolvedAccountId && messages.length) {
    const ghosts = messages.filter(m =>
      !m.message_id && (!m.subject || m.subject === '(no subject)') && !m.snippet).length;
    if (ghosts > 0) recordSyncSignal('ghost_rows_served', { accountId: resolvedAccountId, magnitude: ghosts });
  }

  res.json({ messages, total, ...(isThreaded ? { threaded: true } : {}) });
});

router.get('/messages/:id', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message ID' });
  try {
    const message = await findOwnedMessage(req.session.userId, id, {
      columns: `m.id, m.uid, m.folder, m.entity_id, m.storage_generation, m.uid_validity, m.message_id, m.subject,
             m.from_name, m.from_email, m.to_addresses, m.cc_addresses,
             m.reply_to, m.in_reply_to, m.thread_references,
             m.date, m.snippet, m.is_read, m.is_starred,
             m.has_attachments, m.account_id, m.category,
             m.list_unsubscribe, m.list_unsubscribe_post, m.unsubscribed_at, m.delivery_addresses,
             m.spam_verdict, m.spam_user_override, m.spam_score_ml,
             a.name AS account_name, a.email_address AS account_email,
             a.color AS account_color`,
      live: true,
    });
    if (!message) return res.status(404).json({ error: 'Message not found' });
    res.json((await hydrateCachedAttachmentMetadata(req.session.userId, await hydrateNativeLabels(req.session.userId, [message])))[0]);
  } catch (err) {
    console.error('GET /messages/:id error:', err.message);
    res.status(500).json({ error: 'Failed to load message' });
  }
});

// Resolve a message by a DURABLE reference, for deep links (#270). The row's UUID PK is
// regenerated when an email is moved/resynced (rows are purged + re-inserted), so a deep
// link keyed on the UUID dies once the email changes folder. We instead match the stable
// RFC Message-ID header first, then fall back to the UUID for legacy links and push
// notifications (which still embed the UUID and are short-lived anyway). Columns and the
// user-scoping (a.user_id, is_deleted) mirror GET /messages/:id. Distinct path so it never
// collides with the greedy /messages/:id route.
router.get('/resolve-message', async (req, res) => {
  const ref = typeof req.query.ref === 'string' ? req.query.ref : '';
  if (!ref) return res.status(400).json({ error: 'Missing ref' });
  const rawAccountId = typeof req.query.accountId === 'string' ? req.query.accountId : '';
  if (rawAccountId && !UUID_RE.test(rawAccountId)) {
    return res.status(400).json({ error: 'Invalid accountId' });
  }
  const accountId = rawAccountId || null;
  const COLS = `m.id, m.uid, m.folder, m.entity_id, m.storage_generation, m.uid_validity, m.message_id, m.subject,
             m.from_name, m.from_email, m.to_addresses, m.cc_addresses,
             m.reply_to, m.in_reply_to, m.thread_references, m.thread_id,
             m.date, m.snippet, m.is_read, m.is_starred,
             m.has_attachments, m.account_id, m.category,
             m.list_unsubscribe, m.list_unsubscribe_post, m.unsubscribed_at, m.delivery_addresses,
             m.spam_verdict, m.spam_user_override, m.spam_score_ml,
             a.name AS account_name, a.email_address AS account_email,
             a.color AS account_color`;
  try {
    // Durable match on the stable Message-ID header. When the same email exists in more
    // than one folder (e.g. INBOX + Archive), prefer the INBOX copy, then the most recent.
    let result = await query(`
      SELECT ${COLS}
      FROM messages m
      JOIN email_accounts a ON m.account_id = a.id
      WHERE m.message_id = $1
        AND a.user_id = $2
        AND m.is_deleted = false
        AND ($3::uuid IS NULL OR m.account_id = $3)
      ORDER BY (m.folder = 'INBOX') DESC, m.date DESC NULLS LAST
      LIMIT 1
    `, [ref, req.session.userId, accountId]);
    // Legacy links / push notifications carry the UUID primary key.
    if (result.rows.length === 0 && UUID_RE.test(ref)) {
      result = await query(`
        SELECT ${COLS}
        FROM messages m
        JOIN email_accounts a ON m.account_id = a.id
        WHERE m.id = $1
          AND a.user_id = $2
          AND m.is_deleted = false
          AND ($3::uuid IS NULL OR m.account_id = $3)
      `, [ref, req.session.userId, accountId]);
    }
    if (result.rows.length === 0) return res.status(404).json({ error: 'Message not found' });
    res.json((await hydrateCachedAttachmentMetadata(req.session.userId, await hydrateNativeLabels(req.session.userId, [result.rows[0]])))[0]);
  } catch (err) {
    console.error('GET /resolve-message error:', err.message);
    res.status(500).json({ error: 'Failed to resolve message' });
  }
});

// Returns true if remote images should be blocked for this message given the user's preferences.
// Default behaviour (no preference set) is to block.
function shouldBlockImages(prefs, message) {
  if (prefs?.blockRemoteImages === false) return false;
  const senderEmail = (message.from_email || '').toLowerCase();
  const atIdx = senderEmail.indexOf('@');
  const senderDomain = atIdx >= 0 ? senderEmail.slice(atIdx + 1) : '';
  const whitelist = prefs?.imageWhitelist || {};
  const allowedAddresses = Array.isArray(whitelist.addresses) ? whitelist.addresses.filter(a => typeof a === 'string').map(a => a.toLowerCase()) : [];
  const allowedDomains   = Array.isArray(whitelist.domains)   ? whitelist.domains.filter(d => typeof d === 'string').map(d => d.toLowerCase())   : [];
  if (senderEmail && allowedAddresses.includes(senderEmail)) return false;
  if (senderDomain && allowedDomains.some(d => senderDomain === d || senderDomain.endsWith('.' + d))) return false;
  return true;
}

// Get all messages belonging to a thread (for threaded view expansion). The id goes in the query
// string: a thread id is a Message-ID, and GitHub's contain slashes, which some reverse proxies
// reject or decode when they appear encoded in a path (#509). The path form stays for clients
// that still use it.
async function getThread(req, res, threadId) {
  if (typeof threadId !== 'string' || !threadId) return res.status(400).json({ error: 'threadId required' });

  try {
    const accountsResult = await query(
      'SELECT id, include_in_unified_inbox FROM email_accounts WHERE user_id = $1 AND enabled = true',
      [req.session.userId]
    );
    const accountIds = req.query.unified === 'true'
      ? resolveAccountScope(accountsResult.rows).accountIds
      : accountsResult.rows.map(row => row.id);
    if (!accountIds.length) return res.json({ messages: [] });

    // Show all non-deleted messages in the thread regardless of folder. This includes
    // Sent replies (which have distinct message_ids) alongside received messages.
    // DISTINCT ON deduplicates the same message appearing in multiple folders (e.g. Gmail's
    // All Mail), preferring the INBOX copy.
    //
    // The key is scoped to the account. One email delivered to two connected accounts is two
    // separate mailbox items sharing a Message-ID, and a bare message_id key dropped one of
    // them: the copy vanished from the conversation as well as from the grouped list, so in
    // conversation mode it was not reachable anywhere in the UI (#476). Thunderbird puts both
    // copies in the one thread here, keyed by Message-ID and explicitly folder- and
    // account-agnostic for THREADING while still listing each copy, which is the behavior this
    // matches. Same-account duplicates (All Mail, the Sent twin) still collapse.
    const result = await query(`
      WITH deduped AS (
        SELECT DISTINCT ON (m.account_id, m.message_id)
               m.id, m.uid, m.folder, m.entity_id, m.storage_generation, m.uid_validity, m.message_id, m.thread_id, m.subject,
               m.from_name, m.from_email, m.to_addresses, m.cc_addresses,
               m.reply_to, m.in_reply_to, m.thread_references,
               m.date, m.snippet, m.is_read, m.is_starred,
               m.has_attachments, m.account_id, m.category,
               m.list_unsubscribe, m.list_unsubscribe_post, m.unsubscribed_at, m.delivery_addresses,
               a.name AS account_name, a.email_address AS account_email, a.color AS account_color,
               -- Deleting or moving the conversation leaves its drafts alone, and its copies already
               -- in Trash, where a delete expunges (utils/conversationActions.js).
               ${draftMessageSql('m')} AS is_draft,
               ${trashMessageSql('m')} AS in_trash
        FROM messages m
        JOIN email_accounts a ON m.account_id = a.id
        WHERE m.is_deleted = false
          AND m.account_id = ANY($1)
          AND m.thread_key = $2
        ORDER BY m.account_id,
                 m.message_id,
                 CASE WHEN m.folder = 'INBOX' THEN 0 ELSE 1 END,
                 m.date ASC
      )
      -- account_id, id break the tie: two accounts' copies of one email carry the same Date,
      -- so date alone would order them arbitrarily between requests.
      SELECT * FROM deduped ORDER BY date ASC, account_id, id
    `, [accountIds, threadId]);

    res.json({ messages: await hydrateCachedAttachmentMetadata(req.session.userId, await hydrateNativeLabels(req.session.userId, result.rows)) });
  } catch (err) {
    console.error('Thread fetch error:', err);
    res.status(500).json({ error: 'Failed to load thread' });
  }
}
router.get('/thread', (req, res) => getThread(req, res, req.query.id));
router.get('/thread/:threadId', (req, res) => getThread(req, res, req.params.threadId));

// Counts are snapshots independently measured on the IMAP server, never cache tallies.
router.get('/unread-counts', async (req, res) => {
  const result = await query(`SELECT a.id AS account_id, a.include_in_unified_inbox,
      f.server_unread_count AS count, f.server_total_count, f.server_counts_at, f.server_count_revision, f.status_attempt_revision, f.status_error
    FROM email_accounts a LEFT JOIN folders f ON f.account_id=a.id AND f.path='INBOX'
    WHERE a.user_id=$1 AND a.enabled`, [req.session.userId]);
  const byAccount = {}, snapshots = {};
  let total = 0, complete = true;
  for (const row of result.rows) {
    const known = row.count != null && row.server_counts_at != null;
    const count = known ? Number(row.count) : null;
    byAccount[row.account_id] = count;
    const stale = !known || !!row.status_error || Date.now() - new Date(row.server_counts_at).getTime() > STATUS_STALE_MS;
    snapshots[row.account_id] = { totalCount: known && row.server_total_count != null ? Number(row.server_total_count) : null, revision: row.server_count_revision || '0', attemptRevision: row.status_attempt_revision || row.server_count_revision || '0', observedAt: row.server_counts_at || null, stale, known };
    if (row.include_in_unified_inbox !== false) {
      if (known) total += count;
      if (stale) complete = false;
    }
  }
  // How many messages are snoozed (#269): the sidebar shows its Snoozed view only while some are.
  // Secondary to the counts, so a failure here reports none rather than failing them.
  let snoozed = 0;
  try {
    const r = await query(
      `SELECT COUNT(*)::int AS n FROM snoozed_messages sm
       JOIN email_accounts a ON a.id = sm.account_id AND a.user_id = $1 AND a.enabled
       WHERE sm.user_id = $1 AND ${LIVE_SNOOZE_SQL}`,
      [req.session.userId]
    );
    snoozed = r?.rows?.[0]?.n ?? 0;
  } catch (err) {
    console.warn('Snoozed count failed:', err.message);
  }
  // Scheduled messages (#543): pending (scheduled, being edited or sent) and those that need the
  // user (failed, paused, uncertain), for the sidebar's Scheduled view. Secondary like snoozed.
  const scheduled = { pending: 0, attention: 0 };
  try {
    const r = await query(
      `SELECT COUNT(*) FILTER (WHERE status IN ('scheduled', 'editing', 'sending'))::int AS pending,
              COUNT(*) FILTER (WHERE status IN ('failed', 'paused', 'uncertain'))::int AS attention
         FROM scheduled_messages WHERE user_id = $1`,
      [req.session.userId]
    );
    scheduled.pending = r?.rows?.[0]?.pending ?? 0;
    scheduled.attention = r?.rows?.[0]?.attention ?? 0;
  } catch (err) {
    console.warn('Scheduled count failed:', err.message);
  }
  res.set('Cache-Control', 'no-store');
  res.json({ total, byAccount, snapshots, complete, snoozed, scheduled });
});

// Hard cap on a live IMAP body fetch. Connection acquisition is already bounded at 30s
// inside imapManager, but the FETCH itself is not — on a half-open/stalled connection
// (e.g. an account mid-reconnect, as happens on large flaky mailboxes) it can hang
// indefinitely, and with no response the client's body spinner spins forever. 40s sits
// above the 30s connect bound so a legitimately slow connect still completes.
const BODY_FETCH_TIMEOUT_MS = 40000;

// Reject with a tagged error if `promise` doesn't settle within `ms`. The underlying
// fetch keeps running and releases its pooled client via withFreshClient's own cleanup;
// we just stop making the HTTP request wait on it. clearTimeout avoids keeping the
// event loop alive after the race settles.
function fetchWithTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('BODY_FETCH_TIMEOUT')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The Bcc MailFlow recorded for a message you sent or a draft you saved (#585). Received mail has
// none stored, so it shows none.
const bccOf = (message) => (Array.isArray(message.bcc_addresses) ? message.bcc_addresses : []);

// Messages whose cached body a repair fetch (below) lately failed to replace: served as stored for
// a while, rather than every view waiting on a mail server that is not answering first. Kept in
// this process only, and emptied past its cap: forgetting one costs a single fetch.
const BODY_REPAIR_RETRY_MS = 10 * 60_000;
const BODY_REPAIR_FAILURES_MAX = 10_000;
const failedBodyRepairs = new Map();

function bodyRepairFailedLately(id) {
  const at = failedBodyRepairs.get(id);
  if (at === undefined) return false;
  if (Date.now() - at < BODY_REPAIR_RETRY_MS) return true;
  failedBodyRepairs.delete(id);
  return false;
}

function noteBodyRepairFailed(id) {
  if (failedBodyRepairs.size >= BODY_REPAIR_FAILURES_MAX) failedBodyRepairs.clear();
  failedBodyRepairs.set(id, Date.now());
}

// A view waits this long on a repair fetch, then gets the stored body: it was readable before,
// and a mail server that accepts a connection and then says nothing would otherwise hold every
// such view for the whole fetch timeout. The fetch goes on, and stores its body when it arrives.
const BODY_REPAIR_TIMEOUT_MS = 8000;
// Repair fetches under way, by message id: the views of one message while it runs share it.
const bodyRepairs = new Map();

// The body of `message` fetched again to repair the stored one, and stored, once however many
// views ask at a time. Resolves to { stored } with what storeFetchedBody stored, or to
// { keptHtml } when the stored HTML stays because the fetch came back with text alone (marked, so
// it is not fetched again for that), or to {} when the message is gone from the server or its row
// changed meanwhile. Either write lands only on the row as the repair found it: one that arrives
// after the view stopped waiting must not replace a body stored since. A failure is noted, so the
// views after it get the stored body for a while.
function repairBody(message) {
  const { id } = message;
  const running = bodyRepairs.get(id);
  if (running) return running;
  const repair = (async () => {
    const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
    const account = accountResult.rows[0];
    imapManager.noteUserActivity(account.id);
    const body = await imapManager.fetchMessageBody(account, message.uid, message.folder);
    if (body.html == null && body.text == null) {
      noteBodyRepairFailed(id);
      return {};
    }
    if (body.html == null) {
      const keptHtml = settleCids(message.body_html, true);
      const kept = await query('UPDATE messages SET body_html = $1 WHERE id = $2 AND body_html = $3 AND uid = $4 AND folder = $5',
        [keptHtml, id, message.body_html, message.uid, message.folder]);
      return kept?.rowCount ? { keptHtml } : {};
    }
    const { sanitized, safeText, stored } = await storeFetchedBody(id, body, { over: message });
    return stored ? { stored: { sanitized, safeText, attachments: body.attachments } } : {};
  })().catch((err) => {
    console.warn('Body repair fetch failed, serving the stored body:', err.message || err);
    noteBodyRepairFailed(id);
    throw err;
  }).finally(() => bodyRepairs.delete(id));
  // A view that stopped waiting has nothing to do with the failure; it is noted above.
  repair.catch(() => {});
  bodyRepairs.set(id, repair);
  return repair;
}

// Get full message body + attachments list
router.get('/messages/:id/body', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const result = await query(`
    SELECT m.*, a.user_id, u.preferences FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    JOIN users u ON u.id = a.user_id
    WHERE m.id = $1 AND a.user_id = $2
  `, [id, req.session.userId]);

  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  const message = result.rows[0];

  // Return cached body if available — but re-fetch when the cached HTML still
  // contains unresolved cid: references, or http:// image URLs that were cached
  // before the http→https upgrade was added (would be blocked as mixed content).
  // A body fetched completely is marked settled and not fetched again for references
  // that can never resolve (utils/cidRefs.js, #595).
  const hasCidRefs  = needsCidRefetch(message.body_html);
  const hasHttpImgs = message.body_html && (
    // <img src="http://"> cached before the http→https upgrade
    /<img[^>]+src=["']http:\/\//i.test(message.body_html) ||
    // background="http://" on table/td/tr elements (marketing email table layouts)
    /background=["']http:\/\//i.test(message.body_html) ||
    // CSS url(http://) in inline style attributes or <style> blocks
    /url\(\s*['"]?http:\/\//i.test(message.body_html)
  );
  const cachedAttachments = message.attachments
    ? (typeof message.attachments === 'string' ? JSON.parse(message.attachments) : message.attachments)
    : [];
  const cached = Boolean(message.body_html || message.body_text);
  // A body the release before served as stored, fetched again only to repair its images: one
  // settled under an earlier marker, or one an email's own images may show in now (#640). When
  // that fetch fails or is slow the stored body is served, as before (repairBody).
  // A draft's stored body is what its composer saved, so it is never replaced this way.
  const repairOnly = cached && !hasHttpImgs && (!hasCidRefs || settledEarlier(message.body_html));
  const staleImages = repairOnly && !(message.flags || []).includes('\\Draft')
    && needsImageRefetch(message.body_html, cachedAttachments);
  const serveCached = async () => {
    // Apply head-stripping to already-cached HTML so emails stored before this
    // fix was deployed are cleaned up immediately on first view.
    let html = message.body_html ? stripEmailHead(message.body_html) : null;
    if (html !== message.body_html) {
      // Update cache so subsequent views don't need to re-strip
      query('UPDATE messages SET body_html = $1 WHERE id = $2', [sanitizeDbText(html), id]).catch(() => {});
    }
    // Rewrite eBay imageser URLs to direct image URLs for emails cached before this fix.
    // imageser requires eBay session cookies (never sent cross-site) and returns 1 byte
    // without them; the real image is always in the `imageUrl` query parameter.
    if (html && html.includes('svcs.ebay.com/imageser')) {
      const rewritten = rewriteEbayImageserUrls(html);
      if (rewritten !== html) {
        html = rewritten;
        query('UPDATE messages SET body_html = $1 WHERE id = $2', [sanitizeDbText(html), id]).catch(() => {});
      }
    }
    // Normalise bare-domain hrefs (e.g. href="benchmade.com") cached before href
    // normalisation was added to sanitizeEmail().  Without this, clicking such links
    // in the sandboxed iframe resolves them against the mailflow origin and opens a
    // new mailflow tab instead of the sender's website.
    if (html && /<a\b[^>]*\shref=["'](?!https?:\/\/|mailto:|cid:|tel:|\/\/|[#/.])/i.test(html)) {
      const rewritten = rewriteAnchorHrefs(html);
      if (rewritten !== html) {
        html = rewritten;
        query('UPDATE messages SET body_html = $1 WHERE id = $2', [sanitizeDbText(html), id]).catch(() => {});
      }
    }
    // Backfill snippet when absent, or regenerate if garbled (undecoded HTML entities
    // from before the entity-stripping fix — e.g. "&zwnj;" in preview text).
    if (!message.snippet || snippetIsGarbled(message.snippet)) {
      const snip = snippetFromBody(message.body_text, html);
      if (snip) {
        query('UPDATE messages SET snippet = $1 WHERE id = $2', [sanitizeDbText(snip), id]).catch(() => {});
      }
    }

    // Apply remote-image blocking at response time — never write the blocked variant
    // back to the DB so the canonical cached HTML always has images intact.
    const skipBlocking = req.query.remoteImages === '1';
    // The settled marker stays in the cache (html, written back above); it never leaves MailFlow.
    const shown = withoutCidMarker(html);
    let responseHtml = shown;
    let hasBlockedRemoteImages = false;
    // Whether remote images are blocked for this message at all, whatever was found: the email
    // frame then forbids remote loads outright, behind blockRemoteImages.
    const remoteImagesBlocked = !skipBlocking && shouldBlockImages(message.preferences, message);
    if (remoteImagesBlocked && shown) {
      const blocked = blockRemoteImages(shown); // once: hasRemoteImages is this same pass
      if (blocked !== shown) {
        responseHtml = blocked;
        hasBlockedRemoteImages = true;
      }
    }
    // Remote images allowed for this message load through the image proxy (services/imageProxy.js),
    // and the email frame then allows images from MailFlow alone.
    const remoteImagesProxied = !remoteImagesBlocked;
    const imageStats = {};
    if (remoteImagesProxied && shown) responseHtml = proxyRemoteImages(shown, (raw, width) => imageProxyPath(id, raw, width), imageStats);
    const inline = req.query.original === '1' ? { html: responseHtml, count: 0 } : await fitInlineImages(responseHtml, req.session.userId);
    return res.json({ ...splitDarkScheme(inline.html), inlineImagesFitted: inline.count > 0, text: message.body_text, attachments: cachedAttachments, hasBlockedRemoteImages, remoteImagesBlocked, remoteImagesProxied, trackersBlocked: imageStats.trackers ?? 0, senderEmail: message.sender_email, senderName: message.sender_name, forwardedFromEmail: message.forwarded_from_email, forwardedFromName: message.forwarded_from_name, forwardedVia: message.forwarded_via, bccAddresses: bccOf(message) });
  };
  // A body fetched from the mail server and stored (storeFetchedBody), as the response gives it.
  const serveFetched = async ({ sanitized, safeText, attachments }) => {
    // Apply remote-image blocking at response time — safeHtml (unblocked) is what
    // was written to the DB cache above, preserving the canonical body; the response is it
    // without the settled marker.
    const skipBlocking = req.query.remoteImages === '1';
    let responseHtml = sanitized;
    let hasBlockedRemoteImages = false;
    const remoteImagesBlocked = !skipBlocking && shouldBlockImages(message.preferences, message);
    if (remoteImagesBlocked && sanitized) {
      const blocked = blockRemoteImages(sanitized);
      if (blocked !== sanitized) {
        responseHtml = blocked;
        hasBlockedRemoteImages = true;
      }
    }
    const remoteImagesProxied = !remoteImagesBlocked;
    const imageStats = {};
    if (remoteImagesProxied && sanitized) responseHtml = proxyRemoteImages(sanitized, (raw, width) => imageProxyPath(id, raw, width), imageStats);
    const inline = req.query.original === '1' ? { html: responseHtml, count: 0 } : await fitInlineImages(responseHtml, req.session.userId);
    return res.json({ ...splitDarkScheme(inline.html), inlineImagesFitted: inline.count > 0, text: safeText, attachments: attachments || [], hasBlockedRemoteImages, remoteImagesBlocked, remoteImagesProxied, trackersBlocked: imageStats.trackers ?? 0, senderEmail: message.sender_email, senderName: message.sender_name, forwardedFromEmail: message.forwarded_from_email, forwardedFromName: message.forwarded_from_name, forwardedVia: message.forwarded_via, bccAddresses: bccOf(message) });
  };
  // A prefetch (?prefetch=1): the client loading a row the pointer rests on, ahead of a click that
  // may never come (#677). It gets a stored body as any view does, and fetches from the mail server
  // only when imapManager.prefetchBodyVerdict says 'yes'. Otherwise it is answered 204, with
  // nothing fetched or stored, and an X-Prefetch header saying why: 'later' (the provider is being
  // backed off), 'never' (prefetches are not for this account), or 'repair' (the stored body is due
  // a repair fetch, which the click does as it always has; serving it unrepaired would leave the
  // client a cached copy the click then shows instead).
  const prefetch = req.query.prefetch === '1';
  const declinePrefetch = why => res.status(204).set('X-Prefetch', why).end();
  if (cached && !hasCidRefs && !hasHttpImgs && !staleImages) return serveCached();
  if (repairOnly) {
    if (bodyRepairFailedLately(id)) return serveCached();
    if (prefetch) return declinePrefetch('repair');
    let repaired;
    try {
      repaired = await fetchWithTimeout(repairBody(message), BODY_REPAIR_TIMEOUT_MS);
    } catch (err) {
      // Still running, it stores its body when that arrives; until then the stored one is served.
      if (err.message === 'BODY_FETCH_TIMEOUT') noteBodyRepairFailed(id);
      return serveCached();
    }
    if (repaired.stored) return serveFetched(repaired.stored);
    if (repaired.keptHtml) message.body_html = repaired.keptHtml;
    return serveCached();
  }

  // Fetch from IMAP: a view the user asked for signals user activity so background jobs back off.
  try {
    const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
    const account = accountResult.rows[0];
    if (prefetch) {
      const verdict = imapManager.prefetchBodyVerdict(account);
      if (verdict !== 'yes') return declinePrefetch(verdict);
    } else {
      // Only a view the user asked for holds background work back; a prefetch is not one.
      imapManager.noteUserActivity(account.id);
    }

    const { html, text, attachments, cidsComplete } = await fetchWithTimeout(
      imapManager.fetchMessageBody(account, message.uid, message.folder, { background: Boolean(prefetch) }),
      BODY_FETCH_TIMEOUT_MS
    );
    return await serveFetched({ ...await storeFetchedBody(id, { html, text, attachments, cidsComplete }), attachments });
  } catch (err) {
    const msg = err.message || 'Unknown error';
    console.error('Body fetch error:', msg);
    // Detect Gmail/IMAP throttling and surface a helpful message
    const isThrottle = /THROTTL/i.test(msg);
    if (isThrottle) {
      return res.status(503).json({
        error: 'The mail server is temporarily throttling access. Please wait a few minutes and try again.',
        throttled: true,
      });
    }
    if (msg === 'BODY_FETCH_TIMEOUT') {
      return res.status(504).json({
        error: 'This message is taking too long to load — the mail server may be temporarily unreachable. Please try again.',
        timeout: true,
      });
    }
    // Our own connection budget, not the provider's. Saying so beats a generic 500:
    // the account is busy, the request is worth retrying, and nothing is broken.
    // The provider itself is refusing additional connections (Yahoo's per-account session
    // ceiling, #474). Distinct from poolExhausted below, which is OUR budget: here nothing
    // MailFlow does right now will make the request succeed, so say what is happening and
    // that MailFlow is already backing off, instead of the raw server string.
    if (err.providerRefusing || isConnectionRefusal(msg)) {
      return res.status(503).json({
        error: 'The mail server is limiting connections for this account. MailFlow is backing off and will retry automatically; please try again shortly.',
        providerLimited: true,
      });
    }
    if (err.poolExhausted) {
      return res.status(503).json({
        error: 'This account is busy with other mail operations. Please try again in a moment.',
        busy: true,
      });
    }
    res.status(500).json({ error: msg });
  }
});

// Get full raw headers
router.get('/messages/:id/headers', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const message = await findOwnedMessage(req.session.userId, id, { columns: 'm.*, a.user_id' });
  if (!message) return res.status(404).json({ error: 'Message not found' });

  try {
    const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
    const account = accountResult.rows[0];

    let headers = '';
    try {
      headers = await imapManager.fetchHeaders(account, message.uid, message.folder);
    } catch (fetchErr) {
      console.warn('Headers IMAP fetch failed:', fetchErr.message);
    }

    if (!headers?.trim()) {
      headers = buildHeadersFromMessage(message);
    }

    // This exists only to REPAIR a subject we never stored, so it is gated on the stored one
    // being missing. It used to re-derive the subject every time and hand it back
    // unconditionally; MessageHeaderModal pushes that value up through onSubjectResolved, so
    // any flaw in header decoding silently rewrote the list and the open message with a worse
    // value than the one already on screen. That is how #454 became visible. Never replacing
    // a subject we already have keeps a decoding bug contained to this modal.
    let resolvedSubject = message.subject;
    const storedSubjectMissing = !message.subject || message.subject === '(no subject)';
    if (storedSubjectMissing && headers?.trim()) {
      const parsed = parseRawHeaders(headers);
      const imapSubject = decodeMimeWords(parsed.subject || '').trim();
      if (imapSubject && imapSubject !== '(no subject)') {
        resolvedSubject = imapSubject;
        await query('UPDATE messages SET subject = $1 WHERE id = $2', [imapSubject, id]);
      }
    }

    res.json({ headers, subject: resolvedSubject });
  } catch (err) {
    console.error('Headers fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch message headers' });
  }
});

// Bcc recipients of a draft, for reopening it in the composer. A draft's Bcc exists only in its own
// headers and saving the reopened draft expunges that copy, so failing to read it has to be an
// error, never an empty list: an empty list is what erased it. Drafts MailFlow saved carry it in
// bcc_addresses; anything else (NULL) is read from the copy on the server.
router.get('/messages/:id/bcc', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const unreadable = "Could not read this draft's Bcc recipients from the mail server.";
  try {
    const message = await findOwnedMessage(req.session.userId, id, {
      columns: 'm.account_id, m.uid, m.folder, m.message_id, m.bcc_addresses',
    });
    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (Array.isArray(message.bcc_addresses)) return res.json({ bcc: message.bcc_addresses });

    const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
    const account = accountResult.rows[0];
    imapManager.noteUserActivity(account.id);
    const headers = parseRawHeaders(await fetchWithTimeout(
      imapManager.fetchHeaders(account, message.uid, message.folder),
      BODY_FETCH_TIMEOUT_MS
    ));
    if (!Object.keys(headers).length) {
      console.warn(`Draft Bcc: no headers for uid ${message.uid} in ${message.folder}`);
      return res.status(502).json({ error: unreadable });
    }
    // Stops a uid that now holds some other message from handing back that message's Bcc.
    const norm = v => String(v || '').replace(/[<>\s]/g, '').toLowerCase();
    if (message.message_id && norm(message.message_id) !== norm(headers['message-id'])) {
      console.warn(`Draft Bcc: uid ${message.uid} in ${message.folder} holds ${headers['message-id'] || 'no Message-ID'}, not ${message.message_id}`);
      return res.status(409).json({ error: 'This draft changed on the mail server. Refresh the folder and try again.' });
    }
    res.json({ bcc: (headers.bcc || '').split('\n').flatMap(line => parseMailboxList(line)) });
  } catch (err) {
    console.warn('Draft Bcc fetch failed:', err.message);
    res.status(502).json({ error: unreadable });
  }
});

const ZIP_MAX_FILES = 100;
const ZIP_MAX_TOTAL_BYTES = 150 * 1024 * 1024; // 150 MB
const ZIP_MAX_FILE_BYTES  =  50 * 1024 * 1024; //  50 MB per file

// Download all attachments as a ZIP archive
router.get('/messages/:id/attachments.zip', async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const message = await findOwnedMessage(req.session.userId, id, { columns: 'm.*, a.user_id', live: true, enabledAccount: true });
  if (!message) return res.status(404).json({ error: 'Message not found' });

  const attachments = typeof message.attachments === 'string'
    ? JSON.parse(message.attachments || '[]')
    : (message.attachments || []);

  if (attachments.length === 0) return res.status(404).json({ error: 'No attachments' });
  if (attachments.length > ZIP_MAX_FILES) return res.status(400).json({ error: `Too many attachments (max ${ZIP_MAX_FILES})` });

  const knownTotal = attachments.reduce((sum, a) => sum + (a.size || 0), 0);
  if (knownTotal > ZIP_MAX_TOTAL_BYTES) {
    return res.status(413).json({ error: 'Total attachment size exceeds the 150 MB ZIP limit.' });
  }

  // Exclude per-file oversize items; unknown-size (0) are allowed through.
  const eligible = attachments.filter(a => !a.size || a.size <= ZIP_MAX_FILE_BYTES);
  if (eligible.length === 0) return res.status(413).json({ error: 'All attachments exceed the 50 MB per-file limit.' });

  try {
    assertAttachmentRequestSource(req.get('X-Mailflow-Message-Source'), message);
    const account = await findOwnedAccount(req.session.userId, message.account_id, { enabled: true });
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const proof = await captureAttachmentSource(account, message.folder, message.uid, message);

    const bufferMap = await imapManager.fetchMultipleAttachments(account, message.uid, message.folder, eligible, { expectedSource: message });
    await assertAttachmentSource(account, proof);
    if (bufferMap.size === 0) return res.status(404).json({ error: 'Could not fetch attachments' });

    // Deduplicate filenames: invoice.pdf → invoice (2).pdf
    const usedNames = new Map();
    const entries = [];
    for (const att of eligible) {
      const buf = bufferMap.get(att.part);
      if (!buf) continue;
      let name = safeFilename(att.filename);
      if (usedNames.has(name)) {
        const n = usedNames.get(name) + 1;
        usedNames.set(name, n);
        const dot = name.lastIndexOf('.');
        name = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
      } else {
        usedNames.set(name, 1);
      }
      entries.push({ name, buf });
    }

    if (entries.length === 0) return res.status(404).json({ error: 'Could not fetch attachments' });

    const totalBytes = entries.reduce((sum, entry) => sum + entry.buf.length, 0);
    if (totalBytes > ZIP_MAX_TOTAL_BYTES || entries.some(entry => entry.buf.length > ZIP_MAX_FILE_BYTES)) {
      return res.status(413).json({ error: 'Fetched attachments exceed the ZIP size limits.' });
    }

    const zipName = truncateFilename(message.subject || 'attachments', 100) + '-attachments.zip';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', attachmentDisposition(zipName));

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', err => {
      console.error('ZIP archive error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to create ZIP' });
    });
    archive.pipe(res);
    for (const { name, buf } of entries) {
      archive.append(buf, { name });
    }
    archive.finalize();
  } catch (err) {
    console.error('ZIP fetch error:', err);
    if (!res.headersSent) res.status(err.status || (err.code?.startsWith('identity_') || err.code === 'storage_generation_conflict' ? 409 : 500))
      .json({ error: err.status || err.code?.startsWith('identity_') || err.code === 'storage_generation_conflict' ? err.message : 'Failed to create ZIP' });
  }
});

// Download attachment
router.get('/messages/:id/attachments/:part', async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  const { id, part } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });
  let partNum;
  try {
    partNum = decodeURIComponent(part);
  } catch {
    return res.status(400).json({ error: 'Invalid attachment part identifier' });
  }

  const message = await findOwnedMessage(req.session.userId, id, { columns: 'm.*, a.user_id', live: true, enabledAccount: true });
  if (!message) return res.status(404).json({ error: 'Message not found' });

  // Find attachment metadata
  const attachments = typeof message.attachments === 'string'
    ? JSON.parse(message.attachments || '[]')
    : (message.attachments || []);
  const att = attachments.find(a => a.part === partNum);
  if (!att) return res.status(404).json({ error: 'Attachment not found' });

  // Reject oversized attachments before opening an IMAP connection.
  // att.size comes from the IMAP BODYSTRUCTURE response and is generally accurate.
  // A size of 0 means unknown — allow the fetch to proceed in that case.
  const ATTACHMENT_SIZE_LIMIT = 50 * 1024 * 1024; // 50 MB
  if (att.size > ATTACHMENT_SIZE_LIMIT) {
    return res.status(413).json({ error: 'Attachment exceeds the 50 MB download limit.' });
  }

  try {
    assertAttachmentRequestSource(req.get('X-Mailflow-Message-Source'), message);
    const account = await findOwnedAccount(req.session.userId, message.account_id, { enabled: true });
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const proof = await captureAttachmentSource(account, message.folder, message.uid, message);
    const buffer = await imapManager.fetchAttachment(account, message.uid, message.folder, partNum, { expectedSource: message });
    await assertAttachmentSource(account, proof);

    if (!buffer) return res.status(404).json({ error: 'Could not fetch attachment' });

    if (buffer.length > ATTACHMENT_SIZE_LIMIT) return res.status(413).json({ error: 'Attachment exceeds the 50 MB download limit.' });

    res.setHeader('Content-Type', att.type || 'application/octet-stream');
    res.setHeader('Content-Disposition', attachmentDisposition(att.filename));
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    console.error('Attachment fetch error:', err);
    res.status(err.status || (err.code?.startsWith('identity_') || err.code === 'storage_generation_conflict' ? 409 : 500))
      .json({ error: err.status || err.code?.startsWith('identity_') || err.code === 'storage_generation_conflict' ? err.message : 'Failed to fetch attachment' });
  }
});

// The image proxy (services/imageProxy.js): one remote image of one of the user's messages,
// fetched by MailFlow. `u` is the reference exactly as the message's HTML writes it, and only a
// reference that HTML holds is fetched, so this cannot fetch anything else. `w` is the width the
// email shows it at, which it is fitted to (services/imageShrink.js).
//
// The references are read from the stored body, and also from it as the body route serves it
// (head stripped, eBay image links unwrapped): the route writes that version back without waiting,
// so on a first view an image request can arrive before it is stored. Kept for a few minutes per
// user and message, as an email's images arrive together: within that time a reference already
// found needs no query, where each image read the whole body from the database again (a
// newsletter's 40 images, 40 reads of its body). A reference not found there is looked up afresh.
// The list was made by this user's own query of their own message, so the shortcut serves no one
// else; a message deleted in those minutes can still show its images until they pass.
//
// The image itself comes from the image cache (services/imageCache.js) when it is there. It never
// changes for a given message, reference and width, so the browser may keep it a month without
// asking, and asking with its ETag is answered at once.
const imageProxyLimiter = createUserLimiter();
const imageRefsCache = new Map();
const IMAGE_REFS_TTL_MS = 5 * 60_000;
const IMAGE_REFS_MAX = 200;
const IMAGE_CACHE_CONTROL = 'private, max-age=2592000, immutable';
const IMAGE_FAILURE_CACHE_CONTROL = 'private, max-age=600';
function cachedImageRefs(key) {
  const hit = imageRefsCache.get(key);
  return hit && Date.now() - hit.at < IMAGE_REFS_TTL_MS ? hit.refs : null;
}
function imageRefsFor(key, stored) {
  const served = rewriteAnchorHrefs(rewriteEbayImageserUrls(stripEmailHead(stored)));
  const refs = new Map([...remoteImageRefs(served), ...remoteImageRefs(stored)]);
  imageRefsCache.delete(key);
  imageRefsCache.set(key, { refs, at: Date.now() });
  if (imageRefsCache.size > IMAGE_REFS_MAX) imageRefsCache.delete(imageRefsCache.keys().next().value);
  return refs;
}

router.get('/messages/:id/image', async (req, res) => {
  const { id } = req.params;
  const raw = typeof req.query.u === 'string' ? req.query.u : '';
  if (!UUID_RE.test(id) || !raw || raw.length > 8192) return res.status(400).end();
  const width = proxyWidth(req.query.w);
  const userId = req.session.userId;

  const refsKey = `${userId}:${id}`;
  let url = cachedImageRefs(refsKey)?.get(raw);
  if (!url) {
    const stored = (await findOwnedMessage(userId, id, { columns: 'm.body_html' }))?.body_html;
    if (!stored) return res.status(404).end();
    url = imageRefsFor(refsKey, stored).get(raw);
  }
  if (!url) return res.status(404).end();

  const key = imageCacheKey(userId, url, width);
  const etag = `"${key.slice(0, 40)}"`;
  const headers = {
    'Cache-Control': IMAGE_CACHE_CONTROL,
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
  };
  if (req.get('If-None-Match') === etag) return res.status(304).set(headers).end();
  const failed = imageCache.failure(key);
  if (failed) return res.status(failed).set('Cache-Control', IMAGE_FAILURE_CACHE_CONTROL).end();

  try {
    const { bytes, type } = await imageCache.load(key, () => imageProxyLimiter(userId,
      () => fetchProxiedImage(url).then((image) => shrinkImage(image, { width }))));
    res.set({ ...headers, 'Content-Type': type, 'Content-Length': String(bytes.length) });
    return res.send(bytes);
  } catch (err) {
    const status = err?.status || 502;
    imageCache.fail(key, status);
    return res.status(status).set('Cache-Control', IMAGE_FAILURE_CACHE_CONTROL).end();
  }
});

// Download the full message as an .eml file (#381). The raw RFC 822 source, exactly as the
// server stores it, so attachments and original headers survive the round trip into any
// other mail client.
router.get('/messages/:id/raw.eml', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const message = await findOwnedMessage(req.session.userId, id, {
    columns: 'm.id, m.uid, m.folder, m.subject, m.account_id, a.user_id',
  });
  if (!message) return res.status(404).json({ error: 'Message not found' });

  try {
    const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
    if (!accountResult.rows.length) return res.status(404).json({ error: 'Account not found' });
    const buffer = await imapManager.fetchRawMessage(accountResult.rows[0], message.uid, message.folder);
    if (!buffer) return res.status(404).json({ error: 'Could not fetch message source' });

    const name = `${truncateFilename(message.subject || 'message', 80)}.eml`;
    res.setHeader('Content-Type', 'message/rfc822');
    res.setHeader('Content-Disposition', attachmentDisposition(name));
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    console.error('Raw message fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch message source' });
  }
});

const OWNED_FLAG_COLUMNS = MESSAGE_FLAG_COLUMNS.split(', ').map(column => `m.${column}`).join(', ');
const WITH_SIBLING_COUNT = `${OWNED_FLAG_COLUMNS}, a.user_id, ${SIBLING_COUNT}`;

const staleFlagScope = error => /^(identity_|storage_generation_)/.test(error.code || '');
const flagConflict = res => res.status(409).json({ error: 'Message identity changed or is not verified. Sync the folder and try again.' });

// All local flag/count writes share the account lock with generation and epoch changes.
// Validate every captured source before writing any member of this account's batch.
async function writeLocalFlags(account, sources, value, { starred = false, siblings = false, skipUnchanged = false } = {}) {
  return withAccountIdentity(account, async tx => {
    const current = [];
    for (const source of sources) current.push(await assertReadSourceIdentity(tx, account, source));
    const field = starred ? 'is_starred' : 'is_read';
    const stamp = starred ? 'star_changed_at' : 'read_changed_at';
    const changed = current.filter(row => !!row[field] !== value);
    const targets = skipUnchanged ? changed : current;
    if (!targets.length) return { updated: [], changed: [], copies: [] };
    await tx.query(`UPDATE messages SET ${field} = $1, ${stamp} = NOW() WHERE id = ANY($2::uuid[])`,
      [value, targets.map(row => row.id)]);
    if (!starred) {
      for (const row of changed) await adjustFolderCounts(account.id, row.folder, 0, value ? -1 : 1, tx.query.bind(tx));
    }
    const copies = [];
    if (siblings) {
      const options = { queryFn: tx.query.bind(tx), storageGeneration: account.storage_generation };
      for (const mid of new Set(targets.map(row => row.message_id).filter(Boolean))) {
        if (starred) await fanOutStarToSiblings(account.id, mid, value, options);
        else copies.push(...await fanOutReadToSiblings(account.id, mid, value, options));
      }
    }
    return { updated: targets, changed, copies };
  });
}

async function pushCapturedFlag(account, source, flag, value) {
  try {
    await imapManager.setFlag(account, source.uid, source.folder, flag, value, { expectedSource: source });
    imapManager._resolveFlagPush(account.id, source.id, flag);
  } catch (error) {
    console.warn('IMAP flag update failed:', error.message);
    if (!staleFlagScope(error)) {
      // Enqueue while the same proof is current; a later replacement cannot adopt this retry.
      try {
        await withReadSourceIdentity(account, source, async () => {
          imapManager._enqueueFlagPush(account.id, source.id, flag, value, { expectedSource: source });
        });
      } catch (scopeError) {
        if (!staleFlagScope(scopeError)) throw scopeError;
      }
    }
  }
}

function pushReadCopies(account, sources, copies, value) {
  if (!copies.length || imapManager.isLabelStore(account)) return;
  (async () => {
    const flipped = new Map(copies.map(row => [row.id, row]));
    const acted = new Set(sources.map(row => row.id));
    const targets = [];
    for (const mid of new Set(sources.map(row => row.message_id))) {
      const source = sources.find(row => row.message_id === mid);
      targets.push(...await readCopyTargets(account.id, mid, source, {
        storageGeneration: account.storage_generation,
        queryFn: (sql, params) => withReadSourceIdentity(account, source, tx => tx.query(sql, params)),
      }));
    }
    await pushSeen(imapManager, account, account.id, targets.filter(row => {
      const captured = flipped.get(row.id);
      return captured && !acted.has(row.id) && captured.entity_id === row.entity_id
        && captured.storage_generation === row.storage_generation;
    }), value);
  })().catch(error => console.warn('Read-copy push failed:', error.message));
}

async function setSingleMessageFlag(req, res, starred) {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });
  const value = starred ? req.body.starred : req.body.read;
  if (typeof value !== 'boolean') return res.status(400).json({ error: `${starred ? 'starred' : 'read'} must be a boolean` });
  const source = await findOwnedMessage(req.session.userId, id, { columns: WITH_SIBLING_COUNT });
  if (!source) return res.status(404).json({ error: 'Message not found' });
  const account = (await query('SELECT * FROM email_accounts WHERE id = $1', [source.account_id])).rows[0];
  if (!account) return flagConflict(res);
  const siblings = Number(source.sibling_count) > 1 && await accountMaintainsLabelSiblings(account.id);
  let result;
  try { result = await writeLocalFlags(account, [source], value, { starred, siblings }); }
  catch (error) { if (staleFlagScope(error)) return flagConflict(res); throw error; }
  await pushCapturedFlag(account, source, starred ? '\\Flagged' : '\\Seen', value);
  if (!starred) pushReadCopies(account, [source], result.copies, value);
  if (result.changed.length) {
    imapManager.broadcast({ type: 'message_flags', accountId: account.id,
      changes: [{ id, [starred ? 'is_starred' : 'is_read']: value }] }, req.session.userId);
  }
  notifyMailMutation([source], req.session.userId);
  res.json({ ok: true, [starred ? 'is_starred' : 'is_read']: value });
}

router.patch('/messages/:id/read', (req, res) => setSingleMessageFlag(req, res, false));
router.patch('/messages/:id/star', (req, res) => setSingleMessageFlag(req, res, true));

// Manual sync (INBOX)
router.post('/sync', async (req, res) => {
  const { accountId } = req.body; // optional — omit for all accounts
  if (accountId) {
    if (!UUID_RE.test(accountId)) return res.status(400).json({ error: 'Invalid account id' });
    const owned = await findOwnedAccount(req.session.userId, accountId, { columns: 'id' });
    if (!owned) return res.status(404).json({ error: 'Account not found' });
  }
  // Run sync in background so response returns immediately
  imapManager.syncNow(req.session.userId, accountId || null)
    .catch(err => console.error('syncNow error:', err.message));
  res.json({ ok: true });
});

// Manual folder-structure resync ("Sync folders now" in the sidebar account menu
// and on the accounts settings page). Refreshes the folder LIST so folders
// created or renamed in other clients appear without waiting for a reconnect.
router.post('/sync-folders', async (req, res) => {
  const { accountId } = req.body; // optional — omit for all accounts
  if (accountId) {
    if (!UUID_RE.test(accountId)) return res.status(400).json({ error: 'Invalid account id' });
    const owned = await findOwnedAccount(req.session.userId, accountId, { columns: 'id' });
    if (!owned) return res.status(404).json({ error: 'Account not found' });
  }
  // Run in background so the response returns immediately; the folders_synced
  // broadcast tells clients when to refetch the folder list.
  imapManager.syncFoldersNow(req.session.userId, accountId || null)
    .catch(err => console.error('syncFoldersNow error:', err.message));
  res.json({ ok: true });
});

// On-demand folder sync — called when the user navigates to a folder with no local messages
router.post('/sync-folder', async (req, res) => {
  const { accountId, folder } = req.body;
  if (!accountId || !folder) return res.status(400).json({ error: 'accountId and folder required' });
  if (!UUID_RE.test(accountId)) return res.status(400).json({ error: 'Invalid account id' });
  if (!isValidFolderName(folder)) return res.status(400).json({ error: 'Invalid folder name' });

  const account = await findOwnedAccount(req.session.userId, accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  // Fire-and-forget — response returns immediately, WebSocket sync_complete notifies frontend
  imapManager.syncFolderOnDemand(account, folder)
    .catch(err => console.error('syncFolderOnDemand error:', err.message));

  res.json({ ok: true });
});

// Mark all read only for the verified rows captured by this request, never a UID range
// that a later mailbox epoch could reuse. Added mail is left untouched.
router.post('/mark-all-read', async (req, res) => {
  const { accountId, folder = 'INBOX' } = req.body;
  if (!accountId || !UUID_RE.test(accountId)) return res.status(400).json({ error: 'Invalid account id' });
  if (!isValidFolderName(folder)) return res.status(400).json({ error: 'Invalid folder name' });
  const account = await findOwnedAccount(req.session.userId, accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const sources = (await query(`SELECT ${MESSAGE_FLAG_COLUMNS} FROM messages WHERE account_id = $1 AND folder = $2`, [accountId, folder])).rows;
  const siblings = await accountMaintainsLabelSiblings(accountId).catch(error => {
    console.warn('Mark-all-read label copies failed:', error.message);
    return false;
  });
  let result;
  try { result = await writeLocalFlags(account, sources, true, { siblings }); }
  catch (error) { if (staleFlagScope(error)) return flagConflict(res); throw error; }
  pushReadCopies(account, result.changed, result.copies, true);
  // Keep this background work bounded and carry every row's original identity into STORE/retry.
  runInBatches(result.updated, 3, async source => {
    const stillRead = await withReadSourceIdentity(account, source, (_tx, current) => current.is_read);
    if (stillRead) await pushCapturedFlag(account, source, '\\Seen', true);
  })
    .catch(error => console.warn('Mark-all-read push failed:', error.message))
    .finally(() => imapManager.scheduleCountRefresh?.(accountId, [folder]));
  imapManager.broadcast({ type: 'sync_complete', accountId }, account.user_id);
  res.json({ ok: true });
});

// Create folder
router.post('/folders', async (req, res) => {
  const { accountId, name, parentPath } = req.body;
  if (!accountId || !name?.trim()) return res.status(400).json({ error: 'accountId and name required' });
  if (!isValidFolderName(name.trim())) return res.status(400).json({ error: 'Invalid folder name' });
  if (parentPath && !isValidFolderName(parentPath)) return res.status(400).json({ error: 'Invalid parent path' });
  const account = await findOwnedAccount(req.session.userId, accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  // Join parent and leaf with '/' and let ensureFolder translate: it splits on
  // '/' and imapflow joins the segments with the server's real hierarchy
  // delimiter and namespace, so a parent stored in native form (INBOX.Foo)
  // plus a new leaf lands at INBOX.Foo.Bar on a dot-delimited server. The raw
  // mailboxCreate this replaces ignored both, so a folder created through
  // MailFlow could be stored under a path the server never had — and creating
  // a subfolder beneath such a ghost silently vanished on the next
  // folder-structure sync.
  const requested = parentPath ? `${parentPath}/${name.trim()}` : name.trim();

  try {
    const { path } = await imapManager.ensureFolder(account, requested, { resolvePath: true });
    // Store the account's delimiter too — rows inserted without one (NULL)
    // poison later delimiter lookups for subfolder creation and rename.
    const delimResult = await query(
      `SELECT delimiter FROM folders
       WHERE account_id = $1 AND delimiter IS NOT NULL AND delimiter <> ''
       LIMIT 1`,
      [accountId]
    );
    await query(
      `INSERT INTO folders (account_id, path, name, delimiter) VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id, path) DO NOTHING`,
      [accountId, path, name.trim(), delimResult.rows[0]?.delimiter || null]
    );
    res.json({ ok: true, path });
  } catch (err) {
    console.error('Create folder error:', err);
    res.status(500).json({ error: 'Failed to create folder' });
  }
});

function withFolderMutationIdentity(account, result, write, { requireEpoch = false } = {}) {
  const scope = result?.identityContext;
  if (!scope || (requireEpoch && !scope.uidValidity)) {
    throw Object.assign(new Error('The provider operation did not return its mailbox identity scope'), { code: 'identity_epoch_unknown' });
  }
  return scope.uidValidity ? withMailboxIdentity(scope, write) : withAccountIdentity(account, write);
}

// Delete folder
router.post('/folders/delete', async (req, res) => {
  const { accountId, path } = req.body;
  if (!accountId || !path) return res.status(400).json({ error: 'accountId and path required' });
  if (!isValidFolderName(path)) return res.status(400).json({ error: 'Invalid folder path' });
  const account = await findOwnedAccount(req.session.userId, accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  let deleted;
  try {
    deleted = await imapManager.deleteFolder(account, path);
  } catch (err) {
    console.error(`IMAP deleteFolder failed for ${path}:`, err.message);
    return res.status(500).json({ error: 'Failed to delete folder on server' });
  }
  let identityPending = false;
  try {
    await withFolderMutationIdentity(account, deleted, async tx => {
      await tx.query('DELETE FROM folders WHERE account_id = $1 AND path = $2', [accountId, path]);
      await tx.query('DELETE FROM messages WHERE account_id = $1 AND folder = $2', [accountId, path]);
    });
  } catch (error) {
    identityPending = true;
    console.warn(`Folder deleted on server; local cache refresh pending: ${error.message}`);
  }
  res.json({ ok: true, ...(identityPending ? { identityPending } : {}) });
});

// Rename folder
router.post('/folders/rename', async (req, res) => {
  const { accountId, oldPath, newName } = req.body;
  if (!accountId || !oldPath || !newName?.trim()) return res.status(400).json({ error: 'Missing required fields' });
  if (!isValidFolderName(newName.trim())) return res.status(400).json({ error: 'Invalid folder name' });
  if (!isValidFolderName(oldPath)) return res.status(400).json({ error: 'Invalid folder path' });
  const account = await findOwnedAccount(req.session.userId, accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  // Build the new path by replacing only the last path component
  const delimResult = await query('SELECT delimiter FROM folders WHERE account_id = $1 AND path = $2', [accountId, oldPath]);
  const delim = delimResult.rows[0]?.delimiter || '/';
  const parts = oldPath.split(delim);
  parts[parts.length - 1] = newName.trim();
  const newPath = parts.join(delim);

  try {
    const renamed = await imapManager.renameFolder(account, oldPath, newPath);
    let identityPending = false;
    try {
      await withFolderMutationIdentity(account, renamed, async tx => {
    // IMAP RENAME moves the entire subtree server-side — mirror that in the DB.
    // Updating only the exact path left every child folder (and its messages)
    // under the old path: the next folder sync then upserted the renamed tree
    // from LIST (a visible duplicate), while the per-folder message sync kept
    // trying to open the stale old child paths forever.
    const childPrefix = oldPath + delim;
    // If a sync raced us and already inserted rows at the new paths, drop the
    // stale old rows instead of colliding with the unique (account_id, path) /
    // (account_id, uid, folder) constraints.
    await tx.query(`
      DELETE FROM folders old
      WHERE old.account_id = $1
        AND (old.path = $2 OR substr(old.path, 1, length($3)) = $3)
        AND EXISTS (
          SELECT 1 FROM folders n
          WHERE n.account_id = $1
            AND n.path = $4 || substr(old.path, length($2) + 1)
        )`, [accountId, oldPath, childPrefix, newPath]);
    await tx.query(`
      UPDATE folders SET path = $4 || substr(path, length($2) + 1), updated_at = NOW()
      WHERE account_id = $1
        AND (path = $2 OR substr(path, 1, length($3)) = $3)`,
      [accountId, oldPath, childPrefix, newPath]);
    await tx.query(
      'UPDATE folders SET name = $1, updated_at = NOW() WHERE account_id = $2 AND path = $3',
      [newName.trim(), accountId, newPath]
    );
    await tx.query(`
      DELETE FROM messages old
      WHERE old.account_id = $1
        AND (old.folder = $2 OR substr(old.folder, 1, length($3)) = $3)
        AND EXISTS (
          SELECT 1 FROM messages n
          WHERE n.account_id = $1
            AND n.folder = $4 || substr(old.folder, length($2) + 1)
            AND n.uid = old.uid
        )`, [accountId, oldPath, childPrefix, newPath]);
    await tx.query(`
      UPDATE messages SET folder = $4 || substr(folder, length($2) + 1)
      WHERE account_id = $1
        AND (folder = $2 OR substr(folder, 1, length($3)) = $3)`,
      [accountId, oldPath, childPrefix, newPath]);
    // Snooze records hold both folders by path: the wakeup finds the message by
    // snoozed_folder and moves it back to original_folder, so a stale path strands it.
    await tx.query(`
      UPDATE snoozed_messages SET snoozed_folder = $4 || substr(snoozed_folder, length($2) + 1)
      WHERE account_id = $1 AND storage_generation=(SELECT storage_generation FROM email_accounts WHERE id=$1)
        AND (snoozed_folder = $2 OR substr(snoozed_folder, 1, length($3)) = $3)`,
      [accountId, oldPath, childPrefix, newPath]);
    await tx.query(`
      UPDATE snoozed_messages SET original_folder = $4 || substr(original_folder, length($2) + 1)
      WHERE account_id = $1 AND storage_generation=(SELECT storage_generation FROM email_accounts WHERE id=$1)
        AND (original_folder = $2 OR substr(original_folder, 1, length($3)) = $3)`,
      [accountId, oldPath, childPrefix, newPath]);
      });
    } catch (err) {
      identityPending = true;
      console.warn(`Folder renamed on server; local cache refresh pending: ${err.message}`);
    }
    res.json({ ok: true, newPath, ...(identityPending ? { identityPending } : {}) });
  } catch (err) {
    console.error('Rename folder error:', err);
    res.status(500).json({ error: 'Failed to rename folder' });
  }
});

// Guards against two overlapping empties of the same (account, folder) — a double-click or a
// second device would otherwise start two background deletes over the same folder.
const emptyInFlight = new Set();

// Empty folder (delete all messages). Emptying a large folder is a slow IMAP operation (chunked
// delete + expunge over the provider), so it runs in the BACKGROUND: the request returns 202
// immediately and the outcome is reported over WebSocket (folder_emptied). This keeps the UI from
// hanging on big folders. On failure the DB rows are left in place so the next sync reconciles.
router.post('/folders/empty', async (req, res) => {
  const { accountId, path } = req.body;
  if (!accountId || !path) return res.status(400).json({ error: 'accountId and path required' });
  if (!isValidFolderName(path)) return res.status(400).json({ error: 'Invalid folder path' });
  const account = await findOwnedAccount(req.session.userId, accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const inflightKey = `${accountId}:${path}`;
  if (emptyInFlight.has(inflightKey)) return res.status(409).json({ error: 'This folder is already being emptied' });
  emptyInFlight.add(inflightKey);

  res.status(202).json({ ok: true, started: true });

  (async () => {
    try {
      const emptied = await imapManager.emptyFolder(account, path);
      let identityPending = false;
      try {
        await withFolderMutationIdentity(account, emptied, async tx => {
          await tx.query('DELETE FROM messages WHERE account_id = $1 AND folder = $2', [accountId, path]);
          await tx.query(
            'UPDATE folders SET total_count = 0, unread_count = 0 WHERE account_id = $1 AND path = $2',
            [accountId, path]
          );
        }, { requireEpoch: true });
      } catch (error) {
        identityPending = true;
        console.warn(`Folder emptied on server; local cache refresh pending: ${error.message}`);
      }
      imapManager.broadcast({ type: 'folder_emptied', accountId, folder: path, ok: true,
        ...(identityPending ? { identityPending } : {}) }, account.user_id);
      imapManager.broadcast({ type: 'sync_complete', accountId }, account.user_id);
    } catch (err) {
      console.error(`Async emptyFolder failed for ${path}:`, err.message);
      imapManager.broadcast({ type: 'folder_emptied', accountId, folder: path, ok: false }, account.user_id);
    } finally {
      emptyInFlight.delete(inflightKey);
    }
  })();
});

async function setBulkMessageFlags(req, res, starred) {
  const { ids } = req.body;
  const value = starred ? req.body.starred : req.body.read;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  if (ids.length > 500) return res.status(400).json({ error: 'Too many ids — maximum 500 per request' });
  if (!areValidUUIDs(ids)) return res.status(400).json({ error: 'Invalid message IDs' });
  if (typeof value !== 'boolean') return res.status(400).json({ error: `${starred ? 'starred' : 'read'} must be a boolean` });
  const owned = await findOwnedMessages(req.session.userId, ids, { columns: OWNED_FLAG_COLUMNS });
  const updated = [], conflicts = [];
  for (const accountId of new Set(owned.map(row => row.account_id))) {
    const sources = owned.filter(row => row.account_id === accountId);
    const account = (await query('SELECT * FROM email_accounts WHERE id = $1', [accountId])).rows[0];
    const siblings = await accountMaintainsLabelSiblings(accountId);
    let result;
    try {
      if (!account) throw Object.assign(new Error('Account changed'), { code: 'identity_source_changed' });
      result = await writeLocalFlags(account, sources, value, { starred, siblings, skipUnchanged: true });
    } catch (error) {
      if (!staleFlagScope(error)) throw error;
      conflicts.push(...sources.map(row => row.id));
      continue;
    }
    updated.push(...result.updated);
    await runInBatches(result.updated, 3, source => pushCapturedFlag(account, source, starred ? '\\Flagged' : '\\Seen', value));
    if (!starred) pushReadCopies(account, result.updated, result.copies, value);
  }
  if (updated.length) {
    imapManager.broadcast({ type: 'message_flags', changes: updated.map(row => ({ id: row.id,
      [starred ? 'is_starred' : 'is_read']: value })) }, req.session.userId);
    notifyMailMutation(updated, req.session.userId);
  }
  res.status(conflicts.length && !updated.length ? 409 : 200).json({ ok: !conflicts.length,
    updated: updated.map(row => row.id), ...(conflicts.length ? { conflicts, error: 'Some message identities changed. Sync the folder and try again.' } : {}) });
}

router.post('/messages/bulk-read', (req, res) => setBulkMessageFlags(req, res, false));
router.post('/messages/bulk-star', (req, res) => setBulkMessageFlags(req, res, true));

// Local bookkeeping after a provider acknowledgement must never turn success into
// a retryable failure. The original snapshot and journal fence every cache/count write.
async function finishMessageMove(account, message, folder, newUid, { rotateId = false, dropDestination = false, label } = {}) {
  try {
    const result = await applyConfirmedMoveCache(account, message, folder, newUid, {
      rotateId, dropDestination,
      onApplied: async (tx, source, destinationKnown, destinationAlreadyCached, previousDestination) => {
        await adjustFolderCounts(account.id, source.folder, -1, source.is_read ? 0 : -1, tx.query.bind(tx));
        if (destinationKnown) {
          const unreadDelta = Number(!source.is_read) - (destinationAlreadyCached ? Number(!previousDestination.is_read) : 0);
          await adjustFolderCounts(account.id, folder, destinationAlreadyCached ? 0 : 1, unreadDelta, tx.query.bind(tx));
          if (label) await tx.query(`UPDATE messages SET spam_user_override=$1, spam_verdict=$1,
            spam_analyzed_at=NOW() WHERE account_id=$2 AND folder=$3 AND uid=$4
            AND storage_generation=$5 AND entity_id=$6`,
          [label, account.id, folder, newUid, source.storage_generation, source.entity_id]);
        }
      },
    });
    if (result.dropped?.length) rememberDroppedRows(folder, result.dropped,
      label ? { spam_user_override: label, spam_verdict: label, spam_analyzed_at: new Date() } : {});
    if (result.sync) imapManager.syncFolderOnDemand(account, folder)
      .catch(error => console.warn('Post-move sync pending:', error.message));
    return result.applied && !result.sync;
  } catch (error) {
    console.warn('Move acknowledged; cache recovery pending:', error.message);
    return false;
  }
}

async function finishMessageDelete(account, message) {
  try {
    await withReadSourceIdentity(account, message, async (tx, source) => {
      await tx.query('DELETE FROM messages WHERE id=$1', [source.id]);
      await adjustFolderCounts(account.id, source.folder, -1, source.is_read ? 0 : -1, tx.query.bind(tx));
    });
    return true;
  } catch (error) {
    console.warn('Delete acknowledged; cache recovery pending:', error.message);
    return false;
  }
}

function mutationStatus(error) {
  return /identity|generation/.test(error.code || '') || error.code === 'MAIL_IDENTITY_STALE' ? 409 : 502;
}

async function bulkMessageMutation(req, res, action) {
  const { ids, folder } = req.body || {};
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || !areValidUUIDs(ids)
    || (action === 'move' && !isValidFolderName(folder))) {
    return res.status(400).json({ error: 'Valid ids (maximum 500) and destination required' });
  }
  const owned = await findOwnedMessages(req.session.userId, [...new Set(ids)], { columns: 'm.*, a.user_id, a.folder_mappings' });
  const done = [], conflicts = [], pending = [], noArchiveFolder = [];
  const groups = Map.groupBy(owned, row => row.account_id);
  for (const [accountId, messages] of groups) {
    let account, destination, allMail = false, permanentFolders = new Set();
    try {
      account = (await query('SELECT * FROM email_accounts WHERE id = $1', [accountId])).rows[0];
      if (!account) { conflicts.push(...messages.map(row => row.id)); continue; }
      for (const row of messages) await withReadSourceIdentity(account, row, async () => {});
      destination = action === 'move' ? folder : action === 'archive'
        ? await resolveArchiveFolder(accountId, messages[0].folder_mappings)
        : await resolveTrashFolder(accountId, messages[0].folder_mappings);
      if (!destination) {
        if (action === 'archive') noArchiveFolder.push(accountId);
        else conflicts.push(...messages.map(row => row.id));
        continue;
      }
      if (action === 'move' && !(await query('SELECT 1 FROM folders WHERE account_id=$1 AND path=$2 AND no_select=false', [accountId, destination])).rows.length) {
        conflicts.push(...messages.map(row => row.id)); continue;
      }
      if (action === 'archive') allMail = await isAllMailFolder(accountId, destination);
      if (action === 'delete') permanentFolders = new Set([
        ...await resolveAllTrashPaths(accountId, messages[0].folder_mappings),
        ...await resolveAllDraftsPaths(accountId, messages[0].folder_mappings),
      ]);
    } catch (error) {
      console.warn('Bulk mutation preparation failed:', error.message);
      conflicts.push(...messages.map(row => row.id)); continue;
    }
    for (const [sourceFolder, rows] of Map.groupBy(messages, row => row.folder)) {
      for (const row of rows) imapManager._guardMoveUid(accountId, row.folder, row.uid);
      try {
        const expunge = action === 'delete' && permanentFolders.has(sourceFolder);
        const result = expunge
          ? await imapManager.bulkPermanentDelete(account, rows.map(row => row.uid), sourceFolder,
            { expectRows: new Map(rows.map(row => [Number(row.uid), row])), expectedSources: rows })
          : await imapManager.bulkMoveMessages(account, rows.map(row => row.uid), sourceFolder, destination, { expectedSources: rows });
        const successes = new Set(result.succeeded.map(String));
        const unknown = new Set((result.pending || []).map(String));
        if (unknown.size) imapManager.syncFolderOnDemand(account, destination)
          .catch(error => console.warn('Bulk mutation recovery sync pending:', error.message));
        for (const row of rows) {
          if (successes.has(String(row.uid))) {
            done.push(row.id);
            const applied = expunge ? await finishMessageDelete(account, row)
              : await finishMessageMove(account, row, destination, result.uidMap.get(Number(row.uid)) ?? null,
                { rotateId: true, dropDestination: allMail });
            if (!applied) pending.push(row.id);
          } else if (unknown.has(String(row.uid))) pending.push(row.id);
          else conflicts.push(row.id);
        }
      } catch (error) {
        console.warn('Bulk mutation refused:', error.message);
        conflicts.push(...rows.map(row => row.id));
      } finally {
        for (const row of rows) imapManager._unguardMoveUid(accountId, row.folder, row.uid);
      }
    }
    imapManager.broadcast({ type: 'folder_updated', folder: destination, accountId }, req.session.userId);
  }
  notifyMailMutation(owned.filter(row => done.includes(row.id)), req.session.userId);
  res.status(conflicts.length && !done.length && !pending.length ? 409 : 200).json({
    ok: !conflicts.length, [action === 'delete' ? 'deleted' : action === 'archive' ? 'archived' : 'moved']: done,
    ...(action === 'archive' ? { noArchiveFolder } : {}),
    ...(conflicts.length ? { conflicts } : {}), ...(pending.length ? { identityPending: true, pending } : {}),
  });
}

// Bulk delete (move to trash)
router.post('/messages/bulk-delete', (req, res) => bulkMessageMutation(req, res, 'delete'));

// ── Mailbox cleanup (bloat analysis + per-sender preview) ──────────────────────
// Both routes are READ-ONLY and strictly scoped to the caller's own account. Nothing here
// deletes: the actual cleanup is performed by the client feeding the returned ids to the
// existing /messages/bulk-delete (move-to-Trash) endpoint in <=500 batches.

// Analyze an INBOX for "bloat": how much is bulk mail, the top bulk senders (Tier 1 cleanup
// targets, exact from_email addresses), and promo-keyword buckets (Tier 2 guidance).
router.get('/mailbox-usage', async (req, res) => {
  const { accountId } = req.query;
  if (!accountId || !UUID_RE.test(accountId)) return res.status(400).json({ error: 'valid accountId required' });
  const acct = await findOwnedAccount(req.session.userId, accountId, { columns: 'id, folder_mappings' });
  if (!acct) return res.status(404).json({ error: 'Account not found' });
  // Whether Archive is a usable cleanup action for this account (#403): the client
  // offers Archive vs Trash and needs to know if an archive folder can be resolved.
  const archiveFolder = await resolveArchiveFolder(accountId, acct.folder_mappings);

  const summary = await query(
    `SELECT count(*)::int AS inbox_total, count(*) FILTER (WHERE is_bulk)::int AS bulk_total
     FROM messages WHERE account_id = $1 AND folder = 'INBOX'`,
    [accountId]
  );
  // Group senders case-insensitively so a sender that uses mixed-case addresses
  // (Promo@x vs promo@x) is one row whose count matches the delete — cleanup-preview
  // matches lower(from_email), so a case-sensitive count here would understate what
  // clicking the row actually trashes. min(from_email) is a real observed casing for
  // display; the delete lower-matches it and so still captures every case variant.
  const senders = await query(
    `SELECT min(from_email) AS from_email, max(from_name) AS from_name, count(*)::int AS count
     FROM messages
     WHERE account_id = $1 AND folder = 'INBOX' AND is_bulk
       AND from_email IS NOT NULL AND from_email <> ''
     GROUP BY lower(from_email) ORDER BY count DESC, lower(min(from_email)) LIMIT 25`,
    [accountId]
  );

  // Tier 2 promo keyword buckets (fixed set), counted over INBOX in one pass. Informational only.
  const KEYWORDS = ['% off', 'deal', 'sale', 'newsletter', 'coupon', 'webinar', 'last chance'];
  const filters = KEYWORDS
    .map((_, i) => `count(*) FILTER (WHERE subject ILIKE $${i + 2} OR coalesce(snippet,'') ILIKE $${i + 2})::int AS k${i}`)
    .join(', ');
  const kw = await query(
    `SELECT ${filters} FROM messages WHERE account_id = $1 AND folder = 'INBOX'`,
    [accountId, ...KEYWORDS.map(k => `%${k}%`)]
  );

  res.json({
    accountId,
    inboxTotal: summary.rows[0].inbox_total,
    bulkTotal: summary.rows[0].bulk_total,
    archiveAvailable: Boolean(archiveFolder),
    tier1Senders: senders.rows.map(r => ({ fromEmail: r.from_email, fromName: r.from_name || '', count: r.count })),
    tier2Keywords: KEYWORDS.map((k, i) => ({ keyword: k, count: kw.rows[0][`k${i}`] })),
  });
});

// Return the INBOX message ids for ONE specific sender, so the client can move exactly those to
// Trash via /messages/bulk-delete. Read-only; strictly scoped to the caller's account, INBOX, and
// an EXACT (case-insensitive) from_email match — never a wildcard, never another folder. Scoped to
// is_bulk so it trashes exactly the bulk messages the sender list counted (mailbox-usage counts
// bulk-only): a non-bulk message from that sender (a receipt, a personal note) is never surprise-
// trashed. Idempotent: once those messages are trashed, a re-run returns an empty set.
router.get('/cleanup-preview', async (req, res) => {
  const { accountId, fromEmail } = req.query;
  if (!accountId || !UUID_RE.test(accountId)) return res.status(400).json({ error: 'valid accountId required' });
  if (!fromEmail || typeof fromEmail !== 'string' || !fromEmail.trim()) return res.status(400).json({ error: 'fromEmail required' });
  const acct = await findOwnedAccount(req.session.userId, accountId, { columns: 'id' });
  if (!acct) return res.status(404).json({ error: 'Account not found' });

  const rows = await query(
    `SELECT id FROM messages
     WHERE account_id = $1 AND folder = 'INBOX' AND is_bulk AND lower(from_email) = lower($2)`,
    [accountId, fromEmail.trim()]
  );
  res.json({ accountId, fromEmail: fromEmail.trim(), count: rows.rows.length, ids: rows.rows.map(r => r.id) });
});

// Bulk move to folder
router.post('/messages/bulk-move', (req, res) => bulkMessageMutation(req, res, 'move'));

// Copy into a selectable account-owned folder.
router.post('/messages/:id/copy', async (req, res) => {
  const { id } = req.params;
  const { folder } = req.body || {};
  if (!areValidUUIDs([id]) || !isValidFolderName(folder)) {
    return res.status(400).json({ error: 'Invalid message or folder' });
  }
  const message = await findOwnedMessage(req.session.userId, id, {
    columns: 'm.*, a.folder_mappings',
    enabledAccount: true,
    live: true,
  });
  if (!message) return res.status(404).json({ error: 'Message not found' });
  const destination = await query(`
    SELECT path, name, special_use FROM folders
    WHERE account_id = $1 AND path = $2 AND no_select = false
  `, [message.account_id, folder]);
  const target = destination.rows[0];
  if (!target || message.folder === folder) return res.status(400).json({ error: 'Folder is not a copy target' });
  const special = String(target.special_use || '').replaceAll('\\', '').toLowerCase();
  const system = new Set(['inbox', 'sent', 'drafts', 'trash', 'junk', 'spam', 'archive', 'all', 'flagged']);
  const names = new Set(['inbox', 'sent', 'drafts', 'trash', 'spam', 'junk', 'archive', 'all mail', 'starred', 'important']);
  const mapped = Object.values(message.folder_mappings || {}).includes(folder);
  if (system.has(special) || names.has(String(target.name || '').toLowerCase()) || mapped) {
    return res.status(400).json({ error: 'System folder is not a label target' });
  }
  try {
    const uid = await imapManager.copyMessage({ id: message.account_id, storage_generation: message.storage_generation }, message.uid, message.folder, folder, { expectedSource: message });
    imapManager.broadcast?.({ type: 'folder_updated', folder, accountId: message.account_id }, req.session.userId);
    res.json({ ok: true, uid });
  } catch (error) {
    console.error('Message copy failed:', error.message);
    res.status(mutationStatus(error)).json({ error: 'Could not copy message' });
  }
});

// Bulk archive
router.post('/messages/bulk-archive', (req, res) => bulkMessageMutation(req, res, 'archive'));

// A snooze record counts only while its message still sits in the folder it was snoozed into.
// Moving a snoozed message out by hand leaves the record behind until the wake-up sweep removes
// it, a few minutes after its wake time (imapManager's sweep uses this same test), and until
// then the message could not be snoozed again (#269). Expects the record aliased as sm.
export { LIVE_SNOOZE_SQL };

// Gather the reply-chain conversation that should be snoozed alongside `msg`.
//
// Snoozing a single message doesn't work on Gmail: Gmail groups the inbox by
// conversation, so moving one message to Snoozed only strips \Inbox from that
// message — its thread siblings keep \Inbox and the whole conversation stays in
// the inbox (#271). MailFlow's own inbox is thread-grouped too. So we snooze the
// entire conversation, but bounded to the RFC 5322 reply chain (Message-ID /
// In-Reply-To / References links) rather than thread_id: thread_id falls back to
// subject grouping and can lump hundreds of unrelated messages together (e.g.
// identical automated-notification emails), which must never be swept into Snoozed.
//
// Returns the messages in `msg`'s source folder reachable from `msg` through
// header links (always including `msg` itself); excludes already-snoozed messages.
export async function gatherSnoozeConversation(msg, { includeSnoozed = false } = {}) {
  if (!msg.thread_id) return [msg];

  // Load the whole thread across ALL folders. thread_id is a superset of the true
  // conversation, and the messages that hold a real conversation together — the
  // other party's replies, your own Sent messages, the thread root — frequently
  // live in Sent / All Mail rather than the inbox. They must be present as graph
  // connectors or a genuine thread fragments and only part of it snoozes. The
  // reply-chain walk below filters out the subject-only collisions that thread_id
  // also collects (e.g. identical automated-notification emails).
  const pool = (await query(
    `SELECT id, uid, account_id, folder, message_id, in_reply_to, thread_references, is_read, entity_id, storage_generation, uid_validity
     FROM messages
     WHERE account_id = $1 AND thread_id = $2 AND message_id IS NOT NULL`,
    [msg.account_id, msg.thread_id]
  )).rows;

  // Ensure the triggering message is present (the query above could miss it on a
  // transient read skew).
  if (!pool.some(r => r.id === msg.id)) pool.push(msg);

  const refsOf = (r) => {
    const ids = (r.thread_references || '').match(/<[^>]+>/g) || [];
    if (r.in_reply_to) ids.push(r.in_reply_to);
    return ids;
  };

  // Entity nodes keep independent deliveries separate even when headers collide.
  // Explicit reply links may connect them only when the referenced header names
  // one entity. An ambiguous reference cannot choose between independent mail.
  const keyOf = r => r.entity_id || r.id;
  const adj = new Map(), byHeader = new Map();
  const node = key => { let edges = adj.get(key); if (!edges) { edges = new Set(); adj.set(key, edges); } return edges; };
  for (const r of pool) {
    const key = keyOf(r);
    node(key);
    if (!byHeader.has(r.message_id)) byHeader.set(r.message_id, new Set());
    byHeader.get(r.message_id).add(key);
  }
  for (const r of pool) {
    for (const ref of refsOf(r)) {
      const targets = byHeader.get(ref);
      if (targets?.size !== 1) continue;
      const [target] = targets;
      node(keyOf(r)).add(target);
      node(target).add(keyOf(r));
    }
  }
  const seen = new Set([keyOf(msg)]);
  const queue = [keyOf(msg)];
  while (queue.length) {
    const cur = queue.shift();
    for (const nb of (adj.get(cur) || [])) if (!seen.has(nb)) { seen.add(nb); queue.push(nb); }
  }

  // Snooze only the conversation members in the acted-on message's source folder
  // (the inbox copies — Sent copies carry no \Inbox and shouldn't move), skipping
  // any already snoozed. Already-snoozed messages stay valid graph connectors above.
  const already = new Set(
    (await query(
      `SELECT sm.entity_id FROM snoozed_messages sm
       WHERE sm.account_id = $1 AND sm.entity_id = ANY($2::uuid[]) AND ${LIVE_SNOOZE_SQL}`,
      [msg.account_id, pool.map(r => r.entity_id).filter(Boolean)]
    )).rows.map(r => r.entity_id)
  );
  // Independent deliveries may share a header. Dedupe only durable entities.
  const picked = new Map();
  for (const r of pool) {
    if (seen.has(keyOf(r)) && r.folder === msg.folder && (includeSnoozed || !already.has(r.entity_id)) && !picked.has(r.entity_id || r.id)) {
      picked.set(r.entity_id || r.id, r);
    }
  }
  // Return the acted-on message first so the caller can treat a failure moving it
  // as fatal before any sibling has been touched (no partial snooze on error).
  const rest = [...picked.values()].filter(r => (r.entity_id || r.id) !== (msg.entity_id || msg.id));
  // msg always qualifies (it's the acted-on, not-yet-snoozed message in its own
  // folder); fall back to it directly if the pool row for it was missed.
  const self = msg;
  return [self, ...rest];
}

// When a snooze ends: a valid date in the future, within 30 days.
export function parseSnoozeUntil(until) {
  if (!until) return { error: 'until is required' };
  const date = new Date(until);
  if (isNaN(date.getTime())) return { error: 'until must be a valid ISO date' };
  if (date <= new Date()) return { error: 'until must be in the future' };
  const maxDate = new Date();
  maxDate.setDate(maxDate.getDate() + 30);
  if (date > maxDate) return { error: 'until must be within 30 days' };
  return { date };
}

// The live snooze records of a snoozed message and those snoozed with it (#269): its thread's
// messages waiting in the same Snoozed folder until the same time. Snoozing takes the whole reply
// chain at once, so changing or ending the snooze does too; a later, separate snooze of another
// message in the thread keeps its own time. As imapManager.snoozedRows returns them.
//
// Its conversation is the reply chain the snooze took (gatherSnoozeConversation), not every message
// sharing its thread_id: that groups by subject too, so two separately snoozed "Build failed"
// notifications set to the same morning came back, or moved, together.
async function snoozedTogether(msg, userId) {
  const chain = await gatherSnoozeConversation(msg, { includeSnoozed: true });
  const ids = [...new Set([msg.entity_id, ...chain.map(r => r.entity_id)].filter(Boolean))];
  const rows = await imapManager.snoozedRows(
    `sm.user_id = $1 AND sm.account_id = $2 AND sm.snoozed_folder = $3 AND sm.storage_generation=$6
     AND sm.snooze_until = (
       SELECT own.snooze_until FROM snoozed_messages own
       WHERE own.storage_generation=sm.storage_generation AND own.user_id = $1 AND own.account_id = $2 AND own.entity_id = $4 AND own.snoozed_folder = $3
       ORDER BY own.snooze_until LIMIT 1)
     AND m.entity_id = ANY($5::uuid[])`,
    [userId, msg.account_id, msg.folder, msg.entity_id, ids, msg.storage_generation]
  );
  await withReadSourceIdentity({ id: msg.account_id, storage_generation: msg.storage_generation }, msg, async () => {});
  return rows;
}

// The reader's own message, with its account's user.
const ownedMessage = (id, userId) => findOwnedMessage(userId, id, { columns: 'm.*, a.user_id' });

// Snooze a message: move it to a Snoozed IMAP folder and record when to restore it
router.post('/messages/:id/snooze', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const { date: untilDate, error: untilError } = parseSnoozeUntil(req.body?.until);
  if (untilError) return res.status(400).json({ error: untilError });

  const msg = await ownedMessage(id, req.session.userId);
  if (!msg) return res.status(404).json({ error: 'Message not found' });

  if (!msg.message_id) return res.status(400).json({ error: 'Message has no Message-ID header — cannot snooze' });

  // Check if already snoozed
  const existing = await query(
    `SELECT sm.id FROM snoozed_messages sm
     WHERE sm.account_id = $1 AND sm.entity_id = $2 AND sm.storage_generation=$3
       AND (sm.wake_state<>'ready' OR ${LIVE_SNOOZE_SQL})`,
    [msg.account_id, msg.entity_id, msg.storage_generation]
  );
  if (existing.rows.length) return res.status(400).json({ error: 'Message is already snoozed' });

  const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [msg.account_id]);
  const account = accountResult.rows[0];

  // Snooze the whole reply-chain conversation, not just this message (see
  // gatherSnoozeConversation for why Gmail requires this and why it's bounded
  // to the header reply chain rather than thread_id).
  const convo = await gatherSnoozeConversation(msg);
  await withReadSourceIdentity(account, msg, async () => {});

  // Store the server's real path (INBOX.Snoozed under an INBOX. namespace prefix): folder
  // sync files the moved mail under it, so rows written as bare 'Snoozed' belong to no
  // folder and the sync adds each message a second time.
  let snoozedFolder;
  try {
    ({ path: snoozedFolder } = await imapManager.ensureFolder(account, 'Snoozed', { resolvePath: true }));
  } catch (err) {
    console.error(`Snooze ensureFolder failed for message ${id}:`, err.message);
    return res.status(500).json({ error: 'Failed to move message to Snoozed folder' });
  }

  if (msg.folder === snoozedFolder) {
    return res.status(400).json({ error: 'Message is already in Snoozed folder' });
  }

  for (const tm of convo) {
    imapManager._guardMoveUid(tm.account_id, tm.folder, tm.uid);
    try {
      // The record goes in before the move. Written after it, a failed row update or a restart
      // in between left the message in Snoozed with nothing to wake it. Until the move lands the
      // record is not live (no copy in Snoozed), so nothing reads it as a snooze yet.
      const record = await withReadSourceIdentity(account, tm, async tx => {
        const entityId = await resolveCanonicalEntity(tx, { accountId: account.id,
          storageGeneration: account.storage_generation }, tm.entity_id);
        await tx.query('UPDATE message_entities SET metadata_version=metadata_version+1 WHERE id=$1', [entityId]);
        await tx.query(`DELETE FROM snoozed_messages sm WHERE sm.account_id=$1 AND sm.storage_generation=$2
          AND sm.entity_id=$3 AND sm.wake_state='ready' AND NOT ${LIVE_SNOOZE_SQL}`,
        [account.id, account.storage_generation, entityId]);
        return tx.query(
          `INSERT INTO snoozed_messages (user_id, account_id, message_id_header, original_folder, snooze_until, snoozed_folder, storage_generation, entity_id, wake_state)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'snoozing') RETURNING id`,
          [req.session.userId, tm.account_id, tm.message_id, tm.folder, untilDate.toISOString(), snoozedFolder, tm.storage_generation, entityId]);
      });
      let snoozedUid;
      try {
        snoozedUid = await imapManager.moveMessage(account, tm.uid, tm.folder, snoozedFolder, { expectedSource: tm });
      } catch (err) {
        // A thrown transport call may have moved mail. Keep the durable decision for recovery.
        console.error(`Snooze IMAP move failed for message ${tm.id}:`, err.message);
        // The message the user acted on must succeed; a failed sibling is logged
        // and skipped so the rest of the conversation still snoozes.
        if (tm.id === msg.id) return res.status(500).json({ error: 'Failed to move message to Snoozed folder' });
        continue;
      }
      await finishMessageMove(account, tm, snoozedFolder, snoozedUid);
      // The acknowledgement makes waking eligible, but a current exact entity
      // projection in Snoozed is still required. Failure here is held recovery.
      await query("UPDATE snoozed_messages SET wake_state='ready' WHERE id=$1 AND wake_state='snoozing'",
        [record.rows[0].id]).catch(error => console.warn('Snooze acknowledged; intent recovery pending:', error.message));

    } finally {
      imapManager._unguardMoveUid(tm.account_id, tm.folder, tm.uid);
    }
  }

  // Refresh GTD section data if the snoozed conversation carries a GTD label (its in_inbox flips).
  notifyMailMutation(convo, req.session.userId);

  res.json({ ok: true });
});

// The Snoozed view (#269): change when a snoozed conversation comes back, as snoozing it did for
// the whole reply chain.
router.patch('/messages/:id/snooze', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });
  const { date: untilDate, error: untilError } = parseSnoozeUntil(req.body?.until);
  if (untilError) return res.status(400).json({ error: untilError });
  const msg = await ownedMessage(id, req.session.userId);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  const capturedAccount = { id: msg.account_id, storage_generation: msg.storage_generation };
  await withReadSourceIdentity(capturedAccount, msg, async () => {});
  const rows = msg.message_id ? await snoozedTogether(msg, req.session.userId) : [];
  if (!rows.length) return res.status(404).json({ error: 'Message is not snoozed' });
  await withReadSourceIdentity(capturedAccount, msg, async tx => {
    for (const row of rows) {
      await assertReadSourceIdentity(tx, capturedAccount, row);
      await tx.query('UPDATE message_entities SET metadata_version=metadata_version+1 WHERE id=$1', [row.entity_id]);
    }
    const updated = await tx.query(
      "UPDATE snoozed_messages SET snooze_until = $1 WHERE id = ANY($2) AND storage_generation=$3 AND wake_state='ready' RETURNING id",
      [untilDate.toISOString(), rows.map(r => r.snooze_id), msg.storage_generation]);
    if (updated.rows.length !== rows.length) {
      throw Object.assign(new Error('The snooze is already waking. Refresh before changing its time.'),
        { status: 409, code: 'identity_source_changed' });
    }
  });
  imapManager.broadcast({ type: 'folder_updated', folder: msg.folder, accountId: msg.account_id }, req.session.userId);
  res.json({ ok: true, until: untilDate.toISOString() });
});

// The Snoozed view (#269): bring a snoozed conversation back now, to where it was snoozed from, as
// its wake-up would, but keeping its read state: the reader asked for it.
router.post('/messages/:id/unsnooze', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });
  const msg = await ownedMessage(id, req.session.userId);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  const capturedAccount = { id: msg.account_id, storage_generation: msg.storage_generation };
  await withReadSourceIdentity(capturedAccount, msg, async () => {});
  const rows = msg.message_id ? await snoozedTogether(msg, req.session.userId) : [];
  if (!rows.length) return res.status(404).json({ error: 'Message is not snoozed' });
  const notWoken = [];
  for (const row of rows) {
    if (!(await imapManager.wakeSnoozed(row, { markUnread: false }))) notWoken.push(row);
  }
  // A persisted claim with no clear outcome is pending, not a retryable wake.
  const pendingRows = notWoken.length ? (await query(
    "SELECT id FROM snoozed_messages WHERE id=ANY($1::uuid[]) AND wake_state<>'ready'",
    [notWoken.map(row => row.snooze_id)])).rows : [];
  const pending = pendingRows.length;
  const restored = rows.length - notWoken.length;
  if (!restored && !pending) return res.status(409).json({ error: 'The snoozed message changed before waking. Refresh and try again.' });
  notifyMailMutation(rows.map(r => ({ account_id: r.account_id, message_id: r.message_id_header, folder: r.snoozed_folder })), req.session.userId);
  res.status(pending ? 202 : 200).json({ ok: true, restored, ...(pending ? { pending } : {}) });
});

// A permanent delete refused because the row's uid holds another message on the server (see
// isRowsMessage). Sync never corrects such a row, so drop it, letting a sync file what the server
// holds at that uid, and pull the folder.
async function refuseStaleExpunge(req, res, account, message) {
  await finishMessageDelete(account, message);
  imapManager.syncFolderOnDemand(account, message.folder).catch(error => console.warn('Post-delete sync pending:', error.message));
  return res.status(409).json({ error: 'This message changed on the server and was not deleted. Refresh and try again.' });
}

// Capture once from the owned projection and carry it through every provider await.
async function deleteMessage(req, res, id) {
  const message = await findOwnedMessage(req.session.userId, id, { columns: 'm.*, a.user_id' });
  if (!message) return res.status(404).json({ error: 'Message not found' });
  const account = (await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id])).rows[0];
  if (!account) return res.status(409).json({ error: 'Account changed; refresh before retrying' });
  const drafts = await resolveAllDraftsPaths(message.account_id, account.folder_mappings);
  const trash = await resolveTrashFolder(message.account_id, account.folder_mappings);
  const allTrash = await resolveAllTrashPaths(message.account_id, account.folder_mappings);
  const strategy = drafts.has(message.folder) ? { action: 'expunge' } : getDeleteStrategy(message.folder, trash, allTrash);
  if (strategy.action === 'no_trash') return res.status(422).json({ error: 'No Trash folder configured for this account' });
  let applied;
  imapManager._guardMoveUid(message.account_id, message.folder, message.uid);
  try {
    if (strategy.action === 'move') {
      let uid;
      try { uid = await imapManager.moveMessage(account, message.uid, message.folder, trash, { expectedSource: message }); }
      catch (error) { return res.status(mutationStatus(error)).json({ error: 'Could not delete message' }); }
      applied = await finishMessageMove(account, message, trash, uid, { rotateId: true });
    } else {
      let deleted;
      try { deleted = await imapManager.permanentDeleteMessage(account, message.uid, message.folder, { expectRow: message, expectedSource: message }); }
      catch (error) { return res.status(mutationStatus(error)).json({ error: 'Could not delete message' }); }
      if (deleted === false) return refuseStaleExpunge(req, res, account, message);
      applied = await finishMessageDelete(account, message);
    }
  } finally { imapManager._unguardMoveUid(message.account_id, message.folder, message.uid); }
  imapManager.broadcast({ type: 'folder_updated', folder: message.folder, accountId: message.account_id }, req.session.userId);
  notifyMailMutation([message], req.session.userId);
  res.json({ ok: true, ...(!applied ? { identityPending: true } : {}) });
}

// One DELETE per message at a time. An overlapping duplicate's MOVE finds nothing and reads as a
// non-UIDPLUS success, so it would adjust counts again, and if its UPDATE lands first it re-files
// the row under the stale source uid and the first request's UPDATE misses the rotated id.
const deleteInFlight = new Set();

router.delete('/messages/:id', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const inflightKey = `${req.session.userId}:${id.toLowerCase()}`;
  if (deleteInFlight.has(inflightKey)) return res.status(409).json({ error: 'This message is already being deleted' });
  deleteInFlight.add(inflightKey);
  try {
    await deleteMessage(req, res, id);
  } finally {
    deleteInFlight.delete(inflightKey);
  }
});

// ── Antispam (v0.1) ─────────────────────────────────────────────────────────
// Manual "Mark as Spam" / "Mark as Not Spam" endpoints.
// They move the message to the account's spam folder (or back to INBOX for
// ham) via IMAP, persist the user override in messages.spam_user_override,
// and log the decision to spam_training_log so future releases can train
// per-user models on it.
//
// No automatic classification runs here — that ships in v0.2 (ML) and v0.3 (SA).

// Helper: build the v0.2 feature payload for a messages row at mark time.
// Shape matches spam_training_log (migration 0048) + spamModelStore inputs.
function extractSpamFeatures(message) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const attachmentNames = attachments
    .map(a => a?.filename || a?.name)
    .filter(Boolean)
    .map(f => { const dot = String(f).lastIndexOf('.'); return dot > 0 ? String(f).slice(dot + 1).toLowerCase() : null; })
    .filter(Boolean);

  const msg = {
    subject: message.subject || '',
    body: message.body_text || '',
    bodyHtml: message.body_html || '',
    from: message.from_email ? `<${message.from_email}>` : null,
    replyTo: null,
    headers: [],
    attachments,
  };

  return {
    subject: msg.subject,
    body_text: message.body_text || null,
    body_html: message.body_html || null,
    token_counts: countTokens(tokenize(msg)),
    flag_features: extractFlagFeatures(msg),
    sender_domain: message.from_email ? message.from_email.split('@').pop()?.toLowerCase() || null : null,
    attachment_types: attachmentNames.length ? attachmentNames : null,
  };
}

// count token occurrences into {word: n}
function countTokens(tokens) {
  const counts = {};
  for (const t of tokens) counts[t] = (counts[t] || 0) + 1;
  return counts;
}

// Log one training decision with its v0.2 features, then feed the ML model.
async function logSpamTraining(userId, message, folder, label, features) {
  await query(
    `INSERT INTO spam_training_log
       (user_id, account_id, message_id_header, message_uid, folder, label, source,
        subject, body_text, body_html, token_counts, flag_features, sender_domain, attachment_types)
     VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT DO NOTHING`,
    [
      userId, message.account_id, message.message_id || null, message.uid, folder, label,
      features.subject, features.body_text, features.body_html,
      JSON.stringify(features.token_counts), JSON.stringify(features.flag_features),
      features.sender_domain, features.attachment_types ?? null,
    ]
  );
  // Incremental training: update the user's Naive Bayes model in <1s.
  // Non-blocking on failure — user feedback must never break the HTTP path.
  try {
    await updateIncrementalForUser(userId, {
      subject: features.subject,
      body: features.body_text || '',
      bodyHtml: features.body_html || '',
      from: message.from_email ? `<${message.from_email}>` : null,
      attachments: Array.isArray(message.attachments) ? message.attachments : [],
    }, label);
  } catch (err) {
    console.warn(`spam incremental training failed for user ${userId}:`, err.message);
  }
}

// Helper: move a single message to a destination folder, update DB, log to
// training_log, and broadcast folder_updated. Shared between /spam and /ham.
async function moveForSpamLabel(messageId, userId, destinationFolder, label, capturedMessage) {
  const message = capturedMessage || await findOwnedMessage(userId, messageId, { columns: 'm.*, a.user_id, a.folder_mappings' });
  if (!message) return { ok: false, status: 404, error: 'Message not found' };

  // v0.2: extract token/flag features at mark time (Solution C, migration
  // 0048) and feed the per-user Naive Bayes model incrementally. The stored
  // features make the retrain path independent of message persistence.
  const spamFeatures = extractSpamFeatures(message);

  // No-op: message already in the destination folder.
  if (message.folder === destinationFolder) {
    // Still record the training label so the user's intent is captured
    // (e.g. re-confirming a verdict), but skip the IMAP move.
    await withReadSourceIdentity({ id: message.account_id, storage_generation: message.storage_generation }, message,
      tx => tx.query(`UPDATE messages SET spam_user_override=$1, spam_verdict=$1, spam_analyzed_at=NOW() WHERE id=$2`, [label, messageId]));
    await logSpamTraining(userId, message, destinationFolder, label, spamFeatures);
    return { ok: true, status: 200, body: { ok: true, alreadyInFolder: true, folder: destinationFolder } };
  }

  const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
  const account = accountResult.rows[0];

  // Guard the source UID before the IMAP move so reconcileDeletes cannot
  // delete the DB row if an EXPUNGE arrives while the move is in flight.
  imapManager._guardMoveUid(account.id, message.folder, message.uid);
  let newUid;
  try {
    try {
      newUid = await imapManager.moveMessage(account, message.uid, message.folder, destinationFolder, { expectedSource: message });
    } catch (err) {
      console.error(`IMAP move for /${label} failed:`, err.message);
      return { ok: false, status: mutationStatus(err), error: 'Could not move message' };
    }
    await finishMessageMove(account, message, destinationFolder, newUid, { label });

  } finally {
    imapManager._unguardMoveUid(account.id, message.folder, message.uid);
  }

  // Training log: capture the decision for future model training. Record the UID that now
  // lives in the destination folder: the row was re-keyed to newUid above, so message.uid (the
  // pre-move source UID) would no longer match the messages row. Without a new uid there is no
  // row to match, and the source uid is recorded as before.
  await logSpamTraining(
    userId,
    { ...message, uid: newUid ?? message.uid, account_id: account.id },
    destinationFolder, label, spamFeatures,
  ).catch(error => console.warn('Spam training recovery pending:', error.message));

  // If folder_mappings.spam is not yet configured, learn from the discovered folder.
  if (label === 'spam' && !account.folder_mappings?.spam) {
    await query(
      `UPDATE email_accounts SET folder_mappings = folder_mappings || jsonb_build_object('spam', $1::text)
       WHERE id = $2 AND storage_generation=$3 AND NOT (folder_mappings ? 'spam')`,
      [destinationFolder, account.id, message.storage_generation]
    ).catch(err => console.warn('Failed to auto-persist folder_mappings.spam:', err.message));
  }

  imapManager.broadcast(
    { type: 'folder_updated', folder: destinationFolder, accountId: account.id },
    userId
  );

  // Refresh GTD section data if the (un)spammed message's thread carries a GTD label. Covers both
  // /spam and /ham, which share this mover. The already-in-folder no-op path above returns
  // early without a move, so GTD section data is untouched there.
  notifyMailMutation([message], userId);

  return { ok: true, status: 200, body: { ok: true, folder: destinationFolder, newUid: newUid || null } };
}

// POST /api/mail/messages/:id/spam
// Moves the message to the account's spam/junk folder and records the user
// override as spam. Coexists with the future ML/SA auto-classification:
// spam_user_override always wins over auto verdicts.
router.post('/messages/:id/spam', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const lookup = await findOwnedMessage(req.session.userId, id, { columns: 'm.*, a.folder_mappings' });
  if (!lookup) return res.status(404).json({ error: 'Message not found' });
  const spamFolder = await resolveSpamFolder(lookup.account_id, lookup.folder_mappings);
  if (!spamFolder) return res.status(422).json({ error: 'No spam folder configured for this account' });

  const result = await moveForSpamLabel(id, req.session.userId, spamFolder, 'spam', lookup);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result.body);
});

// GET /api/mail/category-counts
// Per category of the Inbox: `counts`, how many are unread, and `totals`, how many there are
// (#597), so a tab whose mail is all read still says it holds some. Counted from the cached rows
// the category lists show. Scoped to the user's enabled accounts as the Inbox is (All Inboxes
// opt-in included); optionally one account via ?accountId=.
router.get('/category-counts', async (req, res) => {
  const { accountId } = req.query;
  if (accountId && !UUID_RE.test(accountId)) {
    return res.status(400).json({ error: 'Invalid account id' });
  }

  const accountsResult = await query(
    'SELECT id, include_in_unified_inbox FROM email_accounts WHERE user_id = $1 AND enabled = true',
    [req.session.userId]
  );
  const { accountIds: scopedIds } = resolveAccountScope(accountsResult.rows, accountId);
  if (!scopedIds.length) return res.json({ counts: {} });

  const result = await query(`
    SELECT COALESCE(m.category, 'primary') AS category,
           COUNT(*) FILTER (WHERE m.is_read = false)::int AS unread_count,
           COUNT(*)::int AS total_count
    FROM messages m
    WHERE m.account_id = ANY($1)
      AND m.folder = 'INBOX'
      AND m.is_deleted = false
      AND ${NOT_PLACEHOLDER_SQL}
    GROUP BY COALESCE(m.category, 'primary')
  `, [scopedIds]);

  const counts = {};
  const totals = {};
  for (const row of result.rows) {
    counts[row.category] = row.unread_count;
    totals[row.category] = row.total_count;
  }
  res.set('Cache-Control', 'no-store');
  res.json({ counts, totals });
});

// PATCH /api/mail/messages/:id/category
// Manually override the computed category for a single message.
router.patch('/messages/:id/category', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const { category } = req.body;
  const VALID_CATEGORIES = new Set(['primary', 'newsletter', 'promotion', 'automated', 'social']);
  if (!VALID_CATEGORIES.has(category)) {
    return res.status(400).json({ error: 'Invalid category' });
  }

  // A chosen category is stored as itself, 'primary' included. NULL means "not chosen": the
  // ingest classifier leaves Primary that way, and the Recategorize backfill (which reads only
  // NULL rows) and a re-synced row (COALESCE onto NULL) may still fill it in. Storing a chosen
  // Primary as NULL let either one move the message back out of Primary (#489).
  const result = await query(
    `UPDATE messages SET category = $1
     FROM email_accounts a
     WHERE messages.id = $2
       AND messages.account_id = a.id
       AND a.user_id = $3
     RETURNING messages.id`,
    [category, id, req.session.userId]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  res.json({ ok: true, category });
});

// POST /api/mail/messages/:id/unsubscribe
// Processes a one-click unsubscribe (RFC 8058) or returns parsed
// unsubscribe options for the frontend to handle (URL open, mailto compose).
router.post('/messages/:id/unsubscribe', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const message = await findOwnedMessage(req.session.userId, id, {
    columns: 'm.list_unsubscribe, m.list_unsubscribe_post',
    live: true,
  });
  if (!message) return res.status(404).json({ error: 'Message not found' });
  const { list_unsubscribe: rawUnsub, list_unsubscribe_post: rawUnsubPost } = message;
  if (!rawUnsub) return res.status(400).json({ error: 'No unsubscribe header' });
  const list_unsubscribe = decodeMimeWords(rawUnsub);
  const list_unsubscribe_post = rawUnsubPost ? decodeMimeWords(rawUnsubPost) : rawUnsubPost;

  // Parse angle-bracket-wrapped URLs/mailtos from the header value.
  // e.g. "<https://example.com/unsub>, <mailto:list@example.com?subject=unsubscribe>"
  const refs = [...list_unsubscribe.matchAll(/<([^>]+)>/g)].map(m => m[1].trim());
  const httpsUrl = refs.find(r => /^https:\/\//i.test(r));
  const mailtoUrl = refs.find(r => /^mailto:/i.test(r));

  const isOneClick = /List-Unsubscribe=One-Click/i.test(list_unsubscribe_post || '');

  // RFC 8058 one-click: POST to the https URL on behalf of the user.
  if (isOneClick && httpsUrl) {
    // Validate the URL host — DNS-resolved check blocks hostnames that resolve to private IPs.
    let parsed;
    try { parsed = new URL(httpsUrl); } catch {
      return res.status(400).json({ error: 'Invalid unsubscribe URL' });
    }
    const hostErr = await validateHost(parsed.hostname);
    if (hostErr) return res.status(400).json({ error: 'Unsubscribe URL not allowed' });

    try {
      // safeFetch validates the resolved IP of the initial host AND every redirect
      // hop, so an attacker-supplied List-Unsubscribe URL can't redirect to an
      // internal address. (The validateHost above stays as a fast pre-check.)
      const unsub = await safeFetch(httpsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mailflow/1.0' },
        body: 'List-Unsubscribe=One-Click',
        signal: AbortSignal.timeout(10000),
      });
      if (unsub.ok) {
        await query('UPDATE messages SET unsubscribed_at = NOW() WHERE id = $1', [id]);
        return res.json({ ok: true, type: 'one-click' });
      }
      console.warn(`One-click unsubscribe returned ${unsub.status} for ${httpsUrl}`);
      // Fall through to URL/mailto fallback
    } catch (err) {
      console.warn('One-click unsubscribe failed:', err.message);
      // Fall through to URL/mailto options instead
    }
  }

  // Return parsed options for the frontend to handle.
  // Mark unsubscribed_at optimistically — the user has been given the mechanism to complete it.
  await query('UPDATE messages SET unsubscribed_at = NOW() WHERE id = $1', [id]);
  res.json({
    ok: true,
    type: httpsUrl ? 'url' : 'mailto',
    url: httpsUrl || null,
    mailto: mailtoUrl || null,
  });
});

// POST /api/mail/messages/:id/ham
// Moves a message back from the spam folder to INBOX and records the override
// as ham (not spam). Only meaningful when the message is currently in a
// spam-like folder; returns 400 otherwise.
router.post('/messages/:id/ham', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const lookup = await findOwnedMessage(req.session.userId, id, { columns: 'm.*, a.folder_mappings' });
  if (!lookup) return res.status(404).json({ error: 'Message not found' });
  const allSpam = await resolveAllSpamPaths(lookup.account_id, lookup.folder_mappings);
  if (!allSpam.has(lookup.folder)) {
    return res.status(400).json({ error: 'Message is not in the spam folder' });
  }

  // Resolve inbox folder per account — Gmail, Exchange and others may not use
  // the literal 'INBOX' (e.g. 'Inbox' on Dovecot, 'Posteingang', etc.).
  // Same pattern as folder_mappings.sent / .drafts in send.js and draft.js.
  const inboxFolder = lookup.folder_mappings?.inbox || 'INBOX';
  const result = await moveForSpamLabel(id, req.session.userId, inboxFolder, 'ham', lookup);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result.body);
});

export default router;
