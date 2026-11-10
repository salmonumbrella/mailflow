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

describe('size search HTTP boundary', () => {
  let server, base;
  beforeAll(async () => {
    const app = express(); app.use('/search', searchRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}/search`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValueOnce({ rows: [{ id: 'owned', include_in_unified_inbox: true }, { id: 'excluded', include_in_unified_inbox: false }] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValue({ rows: [{ has_unknown: true }] });
  });
  it.each(['size:1e6', 'larger:-2', 'size:9007199254740992', 'smaller:0.1B', 'larger:2MiB'])('rejects malformed size as 400 before searching: %s', async q => {
    const response = await fetch(`${base}?${new URLSearchParams({ q })}`);
    expect(response.status).toBe(400);
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('reports partial synchronized-cache coverage outside the match expression and inside owned scope', async () => {
    const response = await fetch(`${base}?${new URLSearchParams({ q: '-larger:2M OR subject:invoice', accountId: 'foreign', folder: 'Archive' })}`);
    expect(response.status).toBe(200);
    expect((await response.json()).sizeIndex).toEqual({ state: 'partial', scope: 'selected-folder-synchronized-cache', providerComplete: false });
    const [sql, values] = query.mock.calls[1];
    expect(sql).toContain('WHERE m.account_id = ANY($1)');
    expect(sql).toContain('AND m.is_deleted = false');
    expect(sql).toContain('ORDER BY m.date DESC, m.id DESC');
    expect(values).toEqual([['owned'], '2097152', '%invoice%', 'Archive', 50, 0]);
    const [coverage, scope] = query.mock.calls[2];
    expect(coverage).toContain('m.rfc822_size_bytes IS NULL');
    expect(coverage).toContain('m.is_deleted = false');
    expect(coverage).not.toContain('ILIKE');
    expect(scope).toEqual([['owned'], 'Archive']);
  });
  it('does not label complete cached metadata as complete provider mail, including later pages', async () => {
    query.mockReset();
    query.mockResolvedValueOnce({ rows: [{ id: 'owned', include_in_unified_inbox: true }, { id: 'excluded', include_in_unified_inbox: false }] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ has_unknown: false }] });
    const response = await fetch(`${base}?${new URLSearchParams({ q: 'size:0', accountId: 'excluded', offset: '50' })}`);
    expect(response.status).toBe(200);
    expect((await response.json()).sizeIndex).toEqual({ state: 'complete-for-cache', scope: 'selected-accounts-synchronized-cache', providerComplete: false });
    expect(query.mock.calls[2][1]).toEqual([['excluded']]);
    expect(query.mock.calls[2][0]).toContain('NOT EXISTS');
  });
});
