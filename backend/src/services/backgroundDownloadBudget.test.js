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

describe('bounded oversized background admission', () => {
  const roomy = { ...limits, dailyBytes: 1000 };

  it('admits the combined 16MiB quotation once and charges the complete bound', async () => {
    const queryFn = vi.fn(store());
    const budget = createBackgroundBudget({ queryFn });
    expect((await budget.reserve('a', 'IMAP.test', { messages: 1, bytes: 17319936 }, 0)).allowed).toBe(true);
    expect(queryFn.mock.calls[0][1]).toEqual(['a', '1970-01-01', 17320960, 1073741824]);
    expect((await budget.reserve('b', 'imap.test', { messages: 0, bytes: 0 }, 0)).allowed).toBe(false);
    expect(queryFn).toHaveBeenCalledTimes(1);
  });
  it.each([{ messages: 1, bytes: 0 }, { messages: 0, bytes: 1 }])('requires a fresh window after prior %j', async prior => {
    const budget = createBackgroundBudget({ queryFn: store(), limits: { ...roomy, overhead: 0 } });
    expect((await budget.reserve('a', 'imap.test', prior, 0)).allowed).toBe(true);
    expect((await budget.reserve('b', 'imap.test', { messages: 1, bytes: 30 }, 0)).allowed).toBe(false);
    expect((await budget.reserve('b', 'imap.test', { messages: 1, bytes: 30 }, 60000)).allowed).toBe(true);
    expect((await budget.reserve('c', 'imap.test', { messages: 0, bytes: 0 }, 60000)).allowed).toBe(false);
  });
  it.each([[28, [[1, true], [2, true]]], [68, [[1, false], [2, false], [3, true], [4, true]]]])(
    'repays oversized bytes=%s over subsequent windows', async (bytes, windows) => {
      const budget = createBackgroundBudget({ queryFn: store(), limits: roomy });
      expect((await budget.reserve('a', 'imap.test', { messages: 1, bytes }, 0)).allowed).toBe(true);
      for (const [minute, allowed] of windows) {
        expect((await budget.reserve('b', 'imap.test', { messages: 1, bytes: 8 }, minute * 60000)).allowed).toBe(allowed);
      }
    });
  it('repays skipped windows without erasing the last partial debt', async () => {
    const budget = createBackgroundBudget({ queryFn: store(), limits: roomy });
    expect((await budget.reserve('a', 'imap.test', { messages: 1, bytes: 68 }, 0)).allowed).toBe(true);
    expect((await budget.reserve('b', 'imap.test', { messages: 1, bytes: 8 }, 180000)).allowed).toBe(true);
    expect((await budget.reserve('c', 'imap.test', { messages: 0, bytes: 0 }, 180000)).allowed).toBe(false);
  });
  it('repays at the refusal-reduced cap without rate recovery', async () => {
    const budget = createBackgroundBudget({ queryFn: store(), limits: roomy });
    budget.refuse('imap.test', 0);
    expect((await budget.reserve('a', 'imap.test', { messages: 1, bytes: 28 }, 1)).allowed).toBe(false);
    expect((await budget.reserve('a', 'imap.test', { messages: 1, bytes: 28 }, 60000)).allowed).toBe(true);
    for (const minute of [2, 3, 4]) {
      expect((await budget.reserve('b', 'imap.test', { messages: 1, bytes: 8 }, minute * 60000)).allowed).toBe(minute === 4);
    }
  });
  it('retains the first owner when its retry quotation changes', async () => {
    const budget = createBackgroundBudget({ queryFn: store(), limits: roomy });
    await budget.reserve('a', 'imap.test', { messages: 1, bytes: 8 }, 0);
    expect(await budget.reserve('b', 'imap.test', { messages: 0, bytes: 28 }, 0)).toEqual({ allowed: false, deferAt: 60000 });
    expect((await budget.reserve('c', 'imap.test', { messages: 1, bytes: 0 }, 60000)).allowed).toBe(false);
    expect((await budget.reserve('c', 'imap.test', { messages: 1, bytes: 38 }, 60000)).allowed).toBe(false);
    expect((await budget.reserve('b', 'imap.test', { messages: 1, bytes: 30 }, 60000)).allowed).toBe(true);
  });
  it.each([120000, 180000])('expires an absent owner without replacement at %s', async later => {
    const budget = createBackgroundBudget({ queryFn: store(), limits: roomy });
    await budget.reserve('a', 'imap.test', { messages: 1, bytes: 8 }, 0);
    await budget.reserve('b', 'imap.test', { messages: 1, bytes: 28 }, 0);
    expect((await budget.reserve('c', 'imap.test', { messages: 1, bytes: 28 }, 60000)).allowed).toBe(false);
    expect((await budget.reserve('a', 'imap.test', { messages: 1, bytes: 28 }, later)).allowed).toBe(true);
    await budget.reserve('c', 'imap.test', { messages: 1, bytes: 28 }, later);
    expect((await budget.reserve('a', 'imap.test', { messages: 1, bytes: 28 }, later + 120000)).allowed).toBe(false);
    expect((await budget.reserve('c', 'imap.test', { messages: 1, bytes: 28 }, later + 120000)).allowed).toBe(true);
  });
  it('protects the first fresh window after another account debt, serving small leftovers', async () => {
    const budget = createBackgroundBudget({ queryFn: store(), limits: roomy });
    await budget.reserve('a', 'imap.test', { messages: 1, bytes: 68 }, 0);
    expect(await budget.reserve('b', 'imap.test', { messages: 0, bytes: 28 }, 60000)).toEqual({ allowed: false, deferAt: 240000 });
    expect((await budget.reserve('c', 'imap.test', { messages: 1, bytes: 8 }, 180000)).allowed).toBe(true);
    expect((await budget.reserve('c', 'imap.test', { messages: 1, bytes: 28 }, 240000)).allowed).toBe(false);
    expect((await budget.reserve('b', 'imap.test', { messages: 1, bytes: 30 }, 240000)).allowed).toBe(true);
  });
  it('retargets future protection when refusal reduces repayment capacity', async () => {
    const budget = createBackgroundBudget({ queryFn: store(), limits: roomy });
    await budget.reserve('a', 'imap.test', { messages: 1, bytes: 68 }, 0);
    await budget.reserve('b', 'imap.test', { messages: 0, bytes: 28 }, 60000);
    budget.refuse('imap.test', 60001);
    expect(await budget.reserve('b', 'imap.test', { messages: 1, bytes: 28 }, 120001)).toEqual({ allowed: false, deferAt: 300000 });
    expect((await budget.reserve('c', 'imap.test', { messages: 1, bytes: 28 }, 300000)).allowed).toBe(false);
    expect((await budget.reserve('b', 'imap.test', { messages: 1, bytes: 28 }, 300000)).allowed).toBe(true);
  });
  it('does not extend an already begun protection window on refusal', async () => {
    const budget = createBackgroundBudget({ queryFn: store(), limits: roomy });
    await budget.reserve('a', 'imap.test', { messages: 1, bytes: 8 }, 0);
    await budget.reserve('b', 'imap.test', { messages: 1, bytes: 28 }, 0);
    expect((await budget.reserve('c', 'imap.test', { messages: 1, bytes: 0 }, 60000)).allowed).toBe(false);
    budget.refuse('imap.test', 60001);
    expect((await budget.reserve('a', 'imap.test', { messages: 1, bytes: 28 }, 120001)).allowed).toBe(true);
  });
  it.each(['daily', 'foreground', 'hold'])('does not create priority on pre-debit %s denial', async reason => {
    let foreground = reason === 'foreground';
    const queryFn = vi.fn(store());
    const budget = createBackgroundBudget({ queryFn, limits: { ...roomy, dailyBytes: reason === 'daily' ? 20 : 1000 },
      foregroundPending: () => foreground });
    if (reason === 'hold') budget.refuse('imap.test', 0);
    expect((await budget.reserve('a', 'imap.test', { messages: 1, bytes: 28 }, 0)).allowed).toBe(false);
    foreground = false;
    expect((await budget.reserve('b', 'imap.test', { messages: 1, bytes: 8 }, 60000)).allowed).toBe(true);
    expect(queryFn.mock.calls.filter(call => call[1][0] === 'a')).toHaveLength(reason === 'daily' ? 1 : 0);
  });
  it.each(['foreground', 'refusal'])('retains charged-but-denied oversized spend, debt and priority after %s', async reason => {
    let release; let foreground = false; let first = true;
    const durable = store();
    const queryFn = vi.fn(async (...args) => {
      if (first) { first = false; await new Promise(resolve => { release = resolve; }); }
      return durable(...args);
    });
    const budget = createBackgroundBudget({ queryFn, limits: roomy, foregroundPending: () => foreground });
    const pending = budget.reserve('a', 'imap.test', { messages: 1, bytes: 28 }, 0);
    await Promise.resolve();
    expect(release).toBeTypeOf('function');
    if (reason === 'foreground') foreground = true; else budget.refuse('imap.test', 0);
    release();
    expect((await pending).allowed).toBe(false);
    expect(queryFn.mock.calls[0][1][2]).toBe(30);
    foreground = false;
    expect((await budget.reserve('b', 'imap.test', { messages: 1, bytes: 10 }, 60000)).allowed).toBe(false);
    expect((await budget.reserve('b', 'imap.test', { messages: 1, bytes: 28 }, 120000)).allowed).toBe(false);
    expect((await budget.reserve('a', 'imap.test', { messages: 1, bytes: 28 }, 120000)).allowed).toBe(true);
  });
  it('preserves daily oversize spend across restart without claiming durable minute debt', async () => {
    const queryFn = store(); const daily = { ...roomy, dailyBytes: 50 };
    let budget = createBackgroundBudget({ queryFn, limits: daily });
    expect((await budget.reserve('a', 'imap.test', { messages: 1, bytes: 28 }, 0)).allowed).toBe(true);
    budget = createBackgroundBudget({ queryFn, limits: daily });
    expect(await budget.reserve('a', 'imap.test', { messages: 1, bytes: 28 }, 60000)).toEqual({ allowed: false, deferAt: 86400000 });
    expect((await budget.reserve('b', 'imap.test', { messages: 1, bytes: 28 }, 60000)).allowed).toBe(true);
    expect((await budget.reserve('a', 'imap.test', { messages: 1, bytes: 28 }, 86400000)).allowed).toBe(true);
  });
  it('serializes oversized competitors before any second debit', async () => {
    const queryFn = vi.fn(store()); const budget = createBackgroundBudget({ queryFn, limits: roomy });
    const results = await Promise.all(['a', 'b', 'c'].map(account => budget.reserve(account, 'imap.test', { messages: 1, bytes: 28 }, 0)));
    expect(results.filter(result => result.allowed)).toHaveLength(1);
    expect(queryFn).toHaveBeenCalledTimes(1);
  });
  it('clamps a backward day without resetting ordinary usage or debiting the earlier day', async () => {
    const queryFn = vi.fn(store()); const budget = createBackgroundBudget({ queryFn, limits: roomy });
    await budget.reserve('a', 'imap.test', { messages: 1, bytes: 8 }, 86460000);
    expect((await budget.reserve('b', 'imap.test', { messages: 1, bytes: 8 }, 0)).allowed).toBe(true);
    expect(queryFn.mock.calls.map(call => call[1][1])).toEqual(['1970-01-02', '1970-01-02']);
    expect((await budget.reserve('c', 'imap.test', { messages: 1, bytes: 0 }, 0)).allowed).toBe(false);
  });
  it('does not erase or repay debt on a backward minute', async () => {
    const budget = createBackgroundBudget({ queryFn: store(), limits: roomy });
    await budget.reserve('a', 'imap.test', { messages: 1, bytes: 68 }, 86460000);
    expect((await budget.reserve('b', 'imap.test', { messages: 1, bytes: 8 }, 0)).allowed).toBe(false);
    expect((await budget.reserve('b', 'imap.test', { messages: 1, bytes: 8 }, 86640000)).allowed).toBe(true);
    expect((await budget.reserve('c', 'imap.test', { messages: 0, bytes: 0 }, 86640000)).allowed).toBe(false);
  });
  it.each([{ messages: 3, bytes: 28 }, { messages: 1, bytes: 28, byteCap: 0 }])('does not bypass the message or zero-byte cap: %j', async request => {
    const queryFn = vi.fn(store());
    const budget = createBackgroundBudget({ queryFn, limits: { ...roomy, bytes: request.byteCap ?? 20 } });
    expect((await budget.reserve('a', 'imap.test', request, 0)).allowed).toBe(false);
    expect(queryFn).not.toHaveBeenCalled();
  });
  it('rejects an unsafe charge sum before durable admission', async () => {
    const queryFn = vi.fn(store()); const budget = createBackgroundBudget({ queryFn, limits: roomy });
    await expect(budget.reserve('a', 'imap.test', { messages: 1, bytes: Number.MAX_SAFE_INTEGER }, 0)).rejects.toThrow();
    expect(queryFn).not.toHaveBeenCalled();
  });
});
