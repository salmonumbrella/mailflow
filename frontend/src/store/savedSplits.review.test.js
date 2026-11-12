import { afterEach, beforeEach, it } from 'node:test';
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
it('review: global preference hydration begun during a split save cannot replace that successful save', async () => {
  const write = deferred(); const read = deferred();
  api.saveSavedSplits = () => write.promise;
  const saving = useStore.getState().saveSavedSplits([B], true, 3);
  api.getPreferences = () => read.promise;
  const loading = useStore.getState().loadPreferences();
  write.resolve({ savedSplits: [B], hideEmptySplits: true, savedSplitsRevision: 4 });
  assert.equal(await saving, true);
  read.resolve({ ...prefs, aiActions: [] }); await loading;
  assert.deepEqual(useStore.getState().savedSplits, [B]);
  assert.equal(useStore.getState().savedSplitsRevision, 4);
});

it('review: hydration resolving before an in-flight write leaves the local snapshot intact until save succeeds', async () => {
  const write = deferred(); api.saveSavedSplits = () => write.promise;
  const saving = useStore.getState().saveSavedSplits([B], true, 3);
  api.getPreferences = async () => ({ savedSplits: [], savedSplitsRevision: 2, aiActions: [] });
  await useStore.getState().loadPreferences();
  assert.deepEqual(useStore.getState().savedSplits, [A]); assert.equal(useStore.getState().savedSplitsSaving, true);
  write.resolve({ savedSplits: [B], hideEmptySplits: true, savedSplitsRevision: 4 }); await saving;
  assert.deepEqual(useStore.getState().savedSplits, [B]); assert.equal(useStore.getState().savedSplitsSaving, false);
});
