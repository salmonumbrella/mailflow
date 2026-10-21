import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { setImmediate } from 'node:timers';
import { JSDOM } from 'jsdom';

registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.json')) return { format: 'module', shortCircuit: true,
    source: `export default ${readFileSync(new URL(url), 'utf8')}` };
  if (url.startsWith('file:') && url.endsWith('.js')) {
    const code = readFileSync(new URL(url), 'utf8');
    if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true,
      source: code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
  }
  return nextLoad(url, context);
} });

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  IS_REACT_ACT_ENVIRONMENT: true, __VITE_ENV__: { MODE: 'test', PROD: true } });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
api.savePreferences = async () => ({ ok: true });
const Observer = (await import('./InboxReplyDraftObserver.js')).default;
const { openReplyDraft } = await import('../utils/openReplyDraft.js');
const row = id => ({ id, account_id: 'acct', folder: 'INBOX', message_id: `<${id}@example.test>` });
const draft = id => ({ id: `draft-${id}`, account_id: 'acct', folder: 'Drafts', uid: 5,
  message_id: `<draft-${id}@example.test>`, in_reply_to: `<${id}@example.test>`, attachments_complete: true,
  from_email: 'me@example.test', to_addresses: ['recipient@example.test'] });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
// These fakes have no editor-local state; mounted-composer tests own the dirty check.
const prepared = fn => Object.assign(fn, { canReplace: () => true });
let root;
before(async () => { root = createRoot(document.getElementById('root')); });
after(async () => { await React.act(async () => root.unmount()); });
async function reset({ autoOpenReplyDrafts = false, count = 3 } = {}) {
  await React.act(async () => root.render(null));
  useStore.setState({ user: { id: 'reader' }, selectedMessageId: null, selectedFolder: 'INBOX', selectedAccountId: null,
    messages: Array.from({length: count}, (_, i) => row(String(i))), searchResults: [], searchQuery: '',
    threadMessages: {}, composing: false, composeData: null, prepareComposeSwitch: null,
    replyDrafts: {}, replyDraftRevision: 0, notifications: [], autoOpenReplyDrafts, conversationMode: 'off' });
  api.getReplyDraftIndicators = async ids => ({ indicators: Object.fromEntries(ids.map(id => [id, { exists: true }])) });
  api.getReplyDraft = async id => ({ draft: draft(id), body: { text: `Reply ${id}`, attachments: [] } });
}
async function mount() { await React.act(async () => root.render(React.createElement(Observer, { lookupDelayMs: 0 }))); }
async function select(id) { await React.act(async () => useStore.getState().setSelectedMessage(id)); }

test('default selection and refresh use only synced indicators and leave compose untouched', async () => {
  await reset(); let live = 0;
  api.getReplyDraft = async () => { live++; return { draft: null }; };
  api.getReplyDraftIndicators = async ids => ({ indicators: Object.fromEntries(ids.map(id => [id, { exists: id === '0' }])) });
  await mount(); await select('0');
  assert.equal(useStore.getState().replyDrafts['0'].exists, true);
  assert.equal(useStore.getState().composing, false);
  useStore.setState({ prepareComposeSwitch: prepared(async () => true) });
  await React.act(async () => useStore.getState().openCompose({ subject: 'Manual' }));
  await select('1'); await select('2');
  await React.act(async () => useStore.getState().invalidateReplyDrafts());
  assert.equal(useStore.getState().composeData.subject, 'Manual');
  assert.equal(useStore.getState().replyDrafts['1'].exists, false);
  assert.equal(live, 0);
});

test('slow cached batches cannot resurrect a newer live absence', async () => {
  await reset({ autoOpenReplyDrafts: true }); const cached = deferred();
  api.getReplyDraftIndicators = () => cached.promise;
  api.getReplyDraft = async () => ({ draft: null });
  await mount(); await select('0');
  await React.act(async () => cached.resolve({ indicators: { '0': { exists: true } } }));
  assert.equal(useStore.getState().replyDrafts['0'].exists, false);
});

test('rapid selection ignores stale live results and batching chunks at 100', async () => {
  await reset({ count: 201, autoOpenReplyDrafts: true }); const batches = [];
  api.getReplyDraftIndicators = async ids => { batches.push(ids); return { indicators: Object.fromEntries(ids.map(id => [id, { exists: true }])) }; };
  const old = deferred(); api.getReplyDraft = id => id === '0' ? old.promise : Promise.resolve({ draft: null });
  await mount(); await select('0'); await select('1');
  await React.act(async () => old.resolve({ draft: draft('0') }));
  assert.deepEqual(batches.map(ids => ids.length), [100, 100, 1]);
  assert.equal(useStore.getState().replyDrafts['1'].exists, false);
  assert.equal(useStore.getState().composing, false);
});

