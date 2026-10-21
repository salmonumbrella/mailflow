// Called after each operation's Undo deadline. A running batch holds only due work.
export function createArchiveQueue(archive, { currentGeneration = () => undefined, onBatch = () => {} } = {}) {
  const pending = [];
  let scheduled = false;
  const drain = async () => {
    const jobs = pending.splice(0);
    const current = job => job.generation === currentGeneration();
    const targets = new Map(jobs.filter(current).flatMap(job => job.targets).map(t => [t.id, t]));
    const byAccount = new Map();
    for (const target of targets.values()) {
      if (!byAccount.has(target.account_id)) byAccount.set(target.account_id, []);
      byAccount.get(target.account_id).push(target);
    }
    for (const batch of byAccount.values()) {
      for (let offset = 0; offset < batch.length; offset += 50) {
        const chunk = batch.slice(offset, offset + 50).filter(t => jobs.some(job => current(job) && job.targets.some(own => own.id === t.id)));
        if (!chunk.length) continue;
        const generation = currentGeneration();
        let result;
        try { result = await archive(chunk.map(t => t.id)); }
        catch (error) { result = { error }; }
        const ids = new Set(chunk.map(t => t.id));
        result = { ...result, archived: (result.archived || []).filter(id => ids.has(id)),
          countTargets: (result.countTargets || []).filter(target => ids.has(target.id)), unconfirmed: (result.unconfirmed || []).filter(id => ids.has(id)) };
        if (generation === currentGeneration() && result.countTargets?.length) onBatch(result, chunk, generation);
        for (const job of jobs.filter(job => current(job) && job.targets.some(t => ids.has(t.id)))) {
          const own = new Set(job.targets.map(t => t.id));
          job.result.archived.push(...(result.archived || []).filter(id => own.has(id)));
          job.result.countTargets.push(...(result.countTargets || []).filter(t => own.has(t.id)));
          job.result.noArchiveFolder.push(...(result.noArchiveFolder || []));
          job.result.unconfirmed.push(...result.unconfirmed.filter(id => own.has(id)));
          if (result.error) {
            job.result.error = result.error;
            if (result.error.notApplied !== true) job.result.unconfirmed.push(...chunk.filter(t => own.has(t.id)).map(t => t.id));
          }
        }
      }
    }
    jobs.forEach(job => job.resolve(job.result));
    if (pending.length) setTimeout(drain, 0);
    else scheduled = false;
  };
  return (targets, generation = currentGeneration()) => new Promise(resolve => {
    pending.push({ targets, generation, resolve, result: { archived: [], unconfirmed: [], countTargets: [], noArchiveFolder: [], error: null } });
    if (!scheduled) { scheduled = true; setTimeout(drain, 0); }
  });
}
