import { describe, expect, it, vi } from 'vitest';
import { createBackgroundBudget } from './backgroundDownloadBudget.js';

// A durable fake store models restart; real SQL quota enforcement is covered in PG tests.
function store() {
  const debits = new Map();
  return async (_sql, [account, day, bytes, limit]) => {
    const key = `${account}:${day}`;
    if ((debits.get(key) || 0) + bytes > limit) return { rows: [] };
    debits.set(key, (debits.get(key) || 0) + bytes);
    return { rows: [{ bytes: debits.get(key) }] };
  };
}
const limits = { messages: 2, bytes: 20, dailyBytes: 30, overhead: 2 };

describe('background download admission', () => {
  it('shares minute tokens across accounts on the same normalized host', async () => {
    const budget = createBackgroundBudget({ queryFn: store(), limits });
    expect((await budget.reserve('a', 'IMAP.test', { messages: 1, bytes: 8 }, 0)).allowed).toBe(true);
    expect((await budget.reserve('b', 'imap.test', { messages: 1, bytes: 8 }, 0)).allowed).toBe(true);
    expect(await budget.reserve('c', 'imap.test', { messages: 1, bytes: 0 }, 0)).toMatchObject({ allowed: false, deferAt: 60000 });
    expect((await budget.reserve('a', 'imap.test', { messages: 1, bytes: 8 }, 60000)).allowed).toBe(true);
  });
  it.each([
    [{ messages: 2, bytes: 0 }, { messages: 1, bytes: 0 }],
    [{ messages: 0, bytes: 18 }, { messages: 0, bytes: 0 }],
  ])('enforces message and byte caps independently: %j', async (first, next) => {
    const budget = createBackgroundBudget({ queryFn: store(), limits });
    expect((await budget.reserve('a', 'imap.test', first, 0)).allowed).toBe(true);
    expect((await budget.reserve('b', 'imap.test', next, 0)).allowed).toBe(false);
    expect((await budget.reserve('b', 'imap.test', next, 60000)).allowed).toBe(true);
  });
  it('persists daily debit across restart, including retries and overhead', async () => {
    const queryFn = store();
    let budget = createBackgroundBudget({ queryFn, limits });
    await budget.reserve('a', 'imap.test', { messages: 1, bytes: 8 }, 0);
    budget = createBackgroundBudget({ queryFn, limits });
    await budget.reserve('a', 'imap.test', { messages: 1, bytes: 18 }, 60000);
    expect(await budget.reserve('a', 'imap.test', { messages: 1, bytes: 0 }, 120000)).toMatchObject({ allowed: false, deferAt: 86400000 });
    expect((await budget.reserve('b', 'imap.test', { messages: 1, bytes: 0 }, 120000)).allowed).toBe(true);
    expect((await budget.reserve('a', 'imap.test', { messages: 1, bytes: 0 }, 86400000)).allowed).toBe(true);
  });
  it('serializes competing reservations and preserves foreground priority', async () => {
    let foreground = true;
    const budget = createBackgroundBudget({ queryFn: store(), limits, foregroundPending: () => foreground });
    expect((await budget.reserve('a', 'imap.test', { messages: 1, bytes: 8 }, 0)).allowed).toBe(false);
    foreground = false;
    const results = await Promise.all([1, 2, 3].map(() => budget.reserve('a', 'imap.test', { messages: 1, bytes: 8 }, 0)));
    expect(results.filter(r => r.allowed)).toHaveLength(2);
  });
  it('halves admission after refusal without recovering automatically next minute', async () => {
    const budget = createBackgroundBudget({ queryFn: store(), limits });
    budget.refuse('imap.test', 0);
    expect((await budget.reserve('a', 'imap.test', { messages: 1, bytes: 0 }, 1)).allowed).toBe(false);
    expect((await budget.reserve('a', 'imap.test', { messages: 1, bytes: 0 }, 60000)).allowed).toBe(true);
    expect((await budget.reserve('b', 'imap.test', { messages: 1, bytes: 0 }, 60000)).allowed).toBe(false);
    await budget.reserve('a', 'imap.test', { messages: 1, bytes: 0 }, 120000);
    expect((await budget.reserve('b', 'imap.test', { messages: 1, bytes: 0 }, 120000)).allowed).toBe(false);
  });
  it('enforces production minute and daily defaults independently of tiny test limits', async () => {
    const budget = createBackgroundBudget({ queryFn: store() });
    for (let minute = 0; minute < 102; minute++) {
      expect((await budget.reserve('a', 'imap.test', { messages: 120, bytes: 10484736 }, minute * 60000)).allowed).toBe(true);
      expect((await budget.reserve('b', 'imap.test', { messages: 1, bytes: 0 }, minute * 60000)).allowed).toBe(false);
    }
    expect((await budget.reserve('a', 'imap.test', { messages: 1, bytes: 4193280 }, 6120000)).allowed).toBe(true);
    expect((await budget.reserve('a', 'imap.test', { messages: 1, bytes: 0 }, 6180000)).allowed).toBe(false);
    expect((await budget.reserve('b', 'imap.test', { messages: 1, bytes: 0 }, 6180000)).allowed).toBe(true);
  });
  it('retains bounded progress after repeated host refusals', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const budget = createBackgroundBudget({ queryFn: store() });
      for (let refusal = 0; refusal < 16; refusal++) budget.refuse('imap.test');
      expect((await budget.reserve('a', 'imap.test', { messages: 1, bytes: 768 })).allowed).toBe(false);
      vi.setSystemTime(60000);
      expect((await budget.reserve('a', 'imap.test', { messages: 1, bytes: 768 })).allowed).toBe(true);
      expect((await budget.reserve('b', 'imap.test', { messages: 1, bytes: 768 })).allowed).toBe(false);
      vi.setSystemTime(120000);
      expect((await budget.reserve('b', 'imap.test', { messages: 1, bytes: 768 })).allowed).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it.each([60000, 86400000])('uses admission time when a queued reservation crosses %s', async boundary => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(boundary - 1);
      let release; let first = true;
      const durable = store();
      const budget = createBackgroundBudget({ limits: { ...limits, messages: 1, dailyBytes: boundary === 86400000 ? 10 : 30 },
        queryFn: async (...args) => {
          if (first) { first = false; await new Promise(resolve => { release = resolve; }); }
          return durable(...args);
        },
      });
      const one = budget.reserve('a', 'imap.test', { messages: 1, bytes: 8 });
      await Promise.resolve();
      const two = budget.reserve('a', 'imap.test', { messages: 1, bytes: 8 });
      vi.setSystemTime(boundary); release();
      await one;
      expect((await two).allowed).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('honors refusal arriving while a durable reservation is pending', async () => {
    let release;
    const budget = createBackgroundBudget({ limits, queryFn: async () => {
      await new Promise(resolve => { release = resolve; }); return { rows: [{ bytes: 10 }] };
    } });
    const pending = budget.reserve('a', 'imap.test', { messages: 1, bytes: 8 }, 0);
    await Promise.resolve(); budget.refuse('imap.test', 0); release();
    expect((await pending).allowed).toBe(false);
  });
  for (const field of ['messages', 'bytes']) it.each([NaN, Infinity, -1, 0.5])(`rejects unbounded or malformed ${field}: %s`, async value => {
    const budget = createBackgroundBudget({ queryFn: store(), limits });
    await expect(budget.reserve('a', 'imap.test', { messages: 1, bytes: 0, [field]: value }, 0)).rejects.toThrow();
  });
});
