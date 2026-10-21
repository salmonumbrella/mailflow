import { describe, expect, it } from 'vitest';
import { createSearchIndexLifecycle } from './searchIndexLifecycle.js';

const account = { id: 'lifecycle-account' };
const gate = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

// Lifecycle callback ordering only. Real SQL fencing and restore-route drain
// require the separately authored PG/manager tests; this suite claims neither.
describe('search index lifecycle', () => {
  it('does not invoke a batch before explicit resume or with an already aborted caller', async () => {
    const effects = [];
    const lifecycle = createSearchIndexLifecycle({
      runBatch: async () => { effects.push('claimed'); }, invalidateRun: async () => {},
    });
    expect(await lifecycle.run(account)).toBeNull();
    await lifecycle.resume(account.id);
    expect(await lifecycle.run(account, { signal: AbortSignal.abort() })).toBeNull();
    expect(effects).toEqual([]);
  });

  it('shares one in-flight batch and permits another after it actually settles', async () => {
    const entered = gate(), finish = gate();
    let runs = 0;
    const lifecycle = createSearchIndexLifecycle({
      runBatch: async () => { const n = ++runs; entered.resolve(); await finish.promise; return n; },
      invalidateRun: async () => {},
    });
    await lifecycle.resume(account.id);
    const first = lifecycle.run(account);
    try {
      await entered.promise;
      const second = lifecycle.run(account);
      finish.resolve();
      expect(await Promise.all([first, second])).toEqual([1, 1]);
      expect(await lifecycle.run(account)).toBe(2);
    } finally { finish.resolve(); await first; }
  });

  it('closes admission and aborts synchronously, then waits for both invalidation and actual batch cleanup', async () => {
    const entered = gate(), fence = gate(), fenceEntered = gate(), cleanup = gate();
    let oldSignal, nextSignal, runs = 0, invalidations = 0;
    const lifecycle = createSearchIndexLifecycle({
      runBatch: async (_account, { signal }) => {
        if (++runs > 1) { nextSignal = signal; return 'new session'; }
        oldSignal = signal; entered.resolve(); await cleanup.promise; return 'drained';
      },
      invalidateRun: async () => { invalidations++; fenceEntered.resolve(); await fence.promise; },
    });
    await lifecycle.resume(account.id);
    const active = lifecycle.run(account);
    await entered.promise;
    const stopping = lifecycle.stop(account.id);
    const sameStop = lifecycle.stop(account.id);
    let resumed = false;
    const resuming = lifecycle.resume(account.id).then(() => { resumed = true; });
    try {
      expect(oldSignal.aborted).toBe(true);
      expect(await lifecycle.run(account)).toBeNull();
      await fenceEntered.promise;
      expect(invalidations).toBe(1);
      fence.resolve();
      await Promise.resolve();
      expect(resumed).toBe(false); // DB invalidation alone is not a drain.
      cleanup.resolve();
      expect(await active).toBe('drained');
      await Promise.all([stopping, sameStop, resuming]);
      expect(await lifecycle.run(account)).toBe('new session');
      expect(nextSignal).not.toBe(oldSignal);
      expect(nextSignal.aborted).toBe(false);
    } finally {
      fence.resolve(); cleanup.resolve();
      await Promise.allSettled([active, stopping, sameStop, resuming]);
    }
  });

  it('still drains on invalidation failure and allows resume only after a successful fence retry', async () => {
    const entered = gate(), cleanup = gate(), fenceEntered = gate();
    let failed = true, settled = false;
    const lifecycle = createSearchIndexLifecycle({
      runBatch: async () => { entered.resolve(); await cleanup.promise; },
      invalidateRun: async () => { fenceEntered.resolve(); if (failed) throw new Error('fence storage unavailable'); },
    });
    await lifecycle.resume(account.id);
    const active = lifecycle.run(account);
    await entered.promise;
    const stopping = lifecycle.stop(account.id);
    const observed = stopping.then(() => { settled = true; }, () => { settled = true; });
    const rejected = expect(stopping).rejects.toThrow('fence storage unavailable');
    try {
      await fenceEntered.promise;
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(await lifecycle.run(account)).toBeNull();
      cleanup.resolve(); await active; await rejected; await observed;
      await expect(lifecycle.resume(account.id)).rejects.toThrow('fence storage unavailable');
      failed = false;
      await lifecycle.stop(account.id);
      await lifecycle.resume(account.id);
      await lifecycle.run(account);
    } finally { cleanup.resolve(); await Promise.allSettled([active, stopping, observed, rejected]); }
  });

  it('propagates caller cancellation without closing the connected account session', async () => {
    const entered = gate();
    const caller = new AbortController();
    let runs = 0;
    const lifecycle = createSearchIndexLifecycle({
      runBatch: async (_account, { signal }) => {
        if (++runs > 1) return 'continued';
        entered.resolve();
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        return signal.aborted;
      }, invalidateRun: async () => {},
    });
    await lifecycle.resume(account.id);
    const active = lifecycle.run(account, { signal: caller.signal });
    try { await entered.promise; caller.abort(); expect(await active).toBe(true); }
    finally { caller.abort(); await active; }
    expect(await lifecycle.run(account)).toBe('continued');
  });

  it('drains one account while leaving a different account batch live', async () => {
    const enteredA = gate(), enteredB = gate(), finishB = gate();
    const other = { id: 'other-lifecycle-account' };
    let otherSignal;
    const lifecycle = createSearchIndexLifecycle({
      runBatch: async (current, { signal }) => {
        if (current.id === account.id) {
          enteredA.resolve();
          await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
          return 'a drained';
        }
        otherSignal = signal; enteredB.resolve(); await finishB.promise; return 'b finished';
      }, invalidateRun: async () => {},
    });
    await lifecycle.resume(account.id); await lifecycle.resume(other.id);
    const activeA = lifecycle.run(account), activeB = lifecycle.run(other);
    try {
      await Promise.all([enteredA.promise, enteredB.promise]);
      await lifecycle.stop(account.id);
      expect(await activeA).toBe('a drained');
      expect(otherSignal.aborted).toBe(false);
      finishB.resolve(); expect(await activeB).toBe('b finished');
    } finally { finishB.resolve(); await lifecycle.stop(account.id); await Promise.allSettled([activeA, activeB]); }
  });

  it('keeps every account closed during restore quiescence, including reconnect attempts', async () => {
    const entered = gate(), finish = gate();
    let runs = 0;
    const lifecycle = createSearchIndexLifecycle({
      runBatch: async () => { runs++; entered.resolve(); await finish.promise; },
      invalidateRun: async () => {},
    });
    await lifecycle.resume(account.id);
    const active = lifecycle.run(account);
    await entered.promise;
    const quiescing = lifecycle.quiesce();
    try {
      expect(await lifecycle.resume('newly-reconnected-account')).toBe(false);
      expect(await lifecycle.run({ id: 'newly-reconnected-account' })).toBeNull();
      expect(await lifecycle.run(account)).toBeNull();
      finish.resolve(); await quiescing; await active;
      expect(await lifecycle.resume(account.id)).toBe(false);
      lifecycle.resumeScheduling();
      expect(await lifecycle.run(account)).toBeNull(); // Reconnect must explicitly reopen it.
      await lifecycle.resume(account.id);
      await lifecycle.run(account);
      expect(runs).toBe(2);
    } finally { finish.resolve(); await Promise.allSettled([active, quiescing]); }
  });

  it('does not let a resume already awaiting a drain reopen during restore quiescence', async () => {
    const entered = gate(), finish = gate();
    const lifecycle = createSearchIndexLifecycle({
      runBatch: async () => { entered.resolve(); await finish.promise; }, invalidateRun: async () => {},
    });
    await lifecycle.resume(account.id);
    const active = lifecycle.run(account);
    await entered.promise;
    const stopping = lifecycle.stop(account.id);
    const resuming = lifecycle.resume(account.id);
    const quiescing = lifecycle.quiesce();
    try {
      finish.resolve();
      expect(await resuming).toBe(false);
      await Promise.all([active, stopping, quiescing]);
      expect(await lifecycle.run(account)).toBeNull();
    } finally { finish.resolve(); await Promise.allSettled([active, stopping, resuming, quiescing]); }
  });

  it('quiesces all accounts before reporting any fence failure', async () => {
    const entered = gate(), finish = gate();
    const other = { id: 'other-lifecycle-account' };
    const lifecycle = createSearchIndexLifecycle({
      runBatch: async () => { entered.resolve(); await finish.promise; },
      invalidateRun: async id => { if (id === account.id) throw new Error('restore fence failed'); },
    });
    await lifecycle.resume(account.id); await lifecycle.resume(other.id);
    const active = lifecycle.run(other);
    await entered.promise;
    const quiescing = lifecycle.quiesce();
    let settled = false;
    const observed = quiescing.then(() => { settled = true; }, () => { settled = true; });
    const rejected = expect(quiescing).rejects.toThrow('restore fence failed');
    try {
      await Promise.resolve(); await Promise.resolve();
      expect(settled).toBe(false);
      expect(await lifecycle.run(other)).toBeNull();
      finish.resolve(); await active; await rejected; await observed;
      expect(await lifecycle.resume(other.id)).toBe(false);
    } finally { finish.resolve(); await Promise.allSettled([active, quiescing, observed, rejected]); }
  });

  it('clears a synchronously thrown batch so the next existing tick can retry', async () => {
    let runs = 0;
    const lifecycle = createSearchIndexLifecycle({
      runBatch: () => { if (++runs === 1) throw new Error('worker failed'); return 'retried'; },
      invalidateRun: async () => {},
    });
    await lifecycle.resume(account.id);
    await expect(lifecycle.run(account)).rejects.toThrow('worker failed');
    expect(await lifecycle.run(account)).toBe('retried');
  });

  it('exposes synchronous closed admission for metadata discovery until a successful resume',async()=>{
    const lifecycle=createSearchIndexLifecycle({runBatch:async()=>{},invalidateRun:async()=>{}});
    expect(lifecycle.isOpen(account.id)).toBe(false);await lifecycle.resume(account.id);
    expect(lifecycle.isOpen(account.id)).toBe(true);
    const stopping=lifecycle.stop(account.id);expect(lifecycle.isOpen(account.id)).toBe(false);await stopping;
    lifecycle.resumeScheduling();expect(lifecycle.isOpen(account.id)).toBe(false);
    await lifecycle.resume(account.id);const drained=lifecycle.quiesce();
    expect(lifecycle.isOpen(account.id)).toBe(false);await drained;
  });


  it('drains an admitted metadata handoff and refuses a second busy handoff without joining it',async()=>{
    const finish=gate();let entered=false;
    const lifecycle=createSearchIndexLifecycle({runBatch:async()=>{},invalidateRun:async()=>{}});
    await lifecycle.resume(account.id);
    const active=lifecycle.runDiscovery(account,async()=>{entered=true;await finish.promise;return{changed:1,deferred:false,reason:null};});
    await Promise.resolve();expect(entered).toBe(true);
    expect(await lifecycle.runDiscovery(account,async()=>{throw new Error('busy work must not start');}))
      .toMatchObject({deferred:true,reason:'active-batch'});
    let drained=false;const stopping=lifecycle.stop(account.id).then(()=>{drained=true;});
    try{await Promise.resolve();expect(drained).toBe(false);}
    finally{finish.resolve();await active;await stopping;}
    expect(await lifecycle.runDiscovery(account,async()=>{})).toMatchObject({deferred:true,reason:'stopped'});
  });


  it('exposes only the existing settlement promise without reopening admission or storing work',async()=>{
    const finish=gate();const lifecycle=createSearchIndexLifecycle({runBatch:async()=>finish.promise,invalidateRun:async()=>{}});
    expect(await lifecycle.settled(account.id)).toBeUndefined();expect(lifecycle.isOpen(account.id)).toBe(false);
    await lifecycle.resume(account.id);const active=lifecycle.run(account);
    expect(lifecycle.settled(account.id)).toBe(active);
    finish.resolve();await active;expect(await lifecycle.settled(account.id)).toBeUndefined();
  });

});
