import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: {} }));
vi.mock('../index.js', () => ({
  imapManager: {
    updateSyncIntervalForUser: vi.fn(),
    updateFolderSyncIntervalForUser: vi.fn(),
  },
}));
vi.mock('../services/encryption.js', () => ({
  decrypt: value => value,
  encrypt: value => value,
}));
vi.mock('../services/pushNotifications.js', () => ({ pushConfigured: false }));
vi.mock('../services/hostValidation.js', () => ({
  validateHost: vi.fn(),
  resolveForConnection: vi.fn(),
}));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn(),
}));
vi.mock('../services/authLimiter.js', () => ({
  authLimiterConfig: { maxRequests: 10, windowMs: 900000 },
}));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/mailer.js', () => ({ sendSystemEmail: vi.fn() }));
vi.mock('./oidc.js', () => ({ buildEndSessionUrl: vi.fn() }));
vi.mock('../services/categorizer.js', () => ({
  invalidateGlobalCategorizationCache: vi.fn(),
}));
vi.mock('../services/kvStore.js', () => ({ kv: {} }));
vi.mock('../services/rateLimiter.js', () => ({
  consume: vi.fn(),
  reset: vi.fn(),
}));

import { query } from '../services/db.js';
import * as auth from './auth.js';
import { csrfGuard } from '../middleware/csrfGuard.js';
import { screenLockGate } from '../middleware/screenLock.js';
import { matchApiTokenRoute } from '../services/apiTokenAllowlist.js';

const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() });
const patch = async (body, session = { userId: 'review-user' }) => {
  const res = response();
  await auth.patchGmailDensityPreference({ session, body }, res);
  return res;
};

beforeEach(() => query.mockReset().mockResolvedValue({ rows: [] }));

describe('density CAS request boundaries (independent regression)', () => {
  it('requires a signed-in user before accessing density', async () => {
    const read = response();
    await auth.getGmailDensityPreference({ session: {} }, read);
    const write = await patch({ gmailDensity: 'compact', expectedRevision: 0 }, {});
    expect(read.status).toHaveBeenCalledWith(401);
    expect(write.status).toHaveBeenCalledWith(401);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([undefined, null, '', 'dense', 'COMPACT', ' compact ', 1, true, {}, []])(
    'rejects invalid density %j before a database operation', async gmailDensity => {
      const res = await patch({ gmailDensity, expectedRevision: 0 });
      expect(res.status).toHaveBeenCalledWith(400);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, '0', -1, 0.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, true, {}, []])(
    'rejects non-incrementable or noninteger revision %j before a database operation', async expectedRevision => {
      const res = await patch({ gmailDensity: 'compact', expectedRevision });
      expect(res.status).toHaveBeenCalledWith(400);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each([
    { gmailDensity: 'compact' },
    { gmailDensityRevision: 0 },
    { gmailDensity: 'compact', gmailDensityRevision: 1 },
  ])('does not permit a generic preference batch to bypass CAS: %j', async fields => {
    const res = response();
    await auth.patchPreferences({ session: { userId: 'review-user' }, body: { theme: 'light', ...fields } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(query).not.toHaveBeenCalled();
  });
});


describe('density route uses existing browser-only security gates', () => {
  it('requires the custom CSRF header for cookie-authenticated PATCH', () => {
    const refused = response(), deniedNext = vi.fn();
    csrfGuard({ method: 'PATCH', get: () => undefined }, refused, deniedNext);
    expect(refused.status).toHaveBeenCalledWith(403);
    expect(deniedNext).not.toHaveBeenCalled();
    const accepted = response(), allowedNext = vi.fn();
    csrfGuard({ method: 'PATCH', get: header => header === 'X-Requested-With' ? 'MailFlow' : undefined }, accepted, allowedNext);
    expect(allowedNext).toHaveBeenCalledOnce();
    expect(accepted.status).not.toHaveBeenCalled();
  });

  it.each(['GET', 'PATCH'])('does not allow a locked session to reach density %s', method => {
    const res = response(), next = vi.fn();
    screenLockGate({ method, session: { locked: true }, originalUrl: '/api/auth/preferences/gmail-density?test=1' }, res, next);
    expect(res.status).toHaveBeenCalledWith(423);
    expect(next).not.toHaveBeenCalled();
  });

  it.each(['GET', 'PATCH'])('does not grant API tokens access to density %s', method => {
    expect(matchApiTokenRoute(method, '/api/auth/preferences/gmail-density')).toBeNull();
  });
});
