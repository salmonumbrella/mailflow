import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));

import * as search from './search.js';

const account = '11111111-1111-4111-8111-111111111111';
const otherAccount = '22222222-2222-4222-8222-222222222222';
const scope = 'a'.repeat(64);
const pack = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const row = (id, thread, accountId = account) => ({
  id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
  account_id: accountId,
  thread_key: thread,
  _cursor_date: '2026-10-20T12:00:00.123456Z',
});
const grouped = overrides => ({
  v: 2, type: 'grouped', scope, bucket: 'dated', id: row(1, 'T').id,
  date: '2026-10-20T12:00:00.123456Z', accountId: account,
  threadKey: '<thread@synthetic.test>', snapshot: '10:20:12,15', ...overrides,
});
const decodeGrouped = cursor => search.decodeSearchCursor(cursor, scope, { mode: 'grouped' });
const page = (candidates, limit, exhausted = true) =>
  search.collectGroupedSearchPage(candidates, { limit, exhausted });

describe('grouped cursor envelope', () => {
  it('keeps the flat 2048-byte cap', () => {
    const valid = { v: 1, scope, bucket: 'undated', date: null,
      accountId: account, id: row(1, 'A').id };
    expect(search.decodeSearchCursor(pack(valid), scope)).toEqual(valid);
    const cursor = pack({ ...valid, padding: 'x'.repeat(2048) });
    expect(cursor.length).toBeGreaterThan(2048);
    expect(() => search.decodeSearchCursor(cursor, scope)).toThrow(/^Invalid search cursor$/);
  });

  it('accepts a grouped snapshot near its byte cap without truncating precision', () => {
    const snapshot = `1:1000000:${Array.from({ length: 700 }, (_, i) => i + 2).join(',')}`;
    const expected = grouped({ snapshot });
    const cursor = pack(expected);
    expect(cursor.length).toBeGreaterThan(2048);
    expect(cursor.length).toBeLessThanOrEqual(6144);
    expect(Buffer.byteLength(snapshot)).toBeLessThanOrEqual(4096);
    expect(decodeGrouped(cursor)).toEqual(expected);
  });

  it.each([undefined, null, '', 'not-a-uuid'])('rejects absent or malformed physical boundary id: %s', id => {
    expect(decodeGrouped(pack(grouped()))).toEqual(grouped());
    expect(() => decodeGrouped(pack(grouped({ id })))).toThrow(/^Invalid search cursor; refresh required$/);
  });

  it('rejects an oversized grouped envelope', () => {
    const cursor = pack(grouped({ threadKey: 'x'.repeat(6144) }));
    expect(cursor.length).toBeGreaterThan(6144);
    expect(() => decodeGrouped(cursor)).toThrow(/refresh/i);
  });

  it('rejects an oversized snapshot even inside the grouped envelope cap', () => {
    const snapshot = `1:1000000:${'2,'.repeat(2044)}3`;
    const cursor = pack(grouped({ snapshot }));
    expect(Buffer.byteLength(snapshot)).toBeGreaterThan(4096);
    expect(cursor.length).toBeLessThan(6144);
    expect(() => decodeGrouped(cursor)).toThrow(/refresh/i);
  });

  it.each([
    { v: 1, type: 'grouped' }, { v: 2, type: 'flat' }, { v: 3, type: 'grouped' },
  ])('rejects version/type confusion: %j', overrides => {
    expect(() => decodeGrouped(pack(grouped(overrides)))).toThrow(/refresh/i);
  });

  it('rejects a grouped token on the flat path and a changed scope', () => {
    expect(() => search.decodeSearchCursor(pack(grouped()), scope)).toThrow(/^Invalid search cursor$/);
    expect(() => decodeGrouped(pack(grouped({ scope: 'b'.repeat(64) })))).toThrow(/refresh/i);
  });

  it.each(['', 'not-a-snapshot', '1:2:3:not-valid', '1:2:é'])('rejects malformed snapshot %j', snapshot => {
    expect(() => decodeGrouped(pack(grouped({ snapshot })))).toThrow(/refresh/i);
  });

  it.each([null, '2026-10-20T12:00:00.123456Z'])('round-trips dated and NULL boundaries: %s', date => {
    const boundary = { ...row(1, '<thread@synthetic.test>'), _cursor_date: date };
    const cursor = search.encodeSearchCursor(boundary, scope, { mode: 'grouped', snapshot: '10:20:12,15' });
    expect(decodeGrouped(cursor)).toEqual(grouped({ date, bucket: date === null ? 'undated' : 'dated' }));
  });
});

