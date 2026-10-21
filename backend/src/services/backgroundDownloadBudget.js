import { query } from './db.js';

const DEFAULTS = { messages: 120, bytes: 10 * 1024 ** 2, dailyBytes: 1024 ** 3, overhead: 1024 };
const MINUTE = 60000;
const DAY = 86400000;

// Reserved bounds are charged in full, including failed transfers and protocol overhead.
// Callers must bound the response before admission; an unknown-size read is not admissible.
export function createBackgroundBudget({ queryFn = query, limits = {}, foregroundPending = () => false } = {}) {
  const cap = { ...DEFAULTS, ...limits };
  const hosts = new Map();
  const stateFor = host => {
    const key = host.toLowerCase();
    if (!hosts.has(key)) hosts.set(key, { minute: -1, messages: 0, bytes: 0, byteDebt: 0,
      pendingOversize: null, rate: 1, blockedUntil: 0, tail: Promise.resolve() });
    return hosts.get(key);
  };
  const byteCapacity = state => Math.floor(cap.bytes * state.rate);
  const firstFreshMinute = state => state.minute + 1 + Math.ceil(state.byteDebt / byteCapacity(state));
  const advance = (state, now) => {
    now = Math.max(now, state.minute * MINUTE);
    const minute = Math.floor(now / MINUTE);
    if (minute > state.minute) {
      const capacity = byteCapacity(state);
      const debt = Math.max(0, state.byteDebt - (minute - state.minute - 1) * capacity);
      Object.assign(state, { minute, messages: 0, bytes: Math.min(capacity, debt), byteDebt: Math.max(0, debt - capacity) });
    }
    if (state.pendingOversize && minute > state.pendingOversize.minute) state.pendingOversize = null;
    return now;
  };
  return {
    refuse(host, now = Date.now()) {
      const state = stateFor(host);
      now = advance(state, now);
      state.rate = Math.max(1 / Math.max(1, cap.messages), state.rate / 2);
      state.blockedUntil = Math.max(state.blockedUntil, now + MINUTE);
      if (state.pendingOversize?.minute > state.minute) {
        if (byteCapacity(state) > 0) state.pendingOversize.minute = firstFreshMinute(state);
        else state.pendingOversize = null;
      }
    },
    async reserve(accountId, host, { messages, bytes }, now) {
      const charge = bytes + cap.overhead;
      if (![messages, bytes, charge, ...(now == null ? [] : [now])].every(n => Number.isSafeInteger(n) && n >= 0) || !host) {
        throw new Error('Background read requires bounded integer messages and bytes');
      }
      const state = stateFor(host);
      const previous = state.tail;
      let release;
      state.tail = new Promise(resolve => { release = resolve; });
      await previous;
      try {
        now = advance(state, now ?? Date.now());
        const capacity = byteCapacity(state);
        const messageCapacity = Math.floor(cap.messages * state.rate);
        const oversized = charge > capacity && capacity > 0 && messages <= messageCapacity;
        const hostDeferAt = () => Math.max((state.minute + 1) * MINUTE, state.blockedUntil);
        const deny = (deferAt, prioritize = false) => {
          if (prioritize && !state.pendingOversize) state.pendingOversize = { accountId, minute: firstFreshMinute(state) };
          return { allowed: false, deferAt };
        };
        if (foregroundPending(host) || now < state.blockedUntil) return deny(hostDeferAt());
        if (state.pendingOversize?.minute === state.minute &&
            (state.pendingOversize.accountId !== accountId || !oversized)) return deny(hostDeferAt());
        const fresh = state.messages === 0 && state.bytes === 0 && state.byteDebt === 0;
        if (state.messages + messages > messageCapacity ||
            (state.bytes + charge > capacity && !(oversized && fresh))) {
          return deny(oversized ? firstFreshMinute(state) * MINUTE : hostDeferAt(), oversized);
        }
        const day = new Date(now).toISOString().slice(0, 10);
        const { rows } = await queryFn(`
          INSERT INTO background_download_debits (account_id, day, bytes)
          SELECT id, $2::date, $3::bigint FROM email_accounts
          WHERE id = $1 AND enabled AND $3::bigint <= $4::bigint
          ON CONFLICT (account_id, day) DO UPDATE
            SET bytes = background_download_debits.bytes + EXCLUDED.bytes
            WHERE background_download_debits.bytes + EXCLUDED.bytes <= $4::bigint
          RETURNING bytes`, [accountId, day, charge, cap.dailyBytes]);
        if (!rows.length) return { allowed: false, deferAt: (Math.floor(now / DAY) + 1) * DAY };
        state.messages += messages;
        state.bytes += charge;
        // Charge the entire admitted bound, even if a late foreground/refusal prevents the read.
        if (oversized) state.byteDebt += charge - capacity;
        if (foregroundPending(host) || now < state.blockedUntil) {
          return deny(hostDeferAt(), oversized);
        }
        if (oversized && state.pendingOversize?.accountId === accountId) state.pendingOversize = null;
        return { allowed: true, deferAt: null };
      } finally { release(); }
    },
  };
}

const shared = createBackgroundBudget();
export const reserveBackgroundBudget = (...args) => shared.reserve(...args);
export const recordBackgroundRefusal = (...args) => shared.refuse(...args);
