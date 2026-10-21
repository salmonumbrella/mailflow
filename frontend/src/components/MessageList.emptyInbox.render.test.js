// Synthetic account-switch regression; no private recording data.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k, d) => (typeof d === "string" ? d : d?.defaultValue ?? k), i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export const Trans = ({ children }) => children ?? null;',
        'export const I18nextProvider = ({ children }) => children ?? null;',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    const shimViteEnv = (code) => code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
    if (url.endsWith('.jsx')) {
      const code = readFileSync(new URL(url), 'utf8');
      const out = transform(code, { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: shimViteEnv(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) {
        return { format: 'module', shortCircuit: true, source: shimViteEnv(code) };
      }
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
// useMobile() reads window.innerWidth first, then subscribes to matchMedia. jsdom defaults
// innerWidth to 1024, which is the desktop case the bug report is about.
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.matchMedia = dom.window.matchMedia;
dom.window.Element.prototype.scrollIntoView = () => {};
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}) });
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const { selectAuthoritativeInboxSnapshot } = await import('../utils/countSnapshots.js');
const { beginCountIntent } = await import('../utils/countWriteTracker.js');
const MessageList = (await import('./MessageList.jsx')).default;
const accounts = ['a', 'b', 'c'].map(id => ({ id, enabled: true, include_in_unified_inbox: true,
  email_address: `${id}@mail.test`, name: id }));
const row = account_id => ({ id: `mail-${account_id}`, account_id, folder: 'INBOX', uid: 1,
  subject: `Mail for ${account_id}`, snippet: 'preview', message_id: `<${account_id}@mail.test>`,
  from_name: 'Sender', from_address: 'sender@mail.test', date: '2026-10-20T00:00:00Z',
  is_read: true, is_starred: false, is_deleted: false, has_attachments: false });
let root, pending = [], requests = [], fixtureSession = 0;
api.getMessages = params => new Promise((resolve, reject) => { pending.push({ params, resolve, reject }); requests.push(params); });
const container = document.getElementById('root');
const skeleton = () => !!container.querySelector('.skeleton-line');
const hasText = text => [...container.querySelectorAll('*')].some(element => element.children.length === 0 && element.textContent === text);
const ordinaryEmpty = () => hasText('Inbox is empty');
const isEmpty = () => ordinaryEmpty() || hasText('messageList.emptyInbox');
const snapshot = (totalCount = 0, overrides = {}) => ({ totalCount, revision: '10', attemptRevision: '10',
  known: true, stale: false, observedAt: new Date().toISOString(), ...overrides });
function counts(samples) {
  const state = useStore.getState();
  state.setUnreadCounts({ total: 0, complete: true,
    byAccount: Object.fromEntries(Object.keys(samples).map(id => [id, 0])), snapshots: samples }, state.countGeneration);
}
async function mount({ samples = { a: snapshot(), b: snapshot(), c: snapshot() }, rows = [], total = rows.length, extra = {} } = {}) {
  if (root) await React.act(async () => root.unmount());
  pending = []; requests = [];
  const state = useStore.getState();
  state.setUser({ id: `fixture-user-${++fixtureSession}.test` });
  state.setLocked(false);
  state.setAccounts(accounts);
  state.setSelectedAccount('a');
  counts(samples);
  useStore.setState({ messages: [], messagesOffset: 0, messagesTotal: 0, hasMoreMessages: true,
    loadingMessages: false, searchQuery: '', threadedView: false,
    scrollMode: 'infinite', pageSize: 50, activeGtdTab: null, enabledPlugins: [], categorizationEnabled: false,
    folders: {}, ...extra });
  await React.act(async () => { root = createRoot(container); root.render(React.createElement(MessageList)); });
  assert.equal(pending.length, 1);
  await React.act(async () => pending.shift().resolve({ messages: [], total: 0 }));
  // Witness the real settled ordinary surface before any absence assertion can rely on it.
  assert.equal(ordinaryEmpty(), true, 'the mounted ordinary Inbox baseline renders its real literal');
  assert.equal(isEmpty(), true);
  assert.equal(skeleton(), false);
  assert.equal(useStore.getState().loadingMessages, false);
  if (rows.length || total > 0) {
    await React.act(async () => useStore.getState().setSelectedAccount('a'));
    assert.equal(pending.length, 1);
    await React.act(async () => pending.shift().resolve({ messages: rows, total }));
  }
}
async function select(id) { await React.act(async () => useStore.getState().setSelectedAccount(id)); }
async function settle(rows = [], total = rows.length) {
  assert.ok(pending.length);
  await React.act(async () => pending.shift().resolve({ messages: rows, total }));
}
after(async () => { if (root) await React.act(async () => root.unmount()); dom.window.close(); });

