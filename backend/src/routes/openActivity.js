import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { listOpenActivity, messageOpenActivity, recordOpenActivity } from '../services/openActivity.js';
import { OPEN_ACTIVITY_NOTICE, OPEN_ACTIVITY_RETENTION_DAYS, OPEN_TOKEN_RE, OpenActivityError, openActivityOrigin } from '../services/openActivityRules.js';

export const OPEN_ACTIVITY_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// Process-wide caps do not key on an IP or any visitor identifier. Multi-process deployments
// also share the atomic 60-second/token and 1000-load database limits.
export function createOpenActivityPixelHandler({ record = recordOpenActivity, now = Date.now } = {}) {
  let windowStart = 0, attempts = 0, pending = 0;
  const recent = new Map();
  return (req, res) => {
    res.statusCode = 200;
    res.set({
      'Content-Type': 'image/gif', 'Content-Length': String(OPEN_ACTIVITY_GIF.length),
      'Cache-Control': 'no-store, no-cache, max-age=0, must-revalidate',
      'Pragma': 'no-cache', 'Expires': '0', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'",
    });
    res.end(OPEN_ACTIVITY_GIF);
    // No Express path parameter decoding: malformed escapes get the identical harmless image.
    const match = typeof req.url === 'string' && req.url.length === 48 && /^\/([A-Za-z0-9_-]{43})\.gif$/.exec(req.url);
    if (req.method !== 'GET' || !match || !OPEN_TOKEN_RE.test(match[1])) return;
    const time = now();
    if (time - windowStart >= 60_000 || time < windowStart) { windowStart = time; attempts = 0; recent.clear(); }
    if (attempts >= 120 || pending >= 4 || recent.has(match[1])) return;
    attempts++; recent.set(match[1], true); pending++;
    // Reply first, independent of existence or DB timing. Never log bearer tokens/requests.
    Promise.resolve().then(() => record(match[1])).catch(() => {}).finally(() => { pending--; });
  };
}

// Mount BEFORE body parsers, sessions, CSRF, CORS and telemetry, on OPEN_ACTIVITY_PATH.
export const publicOpenActivity = createOpenActivityPixelHandler();
const router = Router();
router.use(requireAuth);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const handle = fn => async (req, res, next) => {
  try { await fn(req, res); }
  catch (error) {
    if (error instanceof OpenActivityError) return res.status(error.status).json({ error: error.message });
    next(error);
  }
};
router.get('/capabilities', (req, res) => res.json({
  available: Boolean(openActivityOrigin()), defaultEnabled: false,
  retentionDays: OPEN_ACTIVITY_RETENTION_DAYS, notice: OPEN_ACTIVITY_NOTICE,
}));
router.get('/', handle(async (req, res) => {
  if (req.query.accountId !== undefined && (typeof req.query.accountId !== 'string' || !req.query.accountId)) {
    throw new OpenActivityError(400, 'Invalid account');
  }
  res.json({ activity: await listOpenActivity(req.session.userId, req.query.accountId || null), notice: OPEN_ACTIVITY_NOTICE });
}));
router.get('/message/:id', handle(async (req, res) => {
  res.json({ activity: await messageOpenActivity(req.session.userId, req.params.id), notice: OPEN_ACTIVITY_NOTICE });
}));
export default router;
