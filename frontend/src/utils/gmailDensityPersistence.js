import { isGmailDensity } from './gmailDensity.js';

export const GMAIL_DENSITY_INTENT_KEY = 'mailflow_gmail_density_intent';
export const GMAIL_DENSITY_SNAPSHOT_KEY = 'mailflow_gmail_density_snapshot';
const ACK_PREFIX = 'mailflow_gmail_density_ack:';
const REVISION_PREFIX = 'mailflow_gmail_density_revision:';
export const isDensityRevision = value => Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const readJson = (storage, key) => {
  try { return JSON.parse(storage.getItem(key) || 'null'); } catch { return null; }
};
const storageKeys = storage => {
  const keys = [];
  if (typeof storage.key === 'function') {
    for (let index = 0; index < storage.length; index++) keys.push(storage.key(index));
  }
  return keys;
};
const readSnapshot = (storage, userId) => {
  const prefix = `${GMAIL_DENSITY_SNAPSHOT_KEY}:${String(userId)}:`;
  let latest = null;
  for (const key of storageKeys(storage)) {
    if (!key?.startsWith(prefix)) continue;
    const value = readJson(storage, key);
    if (value?.userId === String(userId) && isGmailDensity(value.value) && isDensityRevision(value.revision)
        && (!latest || value.revision > latest.revision)) latest = value;
  }
  return latest;
};
const newIntentToken = () => typeof globalThis.crypto?.randomUUID === 'function'
  ? globalThis.crypto.randomUUID()
  : [...globalThis.crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('');

export function readDensityIntent(storage, userId) {
  const value = readJson(storage, GMAIL_DENSITY_INTENT_KEY);
  if (!value || value.userId !== String(userId) || typeof value.token !== 'string' || !value.token || value.token.length > 100
      || !isGmailDensity(value.value) || (value.revision !== null && !isDensityRevision(value.revision))) return null;
  const ack = readJson(storage, ACK_PREFIX + value.token);
  const acknowledged = ack?.userId === value.userId && ack?.token === value.token && ack?.value === value.value && isDensityRevision(ack.revision);
  const observed = readJson(storage, REVISION_PREFIX + value.token);
  const revisions = [value.revision, acknowledged ? ack.revision : null,
    observed?.userId === value.userId && observed?.token === value.token ? observed.revision : null,
    readSnapshot(storage, userId)?.revision].filter(isDensityRevision);
  return { ...value, pending: !acknowledged, revision: revisions.length ? Math.max(...revisions) : null,
    acknowledgedRevision: acknowledged ? ack.revision : null };
}

export function readDensityCache(storage, userId) {
  const intent = readDensityIntent(storage, userId);
  const snapshot = readSnapshot(storage, userId);
  if (intent?.pending || intent && (!snapshot || intent.acknowledgedRevision >= snapshot.revision)) return intent;
  return snapshot;
}

// These are receipts, never the authoritative intent pointer. Discarding an old receipt
// can cause a redundant CAS, but cannot erase or acknowledge the latest local choice.
function pruneDensityReceipts(storage) {
  if (typeof storage.key !== 'function' || typeof storage.removeItem !== 'function') return;
  const latest = readJson(storage, GMAIL_DENSITY_INTENT_KEY);
  const allKeys = storageKeys(storage);
  const newestSnapshots = new Map();
  for (const key of allKeys) {
    if (!key?.startsWith(GMAIL_DENSITY_SNAPSHOT_KEY + ':')) continue;
    const snapshot = readJson(storage, key);
    if (snapshot && isDensityRevision(snapshot.revision) && (!newestSnapshots.has(snapshot.userId)
        || snapshot.revision > newestSnapshots.get(snapshot.userId).revision)) newestSnapshots.set(snapshot.userId, { key, revision: snapshot.revision });
  }
  const protectedSnapshots = new Set([...newestSnapshots.values()].map(snapshot => snapshot.key));
  const keys = allKeys.filter(key => key && !protectedSnapshots.has(key)
    && (key.startsWith(GMAIL_DENSITY_SNAPSHOT_KEY + ':')
      || (key.startsWith(ACK_PREFIX) || key.startsWith(REVISION_PREFIX)) && !key.endsWith(':' + latest?.token)));
  for (const key of keys.slice(0, Math.max(0, keys.length - 32))) storage.removeItem(key);
}

export function createGmailDensityPersistence({ storage, getContext, read, save, onState, onLocked, delayMs = 1000 }) {
  let timer = null, active = null, scheduled = null, ready = false;
  const observe = (intent, revision) => storage.setItem(REVISION_PREFIX + intent.token, JSON.stringify({ userId: intent.userId, token: intent.token, revision }));
  const current = () => readDensityIntent(storage, getContext().userId);
  const valid = (intent, context) => {
    const now = getContext();
    const latest = current();
    return !now.locked && now.userId === context.userId && now.session === context.session
      && latest?.pending && latest.token === intent.token && latest.value === intent.value;
  };
  const snapshotValid = data => isGmailDensity(data?.gmailDensity) && isDensityRevision(data?.gmailDensityRevision);

  async function flush() {
    clearTimeout(timer); timer = null;
    ready = true;
    if (active) return;
    const intent = current();
    const context = { ...getContext() };
    if (!intent?.pending || intent.token !== scheduled || context.locked || !context.userId) { ready = false; return; }
    ready = false;
    const run = Symbol();
    active = run;
    try {
      let revision = intent.revision;
      if (revision === null) {
        const snapshot = await read();
        if (!valid(intent, context)) return;
        if (!snapshotValid(snapshot)) throw new Error('Invalid density preference response');
        revision = snapshot.gmailDensityRevision;
        observe(intent, revision);
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!valid(intent, context)) return;
        if (revision >= Number.MAX_SAFE_INTEGER) throw new Error('Density preference revision exhausted');
        try {
          const result = await save({ gmailDensity: intent.value, expectedRevision: revision });
          if (!valid(intent, context)) return;
          if (result?.ok !== true || !snapshotValid(result) || result.gmailDensity !== intent.value
              || result.gmailDensityRevision !== revision + 1) throw new Error('Invalid density save response');
          // Never rewrite the shared latest-intent pointer from a completion callback.
          // Another tab can choose between any two localStorage operations.
          storage.setItem(ACK_PREFIX + intent.token, JSON.stringify({ userId: intent.userId, token: intent.token, value: intent.value, revision: result.gmailDensityRevision }));
          pruneDensityReceipts(storage);
          const now = getContext();
          if (!now.locked && now.userId === context.userId && now.session === context.session && current()?.token === intent.token) onState('saved');
          return;
        } catch (error) {
          if (!valid(intent, context)) return;
          if (error.status !== 409 || !snapshotValid(error) || attempt === 2) throw error;
          revision = error.gmailDensityRevision;
          observe(intent, revision);
          // Even a matching conflict snapshot needs a CAS increment: an older dispatched
          // request may still carry this revision and must be fenced before we say Saved.
        }
      }
    } catch (error) {
      if (valid(intent, context)) {
        onState('failed');
        if (error.status === 423) onLocked?.();
      }
    } finally {
      if (active === run) {
        active = null;
        if (ready) void flush();
      }
    }
  }

  function schedule() {
    const intent = current();
    if (!intent?.pending || getContext().locked || !getContext().userId) return false;
    scheduled = intent.token;
    ready = false;
    clearTimeout(timer);
    onState('pending');
    timer = setTimeout(() => { void flush(); }, delayMs);
    return true;
  }

  return {
    choose(value) {
      const { userId, locked } = getContext();
      if (!userId || locked || !isGmailDensity(value)) return false;
      const previous = current() || readSnapshot(storage, userId);
      storage.setItem(GMAIL_DENSITY_INTENT_KEY, JSON.stringify({ userId: String(userId), token: newIntentToken(), value, revision: previous?.revision ?? null }));
      pruneDensityReceipts(storage);
      storage.setItem('mailflow_gmail_density', value);
      return schedule();
    },
    observeRevision(revision) {
      const intent = current();
      if (intent && isDensityRevision(revision) && (intent.revision === null || revision > intent.revision)) {
        observe(intent, revision);
      }
    },
    hydrate(value, revision) {
      const { userId, locked } = getContext();
      if (!userId || locked || !isGmailDensity(value)) return false;
      const intent = current();
      const nextRevision = isDensityRevision(revision) ? revision : 0;
      if (intent?.pending || intent?.revision > nextRevision || readSnapshot(storage, userId)?.revision > nextRevision) return false;
      storage.setItem(`${GMAIL_DENSITY_SNAPSHOT_KEY}:${String(userId)}:${nextRevision}`, JSON.stringify({ userId: String(userId), value, revision: nextRevision }));
      pruneDensityReceipts(storage);
      storage.setItem('mailflow_gmail_density', value);
      return true;
    },
    retry: schedule,
    flush,
    cancel() {
      clearTimeout(timer); timer = null;
      scheduled = null; ready = false; active = null;
    },
  };
}
