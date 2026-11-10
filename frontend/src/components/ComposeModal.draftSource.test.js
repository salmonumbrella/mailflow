import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { setImmediate } from 'node:timers';
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
  cancelSend: api.cancelSend, getSendStatus: api.getSendStatus };
const click = el => React.act(async () => { assert.ok(el); el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
const button = text => [...document.querySelectorAll('button')].find(el => el.textContent.trim() === text);
async function mount(data = {}) {
  useStore.setState({ user: { id: 'owner' }, isLocked: false, accounts: [A, B].map(id => ({ id, email_address: `${id}@example.test`, aliases: [], signature: '' })),
    composing: false, composeData: null, plaintextEmail: true, notifications: [], prepareComposeSwitch: null });
  useStore.getState().openCompose({ accountId: A, draftAccountId: A, draftUid: 5, draftFolder: 'Drafts', draftSource: source(),
    to: ['to@example.test'], subject: 'Draft A', body: 'Text', signature: '', restored: true, ...data });
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(ComposeModal)));
  return async () => { await React.act(async () => root.unmount()); Object.assign(api, original); };
}
async function discard() {
  await click([...document.querySelectorAll('button')].find(el => el.getAttribute('aria-label') === 'compose.discard'));
  await click(button('compose.discardDraft.discard'));
}
async function choose(accountId) {
  await React.act(async () => {
    const select = document.querySelector('select');
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(select, `account:${accountId}`);
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

test('replacement and discard carry exact original and verified saved physical source snapshots', async () => {
  const writes = [], deletes = [];
  api.saveDraft = async body => { writes.push(body); return { uid: 6, folder: 'Drafts', draftSource: source(6), cleanup: { status: 'deleted' } }; };
  api.deleteDraft = async (...args) => { deletes.push(args); return { ok: true, cleanup: { status: 'deleted' } }; };
  const close = await mount();
  try {
    await React.act(async () => { assert.equal(await useStore.getState().prepareComposeSwitch(), true); });
    assert.deepEqual(writes[0].existingSource, source());
    await discard();
    assert.deepEqual(deletes[0], [A, 6, 'Drafts', source(6)]);
    assert.equal(useStore.getState().composing, false);
  } finally { await close(); }
});

for (const proof of [undefined, null, { messageId: '<rfc@example.test>' }]) test(`missing or malformed proof cannot discard or replace (${JSON.stringify(proof)})`, async () => {
  let saves = 0, deletes = 0;
  api.saveDraft = async () => { saves++; return { uid: 6, folder: 'Drafts' }; };
  api.deleteDraft = async () => { deletes++; return { ok: true }; };
  const close = await mount({ draftSource: proof });
  try {
    await React.act(async () => { assert.equal(await useStore.getState().prepareComposeSwitch(), false); });
    await discard();
    assert.equal(saves, 0); assert.equal(deletes, 0);
    assert.equal(useStore.getState().composing, true);
    assert.match(document.body.textContent, /compose.draftSourceUnavailable/);
  } finally { await close(); }
});

for (const change of ['sender', 'sender ABA', 'account ABA', 'source ABA', 'owner ABA', 'close/reopen', 'lock/unlock']) test(`a delayed receipt cannot adopt after ${change}`, async () => {
  let finish, saving;
  const writes = [];
  api.saveDraft = body => { writes.push(body); return new Promise(resolve => { finish = resolve; }); };
  const close = await mount();
  try {
    await React.act(async () => { saving = useStore.getState().prepareComposeSwitch(); });
    const originalData = useStore.getState().composeData;
    if (change.startsWith('sender')) {
      await choose(B);
      if (change.endsWith('ABA')) await choose(A);
    } else await React.act(async () => {
      if (change === 'account ABA') {
        const accounts = useStore.getState().accounts;
        useStore.setState({ accounts: accounts.filter(account => account.id !== A) });
        useStore.setState({ accounts });
      } else if (change === 'source ABA') {
        useStore.setState({ composeData: { ...originalData, draftSource: source(5, A, { uidValidity: '43' }) } });
        useStore.setState({ composeData: originalData });
      } else if (change === 'owner ABA') {
        useStore.setState({ user: { id: 'other' } }); useStore.setState({ user: { id: 'owner' } });
      } else if (change === 'close/reopen') {
        useStore.getState().closeCompose(); useStore.getState().openCompose({ ...originalData, subject: 'New editor' });
      } else {
        const accounts = useStore.getState().accounts;
        useStore.getState().setLocked(true); useStore.getState().setLocked(false); useStore.setState({ accounts });
      }
    });
    const before = useStore.getState().composeData;
    await React.act(async () => { finish({ uid: 6, folder: 'Drafts', draftSource: source(6), cleanup: { status: 'deleted' } }); assert.equal(await saving, false); });
    assert.deepEqual(useStore.getState().composeData, before, 'the old response cannot rewrite the retained or newer editor');
    assert.equal(writes.length, 1);
    if (change === 'lock/unlock') {
      assert.equal(before.draftSaveUncertain, true);
      assert.deepEqual(before.draftSource, source());
    }
  } finally { await close(); }
});

for (const receipt of [undefined, null, {}, source(6, B), source(7), source(6, A, { uidValidity: null })]) test(`unverified save receipt is quarantined rather than appended twice (${JSON.stringify(receipt)})`, async () => {
  let writes = 0, deletes = 0;
  api.saveDraft = async () => { writes++; return { uid: 6, folder: 'Drafts', draftSource: receipt }; };
  api.deleteDraft = async () => { deletes++; return { ok: true, cleanup: { status: 'deleted' } }; };
  const close = await mount();
  try {
    await React.act(async () => { assert.equal(await useStore.getState().prepareComposeSwitch(), false); });
    await click(button('compose.saveDraft'));
    await discard();
    assert.equal(writes, 1); assert.equal(deletes, 0);
    assert.deepEqual(useStore.getState().composeData.draftSource, source());
    assert.equal(useStore.getState().composing, true);
  } finally { await close(); }
});

test('new save epoch and physical UUID come only from the receipt while retained cleanup is visible', async () => {
  const next = source(5, A, { uidValidity: '99', messageId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' });
  const writes = [], deletes = [];
  api.saveDraft = async body => { writes.push(body); return { uid: 5, folder: 'Drafts', draftSource: next,
    messageId: '<rfc-is-not-row@example.test>', cleanup: { status: 'retained', code: 'draft_source_changed' } }; };
  api.deleteDraft = async (...args) => { deletes.push(args); return { ok: true, cleanup: { status: 'deleted' } }; };
  const close = await mount();
  try {
    await React.act(async () => { assert.equal(await useStore.getState().prepareComposeSwitch(), true); });
    assert.deepEqual(writes[0].existingSource, source());
    assert.deepEqual(useStore.getState().composeData.draftSource, next);
    assert.equal(useStore.getState().composeData.draftUidValidity, '99');
    assert.deepEqual(JSON.parse(useStore.getState().composeData.persistedKey), next);
    assert.ok(useStore.getState().notifications.some(note => note.persistent && note.body === 'compose.draftRetainedBody'));
    await discard();
    assert.deepEqual(deletes[0][3], next);
  } finally { await close(); }
});

test('discard waits for a running save but cannot delete after the composer closes and reopens', async () => {
  let finish, saving; const deletes = [];
  api.saveDraft = () => new Promise(resolve => { finish = resolve; });
  api.deleteDraft = async (...args) => { deletes.push(args); return { ok: true, cleanup: { status: 'deleted' } }; };
  const close = await mount();
  try {
    await React.act(async () => { saving = useStore.getState().prepareComposeSwitch(); });
    await discard();
    await React.act(async () => { useStore.getState().closeCompose(); useStore.getState().openCompose({ accountId: A, subject: 'New editor' }); });
    await React.act(async () => { finish({ uid: 6, folder: 'Drafts', draftSource: source(6) }); await saving; await new Promise(resolve => setImmediate(resolve)); });
    assert.equal(deletes.length, 0);
    assert.equal(useStore.getState().composeData.subject, 'New editor');
  } finally { await close(); }
});

for (const result of [null, { ok: true }, { ok: true, cleanup: { status: 'retained' } }]) test(`unconfirmed cleanup never closes as if discard succeeded (${JSON.stringify(result)})`, async () => {
  api.deleteDraft = async () => result;
  const close = await mount();
  try {
    await discard();
    assert.equal(useStore.getState().composing, true);
    assert.match(document.body.textContent, /compose.discardFailed/);
  } finally { await close(); }
});

for (const fails of [false, true]) test(`explicit separate-copy recovery preserves text and issues one new save (${fails ? 'uncertain failure' : 'verified success'})`, async () => {
  const writes = []; let finish;
  api.saveDraft = body => { writes.push(body); return new Promise((resolve, reject) => {
    finish = () => fails ? reject(new Error('Connection lost')) : resolve({ uid: 9, folder: 'Drafts', draftSource: source(9), cleanup: { status: 'not_requested' } });
  }); };
  const close = await mount({ draftSource: null, body: 'Unsaved text stays intact' });
  const originalConfirm = window.confirm;
  let confirmations = 0;
  window.confirm = () => { confirmations++; return true; };
  try {
    await click(button('compose.draftSeparateCopy'));
    await click(button('compose.draftSeparateCopy'));
    assert.equal(confirmations, 1); assert.equal(writes.length, 1);
    assert.equal(writes[0].existingSource, undefined); assert.equal(writes[0].existingUid, undefined);
    assert.equal(writes[0].body, 'Unsaved text stays intact');
    assert.equal(useStore.getState().composeData.draftUid, 5, 'the old pointer is not cleared while saving');
    await React.act(async () => { finish(); for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); });
    assert.equal(writes.length, 1);
    assert.equal(document.querySelector('textarea').value, 'Unsaved text stays intact');
    if (fails) {
      assert.equal(useStore.getState().composeData.draftUid, 5);
      await click(button('compose.saveDraft')); assert.equal(writes.length, 1);
    } else assert.deepEqual(useStore.getState().composeData.draftSource, source(9));
  } finally { window.confirm = originalConfirm; await close(); }
});

test('a sender chosen before saving is not invalidated by an unrelated store notification', async () => {
  let finish, saving;
  const originalSignatures = api.getSignatureLibrary;
  api.getSignatureLibrary = async accountId => ({ accountId, signatures: [], defaults: [{ senderKey: 'main', newSignatureId: null, replySignatureId: null }] });
  api.saveDraft = () => new Promise(resolve => { finish = resolve; });
  const close = await mount();
  try {
    await choose(B);
    await React.act(async () => { saving = useStore.getState().prepareComposeSwitch(); });
    await React.act(async () => useStore.setState({ notifications: [{ id: 'unrelated', title: 'Mail arrived' }] }));
    await React.act(async () => { finish({ uid: 6, folder: 'Drafts', draftSource: source(6, B), cleanup: { status: 'deleted' } }); assert.equal(await saving, true); });
    assert.deepEqual(useStore.getState().composeData.draftSource, source(6, B));
  } finally { api.getSignatureLibrary = originalSignatures; await close(); }
});
