// Prevent two sessions in this backend process from both passing the label-copy
// cache check for the same Watch thread. Other states and backend processes are
// outside this guard; it is not a durable provider-copy idempotency token.
const activeWatchClassifications = new Set();

export function tryAcquireWatchClassification(message) {
  const identity = message.thread_key
    ? ['thread', message.thread_key]
    : message.message_id
      ? ['message', message.message_id]
      : ['copy', message.folder, message.uid];
  const key = JSON.stringify([message.account_id, ...identity]);
  if (activeWatchClassifications.has(key)) return null;
  activeWatchClassifications.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeWatchClassifications.delete(key);
  };
}