test('opt-in opens an automatic draft but never replaces an explicit/manual composer', async () => {
  await reset({ autoOpenReplyDrafts: true }); await mount(); await select('0');
  assert.equal(useStore.getState().composeData.source, 'automaticReplyDraft');
  useStore.setState({ prepareComposeSwitch: prepared(async () => true) });
  await React.act(async () => useStore.getState().openCompose({ subject: 'Manual' }));
  await select('1');
  assert.equal(useStore.getState().composeData.subject, 'Manual');
});

test('explicit opening revalidates after saving and keeps a failed save open', async () => {
  await reset(); await select('0');
  useStore.getState().openCompose({ subject: 'Old' });
  useStore.setState({ prepareComposeSwitch: prepared(async () => false) });
  assert.equal(await openReplyDraft('0'), false);
  assert.equal(useStore.getState().composeData.subject, 'Old');
  let calls = 0;
  useStore.setState({ prepareComposeSwitch: prepared(async () => true) });
  api.getReplyDraft = async () => ++calls === 1 ? { draft: draft('0'), body: { text: 'Reply', attachments: [] } } : { draft: null };
  assert.equal(await openReplyDraft('0'), false);
  assert.equal(calls, 2);
  assert.equal(useStore.getState().composeData.subject, 'Old');
});

test('a different manual compose opened during a pending save owns the composer', async () => {
  await reset(); await select('0');
  useStore.getState().openCompose({ subject: 'Old' });
  const saving = deferred(); useStore.setState({ prepareComposeSwitch: prepared(() => saving.promise) });
  const opening = openReplyDraft('0'); await Promise.resolve(); await Promise.resolve();
  useStore.getState().openCompose({ subject: 'New manual' });
  saving.resolve(true);
  assert.equal(await opening, false);
  assert.equal(useStore.getState().composeData.subject, 'New manual');
});

test('explicit opening owns a manual session and retains From provenance', async () => {
  await reset(); await select('0');
  assert.equal(await openReplyDraft('0'), true);
  assert.equal(useStore.getState().composeData.source, 'manualReplyDraft');
  assert.equal(useStore.getState().composeData.accountId, 'acct');
});

test('an explicit opening survives refresh invalidation during a delayed live lookup', async () => {
  await reset(); await mount(); await select('0');
  const pending = deferred(); api.getReplyDraft = () => pending.promise;
  const opening = openReplyDraft('0');
  await React.act(async () => window.dispatchEvent(new CustomEvent('mailflow:refresh')));
  pending.resolve({ draft: draft('0'), body: { text: 'Still current', attachments: [] } });
  assert.equal(await opening, true);
  assert.equal(useStore.getState().composeData.body, 'Still current');
  assert.equal(useStore.getState().replyDrafts['0']?.exists, true);
});

test('explicit opening reports cancellation when the selection changes', async () => {
  await reset(); await select('0');
  const pending = deferred(); api.getReplyDraft = () => pending.promise;
  const opening = openReplyDraft('0');
  await select('1');
  pending.resolve({ draft: draft('0'), body: { text: 'Old selection', attachments: [] } });
  assert.equal(await opening, false);
  assert.equal(useStore.getState().composing, false);
  assert.ok(useStore.getState().notifications.some(n => n.body.includes('cancelled')));
});

test('auto-open waits for cached indicators and skips a known negative or unknown conversation', async () => {
  for (const status of [{ exists: false }, { unknown: true }]) {
    await reset({ autoOpenReplyDrafts: true });
    const cached = deferred(); let live = 0;
    api.getReplyDraftIndicators = () => cached.promise;
    api.getReplyDraft = async () => { live++; return { draft: null }; };
    await mount(); await select('0');
    assert.equal(live, 0);
    await React.act(async () => cached.resolve({ indicators: { '0': status } }));
    assert.equal(live, 0);
    assert.equal(useStore.getState().composing, false);
  }
});

test('navigation outside inbox cancels pending lookup and a lookup failure remains an error', async () => {
  await reset({ autoOpenReplyDrafts: true }); const pending = deferred(); api.getReplyDraft = () => pending.promise;
  await mount(); await select('0');
  await React.act(async () => useStore.setState({ selectedFolder: 'Sent' }));
  await React.act(async () => pending.resolve({ draft: draft('0') }));
  assert.equal(useStore.getState().composing, false);
  await reset({ autoOpenReplyDrafts: true }); api.getReplyDraft = async () => { throw new Error('Server unavailable'); };
  await mount(); await select('0');
  assert.equal(useStore.getState().replyDrafts['0'].error, 'Server unavailable');
});


