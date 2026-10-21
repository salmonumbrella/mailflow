// pendingMarkReadMap: messageId → accountId for PATCHes that are still in-flight.
// Used by useWebSocket to adjust unread counts before the server has committed.
export const pendingMarkReadMap = new Map();

// completedMarkReadMap: messageId → accountId for PATCHes that returned successfully
// but whose DB write may not yet be visible to a concurrent getMessages SELECT.
// Entries expire after 10s — long enough to cover any in-flight getMessages response
// that raced with the mark-read commit.
export const completedMarkReadMap = new Map();

// Safety timeout handles keyed by messageId — cancels the previous timer if the
// same messageId is re-used before the old one fires, preventing a stale timer
// from deleting a newer in-flight entry for the same message.
const _pendingTimers = new Map();

// Set a pending entry with a 30-second safety timeout.
// Callers still call pendingMarkReadMap.delete() on success/error; the timeout
// is a fallback so a hung or abandoned request never leaves a permanent entry.
export function setPending(messageId, accountId) {
  const prev = _pendingTimers.get(messageId);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    pendingMarkReadMap.delete(messageId);
    _pendingTimers.delete(messageId);
  }, 30000);
  _pendingTimers.set(messageId, timer);
  pendingMarkReadMap.set(messageId, accountId);
}

let readSession = null;
let readOrder = 0;
const readIntents = new Map();
const readWrites = new Map();
const readKey = message => JSON.stringify([message.account_id, message.id]);

// The caller supplies an authentication-session identity, not merely a user id:
// signing out and back in as the same user must invalidate old callbacks too.
export function setReadIntentSession(session) {
  if (session === readSession) return;
  readSession = session;
  readIntents.clear();
  readWrites.clear();
}

export function captureReadRequest() {
  return { session: readSession, order: ++readOrder };
}

export function beginReadIntent(message, read, order = ++readOrder) {
  const previous = readIntents.get(readKey(message));
  const intent = {
    previous,
    key: readKey(message), accountId: message.account_id, session: readSession, read, order,
    outcome: previous?.outcome || { read: message.is_read },
    settled: null, accepted: order,
  };
  if (!previous || previous.order <= order) readIntents.set(intent.key, intent);
  return intent;
}

export function isCurrentReadIntent(intent) {
  return intent.session === readSession && readIntents.get(intent.key) === intent;
}

export function queueReadWrite(intentOrIntents, write) {
  const intents = Array.isArray(intentOrIntents) ? intentOrIntents : [intentOrIntents];
  if (intents.length === 0 || intents.some(intent => intent.session !== readSession)) return Promise.resolve();
  const preceding = intents.map(intent => readWrites.get(intent.key)).filter(Boolean);
  const ready = preceding.length ? Promise.all(preceding) : Promise.resolve();
  const queued = ready.then(() => {
    if (intents.every(intent => intent.session === readSession)) return write();
  });
  // One bulk promise occupies each member's existing queue; no account lock or
  // separate scheduler. Rejection advances all of those queues as well.
  const tail = queued.catch(() => {});
  for (const intent of intents) readWrites.set(intent.key, tail);
  void tail.then(() => {
    for (const intent of intents) {
      if (readWrites.get(intent.key) === tail) readWrites.delete(intent.key);
    }
  });
  return queued;
}

// Call only at the final write outcome. An internal API-funnel retry is not a
// completion. The caller decides whether an explicitly not-applied failure can
// roll back and supplies that read state; uncertain failures retain the intent.
export function settleReadIntent(intent, read = intent.read) {
  if (intent.session !== readSession || readIntents.get(intent.key) !== intent) return false;
  intent.read = read;
  intent.settled = ++readOrder;
  intent.accepted = intent.settled;
  return true;
}

export function completeReadIntent(intent, error) {
  if (intent.session !== readSession) return false;
  // Older writes can establish the state a newer refused write must restore,
  // even though they may no longer change the visible optimistic flag.
  if (!error || error.notApplied !== true) intent.outcome.read = intent.read;
  return settleReadIntent(intent, intent.outcome.read);
}

export function reconcileReadState(messages, token, { except } = {}) {
  let changed = false;
  const result = messages.map(message => {
    let intent = readIntents.get(readKey(message));
    while (intent && intent.order === except) intent = intent.previous;
    if (!intent) return message;
    if (intent.settled !== null && token?.session === readSession
      && token.order > intent.settled && token.order >= intent.accepted) {
      intent.accepted = token.order;
      intent.read = message.is_read;
      intent.outcome.read = message.is_read;
      return message;
    }
    if (message.is_read === intent.read) return message;
    changed = true;
    return { ...message, is_read: intent.read };
  });
  // Retain completed fences until session exit: removing one when a fresh
  // response arrives would let an older response arriving later undo it.
  return changed ? result : messages;
}
