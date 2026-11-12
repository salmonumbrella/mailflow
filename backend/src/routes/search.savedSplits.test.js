import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'owner' }; next(); } }));
import routes, { buildSearchConditions } from './search.js';
import { query } from '../services/db.js';
let server, base;
beforeAll(async () => { const app = express(); app.use(routes); await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); }); base = `http://127.0.0.1:${server.address().port}`; });
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
beforeEach(() => query.mockReset());
const split = { id: 'work', label: 'Work', query: 'from:alice -subject:draft' };
function serve(splits = [split], accounts = [{ id: 'main' }, { id: 'excluded', include_in_unified_inbox: false }]) {
  query.mockResolvedValueOnce({ rows: [{ preferences: { savedSplits: splits, savedSplitsRevision: 2 } }] }).mockResolvedValueOnce({ rows: accounts }).mockResolvedValue({ rows: [{ total: 4, unread: 2 }] });
}
it('batches counts using native conditions and owned unified accounts', async () => {
  serve(); const res = await fetch(`${base}/splits`);
  expect(await res.json()).toEqual({ counts: { work: { total: 4, unread: 2 } }, savedSplitsRevision: 2, source: 'synced-cache' });
  expect(query.mock.calls[0][1]).toEqual(['owner']); expect(query.mock.calls[1][1]).toEqual(['owner']);
  const compiled = buildSearchConditions(split.query, ['main'], 'INBOX'); expect(query.mock.calls[2][1]).toEqual(compiled.params);
  for (const condition of compiled.conditions) expect(query.mock.calls[2][0]).toContain(condition);
  expect(query.mock.calls[2][0]).toContain('m.is_deleted = false');
});
it('counts explicitly selected opted-out accounts', async () => { serve(); await fetch(`${base}/splits?accountId=excluded`); expect(query.mock.calls[2][1][0]).toEqual(['excluded']); });
it('never grants foreign account scope', async () => { serve(); await fetch(`${base}/splits?accountId=foreign`); expect(query.mock.calls[2][1][0]).toEqual(['main']); });
it('reports unsupported-only rules as errors, never zero', async () => {
  serve([{ ...split, query: 'has:unknown is:unknown' }]); const data = await (await fetch(`${base}/splits`)).json();
  expect(data.counts.work.error).toMatch(/no supported search conditions/); expect(data.counts.work.total).toBeUndefined(); expect(query).toHaveBeenCalledTimes(2);
});
it('reports genuine empty account scope as zero without a mail query', async () => {
  serve([split], []); const data = await (await fetch(`${base}/splits`)).json(); expect(data.counts.work).toEqual({ total: 0, unread: 0 }); expect(query).toHaveBeenCalledTimes(2);
});
it('preserves native in: and negation semantics', () => {
  const compiled = buildSearchConditions('in:all from:alice -is:read', ['main'], 'INBOX');
  expect(compiled.params).toEqual([['main'], '%alice%']); expect(compiled.conditions.join(' ')).toContain('NOT COALESCE((m.is_read = true), false)'); expect(compiled.conditions.join(' ')).toContain('NOT EXISTS');
});
it('returns visible failure instead of fabricated zero counts', async () => {
  query.mockRejectedValueOnce(new Error('database unavailable')); const res = await fetch(`${base}/splits`); expect(res.status).toBe(500); expect(await res.json()).toHaveProperty('error');
});
