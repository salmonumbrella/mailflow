import { randomUUID } from 'crypto';
import { query } from './db.js';
import { InvitationError } from './calendarInvitation.js';

const STALE_MS = 5 * 60 * 1000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function owner(scope) {
  if (!UUID.test(scope?.userId || '') || !UUID.test(scope?.accountId || '')) throw new TypeError('A trusted invitation owner and account are required');
  return [scope.userId, scope.accountId];
}

export async function observeInvitationSequence(key, sequence, cancelled = false, scope) {
  // Cancellation wins over a request of the same sequence, but a later new request can reopen it.
  const rank = sequence * 2 + Number(cancelled);
  const { rows } = await query(`INSERT INTO invitation_response_state (key, value, user_id, account_id, expires_at) VALUES ($1, $2::text, $3, $4, NULL)
    ON CONFLICT (key) DO UPDATE SET value = GREATEST(invitation_response_state.value::bigint, $2::bigint)::text
    WHERE invitation_response_state.user_id = $3 AND invitation_response_state.account_id = $4
    RETURNING value`, [key, rank, ...owner(scope)]);
  if (!rows.length) throw new InvitationError(404, 'Invitation state not found.');
  if (cancelled) throw new InvitationError(409, 'This meeting was cancelled. No response will be sent.', 'cancelled_invitation');
  if (Number(rows[0].value) > rank) throw new InvitationError(409, 'A newer version or cancellation of this invitation has already been opened. Respond to the latest invitation.', 'outdated_invitation');
}
function parse(value) {
  try {
    const state = JSON.parse(value);
    if (state?.v === 1 && ['pending', 'sent', 'failed', 'uncertain'].includes(state.status) && typeof state.attemptId === 'string') return state;
  } catch { /* A corrupt reservation must never release an uncertain send. */ }
  throw new InvitationError(503, 'The saved response cannot be read. Check your Sent folder before trying again.', 'response_unavailable');
}

async function replace(key, previous, next, scope) {
  const { rowCount } = await query('UPDATE invitation_response_state SET value = $3 WHERE key = $1 AND value::jsonb = $2::jsonb AND expires_at IS NULL AND user_id = $4 AND account_id = $5', [key, JSON.stringify(previous), JSON.stringify(next), ...owner(scope)]);
  return rowCount === 1;
}

export async function readInvitationResponse(key, now = Date.now(), scope) {
  const { rows } = await query('SELECT value FROM invitation_response_state WHERE key = $1 AND expires_at IS NULL AND user_id = $2 AND account_id = $3', [key, ...owner(scope)]);
  if (!rows.length) return null;
  let state = parse(rows[0].value);
  if (state.status === 'pending' && now - Date.parse(state.updatedAt) > STALE_MS) {
    const next = { ...state, status: state.phase === 'prepare' ? 'failed' : 'uncertain', updatedAt: new Date(now).toISOString(), code: 'interrupted' };
    if (await replace(key, state, next, scope)) state = next;
    else return readInvitationResponse(key, now, scope);
  }
  return state;
}

// No expiry: a timeout or restart can never make the same invitation silently send twice.
// The key is a hash of owner/account/event identity. The value has no recipients or calendar text.
export async function reserveInvitationResponse(key, { response, revision, requestId, expectedAttemptId, retry = false }, now = Date.now(), scope) {
  const existing = await readInvitationResponse(key, now, scope);
  if (existing) {
    if (existing.revision !== revision) throw new InvitationError(409, 'This event changed without a new sequence number. Respond in your calendar app.', 'invitation_changed');
    if (existing.requestId === requestId || existing.status === 'pending' || existing.status === 'uncertain' || (existing.status === 'sent' && existing.response === response)) return { state: existing, acquired: false };
    if (expectedAttemptId !== existing.attemptId || (existing.status === 'failed' && !retry)) throw new InvitationError(409, 'The response changed in another tab. Reload its status before sending.', 'response_changed');
  } else if (expectedAttemptId) throw new InvitationError(409, 'The saved response is unavailable. Reload before sending.', 'response_changed');
  const state = {
    v: 1, attemptId: randomUUID(), requestId, revision, response, status: 'pending', phase: 'prepare',
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    ...(existing?.status === 'sent' ? { previousResponse: existing.response } : existing?.previousResponse ? { previousResponse: existing.previousResponse } : {}),
  };
  let acquired;
  if (existing) acquired = await replace(key, existing, state, scope);
  else {
    const { rowCount } = await query('INSERT INTO invitation_response_state (key, value, user_id, account_id, expires_at) VALUES ($1, $2, $3, $4, NULL) ON CONFLICT (key) DO NOTHING', [key, JSON.stringify(state), ...owner(scope)]);
    acquired = rowCount === 1;
  }
  if (acquired) return { state, acquired: true };
  return { state: await readInvitationResponse(key, now, scope), acquired: false };
}

export async function updateInvitationResponse(key, attemptId, patch, scope) {
  const { rows } = await query('SELECT value FROM invitation_response_state WHERE key = $1 AND expires_at IS NULL AND user_id = $2 AND account_id = $3', [key, ...owner(scope)]);
  if (!rows.length) throw new InvitationError(503, 'The response status could not be saved. Check your Sent folder.', 'response_unavailable');
  const current = parse(rows[0].value);
  if (current.attemptId !== attemptId) return null;
  if (patch.phase === 'smtp' && (current.status !== 'pending' || current.phase !== 'prepare')) return null;
  if (current.status === 'sent' && patch.status !== 'sent') return current;
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  if (await replace(key, current, next, scope)) return next;
  return updateInvitationResponse(key, attemptId, patch, scope);
}

// Lock the sequence observation and claim delivery in the same statement. A concurrent
// newer observation that committed first wins, including one arriving during SMTP setup.
export async function claimInvitationDelivery(key, attemptId, seriesKey, sequence, scope) {
  const current = await readInvitationResponse(key, Date.now(), scope);
  if (!current || current.attemptId !== attemptId || current.status !== 'pending' || current.phase !== 'prepare') return null;
  const next = { ...current, phase: 'smtp', updatedAt: new Date().toISOString() };
  const { rowCount } = await query(`UPDATE invitation_response_state SET value = $3
    WHERE key = $1 AND value::jsonb = $2::jsonb AND expires_at IS NULL AND user_id = $6 AND account_id = $7
      AND EXISTS (SELECT 1 FROM invitation_response_state latest WHERE latest.key = $4
        AND latest.expires_at IS NULL AND latest.user_id = $6 AND latest.account_id = $7
        AND latest.value::bigint <= $5::bigint FOR UPDATE)`,
  [key, JSON.stringify(current), JSON.stringify(next), seriesKey, sequence * 2, ...owner(scope)]);
  if (rowCount === 1) return next;
  await observeInvitationSequence(seriesKey, sequence, false, scope);
  return null;
}

export function publicInvitationResponse(state) {
  if (!state) return null;
  const { status, response, attemptId, updatedAt, previousResponse, sentCopySaved, code } = state;
  return { status, response, attemptId, updatedAt, ...(previousResponse ? { previousResponse } : {}), ...(sentCopySaved === false ? { sentCopySaved } : {}), ...(code ? { code } : {}) };
}
