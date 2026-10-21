import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

// Dedicated granted test database only. No production credentials or default URL.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('grouped search PostgreSQL', () => {
  let db, writer, server, base;
  const schema = `mf_search_${randomUUID().replaceAll('-', '')}`;
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const request = async (extra = {}, status = 200) => {
    const response = await fetch(`${base}/?${new URLSearchParams({ q: 'is:unread', threaded: 'true', limit: 2, cursor: '', ...extra })}`);
    expect(response.status).toBe(status);
    return response.json();
  };
  const insert = (n, thread, date, account = a, connection = db) => connection.query(
    'INSERT INTO messages(id,account_id,thread_id,date,from_email) VALUES ($1,$2,$3,$4,$5)',
    [id(n), account, thread, date, 'sender@synthetic.test']);
  beforeAll(async () => {
    db = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    writer = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await db.connect(); await writer.connect();
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await writer.query(`SET search_path TO ${schema}`);
    await db.query(`CREATE TABLE email_accounts (id uuid PRIMARY KEY, user_id text, enabled boolean DEFAULT true,
        include_in_unified_inbox boolean DEFAULT true, name text, email_address text, color text);
      CREATE TABLE folders (account_id uuid, path text, special_use text, name text);
      CREATE TABLE messages (id uuid PRIMARY KEY, account_id uuid, uid bigint, folder text DEFAULT 'INBOX',
        message_id text, subject text, from_name text, from_email text, to_addresses jsonb, cc_addresses jsonb,
        in_reply_to text, thread_references text, thread_id text, reply_to jsonb, delivery_addresses jsonb,
        thread_key text GENERATED ALWAYS AS (COALESCE(thread_id,id::text)) STORED,
        date timestamptz, snippet text, body_text text, search_vector tsvector,
        is_read boolean DEFAULT false, is_starred boolean, has_attachments boolean, is_deleted boolean DEFAULT false);
      CREATE INDEX idx_messages_thread_key_lookup ON messages(account_id,thread_key) WHERE is_deleted=false;`);
    await db.query(await readFile(new URL('../../migrations/0072_verified_search_text.sql', import.meta.url), 'utf8'));
    await db.query(await readFile(new URL('../../migrations/0073_search_change_fence.sql', import.meta.url), 'utf8'));
    query.mockImplementation((sql, values) => db.query(sql, values));
    const app = express(); app.use('/', routes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await writer?.query('ROLLBACK');
    await writer?.end();
    if (db) { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.end(); }
  });
  beforeEach(async () => {
    await writer.query('ROLLBACK');
    await db.query('ROLLBACK');
    await db.query('TRUNCATE messages, folders, email_accounts, search_text_chunks, search_text_generations CASCADE');
    await db.query("INSERT INTO email_accounts(id,user_id) VALUES ($1,'owner'),($2,'owner')", [a, b]);
  });

  it('orders by newest match, preserves matched identity and raw nullable reply thread, and keeps flat mode physical', async () => {
    await insert(1, 'T', '2026-10-20'); await insert(2, 'T', '2026-10-22');
    await insert(3, null, '2026-10-21');
    await db.query('UPDATE messages SET is_read=true WHERE id=$1', [id(2)]);
    const grouped = await request();
    expect(grouped.messages.map(m => m.id)).toEqual([id(3), id(1)]);
    expect(grouped.messages[0]).toMatchObject({ matched_message_id: id(3), reply_thread_id: null, thread_id: JSON.stringify([a, id(3)]) });
    expect(grouped.messages[1]).toMatchObject({ reply_thread_id: 'T', thread_id: JSON.stringify([a, 'T']) });
    expect(grouped.messages[0]).not.toHaveProperty('message_count');
    const flat = await request({ threaded: 'false', q: 'from:sender', limit: 10 });
    expect(flat.messages.map(m => m.id)).toEqual([id(2), id(3), id(1)]);
    expect(flat.messages[0].thread_id).toBe('T');
  });

  it('requires all free-text terms on one physical message, including sibling probes', async () => {
    await insert(1, 'T', '2026-10-20'); await insert(2, 'T', '2026-10-21');
    await db.query("UPDATE messages SET body_text=CASE WHEN id=$1 THEN 'orchid' ELSE 'quartz' END", [id(1)]);
    expect((await request({ q: 'orchid quartz' })).messages).toEqual([]);
    await db.query("UPDATE messages SET body_text='orchid quartz' WHERE id=$1", [id(1)]);
    expect((await request({ q: 'orchid quartz' })).messages.map(m => m.id)).toEqual([id(1)]);
  });

  it('does not consume withheld A/B/C lookahead and preserves microseconds', async () => {
    for (let n = 1; n <= 3; n++) await insert(n, String(n), `2026-10-20T12:00:00.12345${7 - n}Z`);
    const first = await request();
    expect(first.messages.map(m => m.id)).toEqual([id(1), id(2)]);
    expect(JSON.parse(Buffer.from(first.nextCursor, 'base64url')).date).toBe('2026-10-20T12:00:00.123455Z');
    expect((await request({ cursor: first.nextCursor })).messages.map(m => m.id)).toEqual([id(3)]);
  });

  it.each([null, '2026-10-20'])('walks unstable same-date candidates across scan bounds and accounts: %s', async date => {
    await insert(100, 'first', '2026-10-23'); await insert(101, 'tail', null);
    const initial = await request({ limit: 1 });
    // Every new candidate is live but invisible to the initial sibling fence.
    for (const account of [a, b]) for (let n = 1; n <= 15; n++) await insert(n + (account === b ? 20 : 0), 'T', date, account);
    let cursor = initial.nextCursor;
    const consumed = [], emitted = [];
    for (let round = 0; cursor && round < 10; round++) {
      const page = await request({ cursor });
      emitted.push(...page.messages.map(m => m.id));
      if (page.nextCursor) consumed.push(JSON.parse(Buffer.from(page.nextCursor, 'base64url')).id);
      cursor = page.nextCursor;
    }
    expect(cursor).toBeNull();
    expect(new Set(consumed).size).toBe(consumed.length);
    expect(emitted).toContain(id(1)); expect(emitted).toContain(id(21)); expect(emitted).toContain(id(101));
    expect(consumed).toEqual(date === null ? [id(12), id(101), id(32)] : [id(12), id(29)]);
    expect(emitted).toEqual(date === null ? [id(1), id(13), id(101), id(21), id(33)] : [id(1), id(13), id(21), id(30), id(101)]);
  });

  it('retains an older match after an invisible transaction commits a newer sibling behind the cursor', async () => {
    await insert(1, 'A', '2026-10-22'); await insert(2, 'T', '2026-10-20');
    await writer.query('BEGIN'); await insert(3, 'T', '2026-10-23', a, writer);
    const first = await request({ limit: 1 });
    await writer.query('COMMIT');
    expect((await request({ cursor: first.nextCursor })).messages.map(m => m.id)).toEqual([id(2)]);
  });

  it('restamps supplied values, savepoints and live generation publication with the top-level xid', async () => {
    await writer.query('BEGIN'); await writer.query('SAVEPOINT nested');
    await insert(1, 'T', '2026-10-20', a, writer);
    await writer.query("UPDATE messages SET search_changed_xid='1'::xid8 WHERE id=$1", [id(1)]);
    const stamp = await writer.query('SELECT search_changed_xid=pg_current_xact_id() AS correct FROM messages');
    expect(stamp.rows[0].correct).toBe(true);
    await writer.query('COMMIT');
    await db.query('BEGIN');
    await db.query("INSERT INTO search_text_generations(id,account_id,source_key) VALUES ($1,$2,'synthetic')", [id(90), a]);
    await db.query('UPDATE messages SET search_generation_id=$1', [id(90)]);
    expect((await db.query('SELECT search_changed_xid=pg_current_xact_id() AS correct FROM messages')).rows[0].correct).toBe(true);
    await db.query('COMMIT');
  });

  it.each(['unread', 'body', 'pointer', 'rethread', 'folder'])('does not let a late %s update hide a still-qualifying older match', async kind => {
    await insert(1, 'A', '2026-10-22'); await insert(2, 'T', '2026-10-20');
    await insert(3, kind === 'rethread' ? 'U' : 'T', '2026-10-23');
    let q = 'is:unread';
    if (kind === 'unread') await db.query('UPDATE messages SET is_read=true WHERE id=$1', [id(3)]);
    if (kind === 'body' || kind === 'pointer') {
      q = 'orchid';
      await db.query("UPDATE messages SET body_text=CASE WHEN id=$1 THEN '' ELSE 'orchid' END", [id(3)]);
    }
    if (kind === 'folder') await db.query("UPDATE messages SET folder='Trash' WHERE id=$1", [id(3)]);
    if (kind === 'rethread') await db.query('UPDATE messages SET is_read=true WHERE id=$1', [id(3)]);
    await db.query("INSERT INTO folders(account_id,path,name,special_use) VALUES ($1,'Trash','Trash','\\Trash')", [a]);
    const first = await request({ limit: 1, q });
    expect(first.messages.map(m => m.id)).toEqual([id(1)]);
    if (kind === 'unread') await db.query('UPDATE messages SET is_read=false WHERE id=$1', [id(3)]);
    if (kind === 'body') await db.query("UPDATE messages SET body_text='orchid' WHERE id=$1", [id(3)]);
    if (kind === 'pointer') {
      await db.query("INSERT INTO search_text_generations(id,account_id,source_key) VALUES ($1,$2,'synthetic')", [id(90), a]);
      await db.query("INSERT INTO search_text_chunks VALUES ($1,0,'orchid',to_tsvector('english','orchid'),to_tsvector('simple','orchid'))", [id(90)]);
      await db.query('UPDATE messages SET search_generation_id=$1 WHERE id=$2', [id(90), id(3)]);
    }
    if (kind === 'rethread') await db.query("UPDATE messages SET thread_id='T',is_read=false WHERE id=$1", [id(3)]);
    if (kind === 'folder') await db.query("UPDATE messages SET folder='INBOX' WHERE id=$1", [id(3)]);
    expect((await request({ cursor: first.nextCursor, q })).messages.map(m => m.id)).toEqual([id(2)]);
  });

  it('handles legacy NULL stamps as stable and refuses forged malformed snapshots', async () => {
    // Represent pre-migration rows without changing the production trigger contract.
    await db.query('ALTER TABLE messages DISABLE TRIGGER messages_search_change_fence');
    try { await insert(1, 'T', '2026-10-22'); await insert(2, 'T', '2026-10-20'); }
    finally { await db.query('ALTER TABLE messages ENABLE TRIGGER messages_search_change_fence'); }
    await insert(3, 'U', null);
    const first = await request({ limit: 1 });
    expect(first.messages.map(m => m.id)).toEqual([id(1)]);
    expect((await request({ cursor: first.nextCursor })).messages.map(m => m.id)).toEqual([id(3)]);
    const token = JSON.parse(Buffer.from(first.nextCursor, 'base64url'));
    const forged = Buffer.from(JSON.stringify({ ...token, snapshot: 'not-a-snapshot' })).toString('base64url');
    expect((await request({ cursor: forged }, 400)).error).toMatch(/refresh required/);
  });

  it('enforces owned enabled explicit accounts, opt-in and cursor scope changes', async () => {
    await insert(1, 'T', '2026-10-20'); await insert(2, 'T', '2026-10-20', b);
    await db.query('UPDATE email_accounts SET include_in_unified_inbox=false WHERE id=$1', [b]);
    expect((await request()).messages.map(m => m.id)).toEqual([id(1)]);
    expect((await request({ accountId: b })).messages.map(m => m.id)).toEqual([id(2)]);
    await request({ accountId: id(99) }, 403);
    await db.query('UPDATE email_accounts SET enabled=false WHERE id=$1', [b]);
    await request({ accountId: b }, 403);
    await insert(3, 'U', '2026-10-19');
    const first = await request({ limit: 1 });
    await request({ cursor: first.nextCursor, mode: 'pane' }, 400);
    await db.query("INSERT INTO folders(account_id,path,name,special_use) VALUES ($1,'Trash','Trash','\\Trash')", [a]);
    await request({ cursor: first.nextCursor }, 400);
    await request({ offset: 1 }, 400);
  });
});