test('an explicit opening wins over a concurrent automatic opening', async () => {
  await reset(); await select('0');
  const pending = deferred(); api.getReplyDraft = () => pending.promise;
  const manual = openReplyDraft('0');
  const automatic = openReplyDraft('0', { automatic: true });
  pending.resolve({ draft: draft('0'), body: { text: 'Reply', attachments: [] } });
  assert.equal(await automatic, false);
  assert.equal(await manual, true);
  assert.equal(useStore.getState().composeData.source, 'manualReplyDraft');
});

test('changing conversation or search scope invalidates earlier live indicators', async () => {
  await reset();
  useStore.getState().setReplyDraftStatus('0', { exists: false }, 'live');
  useStore.getState().setConversationMode('pane');
  assert.deepEqual(useStore.getState().replyDrafts, {});
  useStore.getState().setReplyDraftStatus('0', { exists: true }, 'live');
  useStore.getState().setSearchQuery('report');
  assert.deepEqual(useStore.getState().replyDrafts, {});
});

test('a selected inbox message parked by a deep link gets a synced reading-pane indicator', async () => {
  await reset({ count: 0 });
  let live = 0;
  api.getReplyDraft = async () => { live++; return { draft: null }; };
  api.getReplyDraftIndicators = async ids => ({ indicators: Object.fromEntries(ids.map(id => [id, { exists: true }])) });
  useStore.setState({ threadMessages: { '__dl_0': [row('0')] } });
  await mount(); await select('0');
  assert.equal(useStore.getState().replyDrafts['0']?.exists, true);
  assert.equal(useStore.getState().composing, false);
  assert.equal(live, 0);
});

test('automatic opening reuses the freshly validated body from one live request', async () => {
  await reset({ autoOpenReplyDrafts: true });
  const requests = [];
  api.getReplyDraft = async (id, scope) => {
    requests.push({ id, scope });
    return { draft: draft(id), body: { text: 'Fresh reply', attachments: [] } };
  };
  await mount(); await select('0');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].scope.open, true);
  assert.equal(useStore.getState().composeData.body, 'Fresh reply');
});

test('visible row changes reuse the selected live indicator, while refresh checks again', async () => {
  await reset({ autoOpenReplyDrafts: true });
  let lookups = 0;
  api.getReplyDraft = async () => { lookups++; return { draft: null }; };
  await mount(); await select('0');
  assert.equal(lookups, 1);
  await React.act(async () => useStore.setState({ messages: [row('0'), row('3')] }));
  assert.equal(lookups, 1);
  await React.act(async () => useStore.getState().invalidateReplyDrafts());
  assert.equal(lookups, 2);
});

test('an automatic opening cannot apply a live result from the previous selection', async () => {
  await reset(); await select('1');
  assert.equal(await openReplyDraft('0', { automatic: true,
    liveResult: { draft: draft('0'), body: { text: 'Old reply', attachments: [] } } }), false);
  assert.equal(useStore.getState().composing, false);
});

test('automatic reuse rejects a result after account, conversation, or refresh scope changes', async () => {
  for (const change of [
    () => useStore.getState().setConversationMode('pane'),
    () => useStore.setState({ selectedAccountId: 'other-account' }),
    () => useStore.getState().invalidateReplyDrafts(),
  ]) {
    await reset(); await select('0');
    const liveResult = { draft: draft('0'), body: { text: 'Old scope', attachments: [] } };
    const liveScope = { accountId: undefined, threaded: false };
    change();
    assert.equal(await openReplyDraft('0', { automatic: true, liveResult, liveScope, liveRevision: 0 }), false);
    assert.equal(useStore.getState().composing, false);
  }
});


test('a manual composer prevents any automatic live lookup', async () => {
  await reset({ autoOpenReplyDrafts: true });
  useStore.getState().openCompose({ subject: 'Manual' });
  let calls = 0;
  api.getReplyDraft = async () => { calls++; return { draft: null }; };
  await mount(); await select('0');
  assert.equal(calls, 0);
  assert.equal(useStore.getState().composeData.subject, 'Manual');
});

test('turning auto-open off during lookup discards its response', async () => {
  await reset({ autoOpenReplyDrafts: true });
  const pending = deferred(); api.getReplyDraft = () => pending.promise;
  await mount(); await select('0');
  await React.act(async () => useStore.setState({ autoOpenReplyDrafts: false }));
  await React.act(async () => pending.resolve({ draft: draft('0'), body: { text: 'Old', attachments: [] } }));
  assert.equal(useStore.getState().composing, false);
  assert.equal(useStore.getState().replyDrafts['0']?.source, 'cached');
});

