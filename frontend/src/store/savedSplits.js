import { savedSplitPreferences, validateSavedSplits } from '../utils/savedSplits.js';

export function resetSavedSplitsState(epoch = 0) {
  return {
    savedSplits: [], hideEmptySplits: false, savedSplitsRevision: 0,
    savedSplitsLoaded: false, savedSplitsSaving: false, savedSplitsEpoch: epoch + 1,
    activeSavedSplitId: null,
  };
}

export function createSavedSplitsState(set, get, api) {
  const current = (userId, epoch) => get().user?.id === userId && !get().isLocked && get().savedSplitsEpoch === epoch;
  const applyPreferences = prefs => {
    const clean = savedSplitPreferences(prefs);
    const state = get();
    const active = clean.savedSplits.find(split => split.id === state.activeSavedSplitId);
    const queryChanged = state.activeSavedSplitId && (!active || active.query !== state.searchQuery);
    set({ ...clean, savedSplitsLoaded: true,
      ...(queryChanged ? { activeSavedSplitId: active?.id ?? null, searchQuery: active?.query ?? '',
        searchResults: [], selectedMessageId: null, listFocusedMessageId: null,
        replyDrafts: {}, replyDraftRevision: state.replyDraftRevision + 1 } : {}),
    });
  };
  return {
    ...resetSavedSplitsState(),
    hydrateSavedSplits: (prefs, epoch) => {
      if (get().isLocked || get().savedSplitsSaving || get().savedSplitsEpoch !== epoch) return;
      applyPreferences(prefs);
    },
    loadSavedSplits: async () => {
      const { user } = get();
      if (!user || get().isLocked || get().savedSplitsSaving) return;
      const epoch = get().savedSplitsEpoch + 1;
      set({ savedSplitsEpoch: epoch });
      const prefs = await api.getSavedSplits();
      if (current(user.id, epoch)) get().hydrateSavedSplits(prefs, epoch);
    },
    saveSavedSplits: async (savedSplits, hideEmptySplits, expectedRevision) => {
      const state = get();
      if (!state.user || state.isLocked) throw new Error('Sign in to save splits.');
      if (state.savedSplitsSaving) throw new Error('A split save is already in progress.');
      if (!state.savedSplitsLoaded) throw new Error('Load your saved splits before editing.');
      if (!validateSavedSplits(savedSplits) || typeof hideEmptySplits !== 'boolean') throw new Error('Check split names and queries. Names must be unique.');
      if (expectedRevision !== state.savedSplitsRevision) throw new Error('Saved splits changed. Reload them before saving again.');
      const epoch = state.savedSplitsEpoch + 1;
      const userId = state.user.id;
      set({ savedSplitsSaving: true, savedSplitsEpoch: epoch });
      try {
        const prefs = await api.saveSavedSplits({ savedSplits, hideEmptySplits, savedSplitsRevision: expectedRevision });
        if (!current(userId, epoch)) return false;
        applyPreferences(prefs);
        return true;
      } finally {
        // A general preference read can start while this write is in flight. Fence it
        // when the write settles too, so its older snapshot cannot undo the saved value.
        if (current(userId, epoch)) set({ savedSplitsSaving: false, savedSplitsEpoch: epoch + 1 });
      }
    },
    selectSavedSplit: id => {
      const state = get();
      if (!state.user || state.isLocked || state.layout !== 'superhuman' || state.selectedFolder !== 'INBOX') return;
      const split = state.savedSplits.find(item => item.id === id);
      if (id && !split) return;
      if (split && state.activeSavedSplitId === split.id && state.searchQuery === split.query) {
        set({ selectedMessageId: null });
        return;
      }
      set({ activeSavedSplitId: split?.id ?? null, searchQuery: split?.query ?? '', searchResults: [],
        selectedMessageId: null, listFocusedMessageId: null, activeGtdTab: null,
        replyDrafts: {}, replyDraftRevision: state.replyDraftRevision + 1,
      });
    },
  };
}
