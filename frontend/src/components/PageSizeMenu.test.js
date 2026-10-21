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

const dom = new JSDOM('<div id="root"></div>', { url: 'https://synthetic.test', pretendToBeVisual: true });
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
const requests = [];
globalThis.fetch = async (url, options = {}) => {
  requests.push({ url: new URL(String(url), 'https://synthetic.test'), options });
  const body = String(url).includes('/mail/messages?') ? { messages: [{ id: 'message-1', account_id: 'account-1', folder: 'INBOX', uid: 1, subject: 'Synthetic message', from_address: 'sender@synthetic.test', date: '2026-10-20T12:00:00Z', is_read: false }], total: 250 } : { messages: [] };
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
};
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const MessageList = (await import('./MessageList.jsx')).default;
let root;
const container = document.getElementById('root');
const click = element => React.act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
const trigger = () => container.querySelector('button[aria-haspopup="listbox"]');
after(async () => { if (root) await React.act(async () => root.unmount()); dom.window.close(); });

async function mount(layout = 'comfortable') {
  if (root) await React.act(async () => root.unmount());
  useStore.setState({
    accounts: [{ id: 'account-1', email_address: 'reader@synthetic.test', include_in_unified_inbox: true }],
    accountsReady: true, selectedAccountId: 'account-1', selectedFolder: 'INBOX',
    messages: [], messagesTotal: 0, hasMoreMessages: false, loadingMessages: false,
    searchQuery: '', searchAllFolders: false, searchResults: [], isSearching: false, threadedView: false,
    scrollMode: 'paginated', pageSize: 50, layout, categorizationEnabled: false,
    folders: { 'account-1': [{ path: 'INBOX', name: 'INBOX' }] },
  });
  requests.length = 0;
  await React.act(async () => { root = createRoot(container); root.render(React.createElement(MessageList)); });
}

for (const layout of ['comfortable', 'focused']) {
  test(`${layout}: actual page-size control opens a labeled themed listbox`, async () => {
    await mount(layout);
    assert.ok(trigger(), 'page size uses an accessible listbox trigger instead of a native select');
    assert.equal(trigger().getAttribute('aria-label'), 'messageList.messagesPerPage');
    assert.match(trigger().textContent, /50/);
    await click(trigger());
    const menu = document.querySelector('[role="listbox"]');
    assert.ok(menu);
    assert.equal(menu.getAttribute('aria-label'), 'messageList.messagesPerPage');
    assert.deepEqual([...menu.querySelectorAll('[role="option"]')].map(option => option.textContent.trim()), ['25', '50', '100', '200']);
    assert.equal(menu.querySelector('[aria-selected="true"]').textContent.trim(), '50');
  });
}

const key = (element, value, extra = {}) => React.act(async () => {
  const event = new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra });
  element.dispatchEvent(event);
  return event;
});
const popup = () => document.querySelector('[role="listbox"]');
const option = size => [...document.querySelectorAll('[role="option"]')].find(node => node.textContent.trim() === String(size));
const settle = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
let PageSizeMenu;
async function renderMenu(value = 50, onChange = () => {}, identity = 'same') {
  PageSizeMenu ||= (await import('./PageSizeMenu.jsx')).default;
  if (!root) root = createRoot(container);
  await React.act(async () => root.render(React.createElement('div', null,
    React.createElement('button', { id: 'before' }, 'Before'),
    React.createElement(PageSizeMenu, { scope: identity, value, onChange, label: 'Messages per page' }),
    React.createElement('button', { id: 'after' }, 'After'))));
}

test('constrained popup scrolling preserves the visible focused last option', async () => {
  await renderMenu();
  const oldHeight = window.innerHeight;
  window.innerHeight = 240;
  trigger().getBoundingClientRect = () => ({ left: 100, top: 100, bottom: 124 });
  try {
    await click(trigger());
    const menu = popup();
    Object.defineProperty(menu, 'scrollHeight', { configurable: true, get() {
      // Model the browser clamping scrollTop when a layout read removes the scroll range.
      if (parseFloat(this.style.maxHeight) >= 160) this.scrollTop = 0;
      return 160;
    } });
    await key(document.activeElement, 'End');
    menu.scrollTop = 56;
    await React.act(async () => menu.dispatchEvent(new window.Event('scroll')));
    assert.equal(menu.scrollTop, 56);
    assert.equal(document.activeElement, option(200));
    assert.ok(160 - menu.scrollTop <= parseFloat(menu.style.maxHeight), 'last option remains within the constrained visible range');
  } finally {
    window.innerHeight = oldHeight;
    await React.act(async () => root.render(null));
  }
});