for (const stage of ['first lookup', 'after save']) for (const nextUser of [null, { id: 'other-reader' }]) {
  test(`explicit ${stage} cannot update state after ownership changes to ${nextUser?.id || 'signed out'}`, async () => {
    await reset(); await select('0');
    const pending = deferred(); let calls = 0;
    if (stage === 'after save') {
      useStore.getState().openCompose({ subject: 'Existing' });
      useStore.setState({ prepareComposeSwitch: prepared(async () => true) });
    }
    api.getReplyDraft = async () => ++calls === (stage === 'after save' ? 2 : 1) ? pending.promise
      : { draft: draft('0'), body: { text: 'Reply', attachments: [] } };
    const opening = openReplyDraft('0');
    await new Promise(resolve => setImmediate(resolve));
    useStore.getState().setUser(nextUser);
    pending.resolve({ draft: draft('0'), body: { text: 'Old owner', attachments: [] } });
    assert.equal(await opening, false);
    // An identity change closes the composer that was open (store setUser), and the cancelled
    // handoff must not open one for the new owner.
    assert.equal(useStore.getState().composeData, null);
    assert.deepEqual(useStore.getState().replyDrafts, {});
    assert.deepEqual(useStore.getState().notifications, []);
  });
}

test('an unrelated indicator revision change while saving does not cancel an explicit handoff', async () => {
  await reset(); await select('0');
  useStore.getState().openCompose({ subject: 'Existing' });
  useStore.setState({ prepareComposeSwitch: prepared(async () => { useStore.getState().invalidateReplyDrafts(); return true; }) });
  assert.equal(await openReplyDraft('0'), true);
  assert.equal(useStore.getState().composeData.source, 'manualReplyDraft');
  assert.equal(useStore.getState().composeData.body, 'Reply 0');
});

for (const change of [{ selectedMessageId: '1' }, { selectedAccountId: 'other-account' }]) {
  test(`a live result cannot write status during a batched scope change ${JSON.stringify(change)}`, async () => {
    await reset({ autoOpenReplyDrafts: true });
    const pending = deferred();
    api.getReplyDraft = id => id === '0' ? pending.promise : Promise.resolve({ draft: null });
    await mount(); await select('0');
    await React.act(async () => {
      useStore.setState(change);
      pending.resolve({ draft: draft('0'), body: { text: 'Old scope', attachments: [] } });
      await Promise.resolve();
      assert.notEqual(useStore.getState().replyDrafts['0']?.source, 'live');
    });
    assert.equal(useStore.getState().composing, false);
  });
}

for (const selections of [['1'], ['1', '0']]) test(`selection during automatic handoff retries ${selections.join(' then ')}`, async () => {
  await reset({ autoOpenReplyDrafts: true });
  const saving = deferred();
  const calls = [];
  useStore.getState().openCompose({ source: 'automaticReplyDraft', subject: 'Initial editor' });
  useStore.setState({ prepareComposeSwitch: prepared(() => saving.promise) });
  api.getReplyDraft = async id => { calls.push(id); return { draft: draft(id), body: { text: 'Reply ' + id, attachments: [] } }; };
  await mount(); await select('0');
  assert.deepEqual(calls, ['0']);
  for (const id of selections) await select(id);
  await React.act(async () => saving.resolve(true));
  await React.act(async () => new Promise(resolve => setImmediate(resolve)));
  assert.equal(useStore.getState().selectedMessageId, selections.at(-1));
  assert.equal(useStore.getState().composeData.sourceSelectionId, selections.at(-1));
});

for (const change of ['different owner', 'sign out and back', 'close']) test(`ordinary compose handoff cancels after ${change}`, async () => {
  await reset();
  useStore.getState().openCompose({ subject: 'Old' });
  const pending = deferred();
  useStore.setState({ prepareComposeSwitch: prepared(() => pending.promise) });
  const opening = useStore.getState().openCompose({ subject: 'New manual' });
  if (change === 'close') useStore.getState().closeCompose();
  else if (change === 'different owner') useStore.getState().setUser({ id: 'new-reader' });
  else { useStore.getState().setUser(null); useStore.getState().setUser({ id: 'reader' }); }
  pending.resolve(true);
  assert.equal(await opening, false);
  assert.notEqual(useStore.getState().composeData?.subject, 'New manual');
});

