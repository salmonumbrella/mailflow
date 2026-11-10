import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) {
      return {
        format: 'module',
        source: `export default ${readFileSync(new URL(url), 'utf8')}`,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

globalThis.localStorage = (() => {
  let values = { mailflow_theme: 'dark' };
  return {
    getItem: key => values[key] ?? null,
    setItem: (key, value) => { values[key] = String(value); },
    removeItem: key => { delete values[key]; },
    clear: () => { values = {}; },
  };
})();

const { api } = await import('../utils/api.js');
const { useStore } = await import('./index.js');
const originalApi = { ...api };
const A = { id: 'a', label: 'Alice', query: 'from:alice' };
const B = { id: 'b', label: 'Files', query: 'has:attachment' };
const deferred = () => { let resolve; let reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const prefs = { savedSplits: [A], hideEmptySplits: false, savedSplitsRevision: 3 };
beforeEach(() => {
  useStore.setState({ ...useStore.getInitialState(), user: { id: 'a' }, isLocked: false, layout: 'superhuman', selectedFolder: 'INBOX', ...prefs, savedSplitsLoaded: true });
  api.getPreferences = async () => ({ ...prefs, aiActions: [] });
  api.savePreferences = async () => ({});
  api.getSavedSplits = async () => prefs;
  api.saveSavedSplits = async values => ({ ...values, savedSplitsRevision: values.savedSplitsRevision + 1 });
});
afterEach(() => Object.assign(api, originalApi));
describe('saved split state', () => {
  it('persists only after success and cannot overlap same-window saves', async () => {
    const request = deferred(); api.saveSavedSplits = () => request.promise;
    const saving = useStore.getState().saveSavedSplits([B], true, 3);
    assert.deepEqual(useStore.getState().savedSplits, [A]);
    await assert.rejects(useStore.getState().saveSavedSplits([], false, 3), /already in progress/);
    request.resolve({ savedSplits: [B], hideEmptySplits: true, savedSplitsRevision: 4 }); await saving;
    assert.deepEqual(useStore.getState().savedSplits, [B]); assert.equal(useStore.getState().savedSplitsSaving, false);
  });
  it('does not overwrite state or claim success after a server error', async () => {
    api.saveSavedSplits = async () => { throw new Error('409 conflict'); };
    await assert.rejects(useStore.getState().saveSavedSplits([], true, 3), /conflict/);
    assert.deepEqual(useStore.getState().savedSplits, [A]); assert.equal(useStore.getState().savedSplitsSaving, false);
  });
  it('rejects an obsolete editor before transmitting another write', async () => {
    let calls = 0; api.saveSavedSplits = async () => { calls++; };
    await assert.rejects(useStore.getState().saveSavedSplits([], false, 2), /changed/); assert.equal(calls, 0);
  });
  it('discards a deferred save through user A to B to A', async () => {
    const request = deferred(); api.saveSavedSplits = () => request.promise;
    const saving = useStore.getState().saveSavedSplits([B], true, 3);
    useStore.getState().setUser({ id: 'b' }); useStore.getState().setUser({ id: 'a' });
    request.resolve({ savedSplits: [B], hideEmptySplits: true, savedSplitsRevision: 4 });
    assert.equal(await saving, false); assert.deepEqual(useStore.getState().savedSplits, []); assert.equal(useStore.getState().savedSplitsLoaded, false);
  });
  it('clears private queries on lock and discards their pending save', async () => {
    const request = deferred(); api.saveSavedSplits = () => request.promise;
    useStore.getState().selectSavedSplit('a'); const saving = useStore.getState().saveSavedSplits([B], true, 3);
    useStore.getState().setLocked(true); request.resolve({ savedSplits: [B], hideEmptySplits: true, savedSplitsRevision: 4 }); await saving;
    assert.deepEqual(useStore.getState().savedSplits, []); assert.equal(useStore.getState().activeSavedSplitId, null);
  });
  it('drops delayed hydration after a successful local edit', async () => {
    const request = deferred(); api.getPreferences = () => request.promise;
    const loading = useStore.getState().loadPreferences(); await useStore.getState().saveSavedSplits([B], true, 3);
    request.resolve({ ...prefs, aiActions: [] }); await loading;
    assert.deepEqual(useStore.getState().savedSplits, [B]); assert.equal(useStore.getState().savedSplitsRevision, 4);
  });
  it('orders repeated reloads and drops older user reads', async () => {
    const old = deferred(); api.getSavedSplits = () => old.promise;
    const loading = useStore.getState().loadSavedSplits();
    api.getSavedSplits = async () => ({ ...prefs, savedSplits: [B], savedSplitsRevision: 8 }); await useStore.getState().loadSavedSplits();
    old.resolve(prefs); await loading; assert.deepEqual(useStore.getState().savedSplits, [B]);
    const previous = deferred(); api.getSavedSplits = () => previous.promise; const previousLoad = useStore.getState().loadSavedSplits();
    useStore.getState().setUser({ id: 'new' }); previous.resolve(prefs); await previousLoad; assert.deepEqual(useStore.getState().savedSplits, []);
  });
  it('updates or clears the active native query after edits and deletes', async () => {
    useStore.getState().selectSavedSplit('a'); await useStore.getState().saveSavedSplits([{ ...A, query: 'is:unread' }], false, 3);
    assert.equal(useStore.getState().searchQuery, 'is:unread'); await useStore.getState().saveSavedSplits([], false, 4);
    assert.equal(useStore.getState().searchQuery, ''); assert.equal(useStore.getState().activeSavedSplitId, null);
  });
  it('manual search and account navigation clear split selection without changing saved definitions', () => {
    useStore.getState().selectSavedSplit('a'); useStore.getState().setSearchQuery('subject:new');
    assert.equal(useStore.getState().activeSavedSplitId, null);
    useStore.getState().selectSavedSplit('a'); useStore.getState().setSelectedAccount('other', 'Archive');
    assert.equal(useStore.getState().searchQuery, ''); assert.deepEqual(useStore.getState().savedSplits, [A]);
  });
  it('does not empty active results when reselecting, renaming or reordering the same query', async () => {
    useStore.getState().selectSavedSplit('a'); useStore.setState({ searchResults: [{ id: 'mail' }], selectedMessageId: 'mail' });
    useStore.getState().selectSavedSplit('a'); assert.deepEqual(useStore.getState().searchResults, [{ id: 'mail' }]);
    assert.equal(useStore.getState().selectedMessageId, null);
    await useStore.getState().saveSavedSplits([{ ...A, label: 'Renamed' }], true, 3);
    assert.deepEqual(useStore.getState().searchResults, [{ id: 'mail' }]);
  });
  it('reconciles the active rule after explicit reload and clears a remotely deleted split', async () => {
    useStore.getState().selectSavedSplit('a');
    api.getSavedSplits = async () => ({ ...prefs, savedSplits: [{ ...A, query: 'is:unread' }], savedSplitsRevision: 4 });
    await useStore.getState().loadSavedSplits(); assert.equal(useStore.getState().searchQuery, 'is:unread');
    api.getSavedSplits = async () => ({ ...prefs, savedSplits: [], savedSplitsRevision: 5 });
    await useStore.getState().loadSavedSplits(); assert.equal(useStore.getState().searchQuery, ''); assert.equal(useStore.getState().activeSavedSplitId, null);
  });

});
