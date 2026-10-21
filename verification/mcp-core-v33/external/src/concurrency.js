// A counting semaphore: at most `limit` holders at once, the rest wait in arrival order.
export class Semaphore {
  constructor(limit) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Semaphore limit must be a positive integer');
    this.limit = limit;
    this.active = 0;
    this.waiting = [];
  }

  get idle() {
    return this.active === 0 && this.waiting.length === 0;
  }

  acquire(signal) {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, onAbort: null };
      if (signal) {
        entry.onAbort = () => {
          const index = this.waiting.indexOf(entry);
          if (index !== -1) this.waiting.splice(index, 1);
          reject(abortReason(signal));
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.waiting.push(entry);
    });
  }

  release() {
    const next = this.waiting.shift();
    if (next) {
      if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
      next.resolve();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

function abortReason(signal) {
  return signal.reason instanceof Error ? signal.reason : new Error('Aborted');
}

// Runs fn over items with at most `limit` in flight. Every item gets { ok, value } or
// { ok: false, error } in input order, so one failure never hides what happened to the others.
export async function mapSettled(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { ok: true, value: await fn(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// Counts the work in progress, and says when none is left.
export class InFlight {
  constructor() {
    this.count = 0;
    this.waiting = [];
  }

  async track(fn) {
    this.count += 1;
    try {
      return await fn();
    } finally {
      this.count -= 1;
      if (this.count === 0) for (const resolve of this.waiting.splice(0)) resolve();
    }
  }

  idle() {
    return this.count === 0 ? Promise.resolve() : new Promise(resolve => this.waiting.push(resolve));
  }
}

// AbortSignal.any arrived in Node 20.3; engines allow any Node 20.
export function anySignal(signals) {
  const list = signals.filter(Boolean);
  if (!list.length) return undefined;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const controller = new AbortController();
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
