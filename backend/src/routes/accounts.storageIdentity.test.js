import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ query: vi.fn(), transactionQuery: vi.fn(), withTransaction: vi.fn(), apply: vi.fn(), status: vi.fn() }));
vi.mock('../services/db.js', () => ({ query: db.query, withTransaction: db.withTransaction }));
vi.mock('../services/messageIdentity.js', () => ({ applyStorageIdentityDecision: db.apply, getIdentityStatus: db.status }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'owner' }; next(); } }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: async () => ({ allowPrivateHosts: true, allowNonstandardPorts: true }) }));
vi.mock('../services/encryption.js', () => ({ encrypt: value => value }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: async () => null }));
import 'express-async-errors';
import express from 'express';
import accountRoutes from './accounts.js';

const ID = '44444444-4444-4444-4444-444444444444';
const GENERATION = '55555555-5555-4555-8555-555555555555';
const NEXT = '66666666-6666-4666-8666-666666666666';
let row, transaction, rejectWrite, events;

describe('account storage identity decisions', () => {
  let server, base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/accounts', accountRoutes);
    app.use((err, _req, res, next) => { void next; res.status(500).json({ error: err.message }); });
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/accounts/${ID}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => {
    row = { id: ID, user_id: 'owner', protocol: 'imap', enabled: false, imap_host: 'imap.example.com', imap_port: 993, auth_user: 'me', oauth_provider: null, email_address: 'me@example.com', storage_generation: GENERATION, auth_pass: 'secret', oauth_refresh_token: 'secret-token' };
    rejectWrite = false;
    events = [];
    const answer = async (sql, params) => {
      events.push(sql);
      if (/^UPDATE email_accounts SET/.test(sql)) {
        if (rejectWrite) throw new Error('Simulated core write failure');
        const fields = sql.match(/SET (.*?) WHERE/s)[1].split(', ').map(part => part.split(' = ')[0]);
        fields.forEach((field, i) => { row[field] = params[i]; });
      }
      return { rows: row ? [{ ...row }] : [] };
    };
    db.query.mockReset().mockImplementation(answer);
    db.transactionQuery.mockReset().mockImplementation(answer);
    transaction = { query: db.transactionQuery };
    db.withTransaction.mockReset().mockImplementation(async fn => {
      const previous = { ...row };
      events.push('BEGIN');
      try { const result = await fn(transaction); events.push('COMMIT'); return result; }
      catch (err) { row = previous; events.push('ROLLBACK'); throw err; }
    });
    db.apply.mockReset().mockImplementation(async (client, { expectedGeneration, decision }) => {
      expect(client).toBe(transaction);
      if (expectedGeneration !== row.storage_generation) throw Object.assign(new Error('Refresh mailbox settings'), { status: 409, code: 'storage_generation_conflict' });
      if (decision === 'replace') row.storage_generation = NEXT;
      events.push(`identity:${decision}`);
      return { storageGeneration: row.storage_generation, replaced: decision === 'replace' };
    });
    db.status.mockReset().mockResolvedValue({ storageGeneration: GENERATION, boundEntityCount: '2', unresolvedEntityCount: '1', unresolvedOperationCount: '0', unverifiedCacheRows: '1', priorGenerationEntityCount: '3' });
  });
  const put = body => fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it.each([{ imap_host: 'other.example.com' }, { imap_port: 1143 }, { auth_user: 'someone-else' }])('refuses an ambiguous selector edit %j without writing', async change => {
    const res = await put(change);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('storage_identity_decision_required');
    expect(events.some(event => /^UPDATE/.test(event))).toBe(false);
    expect(db.apply).not.toHaveBeenCalled();
    expect(events.at(-1)).toBe('ROLLBACK');
  });
  it.each(['preserve', 'replace'])('atomically saves an explicit %s choice and only returns safe fields', async decision => {
    const res = await put({ auth_user: 'other', storageIdentityDecision: decision, expectedStorageGeneration: GENERATION });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.storage_generation).toBe(decision === 'replace' ? NEXT : GENERATION);
    expect(body.auth_user).toBe('other');
    expect(body.auth_pass).toBeUndefined();
    expect(body.oauth_refresh_token).toBeUndefined();
    expect(events.indexOf(`identity:${decision}`)).toBeLessThan(events.findIndex(event => /^UPDATE/.test(event)));
    expect(events.at(-1)).toBe('COMMIT');
  });
  it('rolls back generation replacement if the account write fails', async () => {
    rejectWrite = true;
    const res = await put({ auth_user: 'other', storageIdentityDecision: 'replace', expectedStorageGeneration: GENERATION });
    expect(res.status).toBe(500);
    expect(row.storage_generation).toBe(GENERATION);
    expect(row.auth_user).toBe('me');
    expect(events.at(-1)).toBe('ROLLBACK');
  });
  it.each([undefined, NEXT, 'bad-uuid'])('refuses missing/stale/malformed expected generation %s', async expected => {
    const res = await put({ auth_user: 'other', storageIdentityDecision: 'replace', expectedStorageGeneration: expected });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('storage_generation_conflict');
    expect(events.some(event => /^UPDATE/.test(event))).toBe(false);
  });
  it('CAS rejects stale credentials-only saves as well', async () => {
    const res = await put({ auth_pass: 'new', expectedStorageGeneration: NEXT });
    expect(res.status).toBe(409);
    expect(row.auth_pass).toBe('secret');
  });
  it('does not require a decision for normalized selectors or credential-only refresh', async () => {
    expect((await put({ imap_host: ' IMAP.EXAMPLE.COM. ', imap_port: '993', auth_user: ' me ', auth_pass: 'new', expectedStorageGeneration: GENERATION })).status).toBe(200);
    expect(row.imap_host).toBe('imap.example.com');
    expect(row.auth_user).toBe('me');
    expect(db.apply).not.toHaveBeenCalled();
    expect((await put({ auth_pass: 'another' })).status).toBe(200);
  });
  it('requires the choice for an OAuth delegated mailbox but ignores owned server fields', async () => {
    row.oauth_provider = 'microsoft';
    expect((await put({ imap_host: 'attacker.invalid', auth_pass: 'bad' })).status).toBe(400);
    expect(row.imap_host).toBe('imap.example.com');
    expect((await put({ auth_user: 'shared@example.com' })).status).toBe(409);
    expect((await put({ auth_user: 'shared@example.com', expectedStorageGeneration: GENERATION, storageIdentityDecision: 'replace' })).status).toBe(200);
  });
  it('normalizes the OAuth fallback to the same effective mailbox', async () => {
    row.oauth_provider = 'google'; row.auth_user = null;
    expect((await put({ auth_user: row.email_address, expectedStorageGeneration: GENERATION })).status).toBe(200);
    expect(db.apply).not.toHaveBeenCalled();
  });
  it('rejects invalid choices and generation writes supplied as fields', async () => {
    expect((await put({ auth_user: 'other', storageIdentityDecision: 'maybe' })).status).toBe(400);
    expect((await put({ storage_generation: NEXT })).status).toBe(400);
    expect(row.storage_generation).toBe(GENERATION);
  });
  it('returns owned status counts but no status for an unowned account', async () => {
    const response = await fetch(`${base}/identity-status`);
    expect(response.status).toBe(200);
    expect((await response.json()).priorGenerationEntityCount).toBe('3');
    row = null;
    expect((await fetch(`${base}/identity-status`)).status).toBe(404);
    expect(db.status).toHaveBeenCalledTimes(1);
  });
});
