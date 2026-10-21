// MessageList's search states (#592): a search still waiting for its response says so instead of
// "no results", and a response that arrives after the query was cleared, or after the account
// or folder changed, is dropped. Harness as MessageList.render.test.js.

import { test, describe } from 'node:test';
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
  localStorage: dom.window.localStorage, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent,
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
// Search responses are held until a test releases them, as a slow server would.
const pending = [];
globalThis.fetch = async (url) => {
  const path = String(url);
  if (path.includes('/search?')) {
    const body = await new Promise((resolve, reject) => pending.push({ path, resolve, reject }));
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
  }
  const body = path.includes('/mail/messages?') ? { messages: [], total: 0 } : {};
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const MessageList = (await import('./MessageList.jsx')).default;

const ACCOUNT = { id: 'acct-1', email_address: 'a@example.test', name: 'A', color: '#6366f1', include_in_unified_inbox: true };
const hit = (id) => ({
  id, account_id: 'acct-1', folder: 'INBOX', uid: 1, subject: `Synthetic search example ${id}`, snippet: '',
  message_id: `<${id}@example.test>`, from_name: 'S', from_address: 's@example.test', date: new Date().toISOString(),
  is_read: true, is_starred: false, is_deleted: false, has_attachments: false,
});

let root;
const container = () => dom.window.document.getElementById('root');
const text = () => container().textContent;
const settle = () => React.act(async () => { await new Promise(r => setTimeout(r, 350)); });
const respond = async (body) => { const next = pending.shift(); assert.ok(next, 'a search request was made'); await React.act(async () => { next.resolve(body); await new Promise(r => setTimeout(r, 0)); }); return next.path; };

async function mount({ mobile = false, scrollMode = 'infinite', mode = 'off', pageSize = 50 } = {}) {
  pending.length = 0;
  if (root) await React.act(async () => root.unmount());
  dom.window.innerWidth = mobile ? 390 : 1024;
  useStore.setState({
    accounts: [ACCOUNT], accountsReady: true, selectedAccountId: 'acct-1', selectedFolder: 'INBOX',
    messages: [], messagesTotal: 0, hasMoreMessages: false, loadingMessages: false,
    searchQuery: '', searchResults: [], isSearching: false, threadedView: mode !== 'off', conversationMode: mode,
    selectedMessageId: null, notifications: [], markReadBehavior: 'manual',
    scrollMode, pageSize,
    folders: { 'acct-1': [{ path: 'INBOX', name: 'INBOX' }] },
  });
  await React.act(async () => { root = createRoot(container()); root.render(React.createElement(MessageList)); });
}
const search = (q) => React.act(async () => { useStore.getState().setSearchQuery(q); });

describe('MessageList search states (#592)', () => {
  test('says it is searching while the request is pending, and no results only once it says so', async () => {
    await mount();
    await search('Synthetic');
    assert.match(text(), /messageList\.searching/, 'during the debounce');
    assert.doesNotMatch(text(), /messageList\.noSearchResults/);
    await settle();
    assert.match(text(), /messageList\.searching/, 'while the request is pending');
    assert.doesNotMatch(text(), /messageList\.noSearchResults/);
    await respond({ messages: [] });
    assert.match(text(), /messageList\.noSearchResults/);
    assert.equal(container().querySelector('[role="status"]'), null);
  });

  test('shows the results once they arrive', async () => {
    await mount();
    await search('Synthetic');
    await settle();
    await respond({ messages: [hit('a')] });
    assert.match(text(), /Synthetic search example a/);
  });

  test('drops a response that arrives after the query was cleared', async () => {
    await mount();
    await search('Synthetic');
    await settle();
    await search('');
    await respond({ messages: [hit('late')] });
    assert.deepEqual(useStore.getState().searchResults, []);
    assert.doesNotMatch(text(), /Synthetic search example late/);
  });

  // The main search already dropped a response from before a folder change; "load more" checked
  // only the query text, so a page asked for in one folder could be added to another's results.
  test('drops a page of more results that arrives after the folder changed', async () => {
    await mount();
    await React.act(async () => useStore.setState({ pageSize: 2, folders: { 'acct-1': [{ path: 'INBOX', name: 'INBOX' }, { path: 'Archive', name: 'Archive' }] } }));
    await search('Synthetic');
    await settle();
    await respond({ messages: [hit('a'), hit('b')], nextCursor: 'inbox-page-2' });
    const more = [...container().querySelectorAll('button')].find(b => /messageList\.loadMore/.test(b.textContent));
    assert.ok(more, 'a full page offers more');
    await React.act(async () => { more.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    const page = pending.shift();
    assert.equal(new URL(page.path, dom.window.location).searchParams.get('cursor'), 'inbox-page-2');
    await React.act(async () => { useStore.setState({ selectedFolder: 'Archive' }); });
    await settle();
    await respond({ messages: [hit('archived')] });
    // The page asked for in INBOX arrives last.
    await React.act(async () => { page.resolve({ messages: [hit('stale')] }); await new Promise(r => setTimeout(r, 0)); });
    assert.deepEqual(useStore.getState().searchResults.map(m => m.id), ['archived']);
  });
});

describe('MessageList search cursors', () => {
  const moreButton = () => [...container().querySelectorAll('button')].find(b => /messageList\.loadMore/.test(b.textContent));
  const clickMore = () => React.act(async () => moreButton().click());
  async function firstPage() {
    await mount();
    await search('Synthetic');
    await settle();
    const path = await respond({ messages: [hit('a'), hit('b')], nextCursor: 'page-2' });
    assert.equal(new URL(path, dom.window.location).searchParams.get('cursor'), '');
  }

  test('uses the cursor after newer insertions, deduplicates overlap, and ignores repeat clicks', async () => {
    await firstPage();
    const button = moreButton();
    await React.act(async () => { button.click(); button.click(); });
    assert.equal(pending.length, 1, 'one request per cursor even before React rerenders');
    const params = new URL(pending[0].path, dom.window.location).searchParams;
    assert.equal(params.get('cursor'), 'page-2');
    assert.equal(params.has('offset'), false);
    await respond({ messages: [hit('b'), hit('c'), hit('c')], nextCursor: 'page-3' });
    assert.deepEqual(useStore.getState().searchResults.map(m => m.id), ['a', 'b', 'c']);
    await clickMore();
    assert.equal(new URL(pending[0].path, dom.window.location).searchParams.get('cursor'), 'page-3');
    await respond({ messages: [hit('d')], nextCursor: null });
    assert.deepEqual(useStore.getState().searchResults.map(m => m.id), ['a', 'b', 'c', 'd']);
    assert.equal(moreButton(), undefined);
  });

  test('a pending page cannot replace a new query cursor or unlock its in-flight page', async () => {
    await firstPage();
    await clickMore();
    const stale = pending.shift();
    await search('Replacement');
    await settle();
    const freshPath = await respond({ messages: [hit('fresh')], nextCursor: 'fresh-2' });
    assert.equal(new URL(freshPath, dom.window.location).searchParams.get('cursor'), '');
    await clickMore();
    await React.act(async () => { stale.resolve({ messages: [hit('stale')], nextCursor: 'stale-3' }); await new Promise(r => setTimeout(r, 0)); });
    assert.deepEqual(useStore.getState().searchResults.map(m => m.id), ['fresh']);
    assert.equal(moreButton(), undefined, 'stale finalizer must not clear current loading state');
    assert.equal(new URL(pending[0].path, dom.window.location).searchParams.get('cursor'), 'fresh-2');
    await respond({ messages: [hit('next')], nextCursor: null });
    assert.deepEqual(useStore.getState().searchResults.map(m => m.id), ['fresh', 'next']);
  });
});

describe('MessageList replacement search feedback', () => {
  const status = () => container().querySelector('[role="status"]');
  const release = (request, body) => React.act(async () => {
    request.resolve(body);
    await new Promise(r => setTimeout(r, 0));
  });
  const seedResults = async (options) => {
    await mount(options);
    await search('Synthetic');
    await settle();
    await respond({ messages: [hit('previous')] });
  };

  for (const mobile of [false, true]) {
    test(`keeps results and announces replacement search on ${mobile ? 'mobile' : 'desktop'}`, async () => {
      await seedResults({ mobile });
      const idleElements = new Set(container().querySelectorAll('div'));
      const input = container().querySelector('input[placeholder="messageList.search"]');
      await React.act(async () => input.focus());
      await search('Replacement');
      assert.equal(document.activeElement, input, 'typing keeps focus');
      assert.equal(input.disabled, false);
      assert.match(text(), /Synthetic search example previous/);
      assert.ok(status(), 'pending replacement has a status');
      assert.match(status().textContent, /messageList\.searching/);
      assert.equal(container().querySelectorAll('[role="status"]').length, 1);
      assert.ok(status().querySelector('[aria-hidden="true"]'), 'spinner is decorative');
      const progressSlot = status().parentElement;
      assert.ok(idleElements.has(progressSlot), 'the slot exists before searching starts');
      assert.equal(progressSlot.style.height, '34px', 'progress has reserved space');
      assert.doesNotMatch(text(), /messageList\.noMoreMessages/);
      assert.doesNotMatch(text(), /messageList\.loadMore/);
      await settle();
      assert.ok(status(), 'status survives the debounce');
      await respond({ messages: [hit('replacement')] });
      assert.equal(status(), null);
      assert.ok(progressSlot.isConnected, 'the progress slot remains after completion');
      assert.equal(progressSlot.textContent, '', 'idle space has no searching announcement');
      assert.doesNotMatch(text(), /Synthetic search example previous/);
      assert.match(text(), /Synthetic search example replacement/);
      assert.match(text(), /messageList\.noMoreMessages/);
      await search('');
      assert.equal(progressSlot.isConnected, false, 'folder browsing has no progress slot');
    });
  }

  test('shows no matches only after the replacement completes', async () => {
    await seedResults();
    await search('Missing');
    await settle();
    assert.match(text(), /Synthetic search example previous/);
    assert.ok(status());
    await respond({ messages: [] });
    assert.equal(status(), null);
    assert.match(text(), /messageList\.noSearchResults/);
    assert.doesNotMatch(text(), /Synthetic search example previous/);
  });

  test('surfaces a failed replacement and stops the progress feedback', async () => {
    await seedResults();
    await search('Failure');
    await settle();
    const request = pending.shift();
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args);
    try {
      await React.act(async () => {
        request.reject(new Error('Synthetic search failure'));
        await new Promise(r => setTimeout(r, 0));
      });
    } finally {
      console.error = originalError;
    }
    assert.equal(errors.length, 1);
    assert.equal(status(), null);
    assert.match(text(), /Synthetic search failure/);
    assert.doesNotMatch(text(), /Synthetic search example previous/);
  });

  for (const staleFails of [false, true]) {
    test(`a stale ${staleFails ? 'failure' : 'success'} cannot end the current progress feedback`, async () => {
      await seedResults();
      await search('Older');
      await settle();
      const older = pending.shift();
      await search('Newer');
      await settle();
      await React.act(async () => {
        if (staleFails) older.reject(new Error('Stale failure'));
        else older.resolve({ messages: [hit('stale')] });
        await new Promise(r => setTimeout(r, 0));
      });
      assert.ok(status(), 'old finalizer cannot stop current status');
      assert.match(text(), /Synthetic search example previous/);
      assert.doesNotMatch(text(), /Synthetic search example stale|Stale failure/);
      await respond({ messages: [hit('newest')] });
      assert.equal(status(), null);
      assert.match(text(), /Synthetic search example newest/);
    });
  }

  test('clearing remains usable during a replacement and drops its late response', async () => {
    await seedResults({ mobile: true });
    await search('Replacement');
    await settle();
    const input = container().querySelector('input[placeholder="messageList.search"]');
    const clear = input.parentElement.querySelector('button');
    assert.equal(clear.disabled, false);
    await React.act(async () => clear.click());
    assert.equal(input.value, '');
    assert.equal(status(), null);
    await respond({ messages: [hit('late')] });
    assert.deepEqual(useStore.getState().searchResults, []);
    assert.doesNotMatch(text(), /Synthetic search example late|messageList\.searching/);
  });

  for (const scope of ['selectedFolder', 'selectedAccountId']) {
    test(`a ${scope} change keeps feedback until the new scope responds`, async () => {
      await seedResults();
      await search('Replacement');
      await settle();
      const older = pending.shift();
      await React.act(async () => useStore.setState({
        [scope]: scope === 'selectedFolder' ? 'Archive' : null,
      }));
      await settle();
      await release(older, { messages: [hit('stale')] });
      assert.ok(status());
      assert.match(text(), /Synthetic search example previous/);
      await respond({ messages: [hit('new-scope')] });
      assert.equal(status(), null);
      assert.match(text(), /Synthetic search example new-scope/);
    });
  }

  test('does not display folder pagination under search results', async () => {
    await mount({ scrollMode: 'paginated' });
    await React.act(async () => useStore.setState({ messagesTotal: 100 }));
    assert.match(text(), /messageList\.pageOf/);
    await search('Synthetic');
    await settle();
    await respond({ messages: [hit('previous')] });
    assert.doesNotMatch(text(), /messageList\.pageOf|messageList\.nextPage/);
    await search('Replacement');
    assert.ok(status());
    assert.doesNotMatch(text(), /messageList\.pageOf|messageList\.nextPage/);
    await settle();
    await respond({ messages: [] });
  });
});

describe('grouped search cursor integration', () => {
  const group = (id, thread = 'T', account = ACCOUNT.id) => ({
    ...hit(id), account_id: account, matched_message_id: id,
    thread_id: JSON.stringify([account, thread]), reply_thread_id: null,
    from_email: 'nana@synthetic.test', from_name: 'Nana', is_read: false,
  });
  const moreButton = () => [...container().querySelectorAll('button')]
    .find(button => /messageList\.loadMore/.test(button.textContent));
  const more = async () => {
    const button = moreButton();
    assert.ok(button, 'server hasMore offers continuation');
    await React.act(async () => button.click());
  };
  const ids = () => useStore.getState().searchResults.map(message => message.id);
  const params = path => new URL(path, 'https://synthetic.test').searchParams;

  for (const mode of ['list', 'pane']) {
    test(`${mode} search requests grouped cursor mode and selects the matched physical row`, async () => {
      await mount({ mode });
      await search('Nana'); await settle();
      const path = await respond({ messages: [group('latest-inbound')], hasMore: false, nextCursor: null });
      assert.equal(params(path).get('threaded'), 'true');
      assert.equal(params(path).get('mode'), mode);
      assert.equal(params(path).get('cursor'), '');
      assert.equal(params(path).has('offset'), false);
      const row = container().querySelector('[data-msgid="latest-inbound"] [draggable]');
      assert.ok(row);
      await React.act(async () => row.click());
      assert.equal(useStore.getState().selectedMessageId, 'latest-inbound');
      const selected = useStore.getState().searchResults[0];
      assert.equal(selected.matched_message_id, 'latest-inbound');
      assert.equal(selected.from_email, 'nana@synthetic.test');
      assert.equal(selected.reply_thread_id, null);
      assert.equal(selected.search_scope.mode, mode);
    });
  }

  test('off mode retains different physical matches within one thread', async () => {
    await mount(); await search('Nana'); await settle();
    // Actual flat/v1 returns raw thread_id and nextCursor, with no hasMore or matched fields.
    const path = await respond({ messages: [{ ...hit('one'), thread_id: 'T' },
      { ...hit('two'), thread_id: 'T' }], nextCursor: null });
    assert.equal(params(path).has('threaded'), false);
    assert.equal(params(path).get('mode'), 'off');
    assert.deepEqual(ids(), ['one', 'two']);
  });

  test('off mode continues with the actual flat v1 cursor envelope without hasMore', async () => {
    await mount({ mode: 'off', pageSize: 1 }); await search('Nana'); await settle();
    const firstPath = await respond({ messages: [{ ...hit('one'), thread_id: 'T' }], nextCursor: 'v1-next' });
    assert.equal(params(firstPath).has('threaded'), false);
    assert.equal(params(firstPath).get('cursor'), '');
    assert.equal(params(firstPath).has('offset'), false);
    assert.deepEqual(ids(), ['one']);
    assert.ok(moreButton(), 'a flat nextCursor offers continuation without grouped hasMore');
    await more();
    const nextPath = await respond({ messages: [{ ...hit('two'), thread_id: 'T' }], nextCursor: null });
    assert.equal(params(nextPath).get('cursor'), 'v1-next');
    assert.equal(params(nextPath).has('threaded'), false);
    assert.equal(params(nextPath).has('offset'), false);
    assert.deepEqual(ids(), ['one', 'two']);
    assert.equal(moreButton(), undefined, 'null flat cursor exhausts the physical result');
  });

  test('loading after opening page one retains its representative and first group occurrence', async () => {
    await mount({ mode: 'list', pageSize: 2 }); await search('Nana'); await settle();
    await respond({ messages: [group('first'), group('other', 'U')], hasMore: true, nextCursor: 'c1' });
    await React.act(async () => useStore.getState().updateMessage('first', { is_read: true }));
    const first = useStore.getState().searchResults[0];
    await more();
    const path = await respond({ messages: [group('older'), group('next', 'V')], hasMore: false, nextCursor: null });
    assert.equal(params(path).get('cursor'), 'c1');
    assert.deepEqual(ids(), ['first', 'other', 'next']);
    assert.equal(useStore.getState().searchResults[0], first);
    assert.equal(first.is_read, true);
  });

  test('is:unread continuation keeps the first qualifying T match when a late newer T reappears', async () => {
    await mount({ mode: 'list', pageSize: 1 }); await search('is:unread Nana'); await settle();
    await respond({ messages: [group('a', 'A')], hasMore: true, nextCursor: 'c1' });
    await more();
    await respond({ messages: [group('t-old')], hasMore: true, nextCursor: 'c2' });
    await more();
    await respond({ messages: [group('t-new')], hasMore: false, nextCursor: null });
    assert.deepEqual(ids(), ['a', 't-old']);
  });

  test('duplicate-only pages advance internally at most three times and keep continuation available', async () => {
    await mount({ mode: 'list', pageSize: 1 }); await search('Nana'); await settle();
    await respond({ messages: [group('first')], hasMore: true, nextCursor: 'c1' });
    await more();
    for (let i = 1; i <= 3; i++) {
      const path = await respond({ messages: [group(`older-${i}`)], hasMore: true, nextCursor: `c${i + 1}` });
      assert.equal(params(path).get('cursor'), `c${i}`);
    }
    assert.deepEqual(ids(), ['first']);
    assert.equal(pending.length, 0, 'three-round bound prevents another automatic request');
    assert.ok(moreButton());
    await more();
    const path = await respond({ messages: [group('next', 'U')], hasMore: false, nextCursor: null });
    assert.equal(params(path).get('cursor'), 'c4');
    assert.deepEqual(ids(), ['first', 'next']);
  });

  test('mode replacement invalidates a pending continuation and starts a fresh cursor', async () => {
    await mount({ mode: 'list', pageSize: 1 }); await search('Nana'); await settle();
    await respond({ messages: [group('first')], hasMore: true, nextCursor: 'old-cursor' });
    await more(); const old = pending.shift();
    await React.act(async () => useStore.setState({ conversationMode: 'pane', threadedView: true }));
    await settle();
    const path = await respond({ messages: [group('replacement', 'U')], hasMore: false, nextCursor: null });
    assert.equal(params(path).get('mode'), 'pane');
    assert.equal(params(path).get('cursor'), '');
    await React.act(async () => { old.resolve({ messages: [group('stale', 'V')], hasMore: true, nextCursor: 'wrong' }); await new Promise(r => setTimeout(r, 0)); });
    assert.deepEqual(ids(), ['replacement']);
  });

  test('removal-prefetch uses the last server cursor and preserves groups from another account', async () => {
    await mount({ mode: 'list', pageSize: 1 });
    await React.act(async () => useStore.setState({ selectedAccountId: null,
      accounts: [ACCOUNT, { ...ACCOUNT, id: 'account-b', email_address: 'b@synthetic.test' }] }));
    await search('Nana'); await settle();
    await respond({ messages: [group('remove')], hasMore: true, nextCursor: 'after-remove' });
    const row = container().querySelector('[data-msgid="remove"] [draggable]');
    await React.act(async () => row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ctrlKey: true })));
    const button = container().querySelector('button[title="messageList.deleteSelected"]');
    assert.ok(button);
    await React.act(async () => { button.click(); await new Promise(r => setTimeout(r, 0)); });
    try {
      const path = await respond({ messages: [group('replacement', 'T', 'account-b')], hasMore: false, nextCursor: null });
      assert.equal(params(path).get('cursor'), 'after-remove');
      assert.equal(params(path).has('offset'), false);
      assert.deepEqual(ids(), ['replacement']);
    } finally {
      const undo = useStore.getState().notifications.find(notification => notification.onUndo)?.onUndo;
      assert.ok(undo, 'delete remains reversible while testing prefetch');
      await React.act(async () => {
        undo();
        root.unmount();
        root = null;
      });
    }
  });
});

