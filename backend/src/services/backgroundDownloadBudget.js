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
    if (!hosts.has(key)) hosts.set(key, { minute: -1, messages: 0, bytes: 0, rate: 1, blockedUntil: 0, tail: Promise.resolve() });
    return hosts.get(key);
  };
  return {
    refuse(host, now = Date.now()) {
      const state = stateFor(host);
      state.rate = Math.max(1 / Math.max(1, cap.messages), state.rate / 2);
      state.blockedUntil = Math.max(state.blockedUntil, now + MINUTE);
    },
    async reserve(accountId, host, { messages, bytes }, now) {
      if (![messages, bytes, ...(now == null ? [] : [now])].every(n => Number.isSafeInteger(n) && n >= 0) || !host) {
        throw new Error('Background read requires bounded integer messages and bytes');
      }
      const state = stateFor(host);
      const previous = state.tail;
      let release;
      state.tail = new Promise(resolve => { release = resolve; });
      await previous;
      try {
        now ??= Date.now();
        const minute = Math.floor(now / MINUTE);
        if (state.minute !== minute) Object.assign(state, { minute, messages: 0, bytes: 0 });
        const charge = bytes + cap.overhead;
        if (foregroundPending(host) || now < state.blockedUntil ||
            state.messages + messages > Math.floor(cap.messages * state.rate) ||
            state.bytes + charge > Math.floor(cap.bytes * state.rate)) {
          return { allowed: false, deferAt: Math.max((minute + 1) * MINUTE, state.blockedUntil) };
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
        if (foregroundPending(host) || now < state.blockedUntil) {
          return { allowed: false, deferAt: Math.max((minute + 1) * MINUTE, state.blockedUntil) };
        }
        return { allowed: true, deferAt: null };
      } finally { release(); }
    },
  };
}

const shared = createBackgroundBudget();
export const reserveBackgroundBudget = (...args) => shared.reserve(...args);
export const recordBackgroundRefusal = (...args) => shared.refuse(...args);
