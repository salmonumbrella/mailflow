import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => {
  req.session = { userId: 'owner' }; next();
} }));
import routes from './search.js';
import { query } from '../services/db.js';

// Actual route/response boundary; the manager method is the existing app binding.
// Real predicate qualification is separately covered by the PostgreSQL cases.
describe('search metadata priority route', () => {
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  const foreign = '33333333-3333-4333-8333-333333333333';
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  let app, server, base, accounts, bodyRows, probeRows, probe, priority, releases, errors;
  const row = n => ({ id: id(n), account_id: a, thread_id: 'T', thread_key: 'T',
    date: '2026-10-20', _cursor_date: '2026-10-20T12:00:00.000000Z',
    from_email: 'body-only@synthetic.test', subject: 'different metadata' });
  const request = async extra => {
    const response = await fetch(`${base}/?${new URLSearchParams({ q: 'orchid', cursor: '', ...extra })}`);
    return { status: response.status, data: await response.json() };
  };
  beforeAll(async () => {
    app = express(); app.use('/', routes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => {
    accounts = [{ id: a, include_in_unified_inbox: true }, { id: b, include_in_unified_inbox: false }];
    bodyRows = [row(1)]; probeRows = [{ id: id(2), account_id: a }]; releases = [];
    priority = vi.fn().mockResolvedValue({ changed: 1, deferred: false, reason: null });
    app.set('imapManager', { prioritizeSearchMessages: priority });
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    probe = vi.fn(async () => ({ rows: probeRows }));
    query.mockReset().mockImplementation((sql, values) => {
      if (sql.startsWith('SELECT id, include')) return Promise.resolve({ rows: accounts });
      if (sql.startsWith('SELECT account_id, path')) return Promise.resolve({ rows: [] });
      if (sql.startsWith('/* search metadata priority */')) return probe(sql, values);
      // The flat candidate clause is appended to select's last line; the
      // grouped sibling guard also mentions m.date, so identify the complete
      // candidate clause and cross-check its own ORDER BY, not a line prefix.
      const buckets = [...sql.matchAll(/\bAND m\.date IS (NOT )?NULL(?=\s+(?:AND|ORDER BY))/g)];
      expect(buckets).toHaveLength(1);
      const undated = buckets[0][1] === undefined;
      const grouped = sql.startsWith('WITH fence AS MATERIALIZED (');
      expect(sql).toContain(`ORDER BY ${undated ? '' : 'm.date DESC, '}m.account_id, ${grouped ? 'm.thread_key, ' : ''}m.id`);
      if (grouped) return Promise.resolve({ rows: undated || !bodyRows.length
        ? [{ id: null, _snapshot: '10:20:12' }] : bodyRows.map(row => ({ ...row, _snapshot: '10:20:12' })) });
      return Promise.resolve({ rows: undated ? [] : bodyRows.map(row => {
        const physical = { ...row };
        delete physical.thread_key;
        return physical;
      }) });
    });
  });
  afterEach(async () => {
    releases.forEach(resolve => resolve());
    await new Promise(resolve => setImmediate(resolve));
    errors.mockRestore();
  });
  it.each(['false', 'true'])('prioritizes independent metadata IDs, never response body hits: grouped=%s', async threaded => {
    const { status, data } = await request({ threaded });
    expect(status).toBe(200); expect(data.messages.map(row => row.id)).toEqual([id(1)]);
    await vi.waitFor(() => expect(priority).toHaveBeenCalledWith(a, [id(2)], { userId: 'owner' }));
    expect(priority.mock.calls.flatMap(call => call[1])).not.toContain(id(1));
    expect(Object.keys(data).sort()).toEqual(threaded === 'true'
      ? ['hasMore', 'messages', 'nextCursor', 'query'] : ['messages', 'nextCursor', 'query']);
    const [sql, values] = probe.mock.calls[0];
    expect(sql).toContain('m.account_id = ANY($1)'); expect(values[0]).toEqual([a]);
    expect(sql).toContain('a.user_id = $4 AND a.enabled = true'); expect(values.at(-1)).toBe('owner');
    expect(sql).toContain('m.is_deleted = false'); expect(sql).toContain('f.account_id = m.account_id');
    expect(sql).toContain("$3::text <> ''"); expect(sql).toContain('m.subject ILIKE $2');
    expect(sql).not.toMatch(/body_text|search_vector|search_generation_id|search_text_chunks|pg_visible/);
    expect(sql).toMatch(/ORDER BY m.date DESC NULLS LAST, m.account_id, m.id LIMIT 50$/);
  });
  it('does not infer priority input from empty response rows', async () => {
    bodyRows = [];
    expect((await request()).data.messages).toEqual([]);
    await vi.waitFor(() => expect(priority).toHaveBeenCalledWith(a, [id(2)], { userId: 'owner' }));
  });
  it('retains operator negation and exact/fuzzy folder precedence in the independent probe', async () => {
    await request({ q: 'from:nana to:partner subject:orchid -from:blocked is:unread in:Archive', folder: 'INBOX' });
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
    const [sql, values] = probe.mock.calls[0];
    expect(sql).toContain('NOT COALESCE(((m.from_email ILIKE $5 OR m.from_name ILIKE $5)), false)');
    expect(sql).toContain('m.to_addresses::text ILIKE $3'); expect(sql).toContain('m.is_read = false');
    expect(sql).toContain('(m.folder ILIKE $6 OR m.folder ILIKE $7)');
    expect(values).toEqual([[a], '%nana%', '%partner%', '%orchid%', '%blocked%', 'archive', '%/archive', 'owner']);
  });
  it.each(['is:unread', '-orchid', 'orchid -quartz', 'in:Archive', 'x'])('does not broaden a query without a safe positive metadata probe: %s', async q => {
    expect((await request({ q })).status).toBe(200);
    await new Promise(resolve => setImmediate(resolve));
    expect(probe).not.toHaveBeenCalled(); expect(priority).not.toHaveBeenCalled();
  });
  it('rejects an unowned explicit account before any probe or manager call', async () => {
    expect((await request({ threaded: 'true', accountId: foreign })).status).toBe(403);
    expect(probe).not.toHaveBeenCalled(); expect(priority).not.toHaveBeenCalled();
  });
  it('caps at 50 distinct physical IDs and never passes a probe row outside captured authorized scope', async () => {
    accounts[1].include_in_unified_inbox = true;
    probeRows = [{ id: id(999), account_id: foreign }, ...Array.from({ length: 60 }, (_, n) =>
      ({ id: id(n + 10), account_id: n % 2 ? a : b }))];
    expect((await request()).status).toBe(200);
    await vi.waitFor(() => expect(priority).toHaveBeenCalledTimes(2));
    const ids = priority.mock.calls.flatMap(call => call[1]);
    expect(ids).toHaveLength(50); expect(new Set(ids).size).toBe(50); expect(ids).not.toContain(id(999));
    expect(priority.mock.calls.every(([account, ids, opts]) => [a, b].includes(account) && ids.length <= 50 && opts.userId === 'owner')).toBe(true);
  });
  it('honors explicit selection of an owned opted-out account', async () => {
    probeRows = [{ id: id(2), account_id: b }];
    bodyRows = [{ ...row(1), account_id: b }];
    expect((await request({ accountId: b })).status).toBe(200);
    await vi.waitFor(() => expect(priority).toHaveBeenCalledWith(b, [id(2)], { userId: 'owner' }));
    expect(probe.mock.calls[0][1][0]).toEqual([b]);
  });
  it.each(['probe', 'manager'])('keeps a %s rejection detached from the successful response', async kind => {
    const error = new Error(`synthetic ${kind} refusal`);
    if (kind === 'probe') probe.mockRejectedValue(error); else priority.mockRejectedValue(error);
    expect((await request()).status).toBe(200);
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith('Search priority failed:', error.message));
    expect(probe).toHaveBeenCalledOnce();
    expect(priority).toHaveBeenCalledTimes(kind === 'probe' ? 0 : 1);
  });
  it.each(['probe', 'manager'])('returns HTTP without waiting on the held %s chain', async kind => {
    const gate = new Promise(resolve => releases.push(resolve));
    if (kind === 'probe') probe.mockImplementation(async () => { await gate; return { rows: probeRows }; });
    else priority.mockImplementation(async () => { await gate; return { changed: 0, deferred: true, reason: 'busy' }; });
    let response;
    const issued = request().then(value => { response = value; });
    await vi.waitFor(() => expect(response?.status).toBe(200));
    expect(probe).toHaveBeenCalledOnce();
    if (kind === 'probe') expect(priority).not.toHaveBeenCalled();
    else expect(priority).toHaveBeenCalledOnce();
    releases[0](); await issued;
  });
  it('does not invent a manager binding when the existing app instance has not been composed', async () => {
    app.set('imapManager', undefined);
    expect((await request()).status).toBe(200);
    expect(probe).not.toHaveBeenCalled(); expect(priority).not.toHaveBeenCalled();
  });
});
