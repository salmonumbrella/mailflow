import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import express from 'express';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => {
  req.session = { userId: 'owner' }; next();
} }));
import routes from './search.js';
import { query } from '../services/db.js';

describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('search keyset pagination PostgreSQL', () => {
  let database, server, base;
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const page = async (cursor = '', extra = {}) => {
    const response = await fetch(`${base}/?${new URLSearchParams({ q: 'is:unread', limit: 200, cursor, ...extra })}`);
    expect(response.status).toBe(200);
    return response.json();
  };
  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`
      CREATE TEMP TABLE email_accounts (id uuid PRIMARY KEY, user_id text, enabled boolean DEFAULT true,
        include_in_unified_inbox boolean DEFAULT true, name text, email_address text, color text);
      CREATE TEMP TABLE folders (account_id uuid, path text, special_use text, name text);
      CREATE TEMP TABLE messages (id uuid PRIMARY KEY, account_id uuid, uid bigint, folder text DEFAULT 'INBOX',
        message_id text, subject text, from_name text, from_email text, to_addresses jsonb, cc_addresses jsonb,
        in_reply_to text, thread_references text, thread_id text, reply_to jsonb, delivery_addresses jsonb,
        date timestamptz, snippet text, is_read boolean DEFAULT false, is_starred boolean,
        has_attachments boolean, is_deleted boolean DEFAULT false);
      CREATE INDEX ON messages(date DESC);
      CREATE INDEX ON messages(account_id, folder, date DESC) WHERE is_deleted = false;
    `);
    query.mockImplementation((sql, values) => database.query(sql, values));
    const app = express(); app.use('/', routes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await database?.end();
  });
  beforeEach(async () => {
    await database.query('TRUNCATE messages, email_accounts, folders');
    await database.query("INSERT INTO email_accounts(id,user_id) VALUES ($1,'owner'),($2,'owner')", [a, b]);
    query.mockClear();
  });

  it('visits 2000 ties, microsecond boundaries and NULL dates exactly once in canonical order', async () => {
    await database.query(`INSERT INTO messages(id,account_id,date)
      SELECT ('00000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,
        CASE WHEN i % 2 = 0 THEN $1::uuid ELSE $2::uuid END, '2026-10-20 12:00:00.123456+00'
      FROM generate_series(1,2000) i`, [a, b]);
    await database.query(`INSERT INTO messages(id,account_id,date) VALUES
      ($1,$4,'2026-10-20 12:00:00.123457+00'), ($2,$4,'2026-10-20 12:00:00.123455+00'), ($3,$5,NULL)`,
    [id(2001), id(2002), id(2003), a, b]);
    const expected = [id(2001), ...Array.from({ length: 1000 }, (_, i) => id((i + 1) * 2)),
      ...Array.from({ length: 1000 }, (_, i) => id(i * 2 + 1)), id(2002), id(2003)];
    const seen = [];
    let cursor = '';
    do {
      const result = await page(cursor);
      seen.push(...result.messages.map(m => m.id));
      expect(result).toHaveProperty('nextCursor');
      cursor = result.nextCursor;
    } while (cursor && seen.length <= expected.length);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(expected.length);
  });

  it('does not shift older pages after a newer insert and deletion of a seen row', async () => {
    await database.query(`INSERT INTO messages(id,account_id,date) VALUES
      ($1,$5,'2026-10-20 12:00:00.123457+00'), ($2,$5,'2026-10-20 12:00:00.123456+00'),
      ($3,$5,'2026-10-20 12:00:00.123455+00'), ($4,$5,NULL)`, [id(1), id(2), id(3), id(4), a]);
    const first = await page('', { limit: 2 });
    expect(first.messages.map(m => m.id)).toEqual([id(1), id(2)]);
    await database.query('DELETE FROM messages WHERE id=$1', [id(1)]);
    await database.query("INSERT INTO messages(id,account_id,date) VALUES ($1,$2,'2026-10-21')", [id(5), a]);
    const second = await page(first.nextCursor, { limit: 2 });
    expect(second.messages.map(m => m.id)).toEqual([id(3), id(4)]);
    expect(second.nextCursor).toBeNull();
  });

  it('continues within NULL dates and keeps legacy offsets deterministic', async () => {
    await database.query('INSERT INTO messages(id,account_id,date) VALUES ($1,$4,NULL),($2,$5,NULL),($3,$4,now())',
      [id(1), id(2), id(3), a, b]);
    let cursor = '';
    for (const expected of [id(3), id(1), id(2)]) {
      const result = await page(cursor, { limit: 1 });
      expect(result.messages.map(m => m.id)).toEqual([expected]);
      cursor = result.nextCursor;
    }
    expect(cursor).toBeNull();
    const legacy = await fetch(`${base}/?q=is:unread&limit=1&offset=1`);
    expect((await legacy.json()).messages.map(m => m.id)).toEqual([id(1)]);
  });

  it('rejects malformed and changed query/account/folder/mode cursors and rechecks authorization', async () => {
    await database.query('INSERT INTO messages(id,account_id,date) VALUES ($1,$4,now()),($2,$4,now()),($3,$5,NULL)',
      [id(1), id(2), id(3), a, b]);
    const first = await page('', { limit: 1, accountId: a, folder: 'INBOX' });
    expect(typeof first.nextCursor).toBe('string');
    for (const extra of [{ cursor: '!' }, { q: 'is:read' }, { accountId: b }, { folder: 'Archive' }, { mode: 'list' }]) {
      const response = await fetch(`${base}/?${new URLSearchParams({ q: 'is:unread', cursor: first.nextCursor,
        accountId: a, folder: 'INBOX', ...extra })}`);
      expect(response.status).toBe(400);
    }
    const decoded = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString());
    for (const invalid of [{ v: 9 }, { bucket: 'other' }, { date: '2026-02-31T12:00:00.123456Z' },
      { date: '0000-01-01T00:00:00.000000Z' }, { id: 'invalid' }]) {
      const cursor = Buffer.from(JSON.stringify({ ...decoded, ...invalid })).toString('base64url');
      const response = await fetch(`${base}/?${new URLSearchParams({ q: 'is:unread', cursor, accountId: a, folder: 'INBOX' })}`);
      expect(response.status).toBe(400);
    }
    await database.query('UPDATE email_accounts SET enabled=false WHERE id=$1', [a]);
    const response = await fetch(`${base}/?${new URLSearchParams({ q: 'is:unread', cursor: first.nextCursor, accountId: a, folder: 'INBOX' })}`);
    expect(response.status).toBe(400);
    const remaining = await page();
    expect(remaining.messages.map(m => m.id)).toEqual([id(3)]);
  });

  it('walks the existing date index for broad first and next pages with a leading date bound', async () => {
    await database.query(`INSERT INTO messages(id,account_id,date)
      SELECT ('00000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,
        CASE WHEN i%2=0 THEN $1::uuid ELSE $2::uuid END,
        '2026-10-20'::timestamptz - (i/10)*interval '1 second' FROM generate_series(1,2000) i`, [a, b]);
    await database.query('ANALYZE messages; ANALYZE email_accounts; ANALYZE folders');
    const first = await page('', { limit: 50 });
    await page(first.nextCursor, { limit: 50 });
    const searches = query.mock.calls.filter(([sql]) => sql.includes('AS _cursor_date'));
    expect(searches).toHaveLength(2);
    for (const [index, [sql, values]] of searches.entries()) {
      const result = await database.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, values);
      const nodes = [];
      const visit = node => { nodes.push(node); node.Plans?.forEach(visit); };
      visit(result.rows[0]['QUERY PLAN'][0].Plan);
      const scan = nodes.find(node => node['Relation Name'] === 'messages');
      expect(scan['Node Type']).toBe('Index Scan');
      if (index) expect(scan['Index Cond']).toContain('date <=');
    }
  });
});