test('coarse target minima stay at least 44 visual pixels at supported scales', async () => {
  for (const fontSize of [80, 100, 125]) {
    await React.act(async () => useStore.setState({ fontSize }));
    await renderMenu();
    // jsdom has no media-query layout engine: activate the actual coarse rule, then
    // check its computed minimum in visual coordinates. Real bounds stay a browser gate.
    const sheet = container.querySelector('style').sheet;
    const coarse = [...sheet.cssRules].find(rule => rule.conditionText === '(pointer: coarse)');
    const activeCoarse = document.createElement('style');
    activeCoarse.textContent = [...coarse.cssRules].map(rule => rule.cssText).join('\n');
    document.head.append(activeCoarse);
    try {
      await click(trigger());
      for (const target of [trigger(), ...popup().querySelectorAll('[role="option"]')]) {
        const style = getComputedStyle(target);
        assert.ok(parseFloat(style.minHeight) * fontSize / 100 >= 44, `${fontSize}% target height`);
        assert.ok(parseFloat(style.minWidth) * fontSize / 100 >= 44, `${fontSize}% target width`);
      }
    } finally {
      activeCoarse.remove();
      await React.act(async () => root.render(null));
    }
  }
  await React.act(async () => useStore.setState({ fontSize: 100 }));
});

test('every current/next pair commits exactly one numeric choice and reflects the controlled value', async () => {
  for (const current of [25, 50, 100, 200]) for (const next of [25, 50, 100, 200]) {
    const choices = [];
    await renderMenu(current, size => choices.push(size));
    await click(trigger());
    assert.equal(document.activeElement, option(current));
    assert.equal(option(current).getAttribute('aria-selected'), 'true');
    await click(option(next));
    assert.deepEqual(choices, [next]);
    assert.equal(popup(), null);
    assert.equal(document.activeElement, trigger());
    await renderMenu(next);
    assert.equal(trigger().textContent, String(next));
  }
});

test('keyboard navigation moves roving focus without committing; Enter and Space commit', async () => {
  for (const commitKey of ['Enter', ' ']) {
    const choices = [];
    await renderMenu(50, size => choices.push(size));
    await key(trigger(), 'ArrowDown');
    assert.equal(document.activeElement, option(50));
    for (const [pressed, expected] of [['End', 200], ['ArrowDown', 25], ['ArrowUp', 200], ['Home', 25]]) {
      await key(document.activeElement, pressed);
      assert.equal(document.activeElement, option(expected));
      assert.equal(option(expected).tabIndex, 0);
      assert.equal(popup().querySelectorAll('[tabindex="0"]').length, 1);
      assert.deepEqual(choices, []);
    }
    await key(document.activeElement, commitKey);
    assert.deepEqual(choices, [25]);
    assert.equal(document.activeElement, trigger());
  }
});

test('Escape is isolated from global actions, while unrelated closed-trigger shortcuts propagate', async () => {
  const seen = [], choices = [];
  const globalKey = event => seen.push(event.key);
  document.addEventListener('keydown', globalKey);
  try {
    await renderMenu(100, size => choices.push(size));
    await key(trigger(), 'j');
    await key(trigger(), 'k', { ctrlKey: true });
    assert.deepEqual(seen, ['j', 'k']);
    await key(trigger(), ' ');
    await key(document.activeElement, 'j');
    await key(document.activeElement, 'ArrowDown');
    await key(document.activeElement, 'Escape');
    assert.deepEqual(seen, ['j', 'k']);
    assert.deepEqual(choices, []);
    assert.equal(popup(), null);
    assert.equal(document.activeElement, trigger());
    await key(trigger(), 'ArrowUp');
    assert.equal(document.activeElement, option(100), 'cancellation preserves selected value');
    await key(document.activeElement, 'Escape');
    await renderMenu(25);
    await click(trigger());
    assert.equal(document.activeElement, option(25), 'reopening uses externally changed preference');
    await key(document.activeElement, 'Escape');
  } finally { document.removeEventListener('keydown', globalKey); }
});

