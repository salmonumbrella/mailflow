import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
import { query } from '../services/db.js';
import { getSavedSplits, putSavedSplits } from './savedSplitsPreferences.js';
import { validateSavedSplits } from '../utils/savedSplits.js';
const split = { id: 's1', label: 'Work', query: 'from:alice is:unread' };
const prefs = { savedSplits: [split], hideEmptySplits: true, savedSplitsRevision: 0 };
const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() });
beforeEach(() => query.mockReset().mockResolvedValue({ rows: [{ id: 'owner' }] }));

describe('saved split persistence', () => {
  it('keeps dependency-free validation identical in frontend and backend', () => {
    expect(readFileSync(new URL('../utils/savedSplits.js', import.meta.url), 'utf8'))
      .toBe(readFileSync(new URL('../../../frontend/src/utils/savedSplits.js', import.meta.url), 'utf8'));
  });
  it('trims bounded definitions while preserving explicit order', () => {
    expect(validateSavedSplits([{ ...split, label: ' Work ', query: ' from:alice ' }])).toEqual([{ ...split, query: 'from:alice' }]);
  });
  it.each([null, {}, 'bad', [null], [{ ...split, id: 'bad id' }], [{ ...split, id: 'x'.repeat(65) }],
    [{ ...split, label: '' }], [{ ...split, label: 'x'.repeat(61) }], [{ ...split, query: 'x'.repeat(501) }],
    [{ ...split, query: 42 }], [{ ...split, query: '\n' }], [split, split], [split, { ...split, id: 's2', label: 'work' }],
    Array.from({ length: 13 }, (_, n) => ({ id: `s${n}`, label: `Name${n}`, query: 'test' }))])('rejects malformed definitions %#', value => {
    expect(validateSavedSplits(value)).toBeNull();
  });
  it('merges just the split subdocument and compares its revision atomically', async () => {
    const res = response(); await putSavedSplits({ session: { userId: 'owner' }, body: prefs }, res);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("COALESCE(preferences, '{}'::jsonb) || $2::jsonb");
    expect(sql).toContain("WHERE id = $1 AND COALESCE((preferences->>'savedSplitsRevision')::bigint, 0) = $3");
    expect(params).toEqual(['owner', JSON.stringify({ ...prefs, savedSplitsRevision: 1 }), 0]);
    expect(res.json).toHaveBeenCalledWith({ ...prefs, savedSplitsRevision: 1 });
  });
  it('returns conflict when a newer editor already saved', async () => {
    query.mockResolvedValue({ rows: [] }); const res = response();
    await putSavedSplits({ session: { userId: 'owner' }, body: prefs }, res); expect(res.status).toHaveBeenCalledWith(409);
  });
  it('requires authentication for reads and writes', async () => {
    for (const handler of [getSavedSplits, putSavedSplits]) { const res = response(); await handler({ body: prefs }, res); expect(res.status).toHaveBeenCalledWith(401); }
    expect(query).not.toHaveBeenCalled();
  });
  it.each([{ ...prefs, hideEmptySplits: 'true' }, { ...prefs, savedSplitsRevision: -1 }, { ...prefs, savedSplitsRevision: 0.5 }, { ...prefs, savedSplitsRevision: 2147483647 }, {}])('rejects invalid envelopes %# before any write', async body => {
    const res = response(); await putSavedSplits({ session: { userId: 'owner' }, body }, res);
    expect(res.status).toHaveBeenCalledWith(400); expect(query).not.toHaveBeenCalled();
  });
  it('reads only the authenticated user and defaults missing preferences', async () => {
    query.mockResolvedValue({ rows: [{ preferences: { theme: 'light' } }] }); const res = response();
    await getSavedSplits({ session: { userId: 'owner' } }, res);
    expect(query.mock.calls[0][1]).toEqual(['owner']);
    expect(res.json).toHaveBeenCalledWith({ savedSplits: [], hideEmptySplits: false, savedSplitsRevision: 0 });
  });
});