// Keep saves pending so a server notification can arrive after the observer owns a handoff.
async function pendingAutomaticHandoff() {
  await reset({ autoOpenReplyDrafts: true, count: 0 });
  useStore.setState({ messages: ['0', '1'].map(id => ({ ...row(id), message_id: `<${id}@synthetic.test>` })) });
  useStore.getState().openCompose({ source: 'automaticReplyDraft', subject: 'Edited current reply' });
  const saves = [];
  const lookups = [];
  useStore.setState({ prepareComposeSwitch: prepared(options => {
    const pending = deferred();
    saves.push({ ...pending, options, session: useStore.getState().composeSession });
    return pending.promise;
  }) });
  api.getReplyDraft = async id => {
    lookups.push(id);
    return { draft: { ...draft(id), message_id: `<draft-${id}@synthetic.test>`,
      in_reply_to: `<${id}@synthetic.test>`, from_email: 'me@synthetic.test', to_addresses: ['recipient@synthetic.test'] },
    body: { text: `External reply ${id}`, attachments: [] } };
  };
  await mount(); await select('0');
  assert.equal(saves.length, 1);
  return { saves, lookups };
}

const flushHandoff = () => React.act(async () => new Promise(resolve => setImmediate(resolve)));
const selfSave = save => {
  const before = useStore.getState().replyDraftRevision;
  useStore.getState().invalidateReplyDrafts();
  save.options.onDraftSaved({ before, after: useStore.getState().replyDraftRevision, session: save.session });
};

test('external invalidation during automatic handoff retries the selected draft once', async () => {
  const { saves, lookups } = await pendingAutomaticHandoff();
  await React.act(async () => useStore.getState().invalidateReplyDrafts());
  assert.equal(saves.length, 1, 'no parallel handoff during refresh');
  await React.act(async () => saves[0].resolve(true));
  await flushHandoff();
  assert.equal(saves.length, 2, 'external change retries the cancelled handoff');
  assert.deepEqual(lookups, ['0', '0']);
  await React.act(async () => saves[1].resolve(true));
  await flushHandoff();
  assert.equal(useStore.getState().composeData.sourceSelectionId, '0');
  assert.equal(useStore.getState().composeData.body, 'External reply 0');
  assert.deepEqual(lookups, ['0', '0', '0'], 'one retry plus its post-save validation');
});

for (const events of [[], ['self'], ['self', 'self'], ['self', 'external', 'self'], ['external', 'external']]) {
  test(`automatic handoff classifies revision sequence ${events.join('/') || 'unchanged'}`, async () => {
    const { saves, lookups } = await pendingAutomaticHandoff();
    for (const event of events) await React.act(async () => {
      if (event === 'self') selfSave(saves[0]);
      else useStore.getState().invalidateReplyDrafts();
    });
    assert.equal(saves.length, 1, 'notifications never start a parallel opener');
    await React.act(async () => saves[0].resolve(true));
    await flushHandoff();
    const external = events.includes('external');
    assert.equal(saves.length, external ? 2 : 1);
    if (external) {
      await React.act(async () => saves[1].resolve(true));
      await flushHandoff();
    }
    assert.equal(useStore.getState().composeData.sourceSelectionId, '0');
    assert.equal(lookups.length, external ? 3 : 2);
  });
}

test('successive external revisions each retry once and failed save without a new revision stops', async () => {
  const { saves, lookups } = await pendingAutomaticHandoff();
  for (let index = 0; index < 3; index++) {
    await React.act(async () => useStore.getState().invalidateReplyDrafts());
    assert.equal(saves.length, index + 1, 'one opener in flight');
    await React.act(async () => saves[index].resolve(true));
    await flushHandoff();
    assert.equal(saves.length, index + 2, 'one retry for this external revision');
  }
  await React.act(async () => saves[3].resolve(false));
  await flushHandoff(); await flushHandoff();
  assert.equal(saves.length, 4, 'failed save cannot loop on the same revision');
  assert.equal(lookups.length, 4);
  assert.equal(useStore.getState().composeData.subject, 'Edited current reply');
});

for (const action of ['manual composer', 'sign out']) {
  test(`external handoff retry does not reopen after ${action}`, async () => {
    const { saves, lookups } = await pendingAutomaticHandoff();
    await React.act(async () => useStore.getState().invalidateReplyDrafts());
    await React.act(async () => {
      if (action === 'sign out') useStore.getState().setUser(null);
      else {
        useStore.setState({ prepareComposeSwitch: prepared(async () => true) });
        await useStore.getState().openCompose({ subject: 'Manual wins' });
      }
    });
    await React.act(async () => saves[0].resolve(true));
    await flushHandoff();
    assert.equal(saves.length, 1);
    assert.equal(lookups.length, 1);
    assert.equal(useStore.getState().composeData?.subject, action === 'sign out' ? undefined : 'Manual wins');
  });
}

