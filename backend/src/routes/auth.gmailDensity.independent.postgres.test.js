import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
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
import { getGmailDensityPreference, patchGmailDensityPreference, patchPreferences } from './auth.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const baseline = { theme: 'dracula', font: 'system', layout: 'gmail', pageSize: '50',
  shortcuts: { archive: 'e' }, enabledPlugins: ['gtd'], composeDefaultFullscreen: true };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() });
const bodyOf = res => res.json.mock.calls.at(-1)?.[0];

// A private schema lets independent connections exercise actual row-lock/CAS behavior.
// It is created and removed only in the explicitly supplied disposable test database.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('density CAS ordering on PostgreSQL (independent regression)', () => {
  const context = new AsyncLocalStorage();
  const schema = `density_cas_review_${process.pid}_${Math.random().toString(16).slice(2)}`;
  const clients = [];
  beforeAll(async () => {
    for (let index = 0; index < 3; index++) {
      const client = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
      await client.connect();
      clients.push(client);
      await client.query('SET statement_timeout TO 5000');
    }
    await clients[0].query(`CREATE SCHEMA ${schema}`);
    for (const client of clients) await client.query(`SET search_path TO ${schema}`);
    await clients[0].query('CREATE TABLE users (id uuid PRIMARY KEY, preferences jsonb NOT NULL)');
  });
  afterAll(async () => {
    for (const client of clients) await client.query('ROLLBACK').catch(() => {});
    if (clients[0]) await clients[0].query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await Promise.all(clients.map(client => client.end()));
  });
  beforeEach(async () => {
    await clients[0].query('TRUNCATE users');
    await clients[0].query('INSERT INTO users VALUES ($1, $3::jsonb), ($2, $3::jsonb)', [USER, OTHER, JSON.stringify(baseline)]);
    query.mockReset().mockImplementation(async (sql, params) => {
      const request = context.getStore() || {};
      await request.beforeQuery?.(sql, params);
      return (request.client || clients[0]).query(sql, params);
    });
  });
  const current = async (id = USER) => (await clients[0].query('SELECT preferences FROM users WHERE id = $1', [id])).rows[0].preferences;
  const patch = async (gmailDensity, expectedRevision, options = {}) => {
    const res = options.res || response();
    await context.run(options, () => patchGmailDensityPreference({ session: { userId: options.userId || USER }, body: { gmailDensity, expectedRevision } }, res));
    return res;
  };
  const read = async (id = USER) => {
    const res = response();
    await getGmailDensityPreference({ session: { userId: id } }, res);
    return res;
  };

  it('initializes an absent revision and only changes this user density fields', async () => {
    expect(bodyOf(await read())).toEqual({ gmailDensity: 'default', gmailDensityRevision: 0 });
    const res = await patch('compact', 0);
    expect(bodyOf(res)).toEqual({ ok: true, gmailDensity: 'compact', gmailDensityRevision: 1 });
    expect(await current()).toEqual({ ...baseline, gmailDensity: 'compact', gmailDensityRevision: 1 });
    expect(await current(OTHER)).toEqual(baseline);
    const unrelated = response();
    await patchPreferences({ session: { userId: USER }, body: { theme: 'light' } }, unrelated);
    expect(bodyOf(unrelated)).toEqual({ ok: true });
    expect(await current()).toEqual({ ...baseline, theme: 'light', gmailDensity: 'compact', gmailDensityRevision: 1 });
  });

  it('rejects an old page write that arrives after the newer page has saved', async () => {
    const reached = deferred(), release = deferred();
    const older = patch('comfortable', 0, { client: clients[1], beforeQuery: async sql => {
      if (/^\s*UPDATE/i.test(sql)) { reached.resolve(); await release.promise; }
    } });
    await reached.promise;
    try {
      const newer = await patch('compact', 0, { client: clients[2] });
      expect(bodyOf(newer)).toEqual({ ok: true, gmailDensity: 'compact', gmailDensityRevision: 1 });
    } finally { release.resolve(); }
    const stale = await older;
    expect(stale.status).toHaveBeenCalledWith(409);
    expect(bodyOf(stale)).toMatchObject({ code: 'gmail_density_conflict', gmailDensity: 'compact', gmailDensityRevision: 1 });
    expect(await current()).toEqual({ ...baseline, gmailDensity: 'compact', gmailDensityRevision: 1 });
  });

  it('fences a request whose browser promise rejected before its database write ran', async () => {
    const reached = deferred(), release = deferred();
    const stillRunningOnServer = patch('comfortable', 0, { client: clients[1], beforeQuery: async sql => {
      if (/^\s*UPDATE/i.test(sql)) { reached.resolve(); await release.promise; }
    } });
    await reached.promise;
    // Losing the transport does not cancel the server handler. The client releases its
    // own queue, so the latest intent can reach PostgreSQL before the detached request.
    const browserRequest = Promise.reject(new Error('transport closed'));
    await expect(browserRequest).rejects.toThrow('transport closed');
    try {
      expect(bodyOf(await patch('compact', 0, { client: clients[2] }))).toMatchObject({ ok: true, gmailDensityRevision: 1 });
    } finally { release.resolve(); }
    expect((await stillRunningOnServer).status).toHaveBeenCalledWith(409);
    expect(await current()).toEqual({ ...baseline, gmailDensity: 'compact', gmailDensityRevision: 1 });
  });

  it('recovers a committed write whose acknowledgement was lost without trusting its old revision', async () => {
    const disconnected = response();
    disconnected.json.mockImplementation(() => { throw new Error('response transport lost'); });
    await expect(patch('comfortable', 0, { res: disconnected })).rejects.toThrow('response transport lost');
    expect(await current()).toEqual({ ...baseline, gmailDensity: 'comfortable', gmailDensityRevision: 1 });
    const conflict = await patch('compact', 0);
    expect(conflict.status).toHaveBeenCalledWith(409);
    const recovered = await patch('compact', bodyOf(conflict).gmailDensityRevision);
    expect(bodyOf(recovered)).toEqual({ ok: true, gmailDensity: 'compact', gmailDensityRevision: 2 });
    expect(await current()).toEqual({ ...baseline, gmailDensity: 'compact', gmailDensityRevision: 2 });
  });

  it('rechecks the revision after waiting for a competing transaction to commit', async () => {
    await clients[1].query('BEGIN');
    let contender;
    try {
      expect(bodyOf(await patch('comfortable', 0, { client: clients[1] }))).toMatchObject({ ok: true, gmailDensityRevision: 1 });
      const reached = deferred();
      contender = patch('compact', 0, { client: clients[2], beforeQuery: sql => {
        if (/^\s*UPDATE/i.test(sql)) reached.resolve();
      } });
      await reached.promise;
      const pid = clients[2].processID;
      let locked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await clients[0].query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid]);
        if (result.rows[0]?.wait_event_type === 'Lock') { locked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(locked, 'the second CAS must actually wait on the first transaction row lock').toBe(true);
    } finally { await clients[1].query('COMMIT'); }
    const conflict = await contender;
    expect(conflict.status).toHaveBeenCalledWith(409);
    expect(bodyOf(conflict)).toMatchObject({ gmailDensity: 'comfortable', gmailDensityRevision: 1 });
    expect(bodyOf(await patch('compact', bodyOf(conflict).gmailDensityRevision))).toMatchObject({ ok: true, gmailDensity: 'compact', gmailDensityRevision: 2 });
    expect(await current()).toEqual({ ...baseline, gmailDensity: 'compact', gmailDensityRevision: 2 });
  });

  it('requires a new successful CAS even when the requested value already matches', async () => {
    const first = await patch('compact', 0);
    const second = await patch('compact', bodyOf(first).gmailDensityRevision);
    expect(bodyOf(second)).toEqual({ ok: true, gmailDensity: 'compact', gmailDensityRevision: 2 });
    const old = await patch('comfortable', 1);
    expect(old.status).toHaveBeenCalledWith(409);
    expect(await current()).toEqual({ ...baseline, gmailDensity: 'compact', gmailDensityRevision: 2 });
  });

  it('blocks unversioned generic writes without changing another key from the rejected batch', async () => {
    await patch('compact', 0);
    for (const fields of [{ gmailDensity: 'comfortable' }, { gmailDensityRevision: 0 }]) {
      const res = response();
      await patchPreferences({ session: { userId: USER }, body: { theme: 'light', ...fields } }, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(await current()).toEqual({ ...baseline, gmailDensity: 'compact', gmailDensityRevision: 1 });
    }
  });

  it('returns the terminal safe revision accurately and rejects attempts to increment it', async () => {
    await clients[0].query('UPDATE users SET preferences = preferences || $2::jsonb WHERE id = $1',
      [USER, JSON.stringify({ gmailDensityRevision: Number.MAX_SAFE_INTEGER - 1 })]);
    expect(bodyOf(await patch('compact', Number.MAX_SAFE_INTEGER - 1))).toEqual({
      ok: true, gmailDensity: 'compact', gmailDensityRevision: Number.MAX_SAFE_INTEGER,
    });
    expect(bodyOf(await read())).toEqual({ gmailDensity: 'compact', gmailDensityRevision: Number.MAX_SAFE_INTEGER });
    query.mockClear();
    expect((await patch('comfortable', Number.MAX_SAFE_INTEGER)).status).toHaveBeenCalledWith(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns404 rather than success or a misleading conflict for a deleted user', async () => {
    await clients[0].query('DELETE FROM users WHERE id = $1', [USER]);
    expect((await read()).status).toHaveBeenCalledWith(404);
    expect((await patch('compact', 0)).status).toHaveBeenCalledWith(404);
  });
});
