import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PassThrough, Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ pool: null }));
vi.mock('./db.js', () => ({ query: (sql, params) => boundary.pool.query(sql, params) }));
import * as ledger from './invitationLedger.js';
import { restoreBackup, writeBackup } from './backup.js';
const scope = { userId: '11111111-1111-4111-8111-111111111111', accountId: '22222222-2222-4222-8222-222222222222' };
const reserveInvitationResponse = (key, input, now = Date.now(), owner = scope) => ledger.reserveInvitationResponse(key, input, now, owner);
const readInvitationResponse = (key, now = Date.now(), owner = scope) => ledger.readInvitationResponse(key, now, owner);
const updateInvitationResponse = (key, attempt, patch, owner = scope) => ledger.updateInvitationResponse(key, attempt, patch, owner);
const observeInvitationSequence = (key, sequence, cancelled = false, owner = scope) => ledger.observeInvitationSequence(key, sequence, cancelled, owner);
const claimInvitationDelivery = (key, attempt, series, sequence, owner = scope) => ledger.claimInvitationDelivery(key, attempt, series, sequence, owner);
import { invitationKey, parseCalendarInvitation } from './calendarInvitation.js';

const fixture = readFileSync(new URL('./fixtures/invitation.ics', import.meta.url), 'utf8');
const invitation = parseCalendarInvitation(fixture, { accountEmail: 'me@example.test', fromEmail: 'lead@example.test', recipients: ['me@example.test'] });
const key = invitationKey('owner', 'account', invitation);
const request = (extra = {}) => ({ response: 'ACCEPTED', revision: invitation.revision, requestId: randomUUID(), expectedAttemptId: null, ...extra });
const sixMinutes = 360_000;

describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('invitation ledger on disposable PostgreSQL', () => {
  const database = `invitations_${process.pid}_${Date.now()}`;
  let admin;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL }); await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(process.env.MAILFLOW_TEST_DATABASE_URL);
    url.pathname = `/${database}`;
    boundary.pool = new pg.Pool({ connectionString: url.toString(), max: 12 });
    process.env.ENCRYPTION_KEY ||= '42'.repeat(32);
    await boundary.pool.query(`CREATE TABLE users (id UUID PRIMARY KEY);
      CREATE TABLE email_accounts (id UUID PRIMARY KEY, user_id UUID REFERENCES users(id) ON DELETE CASCADE);
      CREATE TABLE schema_migrations (version TEXT PRIMARY KEY);
      INSERT INTO schema_migrations VALUES ('0078_invitation_response_state');
      CREATE TABLE api_tokens (id UUID PRIMARY KEY, user_id UUID REFERENCES users(id) ON DELETE CASCADE);`);
    await boundary.pool.query(readFileSync(new URL('../../migrations/0076_sessions_and_kv_store.sql', import.meta.url), 'utf8'));
    await boundary.pool.query(readFileSync(new URL('../../migrations/0078_invitation_response_state.sql', import.meta.url), 'utf8'));
  });
  afterAll(async () => { await boundary.pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${database}`); await admin?.end(); });
  beforeEach(async () => {
    await boundary.pool.query('TRUNCATE users, email_accounts, invitation_response_state, sessions, kv_store, api_tokens');
    await boundary.pool.query('INSERT INTO users (id) VALUES ($1)', [scope.userId]);
    await boundary.pool.query('INSERT INTO email_accounts (id, user_id) VALUES ($1, $2)', [scope.accountId, scope.userId]);
  });
  it('has one reservation winner across 20 concurrent connections', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => reserveInvitationResponse(key, request())));
    expect(results.filter(result => result.acquired)).toHaveLength(1);
    expect(new Set(results.map(result => result.state.attemptId)).size).toBe(1);
    const { rows: [row] } = await boundary.pool.query('SELECT * FROM invitation_response_state');
    expect(row.expires_at).toBeNull(); expect(row.key).not.toContain('owner');
    expect(row.value).not.toContain('example.test'); expect(row.value).not.toContain('VCALENDAR');
  });
  it('does not expire sent state and deduplicates subsequent attempts', async () => {
    const { state } = await reserveInvitationResponse(key, request());
    await updateInvitationResponse(key, state.attemptId, { phase: 'smtp' });
    await updateInvitationResponse(key, state.attemptId, { status: 'sent' });
    expect((await reserveInvitationResponse(key, request(), Date.now() + 365 * 86400_000)).acquired).toBe(false);
    expect((await readInvitationResponse(key)).status).toBe('sent');
  });
  it('scopes identical invitations to owner and account identity, including a recreated account', async () => {
    const other = { userId: randomUUID(), accountId: randomUUID() };
    const recreated = { ...scope, accountId: randomUUID() };
    await boundary.pool.query('INSERT INTO users VALUES ($1)', [other.userId]);
    for (const owner of [other, recreated]) await boundary.pool.query('INSERT INTO email_accounts VALUES ($1, $2)', [owner.accountId, owner.userId]);
    for (const owner of [scope, other, recreated]) {
      expect((await reserveInvitationResponse(invitationKey(owner.userId, owner.accountId, invitation), request(), Date.now(), owner)).acquired).toBe(true);
    }
    expect((await boundary.pool.query('SELECT * FROM invitation_response_state')).rowCount).toBe(3);
    const ownedKey = invitationKey(scope.userId, scope.accountId, invitation);
    expect(await readInvitationResponse(ownedKey, Date.now(), other)).toBeNull();
    await expect(updateInvitationResponse(ownedKey, 'other-attempt', { status: 'sent' }, other)).rejects.toThrow('could not be saved');
  });
  it('a failed preparation may be retried but its old token can never enter SMTP', async () => {
    const now = Date.now() - sixMinutes;
    const first = await reserveInvitationResponse(key, request(), now);
    expect((await readInvitationResponse(key)).status).toBe('failed');
    const retry = await reserveInvitationResponse(key, request({ expectedAttemptId: first.state.attemptId, retry: true }));
    expect(retry.acquired).toBe(true);
    expect(await updateInvitationResponse(key, first.state.attemptId, { phase: 'smtp' })).toBeNull();
    expect((await updateInvitationResponse(key, retry.state.attemptId, { phase: 'smtp' })).phase).toBe('smtp');
    expect(await updateInvitationResponse(key, retry.state.attemptId, { phase: 'smtp' })).toBeNull();
  });
  it('an interrupted SMTP attempt stays uncertain even with explicit retry and another choice', async () => {
    const first = await reserveInvitationResponse(key, request());
    await updateInvitationResponse(key, first.state.attemptId, { phase: 'smtp' });
    expect((await readInvitationResponse(key, Date.now() + sixMinutes)).status).toBe('uncertain');
    const retry = await reserveInvitationResponse(key, request({ response: 'DECLINED', expectedAttemptId: first.state.attemptId, retry: true }));
    expect(retry.acquired).toBe(false); expect(retry.state.status).toBe('uncertain');
    expect((await updateInvitationResponse(key, first.state.attemptId, { status: 'sent' })).status).toBe('sent');
  });
  it('a late failure never overwrites accepted delivery and an old attempt never overwrites a newer response', async () => {
    const first = await reserveInvitationResponse(key, request());
    await updateInvitationResponse(key, first.state.attemptId, { status: 'sent' });
    expect((await updateInvitationResponse(key, first.state.attemptId, { status: 'failed' })).status).toBe('sent');
    const second = await reserveInvitationResponse(key, request({ response: 'DECLINED', expectedAttemptId: first.state.attemptId }));
    expect(second.state.previousResponse).toBe('ACCEPTED');
    expect(await updateInvitationResponse(key, first.state.attemptId, { status: 'sent' })).toBeNull();
    expect((await readInvitationResponse(key)).response).toBe('DECLINED');
  });
  it('racing changes to an accepted response have one winner', async () => {
    const first = await reserveInvitationResponse(key, request());
    await updateInvitationResponse(key, first.state.attemptId, { status: 'sent' });
    const results = await Promise.all(Array.from({ length: 12 }, () => reserveInvitationResponse(key, request({ response: 'TENTATIVE', expectedAttemptId: first.state.attemptId }))));
    expect(results.filter(result => result.acquired)).toHaveLength(1);
  });
  it('refuses corrupt persisted state rather than clearing a potentially delivered reservation', async () => {
    await boundary.pool.query('INSERT INTO invitation_response_state (key, value, user_id, account_id) VALUES ($1, $2, $3, $4)', [key, '{}', scope.userId, scope.accountId]);
    await expect(reserveInvitationResponse(key, request())).rejects.toThrow('cannot be read');
  });
  it('higher sequences and same-sequence cancellations prevent old requests from being answered', async () => {
    const series = 'invitation_sequence:fixture';
    await observeInvitationSequence(series, 3);
    await observeInvitationSequence(series, 4);
    await expect(observeInvitationSequence(series, 3)).rejects.toThrow('newer');
    await expect(observeInvitationSequence(series, 4, true)).rejects.toThrow('cancelled');
    await expect(observeInvitationSequence(series, 4)).rejects.toThrow('newer');
    await expect(observeInvitationSequence(series, 5)).resolves.toBeUndefined();
  });
  it('atomically fences an SMTP claim behind a newer revision committing concurrently', async () => {
    const series = 'invitation_sequence:concurrent';
    await observeInvitationSequence(series, 3);
    const { state } = await reserveInvitationResponse(key, request());
    const other = await boundary.pool.connect();
    try {
      await other.query('BEGIN');
      await other.query('UPDATE invitation_response_state SET value = $2 WHERE key = $1', [series, '8']);
      const claim = claimInvitationDelivery(key, state.attemptId, series, 3);
      const result = expect(claim).rejects.toThrow('newer');
      await new Promise(resolve => setTimeout(resolve, 30));
      await other.query('COMMIT');
      await result;
      expect((await readInvitationResponse(key)).phase).toBe('prepare');
    } finally { await other.query('ROLLBACK'); other.release(); }
  });
  it.each([6, 9])('atomically fences an occurrence behind master rank %s committing concurrently', async rank => {
    const series = 'invitation_sequence:occurrence', master = 'invitation_sequence:master';
    await observeInvitationSequence(series, 2);
    await ledger.checkInvitationMasterSequence(master, 2, scope);
    const { state } = await reserveInvitationResponse(key, request());
    const other = await boundary.pool.connect();
    try {
      await other.query('BEGIN');
      await other.query('UPDATE invitation_response_state SET value = $2 WHERE key = $1', [master, String(rank)]);
      const claim = ledger.claimInvitationDelivery(key, state.attemptId, series, 2, scope, master);
      const result = expect(claim).rejects.toThrow('meeting series');
      await new Promise(resolve => setTimeout(resolve, 30));
      await other.query('COMMIT');
      await result;
      expect((await readInvitationResponse(key)).phase).toBe('prepare');
    } finally { await other.query('ROLLBACK'); other.release(); }
  });
  it.each([-1, 4, 5, 6])('allows a newer or equal occurrence when master rank %s does not supersede it', async rank => {
    const series = 'invitation_sequence:occurrence', master = 'invitation_sequence:master';
    await observeInvitationSequence(series, 3);
    await ledger.checkInvitationMasterSequence(master, 3, scope);
    await boundary.pool.query('UPDATE invitation_response_state SET value = $2 WHERE key = $1', [master, String(rank)]);
    await ledger.checkInvitationMasterSequence(master, 3, scope);
    const { state } = await reserveInvitationResponse(key, request());
    expect(await ledger.claimInvitationDelivery(key, state.attemptId, series, 3, scope, master)).toMatchObject({ phase: 'smtp' });
    expect((await boundary.pool.query('SELECT value FROM invitation_response_state WHERE key = $1', [master])).rows[0].value).toBe(String(rank));
  });
  it('one atomic send claim wins across racing callers', async () => {
    const series = 'invitation_sequence:claim';
    await observeInvitationSequence(series, 3);
    const { state } = await reserveInvitationResponse(key, request());
    const claims = await Promise.all(Array.from({ length: 8 }, () => claimInvitationDelivery(key, state.attemptId, series, 3)));
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
  it.each(['users', 'email_accounts'])('cascades private response and sequence state when %s is deleted', async table => {
    await reserveInvitationResponse(key, request());
    await observeInvitationSequence('invitation_sequence:fixture', 3);
    await boundary.pool.query(`DELETE FROM ${table} WHERE id = $1`, [table === 'users' ? scope.userId : scope.accountId]);
    expect((await boundary.pool.query('SELECT * FROM invitation_response_state')).rowCount).toBe(0);
  });
  it.each(['setup', 'full'])('%s backup preserves RSVP state without restoring sessions, rate limits or API tokens', async backupScope => {
    const accepted = await reserveInvitationResponse(key, request());
    await updateInvitationResponse(key, accepted.state.attemptId, { status: 'sent' });
    const pending = await reserveInvitationResponse('invitation_response:pending', request());
    await updateInvitationResponse('invitation_response:pending', pending.state.attemptId, { phase: 'smtp' });
    const preparing = await reserveInvitationResponse('invitation_response:preparing', request());
    const failed = await reserveInvitationResponse('invitation_response:failed', request());
    await updateInvitationResponse('invitation_response:failed', failed.state.attemptId, { status: 'failed' });
    await observeInvitationSequence('invitation_sequence:backup', 4);
    await boundary.pool.query("INSERT INTO sessions (sid, sess, user_id, expires_at) VALUES ('secret-session', '{}', $1, NOW() + interval '1 day')", [scope.userId]);
    await boundary.pool.query("INSERT INTO kv_store (key, value) VALUES ('rl:private', '123')");
    await boundary.pool.query('INSERT INTO api_tokens VALUES ($1, $2)', [randomUUID(), scope.userId]);
    const client = await boundary.pool.connect();
    try {
      const output = new PassThrough(), chunks = [];
      output.on('data', chunk => chunks.push(chunk));
      await writeBackup(client, { scope: backupScope, appVersion: 'test', out: output });
      const bytes = Buffer.concat(chunks), lines = gunzipSync(bytes).toString().trim().split('\n').map(line => JSON.parse(line));
      expect(lines[0].tables).toContain('invitation_response_state');
      for (const table of ['sessions', 'kv_store', 'api_tokens']) expect(lines[0].tables).not.toContain(table);
      expect(gunzipSync(bytes).toString()).not.toContain('secret-session');
      await client.query('TRUNCATE invitation_response_state, sessions, kv_store, api_tokens');
      await restoreBackup(client, Readable.from([bytes]));
      expect((await readInvitationResponse(key)).status).toBe('sent');
      for (const name of ['pending', 'preparing', 'failed']) {
        const restored = await readInvitationResponse(`invitation_response:${name}`, Date.now() + sixMinutes);
        expect(restored).toMatchObject({ status: 'uncertain', code: 'restored' });
        expect((await reserveInvitationResponse(`invitation_response:${name}`, request({ expectedAttemptId: restored.attemptId, retry: true }))).acquired).toBe(false);
      }
      await expect(observeInvitationSequence('invitation_sequence:backup', 3)).rejects.toThrow('newer');
      for (const table of ['sessions', 'kv_store', 'api_tokens']) expect((await client.query(`SELECT * FROM ${table}`)).rowCount).toBe(0);
      // jsonb restore normalization changes text spacing; semantic CAS still records late evidence.
      expect((await updateInvitationResponse('invitation_response:preparing', preparing.state.attemptId, { status: 'sent' })).status).toBe('sent');
    } finally { client.release(); }
  });
});
