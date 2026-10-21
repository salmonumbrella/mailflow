import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { query } from '../services/db.js';
import { consume } from '../services/rateLimiter.js';
import { logAuthEvent } from '../services/authEvents.js';
import { createFastmailMaskedEmail, validateFastmailMaskedEmailInput } from '../services/fastmailIdentities.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const TEXT = {
  invalid_input: 'Invalid masked-email creation input.',
  unsupported_provider: 'This account does not support Fastmail masked-email creation.',
  account_disabled: 'This account is disabled.',
  credentials_missing: 'The selected account has no configured provider credential.',
  credentials_invalid: 'The selected account provider credential is invalid.',
  account_mismatch: 'The provider credential does not match the selected account.',
  insufficient_scope: 'The provider credential does not permit this operation.',
  provider_unavailable: 'The provider could not complete the request.',
  admission_unavailable: 'Creation could not be admitted. No provider request was made.',
  invalid_response: 'The provider returned an invalid response.',
  rate_limited: 'Masked-email creation is rate limited.',
  outcome_unknown: 'Creation may have completed. Do not automatically retry.',
};
const STATUS = { invalid_input: 400, unsupported_provider: 422, account_disabled: 409,
  credentials_missing: 409, credentials_invalid: 409, account_mismatch: 409,
  insufficient_scope: 403, rate_limited: 429 };
const retrySeconds = value => Number.isInteger(value) && value >= 0 && value <= 86400 ? value : null;
const email = value => typeof value === 'string' && value.length <= 254 && !/[\p{Cc}\p{Cf}\s]/u.test(value)
  && /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value)
  && value.split('@')[0].length <= 64
  && value.split('@')[1].split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));

export function normalizeMaskedCreate(body) {
  try { return validateFastmailMaskedEmailInput(body); } catch { return null; }
}

function audit(req, accountId, clientRequestId, outcome) {
  const suffix = { attempt: 'attempt', created: 'ok', refused: 'refused', unknown: 'unknown' }[outcome];
  logAuthEvent(`masked_create_${suffix}`, { userId: req.session.userId,
    username: req.session.username, ip: req.ip, success: outcome === 'attempt' || outcome === 'created' });
  console.info(JSON.stringify({ event: 'masked_create', accountId, clientRequestId, outcome }));
}

const router = Router();
router.use(requireAuth);
router.post('/:id/masked-emails', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.apiToken && !req.apiToken.scopes?.includes('identity:write')) {
    return res.status(403).json({ error: 'This API token does not have the identity:write scope' });
  }
  if (req.params.id.length !== 36 || !UUID.test(req.params.id)) return res.status(404).json({ error: 'Account not found' });
  const accountId = req.params.id.toLowerCase();
  const { rows } = await query('SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2', [accountId, req.session.userId]);
  if (!rows.length) return res.status(404).json({ error: 'Account not found' });
  const input = normalizeMaskedCreate(req.body);
  const clientRequestId = input?.clientRequestId ?? null;
  audit(req, accountId, clientRequestId, 'attempt');
  const refuse = (reason, status = STATUS[reason] ?? 503, retryAfter = null) => {
    audit(req, accountId, clientRequestId, 'refused');
    if (retryAfter !== null) res.set('Retry-After', String(retryAfter));
    return res.status(status).json({ error: TEXT[reason], reason, outcome: 'refused',
      accountId, clientRequestId, ...(retryAfter === null ? {} : { retryAfter }) });
  };
  if (!input) return refuse('invalid_input');
  let budget;
  try { budget = await consume(`masked-create:${accountId}`, 10, 3600000); }
  catch { return refuse('admission_unavailable'); }
  if (budget.limited) return refuse('rate_limited', 429, Math.max(1, Math.ceil(budget.resetMs / 1000)));
  let result;
  try {
    // No request-disconnect abort: an issued mutation must reach its terminal audit.
    result = await createFastmailMaskedEmail(req.session.userId, accountId, input);
    if (!object(result) || result.accountId !== accountId || result.provider !== 'fastmail'
      || result.clientRequestId !== clientRequestId || result.outcome !== 'created' || result.state !== 'enabled' || !email(result.email)) {
      throw Object.assign(new Error('Invalid masked creation result'), { reason: 'outcome_unknown', outcome: 'unknown' });
    }
  } catch (error) {
    if (error?.status === 404 && error?.outcome !== 'unknown') {
      audit(req, accountId, clientRequestId, 'refused');
      return res.status(404).json({ error: 'Account not found' });
    }
    if (error?.outcome === 'refused' && Object.hasOwn(TEXT, error.reason) && error.reason !== 'outcome_unknown') {
      return refuse(error.reason, STATUS[error.reason] ?? 503, retrySeconds(error.retryAfter));
    }
    audit(req, accountId, clientRequestId, 'unknown');
    return res.status(503).json({ error: TEXT.outcome_unknown, reason: 'outcome_unknown', outcome: 'unknown',
      accountId, clientRequestId, mayHaveCompleted: true });
  }
  audit(req, accountId, clientRequestId, 'created');
  return res.status(201).json({ accountId, provider: 'fastmail', email: result.email.toLowerCase(),
    state: 'enabled', outcome: 'created', clientRequestId });
});

export default router;
