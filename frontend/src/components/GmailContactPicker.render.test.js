import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'const t = (k, d) => typeof d === "string" ? d : k; export const useTranslation = () => ({ t, i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export const Trans = ({ children }) => children ?? null;',
        'export const I18nextProvider = ({ children }) => children ?? null;',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    if (url.endsWith('.jsx')) {
      const code = readFileSync(new URL(url), 'utf8');
      const out = transform(code, { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: out.code };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { api } = await import('../utils/api.js');
const GmailContactPicker = (await import('./GmailContactPicker.jsx')).default;
const originalGetContacts = api.getContacts;
const ALICE = { id: 'alice', display_name: 'Alice', primary_email: 'alice@example.invalid' };
const BOB = { id: 'bob', display_name: 'Bob', primary_email: 'bob@example.invalid' };
let root;
let inserted;
let closed;
const settle = ms => React.act(async () => new Promise(resolve => setTimeout(resolve, ms)));
const click = element => React.act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
const checkbox = email => [...document.querySelectorAll('.mailflow-contact-picker-results label')].find(label => label.textContent.includes(email))?.querySelector('input');
async function search(query) {
  const input = document.querySelector('input[type="search"]');
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, query);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await settle(200);
}
async function mount() {
  inserted = [];
  closed = 0;
  root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(GmailContactPicker, { onInsert: values => inserted.push(values), onClose: () => { closed += 1; } })));
  await settle(10);
}
afterEach(async () => {
  if (root) await React.act(async () => root.unmount());
  root = null;
  api.getContacts = originalGetContacts;
});

test('contact picker inserts selected native contacts once and leaves choices unchanged on Cancel', async () => {
  api.getContacts = async () => ({ contacts: [ALICE, BOB], total: 2 });
  await mount();
  assert.equal(document.activeElement, document.querySelector('input[type="search"]'));
  await click(checkbox(ALICE.primary_email));
  await click(document.querySelector('.mailflow-contact-picker-insert'));
  assert.deepEqual(inserted, [[{ name: 'Alice', email: ALICE.primary_email }]]);
  await click([...document.querySelectorAll('button')].find(button => button.textContent === 'common.cancel'));
  assert.equal(closed, 1);
  assert.equal(inserted.length, 1, 'Cancel performs no additional insertion');
});

test('contact picker ignores older search responses and retains selected contacts across searches', async () => {
  let resolveOld;
  api.getContacts = ({ q }) => q === 'old'
    ? new Promise(resolve => { resolveOld = resolve; })
    : Promise.resolve({ contacts: q === 'new' ? [BOB] : [ALICE], total: 1 });
  await mount();
  await click(checkbox(ALICE.primary_email));
  await search('old');
  await search('new');
  assert.ok(checkbox(BOB.primary_email));
  await React.act(async () => resolveOld({ contacts: [{ ...ALICE, display_name: 'Stale result' }], total: 1 }));
  assert.equal(document.body.textContent.includes('Stale result'), false);
  await click(checkbox(BOB.primary_email));
  await click(document.querySelector('.mailflow-contact-picker-insert'));
  assert.deepEqual(inserted[0].map(contact => contact.email), [ALICE.primary_email, BOB.primary_email]);
});

test('contact picker paginates and selection deduplicates addresses case-insensitively', async () => {
  const calls = [];
  api.getContacts = async ({ offset }) => {
    calls.push(offset);
    return { contacts: offset === 0 ? [ALICE] : [{ ...ALICE, id: 'alias', primary_email: 'ALICE@example.invalid' }, BOB], total: 3 };
  };
  await mount();
  await click(checkbox(ALICE.primary_email));
  await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Load more'));
  await settle(10);
  assert.deepEqual(calls, [0, 100]);
  await click(checkbox(BOB.primary_email));
  await click(document.querySelector('.mailflow-contact-picker-insert'));
  assert.equal(inserted[0].length, 2);
});

test('contact picker traps Tab, reports errors, and Escape cancels without insertion', async () => {
  api.getContacts = async () => { throw new Error('Synthetic contacts failure'); };
  await mount();
  assert.match(document.querySelector('[role="alert"]').textContent, /Synthetic contacts failure/);
  const dialog = document.querySelector('[role="dialog"]');
  const buttons = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
  buttons.at(-1).focus();
  await React.act(async () => buttons.at(-1).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
  assert.equal(document.activeElement, buttons[0]);
  await React.act(async () => dialog.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(closed, 1);
  assert.deepEqual(inserted, []);
});
