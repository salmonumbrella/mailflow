import { folderRole } from './folderDisplay.js';

// Identity fields, not mutable read/star flags. A refreshed UID or storage generation is
// a different source even if the visible row kept its database id.
export const listMessageIdentity = message => JSON.stringify([
  message?.id, message?.account_id, message?.folder, message?.uid,
  message?.entityId, message?.storageGeneration, message?.storage_generation,
  message?.thread_id, message?.message_count, message?.is_draft, message?.in_trash,
]);

export function listActionScopeKey(state, selectedIds, view, generation) {
  return JSON.stringify([
    view, generation, state.selectedAccountId, state.selectedFolder, state.searchQuery,
    state.activeLabel, state.nativeLabelFeed?.key, state.nativeLabelFeed?.status,
    state.selectedMessageId, [...selectedIds].sort(), state.threadedView,
    Object.entries(state.folders || {}).map(([id, folders]) => [id, folders.map(folder => [folder.path, folder.special_use])]),
    state.accounts.map(account => [account.id, account.storage_generation, account.enabled, account.include_in_unified_inbox, account.folder_mappings]),
  ]);
}

export function listActionTargetsCurrent(messages, state) {
  return messages.every(message => {
    const account = state.accounts.find(item => item.id === message?.account_id);
    const generation = message?.storageGeneration || message?.storage_generation;
    return Boolean(message?.id && account && account.enabled !== false)
      && !(generation && account.storage_generation && generation !== account.storage_generation);
  });
}

export function listActionSourceKey(rows, state) {
  const pool = state.searchQuery.trim() ? state.searchResults : state.messages;
  const expanded = state.expandedThreadId;
  const hasExpandedParent = expanded && pool.some(message => (message.thread_id || message.id) === expanded);
  const sources = rows.map(row => {
    const identity = listMessageIdentity(row);
    if (pool.some(current => listMessageIdentity(current) === identity)) return ['list', identity];
    if (hasExpandedParent && state.threadMessages?.[expanded]?.some(current => listMessageIdentity(current) === identity)) return ['expanded', expanded, identity];
    return null;
  });
  return sources.every(Boolean) ? JSON.stringify(sources) : null;
}

export function listActionRowsCurrent(rows, state) {
  return listActionTargetsCurrent(rows, state) && listActionSourceKey(rows, state) !== null;
}

export function isPermanentListDelete(message, state) {
  const account = state.accounts.find(item => item.id === message.account_id);
  const folder = state.folders[message.account_id]?.find(item => item.path === message.folder) || { path: message.folder };
  return Boolean(message.in_trash || message.is_draft)
    || ['trash', 'drafts'].includes(folderRole(folder, account?.folder_mappings))
    || /^(?:\[gmail\]\/|\[google mail\]\/)?(?:trash|bin|deleted items|deleted messages|drafts)$/i.test(message.folder || '');
}

// The list may carry aggregate/read metadata that the thread members do not. Only
// compare mailbox identity here; absence is not evidence of replacement in a cache.
export function sameListActionTarget(expected, current, requireKnown = true) {
  if (!current || current.id !== expected.id || current.account_id !== expected.account_id) return false;
  const known = message => ({
    uid: message.uid, folder: message.folder, entityId: message.entityId,
    generation: message.storageGeneration ?? message.storage_generation,
  });
  const before = known(expected), after = known(current);
  return Object.entries(before).every(([key, value]) => value == null
    || (!requireKnown && after[key] == null) || value === after[key]);
}

// Selection/navigation can change after authorization. Mailbox generation and any
// observable locator replacement cannot: the queued ids still mean the old mail.
export function createListActionCommitGuard(targets, state) {
  const userId = state.user?.id;
  const accountKey = account => account ? JSON.stringify([
    account.id, account.storage_generation, account.enabled !== false,
    account.email_address, account.imap_host, account.imap_username,
  ]) : null;
  const accounts = new Map(targets.map(target => [target.account_id,
    accountKey(state.accounts.find(account => account.id === target.account_id))]));
  const frozen = targets.map(target => ({ ...target }));
  return current => {
    if (current.user?.id !== userId || !listActionTargetsCurrent(frozen, current)) return false;
    for (const [id, key] of accounts) {
      if (!key || key !== accountKey(current.accounts.find(account => account.id === id))) return false;
    }
    const observed = [...(current.messages || []), ...(current.searchResults || []), ...Object.values(current.threadMessages || {}).flat()];
    return frozen.every(target => !observed.some(message => message?.id === target.id && !sameListActionTarget(target, message, false)));
  };
}
