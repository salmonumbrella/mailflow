import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

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
import { patchPreferences, patchGmailDensityPreference } from './auth.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const baseline = { gmailDensity: 'comfortable', theme: 'dracula', font: 'system', layout: 'gmail',
  pageSize: '50', shortcuts: { archive: 'e' }, enabledPlugins: ['gtd'], composeDefaultFullscreen: true };

// Connection-local tables in an explicitly supplied disposable database; no migrations or
// real user rows are needed to exercise the exact preference merge statement.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('Gmail density preference merge on PostgreSQL', () => {
  let client;
  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await client.connect();
    await client.query('CREATE TEMP TABLE users (id uuid PRIMARY KEY, preferences jsonb NOT NULL)');
  });
  afterAll(async () => { await client?.end(); });
  beforeEach(async () => {
    await client.query('TRUNCATE users');
    await client.query('INSERT INTO users VALUES ($1, $3::jsonb), ($2, $3::jsonb)', [USER, OTHER, JSON.stringify(baseline)]);
    query.mockReset().mockImplementation((...args) => client.query(...args));
  });
  const current = async (id = USER) => (await client.query('SELECT preferences FROM users WHERE id = $1', [id])).rows[0].preferences;
  const patch = async (body, versioned = true) => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await (versioned ? patchGmailDensityPreference : patchPreferences)({ session: { userId: USER }, body }, res);
    return res;
  };
  it.each(['default', 'comfortable', 'compact'])('stores %s without changing other preferences or another user', async gmailDensity => {
    const res = await patch({ gmailDensity, expectedRevision: 0 });
    expect(res.json).toHaveBeenCalledWith({ ok: true, gmailDensity, gmailDensityRevision: 1 });
    expect(await current()).toEqual({ ...baseline, gmailDensity, gmailDensityRevision: 1 });
    expect(await current(OTHER)).toEqual(baseline);
  });
  it('preserves density when an independent preference is changed', async () => {
    await patch({ pageSize: '25' }, false);
    expect(await current()).toEqual({ ...baseline, pageSize: '25' });
  });
  it('rejects malformed density before applying any key in the batch', async () => {
    const res = await patch({ gmailDensity: 'dense', theme: 'light' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(query).not.toHaveBeenCalled();
    expect(await current()).toEqual(baseline);
  });
});
