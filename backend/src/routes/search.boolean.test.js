import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'owner' }; next(); } }));
import express from 'express';
import searchRoutes from './search.js';
import { query } from '../services/db.js';

describe('search expression HTTP boundary', () => {
  let server, base;
  beforeAll(async () => {
    const app = express(); app.use('/search', searchRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}/search`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValueOnce({ rows: [{ id: 'owned', include_in_unified_inbox: true }] }).mockResolvedValue({ rows: [] });
  });
  it('places the entire OR expression inside the ownership/deletion boundary', async () => {
    const response = await fetch(`${base}?${new URLSearchParams({ q: 'from:alice OR from:bob', accountId: 'foreign' })}`);
    expect(response.status).toBe(200);
    const [sql, params] = query.mock.calls[1];
    expect(sql).toContain('AND ((m.from_email ILIKE $2 OR m.from_name ILIKE $2) OR (m.from_email ILIKE $3 OR m.from_name ILIKE $3))');
    expect(sql).toContain('WHERE m.account_id = ANY($1)');
    expect(sql).toContain('AND m.is_deleted = false');
    expect(params).toEqual([['owned'], '%alice%', '%bob%', 50, 0]);
  });
  it.each(['is:important', 'label:work', 'subject:invoice OR', 'after:2026-02-31'])('returns a useful 400 without querying messages for %s', async q => {
    const response = await fetch(`${base}?${new URLSearchParams({ q })}`);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBeTruthy();
    expect(query.mock.calls).toHaveLength(1);
  });
  it('supports bare folder searches with explicit trash inclusion', async () => {
    const response = await fetch(`${base}?q=in:trash`);
    expect(response.status).toBe(200);
    expect(query.mock.calls[1][0]).not.toContain('NOT EXISTS');
    expect(query.mock.calls[1][1]).toEqual([['owned'], 'trash', '%/trash', '\\Trash', 'trash', 50, 0]);
  });
});