test('empty-to-empty revisits keep EmptyState while the real page-zero request continues', async () => {
  await mount();
  await select('b');
  assert.equal(useStore.getState().loadingMessages, true);
  assert.equal(skeleton(), false);
  assert.equal(isEmpty(), true);
  assert.equal(requests.length, 2, 'presentation issues no extra or mutation requests');
  assert.equal(pending[0].params.offset, 0);
  await settle();
  await select('a');
  assert.equal(skeleton(), false);
  assert.equal(isEmpty(), true);
  await settle();
});

test('populated-to-empty never borrows old rows; an actual nonempty response wins over provider zero', async () => {
  await mount({ rows: [row('a')] });
  await select('b');
  assert.equal(container.querySelector('[data-msgid]'), null);
  assert.equal(skeleton(), false);
  assert.equal(isEmpty(), true);
  await settle([row('b')]);
  assert.ok(container.querySelector('[data-msgid="mail-b"]'));
  assert.equal(isEmpty(), false);
  assert.equal(useStore.getState().messagesTotal, 1);
});

test('unknown, stale and positive provider totals keep skeletons despite zero unread display', async () => {
  for (const sample of [undefined, snapshot(0, { stale: true }), snapshot(0, { observedAt: new Date(Date.now() - 180001).toISOString() }), snapshot(7)]) {
    await mount({ samples: { a: snapshot(), ...(sample ? { b: sample } : {}) } });
    await select('b');
    assert.equal(skeleton(), true);
    assert.equal(isEmpty(), false);
    await settle();
  }
});

test('unified considers every included account, while excluded accounts do not block emptiness', async () => {
  await mount({ samples: { a: snapshot(), b: snapshot(), c: snapshot(1) } });
  await select(null);
  assert.equal(skeleton(), true);
  await settle();
  await React.act(async () => useStore.getState().setAccounts(accounts.map(a => a.id === 'c' ? { ...a, include_in_unified_inbox: false } : a)));
  // Membership changes revalidate the list; only a and b now support the presentation.
  assert.equal(skeleton(), false);
  assert.equal(isEmpty(), true);
  await settle();
});

test('current load errors show continuation retry instead of a successful empty claim', async () => {
  await mount();
  await select('b');
  await React.act(async () => pending.shift().reject(new Error('Synthetic list failure')));
  assert.equal(useStore.getState().loadingMessages, false);
  assert.equal(isEmpty(), false);
  assert.ok([...container.querySelectorAll('button')].some(button => button.textContent.includes('messageList.loadMore')));
});

test('delayed out-of-order account responses cannot leak old rows or clear current loading', async () => {
  await mount();
  await select('b');
  const old = pending.shift();
  await select('c');
  await React.act(async () => old.resolve({ messages: [row('b')], total: 1 }));
  assert.equal(container.querySelector('[data-msgid]'), null);
  assert.equal(useStore.getState().loadingMessages, true);
  assert.equal(skeleton(), false);
  await settle([row('c')]);
  assert.ok(container.querySelector('[data-msgid="mail-c"]'));
});

test('new authoritative mail evidence removes the pending override and the response renders mail', async () => {
  await mount();
  await select('b');
  assert.equal(isEmpty(), true);
  await React.act(async () => counts({ a: snapshot(), b: snapshot(1, { revision: '11', attemptRevision: '11' }) }));
  assert.equal(skeleton(), true);
  assert.equal(isEmpty(), false);
  await settle([row('b')]);
  assert.ok(container.querySelector('[data-msgid="mail-b"]'));
});