describe('bounded grouped candidate consumption', () => {
  it('does not consume the withheld third group at limit two', () => {
    const candidates = [row(1, 'A'), row(2, 'B'), row(3, 'C')];
    const first = page(candidates, 2);
    expect(first.messages).toEqual(candidates.slice(0, 2));
    expect(first.lastConsumed).toEqual(candidates[1]);
    expect(first.hasMore).toBe(true);
    const second = page(candidates.slice(2), 2);
    expect(second.messages).toEqual([candidates[2]]);
    expect(second.hasMore).toBe(false);
  });

  it('consumes an interleaved duplicate without skipping the next distinct group', () => {
    const candidates = [row(1, 'A'), row(2, 'B'), row(3, 'A'), row(4, 'C')];
    const first = page(candidates, 2);
    expect(first.messages).toEqual(candidates.slice(0, 2));
    expect(first.lastConsumed).toEqual(candidates[2]);
    expect(first.hasMore).toBe(true);
    expect(page(candidates.slice(3), 2).messages).toEqual([candidates[3]]);
  });

  it('emits one representative when unstable and stable siblings both pass the database guard', () => {
    const unstable = row(3, 'T');
    const stable = row(2, 'T');
    const next = row(4, 'U');
    expect(page([unstable, stable, next], 2).messages).toEqual([unstable, next]);
  });

  it('retains identical thread keys from different accounts', () => {
    const candidates = [row(1, 'same', account), row(2, 'same', otherAccount)];
    expect(page(candidates, 2).messages).toEqual(candidates);
  });

  it('stops at the scan budget and retains continuation with fewer than limit groups', () => {
    const candidates = Array.from({ length: 30 }, (_, i) => row(i + 1, 'T'));
    const first = page(candidates, 2, false);
    expect(first.messages).toEqual([candidates[0]]);
    expect(first.lastConsumed).toEqual(candidates[11]);
    expect(first.hasMore).toBe(true);
  });

  it('does not claim exhaustion when the supplied candidate window is incomplete', () => {
    expect(page([row(1, 'T')], 2, false).hasMore).toBe(true);
    expect(page([], 2, true)).toEqual({ messages: [], lastConsumed: null, hasMore: false });
  });

  it('visits every distinct group in exhaustive short candidate streams', () => {
    for (let length = 1; length <= 6; length++) {
      for (let pattern = 0; pattern < 3 ** length; pattern++) {
        let value = pattern;
        const candidates = Array.from({ length }, (_, i) => {
          const candidate = row(i + 1, String(value % 3));
          value = Math.floor(value / 3);
          return candidate;
        });
        for (const limit of [1, 2, 3]) {
          const seen = new Set();
          let offset = 0;
          for (let request = 0; request < length && offset < length; request++) {
            const result = page(candidates.slice(offset), limit);
            expect(new Set(result.messages.map(m => m.thread_key)).size).toBe(result.messages.length);
            for (const message of result.messages) seen.add(message.thread_key);
            const consumed = candidates.indexOf(result.lastConsumed);
            expect(consumed).toBeGreaterThanOrEqual(offset);
            offset = consumed + 1;
            if (!result.hasMore) break;
          }
          expect([...seen]).toEqual([...new Set(candidates.map(m => m.thread_key))]);
        }
      }
    }
  });
});

describe('exact consumed candidate cursor', () => {
  it.each([null, '2026-10-20T12:00:00.123456Z'])('retains same-date physical boundaries across accounts: %s', date => {
    const candidates = [account, otherAccount].flatMap(accountId =>
      Array.from({ length: 15 }, (_, i) => ({ ...row(i + 1, 'T', accountId), _cursor_date: date })));
    const consumed = [];
    let remaining = candidates;
    while (remaining.length) {
      const result = page(remaining, 2);
      const cursor = decodeGrouped(search.encodeSearchCursor(result.lastConsumed, scope,
        { mode: 'grouped', snapshot: '10:20:12,15' }));
      const index = remaining.findIndex(candidate => candidate.account_id === cursor.accountId && candidate.id === cursor.id);
      expect(index).toBeGreaterThanOrEqual(0);
      consumed.push(...remaining.slice(0, index + 1));
      remaining = remaining.slice(index + 1);
      expect(result.hasMore).toBe(remaining.length > 0);
    }
    expect(consumed).toEqual(candidates);
    expect(new Set(consumed.map(candidate => JSON.stringify([candidate.account_id, candidate.id]))).size).toBe(candidates.length);
  });
});
