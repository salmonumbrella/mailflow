import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k) => k, i18n: { language: "en", changeLanguage: () => {} } });',
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
      const out = transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: shimViteEnv(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: shimViteEnv(code) };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.requestAnimationFrame ??= cb => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame ??= id => clearTimeout(id);
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const THREAD = [
  { id: 'first', account_id: 'account', folder: 'INBOX', message_id: '<first@example.invalid>', subject: 'Synthetic conversation', from_email: 'sender@example.invalid', from_name: 'Sender', date: '2026-01-01T10:00:00Z', is_read: true },
  { id: 'sent', account_id: 'account', folder: 'Sent', message_id: '<sent@example.invalid>', subject: 'Re: Synthetic conversation', from_email: 'me@example.invalid', from_name: 'Me', date: '2026-01-02T10:00:00Z', is_read: true },
  { id: 'latest', account_id: 'account', folder: 'INBOX', message_id: '<latest@example.invalid>', subject: 'Re: Synthetic conversation', from_email: 'sender@example.invalid', from_name: 'Sender', date: '2026-01-03T10:00:00Z', is_read: false },
];
globalThis.fetch = async url => {
  const path = String(url);
  const id = /\/messages\/([^/]+)\/body/.exec(path)?.[1];
  const body = path.includes('/mail/thread?') ? { messages: THREAD }
    : id ? { html: `<p>Synthetic readable body of ${id}</p>`, text: '', attachments: [] } : {};
  return { ok: true, status: 200, json: async () => body };
};
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const ConversationPane = (await import('./ConversationPane.jsx')).default;
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const { bodyCache } = await import('../utils/bodyCache.js');
let root;
const click = async element => React.act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
const settle = () => React.act(async () => new Promise(resolve => setTimeout(resolve, 30)));
const openCards = () => document.querySelectorAll('[data-message-id] > button[aria-expanded="true"]');
beforeEach(async () => {
  bodyCache.clear();
  useStore.setState({
    darkEmailBodies: false, accounts: [{ id: 'account', email_address: 'me@example.invalid' }],
    selectedAccountId: 'account', selectedFolder: 'INBOX', selectedMessageId: 'latest', messages: THREAD,
    notifications: [], composing: false, composeData: null, prepareComposeSwitch: null, enabledPlugins: [],
  });
  api.savePreferencesOnExit = () => {};
  useStore.getState().setLayout('gmail');
  root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(ConversationPane, { threadId: '<first@example.invalid>', folder: 'INBOX' })));
  await settle();
});
afterEach(async () => {
  await React.act(async () => root.unmount());
  window.dispatchEvent(new window.Event('pagehide'));
});

test('Gmail conversation shows received and sent mail and expands or collapses every native body', async () => {
  assert.equal(document.querySelectorAll('[data-message-id]').length, 3);
  assert.equal(openCards().length, 1);
  assert.ok(document.querySelector('iframe'), 'opened mail has a real body renderer');
  await click(document.querySelector('[aria-label="message.expandAll"]'));
  await settle();
  assert.equal(openCards().length, 3);
  assert.equal(document.querySelectorAll('iframe').length, 3);
  await click(document.querySelector('[aria-label="message.collapseAll"]'));
  assert.equal(openCards().length, 0);
  await click(document.querySelector('[aria-label="message.expandAll"]'));
  assert.equal(openCards().length, 3, 'repeated expand still works');
});

for (const [label, flag] of [['message.reply', 'isReply'], ['message.replyAll', 'isReplyAll'], ['message.forward', 'isForward']]) {
  test(`Gmail bottom ${label} opens the native composer for the latest message`, async () => {
    const button = [...document.querySelectorAll('.mailflow-reader-replies button')].find(element => element.textContent === label);
    assert.ok(button, label);
    await click(button);
    await settle();
    assert.equal(useStore.getState().composing, true);
    assert.equal(useStore.getState().composeData[flag], true);
    assert.match(useStore.getState().composeData.subject, /Synthetic conversation/);
  });
}

const { flushUndoables } = await import('../utils/undoableAction.js');
const { clearDeleteGuard } = await import('../utils/pendingDeletes.js');
afterEach(() => { THREAD.forEach(message => clearDeleteGuard(message.id)); });

test('Gmail cards expose sender details lazily for the individual message', async () => {
  const requested = [];
  api.getMessageHeaders = async id => { requested.push(id); return { headers: 'To: reader@example.invalid' }; };
  const latest = document.querySelector('[data-message-id="latest"]');
  const button = latest.querySelector('[aria-label="gmailReader.showDetails"]');
  assert.ok(button, 'opened card offers details');
  assert.deepEqual(requested, []);
  await click(button);
  assert.deepEqual(requested, ['latest']);
  assert.match(document.querySelector('[role="dialog"]').textContent, /reader@example.invalid/);
});