for (const selections of [['1'], ['1', '0']]) {
  test(`external invalidation during navigation retries only current selection ${selections.join('/')}`, async () => {
    const { saves, lookups } = await pendingAutomaticHandoff();
    await React.act(async () => useStore.getState().invalidateReplyDrafts());
    for (const id of selections) await select(id);
    await React.act(async () => saves[0].resolve(true));
    await flushHandoff();
    assert.equal(saves.length, 2);
    assert.equal(lookups.at(-1), selections.at(-1));
    await React.act(async () => saves[1].resolve(true));
    await flushHandoff();
    assert.equal(useStore.getState().composeData.sourceSelectionId, selections.at(-1));
    assert.equal(lookups.length, 3);
  });
}

for (const reportRevision of [false, true]) {
  test(`saved revision callback is synchronous and preserves boolean result (callback=${reportRevision})`, async () => {
    await reset({ autoOpenReplyDrafts: true }); await select('0');
    useStore.getState().openCompose({ source: 'automaticReplyDraft', subject: 'Current' });
    const revisions = [];
    useStore.setState({ prepareComposeSwitch: prepared(async options => {
      const save = { options, session: useStore.getState().composeSession };
      for (let revision = 1; revision <= 2; revision++) {
        selfSave(save);
        assert.deepEqual(revisions, reportRevision ? Array.from({ length: revision }, (_, i) => i + 1) : [],
          'save-owned revision is reported before the save yields');
      }
      return true;
    }) });
    const opened = await openReplyDraft('0', { automatic: true,
      ...(reportRevision ? { onSavedRevision: revision => revisions.push(revision) } : {}) });
    assert.equal(opened, true);
  });
}

for (const count of [1, 2]) for (const failure of ['prepare', 'target changed']) {
  test(`failed handoff after ${count} self saves does not retry (${failure})`, async () => {
    const { saves, lookups } = await pendingAutomaticHandoff();
    for (let i = 0; i < count; i++) await React.act(async () => selfSave(saves[0]));
    if (failure === 'target changed') api.getReplyDraft = async id => {
      lookups.push(id);
      return { draft: null };
    };
    await React.act(async () => saves[0].resolve(failure !== 'prepare'));
    await flushHandoff(); await flushHandoff();
    assert.equal(saves.length, 1, 'self-save invalidations must not retry a failed handoff');
    assert.equal(lookups.length, failure === 'prepare' ? 1 : 2);
    assert.equal(useStore.getState().composeData.subject, 'Edited current reply');
    assert.equal(useStore.getState().composeData.sourceSelectionId, undefined);
  });
}

for (const source of ['own autosave', 'external invalidation']) test(`${source} during stalled final lookup keeps explicit save provenance`, async () => {
  await reset({ autoOpenReplyDrafts: true });
  useStore.getState().openCompose({ source: 'automaticReplyDraft', subject: 'Outgoing reply' });
  const session = useStore.getState().composeSession;
  const listeners = new Set();
  const prepare = prepared(async ({ onDraftSaved } = {}) => {
    if (onDraftSaved) listeners.add(onDraftSaved);
    try { return true; }
    finally { listeners.delete(onDraftSaved); }
  });
  // Proposed provider contract; prepare's existing callback remains short-lived.
  prepare.subscribeDraftSaved = listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  useStore.setState({ prepareComposeSwitch: prepare });
  const pending = deferred(); let calls = 0;
  const response = { draft: draft('0'), body: { text: 'Selected reply', attachments: [] } };
  api.getReplyDraft = async () => ++calls === 2 ? pending.promise : response;
  await mount(); await select('0');
  assert.equal(calls, 2, 'preparation finished; final lookup is stalled');
  await React.act(async () => {
    const before = useStore.getState().replyDraftRevision;
    useStore.getState().invalidateReplyDrafts();
    if (source === 'own autosave') {
      for (const listener of listeners) listener({ before, after: before + 1, session });
    }
  });
  await React.act(async () => pending.resolve(response));
  await flushHandoff(); await flushHandoff();
  assert.equal(calls, source === 'own autosave' ? 2 : 4,
    'only an explicitly reported own save avoids the external-change retry');
  assert.equal(useStore.getState().composeData.body, 'Selected reply');
  assert.equal(listeners.size, 0, 'handoff completion releases save subscription');
});