// Proposal to append to MessageList.search.test.js on the exact released v3 successor.
// Uses its actual mounted list, shared wrapper/hotkey/store. Unapplied and unrun.
describe('grouped search merge next own-read action', () => {
  for (const [pendingIntent, heldSecondPage] of [[false, false], [true, false], [true, true]]) {
    test(`${heldSecondPage ? 'intent during held second page retains' : pendingIntent ? 'pending intent retains' : 'equal fresh aggregate replaces'} the representative own flag before the next action`, async t => {
      const { api } = await import('../utils/api.js');
      const { changeMessageRead } = await import('../utils/messageHotkeys.js');
      const { countWriteTracker } = await import('../utils/countWriteTracker.js');
      const { setReadIntentSession } = await import('../utils/pendingReads.js');
      const calls = [], deltas = [];
      let releaseWrite, releaseCounts;
      const writeGate = new Promise(resolve => { releaseWrite = resolve; });
      const countGate = new Promise(resolve => { releaseCounts = resolve; });
      const observation = { byAccount: { 'acct-1': 3 }, snapshots: { 'acct-1': {
        revision: '1', epoch: 'synthetic-nana', refreshSeqAtStart: '1', quiescentAtStart: true,
        known: true, stale: false, observedAt: '2026-10-21T00:00:00Z', totalCount: 5,
      } } };
      t.mock.method(api, 'getUnreadCounts', async () => observation);
      t.mock.method(api, 'getCategoryCounts', async () => ({ counts: { primary: 3 }, countRevision: '1',
        byAccount: { 'acct-1': { counts: { primary: 3 }, totals: { primary: 5 } } } }));
      t.mock.method(api, 'refreshCounts', async () => { await countGate; return { epoch: 'synthetic-nana', refreshSeq: '2' }; });
      t.mock.method(api, 'bulkRead', async (ids, read) => {
        calls.push({ ids, read });
        if (pendingIntent && read) await writeGate;
      });
      t.after(async () => {
        await React.act(async () => {
          useStore.getState().setLocked(true);
          releaseWrite(); releaseCounts();
          if (root) { root.unmount(); root = null; }
          await new Promise(resolve => setTimeout(resolve, 0));
        });
      });
      useStore.getState().setUser({ id: 'nana-own-read@synthetic.test' });
      useStore.getState().setLocked(false);
      await mount({ mode: 'list', pageSize: 1 });
      setReadIntentSession(countWriteTracker.generation());
      useStore.getState().setUnreadCounts(observation);
      const message = { ...hit('r'), category: 'primary', is_read: !pendingIntent,
        thread_id: '["acct-1","T"]', matched_message_id: 'r', unread_count: pendingIntent ? 1 : 0 };
      await search('Nana'); await settle();
      await respond({ messages: [message], hasMore: true, nextCursor: 'next' });
      const st = useStore.getState();
      const dependencies = { update: st.updateMessage, patch: api.bulkRead,
        incrementUnread: account => { deltas.push(1); return st.incrementUnread(account); },
        decrementUnread: account => { deltas.push(-1); return st.decrementUnread(account); },
        adjustCategoryCount: st.adjustCategoryCount };
      const startReadIntent = async () => {
        await React.act(async () => { changeMessageRead(st.searchResults[0], true, dependencies); await new Promise(resolve => setTimeout(resolve, 0)); });
      };
      if (pendingIntent && !heldSecondPage) {
        await startReadIntent();
      } else if (!pendingIntent) {
        await React.act(async () => st.updateMessage('r', { is_read: true, unread_count: 0 }));
      }
      const keepAggregateUnread = () => useStore.setState(state => ({ searchResults: state.searchResults.map(row =>
        row.id === 'r' ? { ...row, is_read: false, representative_is_read: true } : row) }));
      if (!heldSecondPage) await React.act(async () => keepAggregateUnread());
      const more = [...container().querySelectorAll('button')].find(button => /messageList\.loadMore/.test(button.textContent));
      assert.ok(more);
      await React.act(async () => more.click());
      if (heldSecondPage) {
        await respond({ messages: [{ ...message, is_read: false }], hasMore: true, nextCursor: 'held-second' });
        assert.equal(pending.length, 1, 'duplicate-only first response starts a second real request');
        // Response one has already been guarded. The new intent starts while the
        // second actual request is held, before the batch publishes either page.
        await startReadIntent();
        await React.act(async () => keepAggregateUnread());
        await respond({ messages: [{ ...hit('tail'), thread_id: '["acct-1","U"]', matched_message_id: 'tail' }],
          hasMore: false, nextCursor: null });
      } else await respond({ messages: [{ ...message, is_read: false }], hasMore: false, nextCursor: null });
      const merged = useStore.getState().searchResults[0];
      assert.equal(merged.is_read, false, 'aggregate stays unread while the own flag follows its guarded source');
      if (pendingIntent) {
        assert.equal(merged.representative_is_read, true);
        await React.act(async () => { changeMessageRead(merged, true, dependencies); });
        assert.equal(calls.length, 1, 'next explicit read follows the pending read and short-circuits');
        assert.deepEqual(deltas, [-1]);
        await React.act(async () => { changeMessageRead(merged, false, dependencies); releaseWrite(); await new Promise(resolve => setTimeout(resolve, 0)); });
        assert.deepEqual(calls.map(call => call.read), [true, false]);
        assert.deepEqual(deltas, [-1, 1]);
      } else {
        assert.equal(Object.hasOwn(merged, 'representative_is_read'), false, 'fresh physical row has no own-flag override');
        await React.act(async () => { changeMessageRead(merged, false, dependencies); });
        assert.deepEqual(calls, [], 'next explicit unread does not dispatch twice');
        assert.deepEqual(deltas, [], 'next explicit unread does not count twice');
        await React.act(async () => { changeMessageRead(merged, true, dependencies); await new Promise(resolve => setTimeout(resolve, 0)); });
        assert.deepEqual(calls, [{ ids: ['r'], read: true }]);
        assert.deepEqual(deltas, [-1]);
      }
    });
  }
});
// Append to the actual MessageList.search.test.js harness on the lead-released
// combined fixture. No execution on 6ef, which lacks the real token exports.
describe('search request tokens through the actual shared wrapper', () => {
  for (const site of ['initial', 'load-more', 'removal-prefetch']) {
    test(`${site}: precompletion response retains intent and postcompletion response converges remote unread`, async t => {
      const { api } = await import('../utils/api.js');
      const { changeMessageRead } = await import('../utils/messageHotkeys.js');
      const { countWriteTracker } = await import('../utils/countWriteTracker.js');
      const { setReadIntentSession, pendingMarkReadMap } = await import('../utils/pendingReads.js');
      let releaseWrite, releaseCounts;
      const write = new Promise(resolve => { releaseWrite = resolve; });
      const counts = new Promise(resolve => { releaseCounts = resolve; });
      const writes = [];
      t.mock.method(api, 'bulkRead', async (ids, read) => { writes.push({ ids, read }); await write; });
      t.mock.method(api, 'refreshCounts', async () => { await counts; return {}; });
      const tick = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
      t.after(async () => {
        await React.act(async () => {
          for (const notification of useStore.getState().notifications) notification.onUndo?.();
          useStore.getState().setLocked(true);
          releaseWrite(); releaseCounts();
          if (root) { root.unmount(); root = null; }
          await new Promise(resolve => setTimeout(resolve, 0));
        });
      });
      useStore.getState().setUser({ id: `nana-token-${site}@synthetic.test` });
      useStore.getState().setLocked(false);
      await mount({ mode: 'list', pageSize: 2 });
      setReadIntentSession(countWriteTracker.generation());
      const group = (id, thread = id) => ({ ...hit(id), is_read: false,
        thread_id: JSON.stringify(['acct-1', thread]), matched_message_id: id });
      const parent = group('parent');
      const loadMore = async () => {
        const button = [...container().querySelectorAll('button')].find(button => /messageList\.loadMore/.test(button.textContent));
        assert.ok(button); await React.act(async () => button.click());
      };
      const remove = async id => {
        const row = container().querySelector(`[data-msgid="${id}"] [draggable]`);
        assert.ok(row);
        await React.act(async () => row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ctrlKey: true })));
        const button = container().querySelector('button[title="messageList.deleteSelected"]');
        assert.ok(button); await React.act(async () => { button.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
      };
      await search('Nana'); await settle();
      if (site !== 'initial') {
        await respond({ messages: [parent, group('remove-before')], hasMore: true, nextCursor: 'old' });
        if (site === 'load-more') await loadMore(); else await remove('remove-before');
      }
      assert.equal(pending.length, 1, 'the actual old request is issued before the intent');
      const state = useStore.getState();
      await React.act(async () => changeMessageRead(parent, true, {
        update: state.updateMessage, patch: api.bulkRead,
        incrementUnread: state.incrementUnread, decrementUnread: state.decrementUnread,
        adjustCategoryCount: state.adjustCategoryCount,
      }));
      await tick(); assert.equal(writes.length, 1);
      await React.act(async () => { releaseWrite(); await new Promise(resolve => setTimeout(resolve, 0)); });
      assert.equal(pendingMarkReadMap.has(parent.id), false, 'the actual write completion ran');
      await respond({ messages: [parent, group('remove-after')], hasMore: true, nextCursor: 'fresh' });
      const guarded = useStore.getState().searchResults.find(row => row.id === parent.id);
      assert.equal(guarded.representative_is_read ?? guarded.is_read, true,
        'a precompletion request arriving after completion must not undo the local read');
      if (site === 'initial') {
        await React.act(async () => window.dispatchEvent(new dom.window.Event('mailflow:rules-ran')));
        await settle();
      } else if (site === 'load-more') await loadMore(); else await remove('remove-after');
      assert.equal(pending.length, 1, 'a second actual request starts only after completion');
      await respond({ messages: [parent], hasMore: false, nextCursor: null });
      const fresh = useStore.getState().searchResults.find(row => row.id === parent.id);
      assert.equal(fresh.representative_is_read ?? fresh.is_read, false,
        'the unchanged wrapper must admit remote unread from the new issued token');
      assert.equal(Object.hasOwn(fresh, 'representative_is_read'), false);
      assert.equal(writes.length, 1, 'request reconciliation does not issue a second write');
    });
  }
});