test('delete this message removes just its card, supports Undo, and never calls bulk/thread delete', async () => {
  const calls = [];
  api.deleteMessage = async id => { calls.push(id); };
  api.bulkDelete = async () => { assert.fail('individual delete must not use bulk delete'); };
  const button = document.querySelector('[data-message-id="latest"] [aria-label="gmailReader.deleteMessage"]');
  assert.ok(button);
  await click(button);
  assert.deepEqual([...document.querySelectorAll('[data-message-id]')].map(el => el.dataset.messageId), ['first', 'sent']);
  assert.deepEqual(calls, [], 'native undo window delays network deletion');
  const notification = useStore.getState().notifications[0];
  assert.equal(typeof notification.onUndo, 'function');
  await React.act(async () => notification.onUndo());
  assert.equal(document.querySelectorAll('[data-message-id]').length, 3);
  flushUndoables();
  assert.deepEqual(calls, []);
  await click(document.querySelector('[data-message-id="latest"] [aria-label="gmailReader.deleteMessage"]'));
  await React.act(async () => { flushUndoables(); await new Promise(resolve => setTimeout(resolve, 0)); });
  assert.deepEqual(calls, ['latest']);
  assert.ok(document.querySelector('[data-message-id="sent"]'), 'own sent reply remains');
});