for (const outcome of ['success', 'cancel', 'throw']) {
  test(`handoff save subscription is released after final lookup ${outcome}`, async () => {
    await reset({ autoOpenReplyDrafts: true }); await select('0');
    useStore.getState().openCompose({ source: 'automaticReplyDraft', subject: 'Outgoing reply' });
    const listeners = new Set(); let registrations = 0; let legacyCallbacks = 0;
    const prepare = prepared(async ({ onDraftSaved } = {}) => {
      if (onDraftSaved) legacyCallbacks++;
      return true;
    });
    prepare.subscribeDraftSaved = listener => {
      registrations++; listeners.add(listener);
      return () => listeners.delete(listener);
    };
    useStore.setState({ prepareComposeSwitch: prepare });
    let release; let fail; let calls = 0;
    const pending = new Promise((resolve, reject) => { release = resolve; fail = reject; });
    const response = { draft: draft('0'), body: { text: 'Selected reply', attachments: [] } };
    api.getReplyDraft = async () => ++calls === 2 ? pending : response;
    const opening = openReplyDraft('0', { automatic: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2);
    const duringLookup = listeners.size;
    if (outcome === 'cancel') useStore.setState({ selectedMessageId: '1' });
    if (outcome === 'throw') fail(new Error('Synthetic final lookup failure'));
    else release(response);
    assert.equal(await opening, outcome === 'success');
    assert.equal(registrations, 1);
    assert.equal(duringLookup, 1, 'subscription remains live after prepare');
    assert.equal(legacyCallbacks, 0, 'lifetime API must not also use transient callback cleanup');
    assert.equal(listeners.size, 0);
  });
}

test('owned automatic final replacement refusal explains keeping the current editor once', async () => {
  await reset({ autoOpenReplyDrafts: true });
  useStore.getState().openCompose({ source: 'automaticReplyDraft', subject: 'Keep local edits' });
  const session = useStore.getState().composeSession;
  let replaceable = true;
  useStore.setState({ prepareComposeSwitch: Object.assign(async () => true, { canReplace: () => replaceable }) });
  const pending = deferred(); let calls = 0;
  const response = { draft: draft('0'), body: { text: 'Selected reply', attachments: [] } };
  api.getReplyDraft = async () => ++calls === 1 ? response : pending.promise;
  await mount(); await select('0');
  assert.equal(calls, 2, 'prepared handoff is waiting on final validation');
  replaceable = false;
  await React.act(async () => pending.resolve(response));
  await flushHandoff(); await flushHandoff();
  assert.equal(useStore.getState().composeSession, session);
  assert.equal(useStore.getState().composeData.subject, 'Keep local edits');
  assert.equal(calls, 2, 'late edits must not trigger another automatic handoff');
  assert.equal(useStore.getState().notifications.length, 1);
  assert.equal(useStore.getState().notifications[0].body,
    'Save the current message and resolve its attachments before opening this draft.');
});

for (const scope of ['selection', 'preference', 'selection with late edits']) {
  test(`batched ${scope} round trip during mounted handoff opens only a fresh response or retains late edits`, async () => {
    await reset({ autoOpenReplyDrafts: true });
    useStore.getState().openCompose({ source: 'automaticReplyDraft', subject: 'Keep current editor' });
    let replaceable = true;
    useStore.setState({ prepareComposeSwitch: Object.assign(async () => true, { canReplace: () => replaceable }) });
    const stale = deferred();
    const fresh = deferred();
    const calls = [];
    const applied = [];
    const response = text => ({ draft: draft('0'), body: { text, attachments: [] } });
    api.getReplyDraft = async id => {
      calls.push(id);
      if (calls.length === 2) return stale.promise;
      if (calls.length >= 3) return fresh.promise;
      return response('Initial lookup');
    };
    const unsubscribe = useStore.subscribe(state => {
      if (state.composeData?.sourceSelectionId === '0') applied.push(state.composeData.body);
    });
    try {
      await mount(); await select('0');
      assert.deepEqual(calls, ['0', '0'], 'old final lookup is pending');
      await React.act(async () => {
        const key = scope === 'preference' ? 'autoOpenReplyDrafts' : 'selectedMessageId';
        useStore.setState({ [key]: scope === 'preference' ? false : '1' });
        useStore.setState({ [key]: scope === 'preference' ? true : '0' });
      });
      if (scope === 'selection with late edits') replaceable = false;
      await React.act(async () => stale.resolve(response('Stale response')));
      await flushHandoff();
      assert.equal(applied.length, 0, 'revoked response never reaches the composer');
      assert.equal(calls.length, 3, 'one fresh lookup starts for the current selection');
      await React.act(async () => fresh.resolve(response('Fresh response')));
      await flushHandoff();
      if (scope === 'selection with late edits') {
        assert.equal(useStore.getState().composeData.subject, 'Keep current editor');
        assert.equal(applied.length, 0);
        assert.equal(useStore.getState().notifications.length, 1);
        assert.equal(useStore.getState().notifications[0].body,
          'Save the current message and resolve its attachments before opening this draft.');
      } else {
        assert.equal(useStore.getState().composeData.body, 'Fresh response');
        assert.ok(applied.every(body => body === 'Fresh response'));
      }
      await flushHandoff(); await flushHandoff();
      assert.equal(calls.length, 4, 'fresh handoff performs only its initial and final lookup');
    } finally { unsubscribe(); }
  });
}

test('captured context transition cannot retry after sign-out during a handoff', async () => {
  const { saves, lookups } = await pendingAutomaticHandoff();
  await React.act(async () => {
    useStore.setState({ selectedMessageId: '1' });
    useStore.setState({ selectedMessageId: '0' });
    useStore.getState().setUser(null);
  });
  await React.act(async () => saves[0].resolve(true));
  await flushHandoff(); await flushHandoff();
  assert.equal(saves.length, 1);
  assert.equal(lookups.length, 1);
  assert.equal(useStore.getState().composing, false);
  assert.equal(useStore.getState().notifications.length, 0);
});

test('automatic handoff releases its subscriptions after preparation throws', async () => {
  await reset({ autoOpenReplyDrafts: true });
  useStore.getState().openCompose({ source: 'automaticReplyDraft', subject: 'Keep current editor' });
  let reject;
  const pending = new Promise((resolve, fail) => { reject = fail; });
  useStore.setState({ prepareComposeSwitch: prepared(() => pending) });
  const subscribe = useStore.subscribe;
  const active = new Set();
  useStore.subscribe = listener => {
    const unsubscribe = subscribe(listener);
    active.add(listener);
    return () => { active.delete(listener); unsubscribe(); };
  };
  try {
    await mount();
    const resting = active.size;
    await select('0');
    assert.ok(active.size > resting, 'handoff has active subscriptions');
    await React.act(async () => reject(new Error('Synthetic preparation failure')));
    await flushHandoff();
    assert.equal(useStore.getState().composeData.subject, 'Keep current editor');
    await React.act(async () => root.render(null));
    assert.equal(active.size, 0, 'no handoff subscription survives the throw and observer cleanup');
  } finally {
    await React.act(async () => root.render(null));
    useStore.subscribe = subscribe;
  }
});

for (const scope of ['selection', 'account', 'search', 'conversation', 'preference']) {
  test(`returning to original ${scope} during final draft lookup cannot revive the old handoff`, async () => {
    await reset({ autoOpenReplyDrafts: true }); await select('0');
    useStore.getState().openCompose({ source: 'automaticReplyDraft', subject: 'Current editor' });
    useStore.setState({ prepareComposeSwitch: prepared(async () => true) });
    const pending = deferred(); let calls = 0;
    const result = { draft: { ...draft('0'), message_id: '<reply@synthetic.test>', in_reply_to: '<0@synthetic.test>' },
      body: { text: 'Earlier selection response', attachments: [] } };
    api.getReplyDraft = async () => ++calls === 1 ? result : pending.promise;
    const opening = openReplyDraft('0', { automatic: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2, 'final lookup is pending after preparation');
    const key = { selection: 'selectedMessageId', account: 'selectedAccountId', search: 'searchQuery', conversation: 'conversationMode', preference: 'autoOpenReplyDrafts' }[scope];
    const initial = useStore.getState()[key];
    useStore.setState({ [key]: { selection: '1', account: 'other', search: 'query', conversation: 'pane', preference: false }[scope] });
    useStore.setState({ [key]: initial });
    pending.resolve(result);
    assert.equal(await opening, false, 'a revoked handoff stays revoked after A/B/A');
    assert.equal(useStore.getState().composeData.subject, 'Current editor');
  });
}

for (const validator of [null, undefined, () => false, () => true, () => 'true']) {
  test(`prepared replacement requires a synchronous true validator (${String(validator)})`, async () => {
    await reset();
    useStore.getState().openCompose({ subject: 'Keep editor' });
    const session = useStore.getState().composeSession;
    const prepare = validator === null ? null : Object.assign(async () => true,
      validator === undefined ? {} : { canReplace: validator });
    useStore.setState({ prepareComposeSwitch: prepare });
    const opened = useStore.getState().openCompose({ subject: 'Next' }, { preparedSession: session });
    assert.equal(opened, validator?.() === true);
    assert.equal(useStore.getState().composeData.subject, opened ? 'Next' : 'Keep editor');
  });
}
