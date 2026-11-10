import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
    return { format: 'module', shortCircuit: true, source: [
      'export const useTranslation = () => ({ t: (key) => key, i18n: { language: "en", changeLanguage: () => {} } });',
      'export const initReactI18next = { type: "3rdParty", init: () => {} };',
      'export const Trans = ({ children }) => children ?? null;',
      'export const I18nextProvider = ({ children }) => children ?? null;',
      'export default { useTranslation, initReactI18next };',
    ].join('\n') };
  }
  if (url.endsWith('.json')) return { format: 'module', shortCircuit: true,
    source: `export default ${readFileSync(new URL(url), 'utf8')}` };
  if (url.endsWith('.jsx')) {
    const code = transform(readFileSync(new URL(url), 'utf8'), {
      transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url,
    }).code;
    return { format: 'module', shortCircuit: true, source: code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
  }
  if (url.startsWith('file:') && url.endsWith('.js')) {
    const code = readFileSync(new URL(url), 'utf8');
    if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true,
      source: code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
  }
  return nextLoad(url, context);
} });

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, DOMParser: dom.window.DOMParser,
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true, __VITE_ENV__: { MODE: 'test', PROD: true } });
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.matchMedia = dom.window.matchMedia;
globalThis.requestAnimationFrame = cb => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const ComposeModal = (await import('./ComposeModal.jsx')).default;


