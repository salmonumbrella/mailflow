import { labelViewKey, dedupeNativeMessages } from './nativeLabelNavigation.js';

// Refresh only the already loaded window, plus one bounded look-ahead for displaced
// members. Never interpret absence from a first page as proof of label removal.
const REFRESH_LOOKAHEAD = 100;
export function createNativeLabelFeed({ api, store, translate = (key, fallback) => fallback }) {
  let serial = 0;
  let pending = false;
  return {
    invalidate() { serial++; pending = false; },
    async load({ limit = 50, unreadOnly = false, append = false, reset = false } = {}) {
      const state = store.getState();
      const view = state.activeLabel;
      if (!view || append && (pending || !state.nativeLabelFeed?.nextCursor)) return;
      const key = labelViewKey(view);
      const refresh = !append && !reset && state.nativeLabelFeed?.key === key && state.nativeLabelFeed?.unreadOnly === unreadOnly;
      const previous = refresh ? [...state.messages] : [];
      const pageSize = Math.max(1, Math.min(100, Number(limit) || 50));
      const windowSize = append ? (state.nativeLabelFeed?.windowSize || state.messages.length) + pageSize
        : refresh ? Math.max(pageSize, state.nativeLabelFeed.windowSize || previous.length) : pageSize;
      const targetSize = refresh ? windowSize : pageSize;
      const request = ++serial;
      const userId = state.user?.id;
      let cursor = append ? state.nativeLabelFeed.nextCursor : undefined;
      pending = true;
      store.setState({ loadingMessages: true, nativeLabelFeed: { ...(!reset ? state.nativeLabelFeed : {}), key, unreadOnly, status: 'loading', error: null } });
      const current = () => request === serial && labelViewKey(store.getState().activeLabel) === key && store.getState().user?.id === userId && !store.getState().isLocked && (!store.getState().accounts?.find(account => account.id === view.accountId)?.storage_generation || store.getState().accounts.find(account => account.id === view.accountId).storage_generation === view.storageGeneration);
      try {
        let data;
        let rows = [];
        let scanned = 0;
        let pages = 0;
        const pageBudget = Math.ceil(targetSize / pageSize) + 1;
        const cursorSet = new Set();
        const aliases = new Map();
        const removed = new Set();
        const fetchPage = async count => {
          if (++pages > pageBudget) throw new Error(translate('gmail.labelNavigation.paginationLimit', "Label pagination exceeded the refresh limit. Reload from the first page."));
          if (cursorSet.has(cursor)) throw new Error(translate('gmail.labelNavigation.paginationStalled', "Label pagination did not advance. Reload from the first page."));
          cursorSet.add(cursor);
          const result = await api.getNativeLabelMessages(view.labelId, { ...view, labelId: undefined, limit: count, cursor, unreadOnly }).catch(error => { error.labelFeedMissing = error.status === 404; throw error; });
          if (!current()) return false;
          if (result.accountId !== view.accountId || result.storageGeneration !== view.storageGeneration || result.labelId !== view.labelId || !Array.isArray(result.messages)) throw new Error(translate('gmail.labelNavigation.wrongMailbox', "The label response belongs to a different mailbox. Reload labels."));
          if (refresh && result.nextCursor && result.messages.length < count || result.messages.length > count || result.messages.some(message => !message.entityId || message.storageGeneration !== view.storageGeneration || message.account_id !== view.accountId || !message.id || !message.folder)) throw new Error(translate('gmail.labelNavigation.unverifiedMessages', "Some label messages could not be verified. Reload after mail sync."));
          data = result;
          rows.push(...result.messages);
          scanned += result.messages.length;
          cursor = result.nextCursor || null;
          return true;
        };
        do {
          if (!await fetchPage(Math.min(pageSize, targetSize - scanned))) return;
        } while (refresh && cursor && scanned < targetSize);
        const missing = () => {
          const found = new Set(rows.map(message => message.entityId));
          return previous.filter(message => !removed.has(message.entityId) && !found.has(aliases.get(message.entityId) || message.entityId));
        };
        if (refresh && cursor && missing().length && api.queryNativeLabelMemberships) {
          const absent = missing();
          for (let index = 0; index < absent.length; index += 200) {
            const targets = absent.slice(index, index + 200).map(message => ({ entityId: message.entityId }));
            const snapshot = await api.queryNativeLabelMemberships({ accountId: view.accountId, storageGeneration: view.storageGeneration, targets });
            if (!current()) return;
            if (snapshot.accountId !== view.accountId || snapshot.storageGeneration !== view.storageGeneration || !Array.isArray(snapshot.targets) || targets.some(target => !snapshot.targets.some(row => row.requestedEntityId === target.entityId && typeof row.entityId === 'string' && Array.isArray(row.labelIds)))) throw new Error(translate('gmail.labelNavigation.unverifiedMemberships', "Label memberships could not be verified. The previous list has been kept."));
            for (const target of snapshot.targets) {
              aliases.set(target.requestedEntityId, target.entityId);
              if (!target.labelIds.includes(view.labelId)) removed.add(target.requestedEntityId);
            }
          }
        }
        // New arrivals can push the open/checked rows past the old window. Find them
        // within a fixed extra budget; on exhaustion preserve the prior view as stale,
        // rather than silently closing the reader or retaining a supposed live member.
        const scanLimit = scanned + REFRESH_LOOKAHEAD;
        while (refresh && cursor && missing().length && scanned < scanLimit) {
          if (!await fetchPage(Math.min(100, scanLimit - scanned))) return;
        }
        if (refresh && cursor && missing().length) throw new Error(translate('gmail.labelNavigation.windowChanged', "Mail changed beyond the loaded window. The previous list is shown until it can be verified. Reload from the first page to start a fresh view."));
        const messages = dedupeNativeMessages(append ? [...store.getState().messages, ...rows] : rows, view);
        store.setState(state => {
          const selected = state.messages.find(message => message.id === state.selectedMessageId);
          const selectedEntity = aliases.get(selected?.entityId) || selected?.entityId;
          return { messages, messagesTotal: data.total, messagesOffset: messages.length,
            hasMoreMessages: !!data.nextCursor, loadingMessages: false,
            selectedMessageId: messages.find(message => message.id === state.selectedMessageId || selectedEntity && message.entityId === selectedEntity)?.id || null,
            nativeLabelFeed: { key, unreadOnly, windowSize, status: 'ready', error: null, nextCursor: data.nextCursor || null, coverage: data.coverage, unread: data.unread,
              entityAliases: Object.fromEntries(aliases) },
          };
        });
      } catch (error) {
        if (!current()) return;
        if (error.labelFeedMissing || error.code === 'storage_generation_conflict' || error.code === 'stale_generation') {
          store.getState().setSelectedAccount(view.accountId, 'INBOX', { replaceHistory: true });
          store.getState().addNotification?.({ type: 'error', title: translate('gmail.labelNavigation.unavailable', "This label is no longer available. Inbox opened.") });
          return;
        }
        store.setState({ loadingMessages: false, nativeLabelFeed: { ...store.getState().nativeLabelFeed, key, unreadOnly, status: 'error', error: error.message || translate('gmail.labelNavigation.loadFailed', "Labels could not be loaded.") } });
      } finally { if (request === serial) pending = false; }
    },
  };
}