test('Tab returns to the trigger position without preventing native focus traversal', async () => {
  for (const shiftKey of [false, true]) {
    await renderMenu();
    await click(trigger());
    let event;
    await React.act(async () => {
      event = new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
      document.activeElement.dispatchEvent(event);
    });
    assert.equal(event.defaultPrevented, false);
    assert.equal(popup(), null);
    assert.equal(document.activeElement, trigger());
    assert.deepEqual([...trigger().parentElement.querySelectorAll('button')], [document.getElementById('before'), trigger(), document.getElementById('after')]);
  }
});

test('outside pointer, window blur, scope change and unmount dismiss and remove listeners', async () => {
  await renderMenu();
  const listeners = [];
  const restores = [];
  for (const target of [window, document]) {
    const add = target.addEventListener, remove = target.removeEventListener;
    target.addEventListener = function(type, callback, options) {
      if (['resize', 'scroll', 'blur', 'pointerdown', 'focusin'].includes(type)) listeners.push({ target, type, callback, options });
      return add.call(this, type, callback, options);
    };
    target.removeEventListener = function(type, callback, options) {
      const index = listeners.findIndex(entry => entry.target === target && entry.type === type && entry.callback === callback && entry.options === options);
      if (index !== -1) listeners.splice(index, 1);
      return remove.call(this, type, callback, options);
    };
    restores.push(() => { target.addEventListener = add; target.removeEventListener = remove; });
  }
  try {
    for (const dismiss of ['pointer', 'blur', 'scope', 'unmount']) {
      await renderMenu();
      await click(trigger());
      assert.ok(listeners.length > 0);
      if (dismiss === 'pointer') {
        const after = document.getElementById('after');
        await React.act(async () => {
          after.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
          after.focus();
        });
        assert.equal(document.activeElement, after);
      } else if (dismiss === 'blur') await React.act(async () => window.dispatchEvent(new window.Event('blur')));
      else if (dismiss === 'scope') await renderMenu(50, () => {}, 'changed');
      else await React.act(async () => root.render(null));
      assert.equal(popup(), null);
      assert.equal(listeners.length, 0);
    }
  } finally { restores.forEach(restore => restore()); }
});

test('portal uses visual anchor coordinates once at enlarged scale, flips and clamps', async () => {
  const originalRect = window.HTMLElement.prototype.getBoundingClientRect;
  const originalHeight = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'scrollHeight');
  let anchor = { left: 280, top: 250, bottom: 274, width: 40, height: 24, right: 320 };
  window.HTMLElement.prototype.getBoundingClientRect = function() {
    if (this.getAttribute('aria-haspopup') === 'listbox') return anchor;
    if (this.getAttribute('role') === 'listbox') return { width: 100 * (useStore.getState().fontSize / 100), height: 160 };
    return originalRect.call(this);
  };
  Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return this.getAttribute('role') === 'listbox' ? 160 : 0; } });
  try {
    window.innerWidth = 300; window.innerHeight = 300;
    await renderMenu();
    await React.act(async () => useStore.setState({ fontSize: 125 }));
    await click(trigger());
    assert.equal(popup().parentElement, document.body);
    assert.equal(popup().style.left, '167px');
    assert.equal(popup().style.top, '46px');
    assert.equal(popup().style.transform, 'scale(1.25)');
    assert.equal(popup().style.background, 'var(--bg-elevated)');
    anchor = { ...anchor, left: 10, top: 40, bottom: 64 };
    window.innerHeight = 100;
    await React.act(async () => window.dispatchEvent(new window.Event('resize')));
    assert.equal(popup().style.top, '8px');
    assert.equal(popup().style.maxHeight, '22.4px');
    assert.equal(popup().style.overflowY, 'auto');
    assert.equal(popup().style.left, '10px');
    anchor = { ...anchor, top: 110, bottom: 134 };
    await React.act(async () => window.dispatchEvent(new window.Event('scroll')));
    assert.equal(popup(), null, 'scrolling the anchor outside the viewport dismisses the popup');
  } finally {
    window.HTMLElement.prototype.getBoundingClientRect = originalRect;
    if (originalHeight) Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', originalHeight);
    else delete window.HTMLElement.prototype.scrollHeight;
    window.innerWidth = 1024; window.innerHeight = 768;
    await React.act(async () => { root.render(null); useStore.setState({ fontSize: 100 }); });
  }
});

