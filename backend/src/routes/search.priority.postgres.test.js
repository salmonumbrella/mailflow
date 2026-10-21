import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import express from 'express';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => {
  req.session = { userId: 'owner' }; next();
} }));
import routes from './search.js';
import { query } from '../services/db.js';

// Dedicated synthetic granted DB only. This exercises the actual route SQL;
// m87r owns actual lifecycle/job-priority integration and its independent proofs.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('metadata priority PostgreSQL', () => {
  const schema = `mf_search_priority_${randomUUID().replaceAll('-', '')}`;
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  const c = '33333333-3333-4333-8333-333333333333';
  const d = '44444444-4444-4444-8444-444444444444';
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  let db, app, server, base, priority, probes;
  const request = async extra => {
    const response = await fetch(`${base}/?${new URLSearchParams({ q: 'orchid', cursor: '', limit: 200, ...extra })}`);
    expect(response.status).toBe(200); return response.json();
  };
  const insert = (n, subject, body = '', account = a, folder = 'INBOX') => db.query(
    `INSERT INTO messages(id,account_id,folder,subject,body_text,date,from_email)
      VALUES ($1,$2,$3,$4,$5,'2026-10-20','sender@synthetic.test')`, [id(n), account, folder, subject, body]);
  beforeAll(async () => {
    db = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await db.connect(); await db.query(`CREATE SCHEMA ${schema}`); await db.query(`SET search_path TO ${schema}`);
    await db.query(`CREATE TABLE email_accounts (id uuid PRIMARY KEY, user_id text, enabled boolean DEFAULT true,
        include_in_unified_inbox boolean DEFAULT true, name text, email_address text, color text);
      CREATE TABLE folders (account_id uuid, path text, special_use text, name text);
      CREATE TABLE messages (id uuid PRIMARY KEY, account_id uuid, uid bigint, folder text DEFAULT 'INBOX',
        message_id text, subject text, from_name text, from_email text, to_addresses jsonb, cc_addresses jsonb,
        in_reply_to text, thread_references text, thread_id text, reply_to jsonb, delivery_addresses jsonb,
        thread_key text GENERATED ALWAYS AS (COALESCE(thread_id,id::text)) STORED,
        date timestamptz, snippet text, body_text text, search_vector tsvector,
        is_read boolean DEFAULT false, is_starred boolean, has_attachments boolean, is_deleted boolean DEFAULT false);`);
    await db.query(await readFile(new URL('../../migrations/0072_verified_search_text.sql', import.meta.url), 'utf8'));
    await db.query(await readFile(new URL('../../migrations/0073_search_change_fence.sql', import.meta.url), 'utf8'));
    query.mockImplementation((sql, values) => {
      const pending = db.query(sql, values);
      if (sql.startsWith('/* search metadata priority */')) probes.push(pending);
      return pending;
    });
    app = express(); app.use('/', routes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (db) { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.end(); }
  });
  beforeEach(async () => {
    probes = []; priority = vi.fn().mockResolvedValue({ changed: 1, deferred: false, reason: null });
    app.set('imapManager', { prioritizeSearchMessages: priority });
    await db.query('TRUNCATE messages,folders,email_accounts,search_text_chunks,search_text_generations CASCADE');
    await db.query("INSERT INTO email_accounts(id,user_id) VALUES ($1,'owner'),($2,'owner'),($3,'owner'),($4,'other')", [a,b,c,d]);
    await db.query('UPDATE email_accounts SET include_in_unified_inbox=false WHERE id=$1', [b]);
    await db.query('UPDATE email_accounts SET enabled=false WHERE id=$1', [c]);
  });
  afterEach(async () => {
    await Promise.all(probes);
    await new Promise(resolve => setImmediate(resolve));
    app.set('imapManager', undefined);
  });
  it.each(['false', 'true'])('keeps metadata priority separate from a real body-only result: grouped=%s', async threaded => {
    await insert(1, 'orchid'); await insert(2, 'other metadata', 'orchid');
    const result = await request({ threaded });
    expect(result.messages.map(row => row.id)).toEqual([id(1),id(2)]);
    await vi.waitFor(() => expect(priority).toHaveBeenCalledWith(a, [id(1)], { userId: 'owner' }));
    expect(priority).toHaveBeenCalledOnce();
    expect(priority.mock.calls.flatMap(call => call[1])).not.toContain(id(2));
  });
  it('requires every positive term on the physical metadata row instead of using a partly-body-qualified result', async () => {
    await insert(1, 'orchid', 'quartz');
    expect((await request({ q: 'orchid quartz' })).messages.map(row => row.id)).toEqual([id(1)]);
    await vi.waitFor(() => expect(probes).toHaveLength(1));
    await Promise.all(probes); await new Promise(resolve => setImmediate(resolve));
    expect(priority).not.toHaveBeenCalled();
    await insert(2, 'orchid quartz');
    await request({ q: 'orchid quartz' });
    await vi.waitFor(() => expect(priority).toHaveBeenCalledWith(a, [id(2)], { userId: 'owner' }));
  });
  it('uses the same all-folder Trash exclusion and explicit in-folder exception as search', async () => {
    await insert(1, 'orchid', '', a, 'Trash');
    await insert(2, 'orchid', '', a, 'Deleted Items');
    await insert(3, 'orchid', '', a, 'Archive');
    await db.query("INSERT INTO folders VALUES ($1,'Trash','\\Trash','Trash'),($1,'Deleted Items',NULL,'Deleted Items')", [a]);
    expect((await request()).messages.map(row => row.id)).toEqual([id(3)]);
    await vi.waitFor(() => expect(priority).toHaveBeenCalledWith(a, [id(3)], { userId: 'owner' }));
    expect((await request({ q: 'orchid in:Trash', folder: 'Archive' })).messages.map(row => row.id)).toEqual([id(1)]);
    await vi.waitFor(() => expect(priority).toHaveBeenCalledWith(a, [id(1)], { userId: 'owner' }));
  });
  it('caps the live authorized scope at 50 and preserves explicit opted-out-account selection', async () => {
    for (let n = 1; n <= 55; n++) await insert(n, 'orchid');
    await insert(60, 'orchid', '', a, 'Trash'); await insert(61, 'orchid', '', b);
    await insert(62, 'orchid', '', c); await insert(63, 'orchid', '', d); await insert(64, 'orchid');
    await db.query('UPDATE messages SET is_deleted=true WHERE id=$1', [id(64)]);
    await db.query("INSERT INTO folders VALUES ($1,'Trash','\\Trash','Deleted Items')", [a]);
    const result = await request();
    for (const forbidden of [60, 61, 62, 63, 64]) expect(result.messages.map(row => row.id)).not.toContain(id(forbidden));
    await vi.waitFor(() => expect(priority).toHaveBeenCalledOnce());
    expect(priority.mock.calls[0]).toEqual([a, Array.from({ length: 50 }, (_, n) => id(n + 1)), { userId: 'owner' }]);
    await request({ accountId: b });
    await vi.waitFor(() => expect(priority).toHaveBeenCalledWith(b, [id(61)], { userId: 'owner' }));
    const hinted = priority.mock.calls.flatMap(call => call[1]);
    for (const forbidden of [60, 62, 63, 64]) expect(hinted).not.toContain(id(forbidden));
  });
});