test('failed per-message deletion restores only its original conversation, not a later selection', async () => {
  let rejectDelete;
  api.deleteMessage = () => new Promise((resolve, reject) => { rejectDelete = reject; });
  await click(document.querySelector('[data-message-id="latest"] [aria-label="gmailReader.deleteMessage"]'));
  await React.act(async () => flushUndoables());
  const priorGetThread = api.getThread;
  api.getThread = async () => ({ messages: [{ ...THREAD[0], id: 'unrelated', subject: 'New conversation' }] });
  try {
    await React.act(async () => root.render(React.createElement(ConversationPane, { threadId: 'different', folder: 'INBOX' })));
    await settle();
    await React.act(async () => { rejectDelete(new Error('Synthetic delete failure')); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.deepEqual([...document.querySelectorAll('[data-message-id]')].map(el => el.dataset.messageId), ['unrelated']);
    assert.ok(useStore.getState().notifications.some(note => note.type === 'error' && note.body.includes('Synthetic delete failure')));
  } finally { api.getThread = priorGetThread; }
});

test('Trash and Drafts deletion confirm the clicked account message and cancellation sends nothing', async () => {
  const priorGetThread = api.getThread;
  const calls = [];
  api.deleteMessage = async id => calls.push(id);
  try {
    for (const [folder, role] of [['Other Bin', 'trash'], ['Other Drafts', 'drafts']]) {
      const message = { ...THREAD.at(-1), account_id: 'other', folder };
      api.getThread = async () => ({ messages: [THREAD[0], message] });
      await React.act(async () => {
        useStore.setState({ accounts: [{ id: 'account', folder_mappings: { trash: 'Wrong Bin' } }, { id: 'other', folder_mappings: { [role]: folder } }], folders: {} });
        root.render(React.createElement(ConversationPane, { threadId: `safety-${role}`, folder: 'INBOX' }));
      });
      await settle();
      const button = document.querySelector('[data-message-id="latest"] [aria-label="gmailReader.deletePermanently"]');
      assert.ok(button, `${role} label comes from clicked account, not selected account`);
      await click(button);
      const dialog = document.querySelector('[role="alertdialog"]');
      assert.ok(dialog);
      assert.match(dialog.textContent, /gmailReader.deleteWarning/);
      assert.deepEqual(calls, []);
      assert.equal(document.activeElement.textContent, 'common.cancel');
      await click([...dialog.querySelectorAll('button')].find(el => el.textContent === 'common.cancel'));
      await React.act(async () => flushUndoables());
      assert.deepEqual(calls, []);
      await click(button);
      await click([...document.querySelector('[role="alertdialog"]').querySelectorAll('button')].find(el => el.textContent === 'gmailReader.deletePermanently'));
      assert.equal(document.querySelector('[role="alertdialog"]'), null);
      assert.deepEqual(calls, [], 'confirmation retains native delayed Undo');
      await React.act(async () => useStore.getState().notifications[0].onUndo());
    }
  } finally { api.getThread = priorGetThread; }
});

test('deleting the selected representative keeps ReadingPane on actual surviving messages', async () => {
  const ReadingPane = (await import('./ReadingPane.jsx')).default;
  const priorGetThread = api.getThread;
  const conversation = THREAD.map(message => ({ ...message, thread_id: 'kept-thread' }));
  api.getThread = async () => ({ messages: conversation });
  try {
    await React.act(async () => {
      useStore.setState({ messages: [{ ...conversation.at(-1), message_count: 3 }], threadMessages: {}, selectedMessageId: 'latest', selectedAccountId: 'account', searchQuery: '', conversationMode: 'pane' });
      root.render(React.createElement(ReadingPane));
    });
    await settle();
    await click(document.querySelector('[data-message-id="latest"] [aria-label="gmailReader.deleteMessage"]'));
    assert.equal(useStore.getState().selectedMessageId, 'sent');
    assert.deepEqual([...document.querySelectorAll('[data-message-id]')].map(el => el.dataset.messageId), ['first', 'sent']);
    await React.act(async () => useStore.getState().notifications[0].onUndo());
  } finally { api.getThread = priorGetThread; }
});

test('Undo of a non-representative card restores the reader without inserting a hidden child in the list', async () => {
  await React.act(async () => useStore.setState({ messages: [{ ...THREAD.at(-1), thread_id: 'thread', message_count: 3 }], searchResults: [], selectedMessageId: 'latest' }));
  await click(document.querySelector('[aria-label="message.expandAll"]'));
  const before = useStore.getState().messages.map(message => message.id);
  await click(document.querySelector('[data-message-id="first"] [aria-label="gmailReader.deleteMessage"]'));
  assert.equal(document.querySelector('[data-message-id="first"]'), null);
  await React.act(async () => useStore.getState().notifications[0].onUndo());
  assert.ok(document.querySelector('[data-message-id="first"]'));
  assert.deepEqual(useStore.getState().messages.map(message => message.id), before);
  assert.deepEqual(useStore.getState().searchResults, []);
});

test('failed deletion of a hidden child restores its card and cache without new list rows', async () => {
  api.deleteMessage = async () => { throw new Error('Delete refused'); };
  await React.act(async () => useStore.setState({ messages: [{ ...THREAD.at(-1), thread_id: 'thread', message_count: 3 }], searchResults: [], selectedMessageId: 'latest' }));
  await click(document.querySelector('[aria-label="message.expandAll"]'));
  await click(document.querySelector('[data-message-id="first"] [aria-label="gmailReader.deleteMessage"]'));
  await React.act(async () => { flushUndoables(); await new Promise(resolve => setTimeout(resolve, 0)); });
  assert.ok(document.querySelector('[data-message-id="first"]'));
  assert.deepEqual(useStore.getState().messages.map(message => message.id), ['latest']);
  assert.deepEqual(useStore.getState().searchResults, []);
  assert.ok(useStore.getState().threadMessages['<first@example.invalid>'].some(message => message.id === 'first'));
});

test('single reader shows details, safe plain-text quote toggles and sender filter using actual identity', async () => {
  const MessagePane = (await import('./MessagePane.jsx')).default;
  const message = { ...THREAD.at(-1), id: 'single-reader', from_email: 'actual@example.invalid' };
  const text = 'Fresh answer\n> Prior message\n>> Older message\n';
  bodyCache.set(message.id, { text, attachments: [] });
  const filters = [];
  const capture = event => { filters.push(event.detail); event.preventDefault(); };
  window.addEventListener('mailflow:gmail-sender-filter', capture);
  try {
    await React.act(async () => {
      useStore.setState({ user: { id: 'reader' }, messages: [message], selectedMessageId: message.id, searchQuery: '', accounts: [{ id: 'account', enabled: true }], layout: 'gmail' });
      bodyCache.set(message.id, { text, attachments: [] });
      root.render(React.createElement(MessagePane));
    });
    await settle();
    assert.ok(document.querySelector('[aria-label="gmailReader.showDetails"]'));
    const quote = document.querySelector('details');
    assert.ok(quote);
    assert.equal(quote.open, false);
    await click(quote.querySelector('summary'));
    assert.equal(quote.open, true);
    await click(quote.querySelector('summary'));
    assert.equal(quote.open, false);
    assert.ok(document.querySelector('.msg-card[translate="yes"]').textContent.includes('> Prior message'));
    await click(document.querySelector('[aria-label="gmailReader.filterSender"]'));
    assert.deepEqual(filters, [{ accountId: 'account', sender: 'actual@example.invalid', userId: 'reader' }]);
    await React.act(async () => useStore.setState({ layout: 'classic' }));
    assert.equal(document.querySelector('details'), null, 'non-Gmail reader retains complete native text');
    assert.equal(document.querySelector('[aria-label="gmailReader.showDetails"]'), null);
    assert.ok(document.querySelector('.msg-card[translate="yes"]').textContent.includes(text));
  } finally { window.removeEventListener('mailflow:gmail-sender-filter', capture); }
});
