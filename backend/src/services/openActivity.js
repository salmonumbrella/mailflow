import { randomBytes } from 'node:crypto';
import { query, withTransaction } from './db.js';
import {
  OPEN_ACTIVITY_PATH, OPEN_ACTIVITY_MAX_LOADS, OPEN_ACTIVITY_RETENTION_DAYS, OPEN_TOKEN_RE,
  OPEN_UUID_RE, OpenActivityError, openActivityOrigin,
} from './openActivityRules.js';

const MAX_ACCOUNT_RECORDS = 10000;
const messageIdValid = value => typeof value === 'string' && value.length <= 512 && /^<[^<>\s]+@[^<>\s]+>$/.test(value);

export async function prepareOpenActivity({ userId, accountId, messageId, scheduledId = null }) {
  const origin = openActivityOrigin();
  if (!origin) throw new OpenActivityError(409, 'Open activity needs a configured public HTTPS APP_URL.');
  if (!OPEN_UUID_RE.test(userId || '') || !OPEN_UUID_RE.test(accountId || '') || !messageIdValid(messageId)
    || (scheduledId !== null && !OPEN_UUID_RE.test(scheduledId))) throw new OpenActivityError(400, 'Invalid open activity message.');
  const record = await withTransaction(async client => {
    // Account lock bounds simultaneous prepares and also validates the trusted sending identity.
    const owned = await client.query('SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2 FOR UPDATE', [accountId, userId]);
    if (!owned.rows.length) throw new OpenActivityError(404, 'Account not found');
    if (scheduledId) {
      const scheduled = await client.query('SELECT id FROM scheduled_messages WHERE id = $1 AND user_id = $2 AND account_id = $3', [scheduledId, userId, accountId]);
      if (!scheduled.rows.length) throw new OpenActivityError(404, 'Scheduled message not found');
    }
    const existing = await client.query('SELECT id, token, expires_at FROM outgoing_open_activity WHERE user_id = $1 AND account_id = $2 AND message_id = $3', [userId, accountId, messageId]);
    if (existing.rows.length) {
      if (new Date(existing.rows[0].expires_at).getTime() <= Date.now()) throw new OpenActivityError(409, 'This message’s open activity has expired. Turn tracking off before retrying.');
      return existing.rows[0];
    }
    await client.query('DELETE FROM outgoing_open_activity WHERE account_id = $1 AND expires_at <= NOW()', [accountId]);
    const count = await client.query('SELECT COUNT(*)::int AS count FROM outgoing_open_activity WHERE account_id = $1', [accountId]);
    if (count.rows[0].count >= MAX_ACCOUNT_RECORDS) throw new OpenActivityError(409, 'Open activity limit reached. Turn tracking off to send this message.');
    const { rows } = await client.query(
      `INSERT INTO outgoing_open_activity (user_id, account_id, message_id, token, scheduled_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, token`,
      [userId, accountId, messageId, randomBytes(32).toString('base64url'), scheduledId],
    );
    return rows[0];
  });
  return { id: record.id, userId, accountId, pixel: `<img src="${origin}${OPEN_ACTIVITY_PATH}/${record.token}.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0" />` };
}

const STATES = new Set(['sending', 'sent', 'failed', 'cancelled', 'uncertain']);
export async function setOpenActivityStatus(activity, status) {
  if (!activity) return;
  if (!STATES.has(status)) throw new TypeError('Invalid open activity status');
  await query(
    `UPDATE outgoing_open_activity SET status = $4,
       sent_at = CASE WHEN $4 = 'sent' THEN COALESCE(sent_at, NOW()) ELSE sent_at END,
       expires_at = CASE WHEN $4 = 'sent' AND sent_at IS NULL THEN NOW() + INTERVAL '30 days' ELSE expires_at END
     WHERE id = $1 AND user_id = $2 AND account_id = $3 AND status <> 'sent' AND expires_at > NOW()
       AND ($4 <> 'cancelled' OR status IN ('prepared', 'failed'))`,
    [activity.id, activity.userId, activity.accountId, status],
  );
}

// Post-SMTP metadata must never turn an accepted delivery into a retryable send failure.
export async function noteOpenActivityStatus(activity, status) {
  if (!activity) return;
  try { await setOpenActivityStatus(activity, status); }
  catch { console.warn('[openActivity] Could not record delivery state; activity is not confirmed.'); }
}

