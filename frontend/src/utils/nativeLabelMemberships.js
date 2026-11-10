// Native labels identify entities, never IMAP folders or header-similar messages.
export function membershipScope(messages, translate = (key, fallback) => fallback) {
  const oneAccount = messages.length > 0 && messages.every(m => m.account_id === messages[0].account_id);
  const fail = error => ({ error, ...(oneAccount ? { accountId: messages[0].account_id, storageGeneration: messages[0].storageGeneration } : {}) });
  if (!messages.length) return fail(translate('gmail.memberships.selectMessages', "Select messages to label."));
  if (!oneAccount) return fail(translate('gmail.memberships.oneAccount', "Select messages from one account to change labels."));
  if (messages.some(m => m.is_draft)) return fail(translate('gmail.memberships.draftUnsupported', "Labels on drafts are not supported yet. Draft labels cannot be carried over to sent mail."));
  if (messages.some(m => m.nativeLabelState !== 'available' || !m.entityId || !m.storageGeneration)) return fail(translate('gmail.memberships.identityUnavailable', "Labels are unavailable until every selected message has a verified identity. Refresh after mail sync."));
  if (messages.some(m => m.storageGeneration !== messages[0].storageGeneration)) return fail(translate('gmail.memberships.accountChanged', "The account changed. Refresh the messages before editing labels."));
  const targets = [...new Set(messages.map(m => m.entityId))].map(entityId => ({ entityId }));
  if (targets.length > 200) return fail(translate('gmail.memberships.selectionLimit', "Select at most 200 messages at a time."));
  return { accountId: messages[0].account_id, storageGeneration: messages[0].storageGeneration, targets };
}
export function membershipStates(labels, targets) {
  return Object.fromEntries(labels.map(label => {
    const count = targets.filter(target => target.labelIds.includes(label.id)).length;
    return [label.id, count === targets.length ? true : count ? 'mixed' : false];
  }));
}
export function membershipDelta(initial, staged) {
  return { addLabelIds: Object.keys(staged).filter(id => staged[id] === true && initial[id] !== true),
    removeLabelIds: Object.keys(staged).filter(id => staged[id] === false && initial[id] !== false) };
}
export function canonicalMembershipTargets(targets, translate = (key, fallback) => fallback) {
  const canonical = new Map();
  for (const target of targets) {
    const previous = canonical.get(target.entityId);
    if (previous && previous.expectedMetadataVersion !== target.metadataVersion) throw new Error(translate('gmail.memberships.metadataConflict', "Conflicting metadata versions for one message. Refresh labels."));
    canonical.set(target.entityId, { entityId: target.entityId, expectedMetadataVersion: target.metadataVersion });
  }
  return [...canonical.values()];
}
export function verifiedMembershipSnapshot(data, scope) {
  return data?.accountId === scope.accountId && data?.storageGeneration === scope.storageGeneration
    && Array.isArray(data.targets) && data.targets.length === scope.targets.length
    && new Set(data.targets.map(target => target.requestedEntityId)).size === data.targets.length
    && scope.targets.every(target => data.targets.some(row => row.requestedEntityId === target.entityId
      && row.available === true && typeof row.entityId === 'string' && /^\d+$/.test(row.metadataVersion)
      && typeof row.metadataVersion === 'string' && Array.isArray(row.labelIds)));
}
export function definitiveMembershipFailure(error, recovering) {
  if (recovering) return (error.status === 409 && [
    'mutation_conflict', 'mutation_expired', 'stale_generation', 'stale_metadata_version', 'identity_unavailable',
    'undo_unavailable', 'undo_identity_changed', 'metadata_version_exhausted', 'identity_alias_conflict',
  ].includes(error.code)) || (error.status === 404 && ['identity_entity_missing', 'label_not_found'].includes(error.code));
  return error.status >= 400 && error.status < 500 && error.status !== 408;
}
const pendingKey = accountId => `mailflow:pending-native-membership:${accountId}`;
export function readPendingMembership(accountId) {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(pendingKey(accountId)) || 'null');
    return value?.accountId === accountId && typeof value.mutationId === 'string' && (Array.isArray(value.targets) || typeof value.originalMutationId === 'string') ? value : null;
  } catch { return null; }
}
export function savePendingMembership(accountId, payload) {
  try {
    if (payload) window.sessionStorage.setItem(pendingKey(accountId), JSON.stringify(payload));
    else window.sessionStorage.removeItem(pendingKey(accountId));
    return true;
  } catch { return false; }
}
// Different picker instances in one document cannot issue overlapping account decisions.
export const membershipRequests = new Set();