for (const layout of ['comfortable', 'focused']) {
  test(`${layout}: clicking the open trigger restores focus when pointerdown did not focus it`, async () => {
    await mount(layout);
    const button = trigger();
    await key(button, 'ArrowDown');
    assert.equal(document.activeElement, option(50));
    await React.act(async () => button.dispatchEvent(new window.Event('pointerdown', { bubbles: true })));
    assert.equal(document.activeElement, option(50), 'Safari-like pointerdown leaves option focused');
    await click(button);
    assert.equal(popup(), null);
    assert.ok(document.activeElement === button, 'closing returns keyboard focus to the trigger');
    assert.equal(useStore.getState().pageSize, 50);
  });

  for (const focusOwner of ['trigger', 'option', 'navigation']) {
    test(`${layout}: scope transition preserves ${focusOwner} focus without committing`, async () => {
      await mount(layout);
      const originalTrigger = trigger();
      const navigation = document.createElement('button');
      navigation.textContent = 'Navigate';
      document.body.append(navigation);
      try {
        originalTrigger.focus();
        if (focusOwner !== 'trigger') await key(originalTrigger, 'ArrowDown');
        if (focusOwner === 'option') assert.equal(document.activeElement, option(50));
        await React.act(async () => {
          if (focusOwner === 'navigation') navigation.focus();
          useStore.setState({ selectedFolder: 'Archive' });
        });
        assert.equal(popup(), null);
        assert.ok(document.activeElement === (focusOwner === 'navigation' ? navigation : originalTrigger), 'scope change preserves owned focus without stealing navigation focus');
        assert.ok(trigger() === originalTrigger, 'scope changes keep the same trigger node');
        assert.equal(useStore.getState().pageSize, 50);
      } finally { navigation.remove(); }
    });
  }

  test(`${layout}: choosing size persists and resets normal pagination without losing scope`, async () => {
    await mount(layout);
    await React.act(async () => useStore.setState({ categorizationEnabled: true }));
    await click([...container.querySelectorAll('button')].find(node => node.textContent === 'messageList.unread'));
    const next = [...container.querySelectorAll('button')].find(node => node.textContent.includes('messageList.nextPage'));
    await click(next);
    assert.equal(requests.filter(r => r.url.pathname.endsWith('/mail/messages')).at(-1).url.searchParams.get('offset'), '50');
    await click(trigger());
    requests.length = 0;
    await click(option(100));
    assert.equal(useStore.getState().pageSize, 100);
    assert.equal(localStorage.getItem('mailflow_page_size'), '100');
    const calls = requests.filter(r => r.url.pathname.endsWith('/mail/messages'));
    assert.equal(calls.length, 1);
    const params = calls[0].url.searchParams;
    for (const [name, expected] of Object.entries({ limit: '100', offset: '0', accountId: 'account-1', folder: 'INBOX', unreadOnly: 'true', category: 'primary' })) assert.equal(params.get(name), expected, name);
    await React.act(async () => window.dispatchEvent(new window.Event('pagehide')));
    const saves = requests.filter(r => r.url.pathname.endsWith('/auth/preferences'));
    assert.equal(saves.length, 1);
    assert.equal(JSON.parse(saves[0].options.body).pageSize, '100');
  });

  test(`${layout}: active search retains query/account/folder and scope changes dismiss`, async () => {
    await mount(layout);
    await React.act(async () => useStore.getState().setSearchQuery('synthetic'));
    await settle();
    await click(trigger());
    requests.length = 0;
    await click(option(200));
    await settle();
    const calls = requests.filter(r => r.url.pathname.endsWith('/search'));
    assert.equal(calls.length, 1);
    const params = calls[0].url.searchParams;
    for (const [name, expected] of Object.entries({ q: 'synthetic', limit: '200', accountId: 'account-1', folder: 'INBOX' })) assert.equal(params.get(name), expected, name);
    assert.equal(Number(params.get('offset')), 0);
    await click(trigger());
    await React.act(async () => useStore.setState({ selectedFolder: 'Archive' }));
    assert.equal(popup(), null);
    assert.equal(useStore.getState().pageSize, 200);
    await settle();
    await click(trigger());
    await React.act(async () => useStore.setState({ searchAllFolders: true }));
    assert.equal(popup(), null);
    await settle();
  });
}
