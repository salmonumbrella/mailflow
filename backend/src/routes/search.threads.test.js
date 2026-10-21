import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => {
  req.session = { userId: 'owner' }; next();
} }));
import routes from './search.js';
import { query } from '../services/db.js';

// Route transport/projection only; SQL behavior belongs to the real PostgreSQL file.
describe('grouped search route envelope', () => {
  let server, base, candidateQuery;
  const account = '11111111-1111-4111-8111-111111111111';
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const row = (n, thread = 'T') => ({ id: id(n), account_id: account, thread_id: thread,
    thread_key: thread || id(n), _cursor_date: '2026-10-20T12:00:00.123456Z',
    _snapshot: '10:20:12', from_email: 'sender@synthetic.test', snippet: 'matched', reply_to: [] });
  const request = async extra => {
    const response = await fetch(`${base}/?${new URLSearchParams({ q: 'is:unread', threaded: 'true', limit: 1, cursor: '', ...extra })}`);
    return { status: response.status, data: await response.json() };
  };
  beforeAll(async () => {
    const app = express(); app.use('/', routes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => {
    candidateQuery = vi.fn().mockImplementation(sql => {
      const buckets = [...sql.matchAll(/^\s*AND m\.date IS (NOT )?NULL\b/gm)];
      expect(buckets).toHaveLength(1);
      const undated = buckets[0][1] === undefined;
      const order = sql.match(/^\s*ORDER BY (m\.date DESC, )?m\.account_id, m\.thread_key, m\.id\s*$/m);
      expect(order).not.toBeNull();
      expect(Boolean(order[1])).toBe(!undated);
      return Promise.resolve({ rows: undated
        ? [{ id: null, _snapshot: '10:20:12' }] : [row(1), row(2), row(3, 'U')] });
    });
    query.mockReset().mockImplementation((sql, values) => {
      if (sql.startsWith('SELECT id, include')) return Promise.resolve({ rows: [{ id: account, include_in_unified_inbox: true }] });
      if (sql.startsWith('SELECT account_id, path')) return Promise.resolve({ rows: [] });
      return candidateQuery(sql, values);
    });
  });
  it('projects the matched message and cursor of the last consumed duplicate', async () => {
    const { status, data } = await request();
    expect(status).toBe(200);
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0]).toMatchObject({ id: id(1), matched_message_id: id(1),
      thread_id: JSON.stringify([account, 'T']), reply_thread_id: 'T', snippet: 'matched' });
    expect(data.messages[0]).not.toHaveProperty('message_count');
    expect(data.messages[0]).not.toHaveProperty('_snapshot');
    expect(JSON.parse(Buffer.from(data.nextCursor, 'base64url'))).toMatchObject({ v: 2, id: id(2), snapshot: '10:20:12' });
    expect(data.hasMore).toBe(true);
  });
  it('preserves snapshot when the first dated bucket is empty and retains nullable raw reply id', async () => {
    candidateQuery.mockResolvedValueOnce({ rows: [{ id: null, _snapshot: '10:20:12' }] })
      .mockResolvedValueOnce({ rows: [{ ...row(1, null), _cursor_date: null }] });
    const { data } = await request();
    expect(candidateQuery.mock.calls[1][1]).toContain('10:20:12');
    expect(data.messages[0]).toMatchObject({ reply_thread_id: null, matched_message_id: id(1) });
    expect(data.nextCursor).toBeNull(); expect(data.hasMore).toBe(false);
  });
  it('rejects unowned explicit account selection before candidate lookup', async () => {
    expect((await request({ accountId: id(99) })).status).toBe(403);
    expect(candidateQuery).not.toHaveBeenCalled();
  });
  it('rejects offsets and flat cursors through the refresh-required path', async () => {
    expect((await request({ offset: 0 })).status).toBe(400);
    const flat = Buffer.from(JSON.stringify({ v: 1, id: id(1) })).toString('base64url');
    const { status, data } = await request({ cursor: flat });
    expect(status).toBe(400); expect(data.error).toMatch(/refresh required/);
  });
  it('keeps both terms and trash exclusions correlated to the same sibling alias', async () => {
    await request({ q: 'orchid quartz' });
    const [sql, values] = candidateQuery.mock.calls[0];
    expect(sql).toContain('s.search_generation_id'); expect(sql).toContain('f.account_id = s.account_id');
    expect(sql).toContain('s.from_name ILIKE $2'); expect(sql).toContain('s.from_name ILIKE $4');
    expect(values.slice(1, 5)).toEqual(['%orchid%', 'orchid', '%quartz%', 'quartz']);
    expect(sql).toContain('s.thread_key = m.thread_key');
  });
});