test('logout discards prior session evidence and rejects its old count callback', async () => {
  await mount();
  const oldGeneration = useStore.getState().countGeneration;
  await React.act(async () => {
    const state = useStore.getState();
    state.setUser(null);
    state.setUser({ id: 'fixture-other-user.test' });
    state.setAccounts(accounts);
    state.setSelectedAccount('b');
    state.setUnreadCounts({ byAccount: { b: 0 }, snapshots: { b: snapshot() } }, oldGeneration);
  });
  assert.equal(skeleton(), true);
  assert.equal(isEmpty(), false);
  await settle();
});

test('provider total zero supports unread/category/thread scopes while their real requests still run', async () => {
  await mount({ extra: { threadedView: true, categorizationEnabled: true } });
  await select('b');
  assert.equal(pending[0].params.threaded, 'true');
  assert.equal(pending[0].params.category, 'primary');
  assert.equal(skeleton(), false);
  await settle();
  await React.act(async () => container.querySelector('[title="messageList.unreadOnly"]').click());
  assert.equal(pending[0].params.unreadOnly, 'true');
  assert.equal(skeleton(), false);
  assert.equal(isEmpty(), true);
  await settle();
});

test('an exhausted page-zero loadMore response keeps a subsequent offset-zero retry truthful', async () => {
  await mount({ rows: [row('a')] });
  await React.act(async () => useStore.getState().removeMessages(['mail-a']));
  const loadMore = () => [...container.querySelectorAll('button')].find(button => button.textContent.includes('messageList.loadMore'));
  assert.ok(loadMore(), 'removing the last loaded row retains continuation');
  await React.act(async () => loadMore().click());
  assert.equal(pending[0].params.offset, 0);
  await settle([], 91);
  assert.equal(isEmpty(), false);
  await React.act(async () => loadMore().click());
  assert.equal(pending[0].params.offset, 0);
  assert.equal(isEmpty(), false, 'newer DB continuation evidence wins over provider zero');
  assert.equal(skeleton(), true);
  await settle([row('a')], 91);
});


test('the real selector keeps the exact 180000ms snapshot boundary fresh in the mounted list', async () => {
  const realNow = Date.now;
  const now = Date.parse('2026-10-21T12:00:00Z');
  Date.now = () => now;
  try {
    for (const age of [180000, 180001]) {
      await mount({ samples: { a: snapshot(), b: snapshot(0, { observedAt: new Date(now - age).toISOString() }) } });
      await select('b');
      const selected = selectAuthoritativeInboxSnapshot(useStore.getState(), 'b', now);
      assert.equal(selected.known, true);
      assert.equal(selected.stale, age > 180000);
      assert.equal(isEmpty(), age === 180000);
      assert.equal(skeleton(), age > 180000);
      await settle();
    }
  } finally { Date.now = realNow; }
});

test('a real canonical pending intent vetoes zero presentation without seeding projection internals', async () => {
  await mount();
  await select('b');
  assert.equal(isEmpty(), true);
  let end;
  try {
    await React.act(async () => { end = beginCountIntent(['b']); });
    const selected = selectAuthoritativeInboxSnapshot(useStore.getState(), 'b');
    assert.equal(selected.totalCount, 0, 'the authoritative total stays zero');
    assert.equal(selected.pending, true, 'the live canonical projection supplies the pending veto');
    assert.equal(isEmpty(), false);
    assert.equal(skeleton(), true);
    await settle();
  } finally {
    await React.act(async () => {
      useStore.getState().setUser(null);
      end?.(); // Ending the previous generation cannot start a new-session observation.
    });
  }
});

test('a disabled selected account cannot provide enabled-scope empty evidence', async () => {
  await mount();
  await React.act(async () => {
    const state = useStore.getState();
    state.setAccounts(accounts.map(account => account.id === 'b' ? { ...account, enabled: false } : account));
    state.setSelectedAccount('b');
  });
  assert.equal(skeleton(), true);
  assert.equal(isEmpty(), false);
  await settle();
});


function assertKnownZero(accountId = 'a') {
  const sample = selectAuthoritativeInboxSnapshot(useStore.getState(), accountId);
  assert.deepEqual({ known: sample.known, stale: sample.stale, pending: sample.pending, totalCount: sample.totalCount },
    { known: true, stale: false, pending: false, totalCount: 0 });
}
const buttonContaining = text => [...container.querySelectorAll('button')].find(button => button.textContent.includes(text));

