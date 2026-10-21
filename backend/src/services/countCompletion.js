import { randomUUID } from 'node:crypto';
export const COUNT_LEASE_MS = 360000;
const refusal = (code, error, status = 409) => Object.assign(new Error(error), { code, status, retryable: status === 429 });

// Single backend process: restart changes the epoch, so persisted STATUS rows never inherit
// a certificate from a lost in-memory handler/provider ledger. No count intents are persisted.
// Done UUIDs expire with their lease: after purge, replay protection relies on the funnel
// retrying only its own explicit admission refusal, never a completed/uncertain request.
export class CountCompletion {
  constructor({ epoch = randomUUID(), now = () => performance.now(), capacity = 10000, pending = () => 0 } = {}) {
    Object.assign(this, { epoch, now, capacity, pending });
    this.users = new Map();
    this.observations = new Map();
    this.leases = new Map();
    this.leaseSeq = 0;
    this.lease();
  }
  lease() {
    const now = this.now();
    for (const [token, deadline] of this.leases) if (deadline <= now) this.leases.delete(token);
    if (!this.currentLease || now >= this.issuedAt + COUNT_LEASE_MS / 2) {
      this.currentLease = `${this.epoch}.${++this.leaseSeq}`;
      this.issuedAt = now;
      this.leases.set(this.currentLease, now + COUNT_LEASE_MS);
    }
    return { token: this.currentLease, expiresInMs: this.leases.get(this.currentLease) - now };
  }
  user(id) {
    if (!this.users.has(id)) this.users.set(id, { ops: new Map(), handlers: 0, accounts: [], seq: '0' });
    const user = this.users.get(id);
    for (const [key, op] of user.ops) if (op.state !== 'running' && op.until <= this.now()) user.ops.delete(key);
    return user;
  }
  parseId(id) {
    if (typeof id !== 'string' || !/^.+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw refusal('count-op-invalid', 'Invalid count operation ID', 400);
    }
    const split = id.lastIndexOf(':');
    return { leaseToken: id.slice(0, split), uuid: id.slice(split + 1) };
  }
  leaseDeadline(token) { this.lease(); return this.leases.get(token) || 0; }
  capacityCheck(user, additions = 1) {
    if (user.ops.size + additions > this.capacity) throw refusal('count-op-capacity', 'Too many pending count actions; retry after reconciliation', 429);
  }
  async run(userId, opId, work) {
    const user = this.user(userId);
    if (opId) {
      const { leaseToken, uuid } = this.parseId(opId);
      const deadline = this.leaseDeadline(leaseToken), prior = user.ops.get(opId);
      const known = [...user.ops.values()].find(op => op.uuid === uuid && op.state !== 'tombstone');
      if (known) throw refusal(known.state === 'running' ? 'count-op-running' : 'count-op-replayed', 'Count action is already running or completed; reconcile counts');
      if (prior?.state === 'tombstone') throw refusal('count-op-expired', 'Count action was cancelled before dispatch; refresh counts');
      if (deadline <= this.now()) throw refusal('count-epoch-expired', 'Count lease expired before mutation; refresh counts and retry');
      this.capacityCheck(user);
      user.ops.set(opId, { state: 'running', uuid, until: deadline });
    }
    user.handlers++;
    try { return await work(); }
    finally {
      user.handlers--;
      // Retain done IDs until lease expiry too: a duplicate dispatch must never execute twice.
      if (opId) user.ops.get(opId).state = 'done';
    }
  }
  refresh(userId, { ops = [] }, accounts, seq) {
    if (!Array.isArray(ops) || ops.length > this.capacity) throw refusal('count-op-capacity', 'Too many count actions; retry in smaller groups', 429);
    const ids = [...new Set(ops.map(op => {
      if (!op || typeof op.leaseToken !== 'string' || typeof op.uuid !== 'string') throw refusal('count-op-invalid', 'Invalid count operation ID', 400);
      return `${op.leaseToken}:${op.uuid}`;
    }))];
    const user = this.user(userId), unseen = [];
    for (const id of ids) {
      const { leaseToken, uuid } = this.parseId(id), until = this.leaseDeadline(leaseToken);
      if (!user.ops.has(id) && until > this.now()) unseen.push([id, { state: 'tombstone', uuid, until }]);
    }
    this.capacityCheck(user, unseen.length);
    for (const [id, op] of unseen) user.ops.set(id, op);
    user.accounts = accounts;
    if (BigInt(seq) > BigInt(user.seq)) user.seq = String(seq);
    return { epoch: this.epoch, lease: this.lease(), refreshSeq: user.seq };
  }
  quiescent(user) { return user.handlers === 0 && user.accounts.every(id => !this.pending(id)); }
  canObserveAccount(accountId) {
    return !this.pending(accountId) && [...this.users.values()].every(user => !user.accounts.includes(accountId) || this.quiescent(user));
  }
  observation(userId, accountId) {
    const user = this.users.get(userId);
    return { epoch: this.epoch, quiescentAtStart: !!user && user.seq !== '0' && user.accounts.includes(accountId) && this.quiescent(user), refreshSeqAtStart: user?.seq || '0' };
  }
  remember(accountId, path, revision, metadata) {
    const key = JSON.stringify([accountId, path]), prior = this.observations.get(key);
    if (!prior || BigInt(revision) > BigInt(prior.revision)) this.observations.set(key, { revision: String(revision), metadata: { epoch: this.epoch, quiescentAtStart: false, refreshSeqAtStart: '0', ...metadata } });
  }
  latest(accountId, path) {
    const observed = this.observations.get(JSON.stringify([accountId, path]));
    return observed ? { revision: observed.revision, ...observed.metadata } : null;
  }
  metadata(accountId, path, revision) {
    const observation = this.observations.get(JSON.stringify([accountId, path]));
    return observation?.revision === String(revision) ? observation.metadata : { epoch: this.epoch, quiescentAtStart: false, refreshSeqAtStart: '0' };
  }
}
export const countCompletion = new CountCompletion();
export function countMutation(handler) {
  return async (req, res, next) => {
    try { return await countCompletion.run(req.session.userId, req.get?.('X-Count-Op'), () => handler(req, res, next)); }
    catch (error) {
      if (!error.code?.startsWith('count-')) throw error;
      return res.status(error.status).json({ error: error.message, code: error.code, retryable: error.retryable });
    }
  };
}

export function installProviderCountTracking(manager) {
  const writes = new Map();
  manager.trackProviderWrite = async (accountId, work) => {
    writes.set(accountId, (writes.get(accountId) || 0) + 1);
    try { return await work(); }
    finally { const remaining = writes.get(accountId) - 1; if (remaining) writes.set(accountId, remaining); else writes.delete(accountId); }
  };
  for (const name of ['setFlag', 'markAllReadImap', 'moveMessage', 'moveMessageGetNewUid', 'copyMessage', 'bulkMoveMessages', 'permanentDeleteMessage', 'bulkPermanentDelete', 'emptyFolder']) {
    const original = manager[name];
    manager[name] = (...args) => manager.trackProviderWrite(typeof args[0] === 'string' ? args[0] : args[0].id, () => original.apply(manager, args));
  }
  return accountId => (writes.get(accountId) || 0) + (manager._pendingFlagPush?.get(accountId)?.size || 0);
}