export async function noteScheduledOpenActivityStatus(userId, scheduledId, status, { accountId, messageId, trackOpens } = {}) {
  if (!STATES.has(status)) throw new TypeError('Invalid open activity status');
  // A schedule can be edited after a failed attempt. Never activate its previous account's
  // token, or any token if its final message opted out. Cancellation cannot resolve uncertainty.
  if (status !== 'cancelled' && (trackOpens !== true || !OPEN_UUID_RE.test(accountId || '') || !messageIdValid(messageId))) return;
  const scope = status === 'cancelled' ? "AND status IN ('prepared', 'failed')" : 'AND account_id = $4 AND message_id = $5';
  const params = status === 'cancelled' ? [userId, scheduledId, status] : [userId, scheduledId, status, accountId, messageId];
  try {
    await query(
      `UPDATE outgoing_open_activity SET status = $3,
         sent_at = CASE WHEN $3 = 'sent' THEN COALESCE(sent_at, NOW()) ELSE sent_at END,
         expires_at = CASE WHEN $3 = 'sent' AND sent_at IS NULL THEN NOW() + INTERVAL '30 days' ELSE expires_at END
       WHERE user_id = $1 AND scheduled_id = $2 AND status <> 'sent' AND expires_at > NOW() ${scope}`,
      params,
    );
  } catch { console.warn('[openActivity] Could not record scheduled delivery state.'); }
}

export async function recordOpenActivity(token) {
  if (typeof token !== 'string' || !OPEN_TOKEN_RE.test(token)) return;
  // One unique-index lookup/update, atomic across processes. No request headers or address data.
  await query(
    `UPDATE outgoing_open_activity SET load_count = load_count + 1,
       first_loaded_at = COALESCE(first_loaded_at, NOW()), last_loaded_at = NOW()
     WHERE token = $1 AND status = 'sent' AND sent_at <= NOW() AND expires_at > NOW()
       AND load_count < $2 AND (last_loaded_at IS NULL OR last_loaded_at <= NOW() - INTERVAL '60 seconds')`,
    [token, OPEN_ACTIVITY_MAX_LOADS],
  );
}

const COLUMNS = `o.id, o.account_id, o.status, o.created_at, o.sent_at, o.expires_at,
  o.first_loaded_at, o.last_loaded_at, o.load_count`;
const present = row => ({
  id: row.id, accountId: row.account_id, messageId: row.message_row_id || null,
  status: row.status, createdAt: row.created_at, sentAt: row.sent_at, expiresAt: row.expires_at,
  firstLoadedAt: row.first_loaded_at, lastLoadedAt: row.last_loaded_at, loadCount: row.load_count,
  ...(row.subject !== undefined ? { subject: row.subject } : {}),
});

export async function listOpenActivity(userId, accountId = null) {
  if (accountId && !OPEN_UUID_RE.test(accountId)) throw new OpenActivityError(400, 'Invalid account');
  if (accountId) {
    const owned = await query('SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2', [accountId, userId]);
    if (!owned.rows.length) throw new OpenActivityError(404, 'Account not found');
  }
  const { rows } = await query(
    `SELECT ${COLUMNS}, m.id AS message_row_id, m.subject
     FROM outgoing_open_activity o JOIN email_accounts a ON a.id = o.account_id AND a.user_id = o.user_id
     LEFT JOIN LATERAL (SELECT id, subject FROM messages
       WHERE account_id = o.account_id AND message_id = o.message_id AND is_deleted = false ORDER BY date DESC, id LIMIT 1) m ON true
     WHERE o.user_id = $1 AND ($2::uuid IS NULL OR o.account_id = $2) AND o.expires_at > NOW()
     ORDER BY o.created_at DESC, o.id LIMIT 50`, [userId, accountId],
  );
  return rows.map(present);
}

export async function messageOpenActivity(userId, messageId) {
  if (!OPEN_UUID_RE.test(messageId || '')) throw new OpenActivityError(400, 'Invalid message');
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM messages m
     JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
     JOIN outgoing_open_activity o ON o.account_id = m.account_id AND o.user_id = $1 AND o.message_id = m.message_id
     WHERE m.id = $2 AND m.is_deleted = false AND o.expires_at > NOW() LIMIT 1`, [userId, messageId],
  );
  return rows[0] ? present(rows[0]) : null;
}

export { OPEN_ACTIVITY_RETENTION_DAYS };

let sweepTimer = null;
let sweeping = false;
export async function purgeExpiredOpenActivity() {
  if (sweeping) return;
  sweeping = true;
  try {
    await query(`DELETE FROM outgoing_open_activity WHERE id IN
      (SELECT id FROM outgoing_open_activity WHERE expires_at <= NOW() ORDER BY expires_at LIMIT 500)`);
  } catch { console.warn('[openActivity] Expired activity cleanup failed.'); }
  finally { sweeping = false; }
}
export function startOpenActivitySweep() {
  if (sweepTimer) return;
  purgeExpiredOpenActivity();
  sweepTimer = setInterval(purgeExpiredOpenActivity, 60 * 60 * 1000);
  sweepTimer.unref?.();
}
export function stopOpenActivitySweep() {
  clearInterval(sweepTimer); sweepTimer = null;
}