const { api } = await import('../utils/api.js');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const source = (uid = 5, accountId = A, overrides = {}) => ({
  messageId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(uid).padStart(12, '0')}`, accountId,
  storageGeneration: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  entityId: `cccccccc-cccc-4ccc-8ccc-${String(uid).padStart(12, '0')}`,
  folder: 'Drafts', uid: String(uid), uidValidity: '42', ...overrides,
});
const original = { saveDraft: api.saveDraft, deleteDraft: api.deleteDraft, post: api.post,
  cancelSend: api.cancelSend, getSendStatus: api.getSendStatus, logout: api.logout, scheduled: { ...api.scheduled } };
const click = el => React.act(async () => { assert.ok(el); el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
const button = text => [...document.querySelectorAll('button')].find(el => el.textContent.trim() === text);
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
async function mount(data = {}) {
  useStore.setState({ user: { id: 'owner' }, isLocked: false, attachmentSignOutPending: false,
    accounts: [A, B].map(id => ({ id, email_address: `${id}@example.test`, aliases: [], signature: '', enabled: true,
      user_id: 'owner', storage_generation: source().storageGeneration })),
    composing: false, composeData: null, plaintextEmail: true, notifications: [], prepareComposeSwitch: null });
  useStore.getState().openCompose({ accountId: A, draftAccountId: A, draftUid: 5, draftFolder: 'Drafts', draftSource: source(),
    to: ['to@example.test'], subject: 'Draft A', body: 'Text', signature: '', restored: true, ...data });
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(ComposeModal)));
  return async () => { await React.act(async () => { useStore.setState({ user: null }); root.unmount(); }); Object.assign(api, original, { scheduled: { ...original.scheduled } }); };
}

test('immediate send passes its physical source and never issues a second browser draft deletion', async () => {
  const requests = [], deletes = [];
  api.post = async (...args) => { requests.push(args); return { ok: true, cleanup: { status: 'deleted' } }; };
  api.deleteDraft = async (...args) => { deletes.push(args); return { ok: true }; };
  const close = await mount();
  try {
    await click(button('compose.send'));
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0][1].draft, { uid: 5, folder: 'Drafts', accountId: A, source: source() });
    assert.deepEqual(deletes, []);
    assert.equal(useStore.getState().composing, false);
  } finally { await close(); }
});

test('held-send undo waits behind another composer and restores only its original source', async () => {
  api.saveDraft = async () => ({ uid: 6, folder: 'Drafts', draftSource: source(6), cleanup: { status: 'deleted' } });
  api.post = async () => ({ pending: true, pendingId: 'original-send', remainingMs: 10000 });
  api.cancelSend = async () => ({ cancelled: true });
  const close = await mount();
  try {
    await React.act(async () => { assert.equal(await useStore.getState().prepareComposeSwitch(), true); });
    await click(button('compose.send'));
    const undo = useStore.getState().notifications.find(n => n.heldSendId === 'original-send')?.onUndo;
    assert.equal(typeof undo, 'function');
    await React.act(async () => useStore.getState().openCompose({ accountId: B, subject: 'Other compose', draftSource: source(9, B) }));
    await React.act(async () => { await undo(); });
    assert.equal(useStore.getState().composeData.subject, 'Other compose');
    await React.act(async () => useStore.getState().closeCompose());
    assert.deepEqual(useStore.getState().composeData.draftSource, source(6));
    assert.equal(useStore.getState().composeData.draftAccountId, A);
    assert.equal(useStore.getState().composeData.subject, 'Draft A');
  } finally { await close(); }
});

test('held-send failed outcome restores the original pointer after another composer closes', async () => {
  api.saveDraft = async () => ({ uid: 6, folder: 'Drafts', draftSource: source(6), cleanup: { status: 'deleted' } });
  api.post = async () => ({ pending: true, pendingId: 'failed-send', remainingMs: 10000 });
  api.cancelSend = async () => ({ status: 'failed', error: 'Synthetic delivery failure' });
  const close = await mount();
  try {
    await React.act(async () => { assert.equal(await useStore.getState().prepareComposeSwitch(), true); });
    await click(button('compose.send'));
    const undo = useStore.getState().notifications.find(n => n.heldSendId === 'failed-send')?.onUndo;
    assert.equal(typeof undo, 'function');
    await React.act(async () => useStore.getState().openCompose({ accountId: B, subject: 'Other compose', draftSource: source(9, B) }));
    await React.act(async () => { await undo(); });
    assert.equal(useStore.getState().composeData.subject, 'Other compose');
    await React.act(async () => useStore.getState().closeCompose());
    assert.deepEqual(useStore.getState().composeData.draftSource, source(6));
    assert.equal(useStore.getState().composeData.sendError, 'Synthetic delivery failure');
  } finally { await close(); }
});

test('schedule sends the same proof and its undo clears every old draft identity field', async () => {
  const requests = [];
  api.scheduled.create = async body => { requests.push(body); return { id: 'scheduled-one', sendAt: body.sendAt, cleanup: { status: 'deleted' } }; };
  api.scheduled.cancel = async () => ({ status: 'cancelled', undoUntil: new Date(Date.now() + 600000).toISOString() });
  const close = await mount({ draftMessageId: '<old@example.test>', draftUidValidity: '42' });
  try {
    await click(document.querySelector('[data-send-later]'));
    await click(document.querySelector('[data-preset="tomorrowMorning"]'));
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].draft, { uid: 5, folder: 'Drafts', accountId: A, source: source() });
    const undo = useStore.getState().notifications.find(n => n.title === 'compose.scheduleSend.scheduledFor')?.onUndo;
    assert.equal(typeof undo, 'function');
    await React.act(async () => { await undo(); });
    const restored = useStore.getState().composeData;
    for (const field of ['draftUid', 'draftFolder', 'draftAccountId', 'draftSource', 'draftMessageId', 'draftUidValidity']) {
      assert.ok(restored[field] == null, `${field} must not survive schedule undo`);
    }
    assert.equal(restored.subject, 'Draft A');
  } finally { await close(); }
});

for (const kind of ['send', 'schedule']) test(`${kind} response from before same-owner sign-out/sign-in cannot close or notify the new session`, async () => {
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  if (kind === 'send') api.post = async () => response;
  else api.scheduled.create = async () => response;
  const close = await mount();
  try {
    if (kind === 'send') await click(button('compose.send'));
    else {
      await click(document.querySelector('[data-send-later]'));
      await click(document.querySelector('[data-preset="tomorrowMorning"]'));
    }
    await React.act(async () => {
      useStore.setState({ user: null });
      useStore.getState().closeCompose();
      useStore.setState({ user: { id: 'owner' }, notifications: [] });
      useStore.getState().openCompose({ accountId: B, subject: 'New session compose', draftSource: source(9, B) });
    });
    await React.act(async () => { finish({ id: 'old-schedule', ok: true }); await response; });
    assert.equal(useStore.getState().composeData.subject, 'New session compose');
    assert.deepEqual(useStore.getState().notifications, []);
  } finally { await close(); }
});

for (const kind of ['save', 'send', 'schedule']) test(`late ${kind} failure cannot overwrite a new-session composer with the old error`, async () => {
  let fail, saving;
  const response = new Promise((_resolve, reject) => { fail = reject; });
  if (kind === 'save') api.saveDraft = async () => response;
  else if (kind === 'send') api.post = async () => response;
  else api.scheduled.create = async () => response;
  const close = await mount();
  try {
    if (kind === 'save') await React.act(async () => { saving = useStore.getState().prepareComposeSwitch(); });
    else if (kind === 'send') await click(button('compose.send'));
    else {
      await click(document.querySelector('[data-send-later]'));
      await click(document.querySelector('[data-preset="tomorrowMorning"]'));
    }
    await React.act(async () => {
      useStore.setState({ user: null });
      useStore.getState().closeCompose();
      useStore.setState({ user: { id: 'owner' }, notifications: [] });
      useStore.getState().openCompose({ accountId: B, subject: 'New session compose', draftSource: source(9, B) });
    });
    await React.act(async () => {
      fail(new Error('Private stale request error'));
      if (saving) await saving;
      else await response.catch(() => {});
    });
    assert.equal(useStore.getState().composeData.subject, 'New session compose');
    assert.equal(document.body.textContent.includes('Private stale request error'), false);
    assert.deepEqual(useStore.getState().notifications, []);
  } finally { await close(); }
});

for (const kind of ['save', 'send', 'schedule']) test(`sign-out start invalidates a pending ${kind} before the logout response`, async () => {
  let finish, finishLogout, saving, signingOut;
  const response = new Promise(resolve => { finish = resolve; });
  const logout = new Promise(resolve => { finishLogout = resolve; });
  api.logout = async () => logout;
  if (kind === 'save') api.saveDraft = async () => response;
  else if (kind === 'send') api.post = async () => response;
  else api.scheduled.create = async () => response;
  const close = await mount();
  try {
    if (kind === 'save') await React.act(async () => { saving = useStore.getState().prepareComposeSwitch(); });
    else if (kind === 'send') await click(button('compose.send'));
    else {
      await click(document.querySelector('[data-send-later]'));
      await click(document.querySelector('[data-preset="tomorrowMorning"]'));
    }
    await React.act(async () => { signingOut = useStore.getState().signOut(); });
    assert.equal(useStore.getState().user?.id, 'owner', 'logout response remains outstanding');
    const duringLogout = { composing: useStore.getState().composing, composeData: useStore.getState().composeData };
    await React.act(async () => {
      finish({ id: 'old-schedule', ok: true, uid: 6, folder: 'Drafts', draftSource: source(6), cleanup: { status: 'deleted' } });
      if (saving) assert.equal(await saving, false);
      else await response;
    });
    assert.deepEqual({ composing: useStore.getState().composing, composeData: useStore.getState().composeData }, duringLogout);
    assert.deepEqual(useStore.getState().notifications, []);
  } finally {
    await React.act(async () => { finishLogout({ endSessionUrl: 'https://mail.example.invalid/#signed-out' }); await signingOut; });
    await close();
  }
});

for (const change of ['generation', 'source', 'account-missing', 'enabled', 'account-owner', 'user', 'lock']) test(`nested subscriber restoring ${change} cannot hide the intervening state from a draft save`, async () => {
  let finish, saving, armed = false, restore;
  const response = new Promise(resolve => { finish = resolve; });
  api.saveDraft = async () => response;
  // Registered before the composer, matching an earlier store subscriber that repairs state.
  const unsubscribe = useStore.subscribe(() => {
    if (armed) { armed = false; useStore.setState(restore); }
  });
  const close = await mount();
  try {
    await React.act(async () => { saving = useStore.getState().prepareComposeSwitch(); });
    const before = useStore.getState();
    let altered;
    if (change === 'source') {
      restore = { composeData: before.composeData };
      altered = { composeData: { ...before.composeData, draftSource: source(5, A, { entityId: source(8).entityId }) } };
    } else if (change === 'user') {
      restore = { user: before.user }; altered = { user: { id: 'another-owner' } };
    } else if (change === 'lock') {
      restore = { isLocked: before.isLocked }; altered = { isLocked: true };
    } else {
      restore = { accounts: before.accounts };
      const fields = change === 'generation' ? { storage_generation: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }
        : change === 'enabled' ? { enabled: false } : { user_id: 'another-owner' };
      altered = { accounts: change === 'account-missing' ? before.accounts.filter(account => account.id !== A)
        : before.accounts.map(account => account.id === A ? { ...account, ...fields } : account) };
    }
    await React.act(async () => { armed = true; useStore.setState(altered); });
    assert.equal(armed, false, 'the earlier subscriber restored the state synchronously');
    await React.act(async () => {
      finish({ uid: 6, folder: 'Drafts', draftSource: source(6), cleanup: { status: 'deleted' } });
      assert.equal(await saving, false, 'the intervening context must invalidate this save');
    });
    assert.deepEqual(useStore.getState().composeData?.draftSource, source());
  } finally { unsubscribe(); await close(); }
});

for (const change of ['enabled', 'owner']) test(`a holder account ${change} change during save prevents receipt adoption`, async () => {
  let finish, saving;
  const response = new Promise(resolve => { finish = resolve; });
  api.saveDraft = async () => response;
  const close = await mount();
  try {
    await React.act(async () => { saving = useStore.getState().prepareComposeSwitch(); });
    await React.act(async () => useStore.setState(state => ({ accounts: state.accounts.map(account => account.id === A
      ? { ...account, ...(change === 'enabled' ? { enabled: false } : { user_id: 'another-owner' }) } : account) })));
    await React.act(async () => {
      finish({ uid: 6, folder: 'Drafts', draftSource: source(6), cleanup: { status: 'deleted' } });
      assert.equal(await saving, false);
    });
    assert.deepEqual(useStore.getState().composeData?.draftSource, source());
  } finally { await close(); }
});

for (const stage of ['held', 'waiting-to-reopen']) test(`nested owner restoration cannot revive an old ${stage} draft undo`, async () => {
  let armed = false, originalUser;
  const unsubscribe = useStore.subscribe(() => {
    if (armed) { armed = false; useStore.setState({ user: originalUser }); }
  });
  let cancellations = 0;
  api.post = async () => ({ pending: true, pendingId: `nested-${stage}`, remainingMs: 10000 });
  api.cancelSend = async () => { cancellations++; return { cancelled: true }; };
  const close = await mount();
  try {
    await click(button('compose.send'));
    const undo = useStore.getState().notifications.find(n => n.heldSendId === `nested-${stage}`)?.onUndo;
    assert.equal(typeof undo, 'function');
    await React.act(async () => useStore.getState().openCompose({ accountId: B, subject: 'Other compose', draftSource: source(9, B) }));
    if (stage === 'waiting-to-reopen') await React.act(async () => { await undo(); });
    originalUser = useStore.getState().user;
    await React.act(async () => { armed = true; useStore.setState({ user: { id: 'another-owner' } }); });
    assert.equal(armed, false);
    if (stage === 'held') {
      await React.act(async () => { await undo(); });
      assert.equal(cancellations, 0, 'invalidated old Undo must not send another cancellation');
    }
    await React.act(async () => useStore.getState().closeCompose());
    assert.equal(useStore.getState().composing, false, 'old draft must not reappear after an intervening owner');
  } finally { unsubscribe(); await close(); }
});

for (const stage of ['held', 'waiting-to-reopen']) test(`sign-out start invalidates an old ${stage} draft undo before logout completes`, async () => {
  let finishLogout, signingOut, cancellations = 0;
  const logout = new Promise(resolve => { finishLogout = resolve; });
  api.logout = async () => logout;
  api.post = async () => ({ pending: true, pendingId: `signout-${stage}`, remainingMs: 10000 });
  api.cancelSend = async () => { cancellations++; return { cancelled: true }; };
  const close = await mount();
  try {
    await click(button('compose.send'));
    const undo = useStore.getState().notifications.find(n => n.heldSendId === `signout-${stage}`)?.onUndo;
    assert.equal(typeof undo, 'function');
    await React.act(async () => useStore.getState().openCompose({ accountId: B, subject: 'Other compose', draftSource: source(9, B) }));
    if (stage === 'waiting-to-reopen') await React.act(async () => { await undo(); });
    await React.act(async () => { signingOut = useStore.getState().signOut(); });
    assert.equal(useStore.getState().user?.id, 'owner');
    if (stage === 'held') {
      await React.act(async () => { await undo(); });
      assert.equal(cancellations, 0, 'no old cancellation after sign-out starts');
    }
    await React.act(async () => useStore.getState().closeCompose());
    assert.equal(useStore.getState().composing, false);
  } finally {
    await React.act(async () => { finishLogout({ endSessionUrl: 'https://mail.example.invalid/#signed-out' }); await signingOut; });
    await close();
  }
});

test('scheduled undo cannot restore or notify after a nested owner change during cancellation', async () => {
  let armed = false, originalUser, finishCancel, undoing;
  const cancelled = new Promise(resolve => { finishCancel = resolve; });
  const unsubscribe = useStore.subscribe(() => {
    if (armed) { armed = false; useStore.setState({ user: originalUser }); }
  });
  api.scheduled.create = async body => ({ id: 'nested-schedule', sendAt: body.sendAt, cleanup: { status: 'deleted' } });
  api.scheduled.cancel = async () => cancelled;
  const close = await mount();
  try {
    await click(document.querySelector('[data-send-later]'));
    await click(document.querySelector('[data-preset="tomorrowMorning"]'));
    const undo = useStore.getState().notifications.find(n => n.title === 'compose.scheduleSend.scheduledFor')?.onUndo;
    assert.equal(typeof undo, 'function');
    await React.act(async () => { undoing = undo(); });
    originalUser = useStore.getState().user;
    const notifications = useStore.getState().notifications;
    await React.act(async () => { armed = true; useStore.setState({ user: { id: 'another-owner' } }); });
    await React.act(async () => { finishCancel({ status: 'cancelled' }); await undoing; });
    assert.equal(useStore.getState().composing, false);
    assert.deepEqual(useStore.getState().notifications, notifications);
  } finally { unsubscribe(); await close(); }
});

test('a held draft undo waits through lock and a same-user profile refresh before reopening its proof', async () => {
  api.post = async () => ({ pending: true, pendingId: 'locked-undo', remainingMs: 10000 });
  api.cancelSend = async () => ({ cancelled: true });
  const close = await mount();
  try {
    await click(button('compose.send'));
    const undo = useStore.getState().notifications.find(n => n.heldSendId === 'locked-undo')?.onUndo;
    assert.equal(typeof undo, 'function');
    const epoch = useStore.getState().composeAuthEpoch;
    await React.act(async () => useStore.getState().setLocked(true));
    await React.act(async () => { await undo(); });
    assert.equal(useStore.getState().composing, false, 'nothing opens behind the lock');
    await React.act(async () => useStore.getState().setUser({ id: 'owner', display_name: 'Updated profile' }));
    assert.equal(useStore.getState().composeAuthEpoch, epoch, 'same-user refresh is not an authentication transition');
    await React.act(async () => useStore.getState().setLocked(false));
    assert.equal(useStore.getState().composing, true);
    assert.deepEqual(useStore.getState().composeData.draftSource, source());
    assert.equal(useStore.getState().composeData.subject, 'Draft A');
  } finally { await close(); }
});