test('real non-Inbox navigation keeps its pending skeleton and settled folder surface with canonical zero', async () => {
  await mount();
  await React.act(async () => useStore.getState().setSelectedAccount('a', 'Archive'));
  assertKnownZero();
  assert.equal(pending[0].params.folder, 'Archive');
  assert.equal(useStore.getState().loadingMessages, true);
  assert.equal(skeleton(), true, 'a held folder load has a positive existing-loading witness');
  assert.equal(isEmpty(), false);
  await settle();
  assert.equal(hasText('Nothing here'), true, 'settled Archive uses its real folder empty surface');
  assert.equal(isEmpty(), false);
});

test('a real trimmed search retains its pending search status and settled search surface with canonical zero', { timeout: 5000 }, async () => {
  await mount();
  const originalSearch = api.search;
  let resolveSearch, announceSearch;
  const started = new Promise(resolve => { announceSearch = resolve; });
  api.search = query => new Promise(resolve => {
    assert.equal(query.trim(), 'invoice');
    resolveSearch = resolve;
    announceSearch();
  });
  try {
    await React.act(async () => useStore.getState().setSearchQuery('  invoice  '));
    await started; // Wait for the real component debounce/request, not a fixed sleep.
    assertKnownZero();
    assert.equal(useStore.getState().isSearching, true);
    assert.ok(container.querySelector('[role="status"]')?.textContent.includes('messageList.searching'));
    assert.equal(isEmpty(), false);
    await React.act(async () => resolveSearch({ messages: [], nextCursor: null, hasMore: false }));
    assert.equal(hasText('messageList.noSearchResults'), true);
    assert.equal(isEmpty(), false);
  } finally { api.search = originalSearch; }
});

test('a real active GTD tab remains the displayed surface while an ordinary refresh is held', async () => {
  await mount();
  await React.act(async () => {
    const state = useStore.getState();
    state.setAccounts(accounts.map(account => ({ ...account, gtd_enabled: true })));
    await state.setPluginActivated('gtd', true);
    state.setActiveGtdTab('todo');
  });
  assert.equal(hasText('gtd.tabEmpty'), true);
  await React.act(async () => useStore.getState().setSelectedAccount('a'));
  assertKnownZero();
  assert.equal(useStore.getState().activeGtdTab, 'todo');
  assert.equal(useStore.getState().loadingMessages, true);
  assert.equal(pending[0].params.offset, 0);
  assert.equal(hasText('gtd.tabEmpty'), true, 'the actual GTD body is the alternate-surface witness');
  assert.equal(isEmpty(), false);
  await settle();
});

test('real next-page navigation keeps the page>1/nonzero-offset loading surface with canonical zero', async () => {
  await mount({ rows: [row('a')], total: 3 });
  await React.act(async () => {
    const state = useStore.getState();
    state.setScrollMode('paginated');
    state.setPageSize(1);
  });
  assert.equal(pending[0].params.offset, 0);
  await settle([row('a')], 3);
  await React.act(async () => useStore.getState().removeMessages(['mail-a']));
  const next = buttonContaining('messageList.nextPage');
  assert.ok(next && !next.disabled);
  await React.act(async () => next.click());
  assertKnownZero();
  assert.equal(pending[0].params.offset, 1, 'the real second-page button dispatches a forward page');
  assert.equal(pending[0].params.limit, 1);
  assert.equal(useStore.getState().messagesOffset, 1);
  assert.equal(useStore.getState().loadingMessages, true);
  assert.equal(skeleton(), true);
  assert.equal(isEmpty(), false);
  await settle([], 3);
});

test('a real infinite forward-offset load cannot borrow the page-zero empty presentation', async () => {
  await mount({ rows: [row('a')], total: 3 });
  await React.act(async () => useStore.getState().setPageSize(1));
  await settle([row('a')], 3);
  await React.act(async () => useStore.getState().removeMessages(['mail-a']));
  await React.act(async () => buttonContaining('messageList.loadMore').click());
  assertKnownZero();
  assert.equal(pending[0].params.offset, 1);
  assert.equal(useStore.getState().messagesOffset, 1);
  assert.equal(useStore.getState().loadingMessages, true);
  assert.equal(skeleton(), true);
  assert.equal(isEmpty(), false);
  await settle([row('a')], 3);
});
