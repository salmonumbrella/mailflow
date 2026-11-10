// Render-level checks for the GTD rail row. The hover color should use the same theme token as
// inbox rows, and pointer hover remains available independently of the optional hover buttons.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k, d) => (typeof d === "string" ? d : k), i18n: { language: "en", changeLanguage: () => {} } });',
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

const { useStore } = await import('../store/index.js');
const GtdSidebarContent = (await import('./GtdSidebarContent.jsx')).default;
const GmailGtdSection = (await import('./GmailGtdSection.jsx')).default;
const makeThreads = (count, state = 'todo') => Array.from({ length: count }, (_, index) => ({
  id: `${state}-${index}`, account_id: 'account-1', message_id: `<${state}-${index}>`,
  from_name: `Sender ${index}`, subject: `Subject ${index}`, snippet: 'Native preview',
  date: '2026-11-10T01:00:00Z', is_read: index > 0,
}));
const triage = { openMenu() {}, classifyRow() {}, done() {}, setRead() {}, toggleStar() {}, deleteRow() {} };
const click = async element => React.act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));

test('Gmail GTD section has nine compact rows, working paging and collapse', async () => {
  const container = document.getElementById('root');
  const root = createRoot(container);
  const opened = [];
  let toggles = 0;
  const props = { section: { key: 'todo', total: 70, threads: makeThreads(20) }, loaded: true, collapsed: false,
    onToggle: () => toggles++, onOpenRow: row => opened.push(row.id), rowActions: triage, t: key => key };
  try {
    await React.act(async () => root.render(React.createElement(GmailGtdSection, props)));
    assert.equal(container.querySelectorAll('.gmail-gtd-row').length, 9);
    assert.match(container.textContent, /1–9 \/ 70/);
    assert.match(container.textContent, /gtd.gmail.bounded/);
    assert.equal(container.querySelector('[aria-label="message.find.previous: gtd.gmail.action"]').disabled, true);
    await click(container.querySelector('[aria-label="message.find.next: gtd.gmail.action"]'));
    assert.match(container.textContent, /10–18 \/ 70/);
    await React.act(async () => container.querySelector('.gmail-gtd-row').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    assert.deepEqual(opened, ['todo-9']);
    await click(container.querySelector('[aria-expanded]'));
    assert.equal(toggles, 1);
    await React.act(async () => root.render(React.createElement(GmailGtdSection, { ...props, collapsed: true })));
    assert.equal(container.querySelectorAll('.gmail-gtd-row').length, 0);
    await React.act(async () => root.render(React.createElement(GmailGtdSection, { ...props, section: { key: 'todo', total: 2, threads: makeThreads(2) } })));
    assert.match(container.textContent, /1–2 \/ 2/);
  } finally { await React.act(async () => root.unmount()); }
});

test('switching Gmail to native restores merged Waiting without changing sections or palette', async () => {
  const container = document.getElementById('root');
  const root = createRoot(container);
  const sections = { todo: { total: 1, threads: makeThreads(1) }, watch: { total: 2, threads: makeThreads(2, 'watch') }, delegated: { total: 1, threads: makeThreads(1, 'delegated') }, waiting: { total: 3 } };
  const before = useStore.getState();
  useStore.setState({ layout: 'gmail', gtdSections: sections, gtdCollapsedSections: {}, accounts: [{ id: 'account-1', gtd_enabled: true }], selectedMessageId: null, theme: 'dark' });
  try {
    await React.act(async () => root.render(React.createElement(GtdSidebarContent, { onCollapse() {} })));
    assert.equal(container.querySelectorAll('[data-gmail-gtd-section]').length, 5);
    assert.equal(container.querySelectorAll('[data-gmail-gtd-section="watch"] .gmail-gtd-row').length, 2);
    assert.equal(container.querySelectorAll('[data-gmail-gtd-section="delegated"] .gmail-gtd-row').length, 1);
    await React.act(async () => useStore.setState({ layout: 'comfortable' }));
    assert.equal(container.querySelectorAll('[data-gmail-gtd-section]').length, 0);
    assert.equal(container.querySelectorAll('[data-gtd-section="waiting"]').length, 3);
    assert.equal(useStore.getState().gtdSections, sections);
    assert.equal(useStore.getState().theme, 'dark');
  } finally { await React.act(async () => root.unmount()); useStore.setState(before, true); }
});

test('Gmail distinguishes loading sections from genuine empty sections', async () => {
  const container = document.getElementById('root');
  const root = createRoot(container);
  const props = { section: { key: 'watch', total: 0, threads: [] }, loaded: false, collapsed: false, onToggle() {}, onOpenRow() {}, rowActions: triage, t: key => key };
  try {
    await React.act(async () => root.render(React.createElement(GmailGtdSection, props)));
    assert.equal(container.querySelector('[role="status"]').textContent, 'common.loading');
    await React.act(async () => root.render(React.createElement(GmailGtdSection, { ...props, loaded: true })));
    assert.equal(container.querySelector('[role="status"]').textContent, 'gtd.tabEmpty');
  } finally { await React.act(async () => root.unmount()); }
});

test('Gmail compact rows keep section-scoped menus and hovered Done shortcuts', async () => {
  const { dispatchHoveredGtdShortcut } = await import('../utils/gtdHoveredRow.js');
  const GtdTriageRow = (await import('./GtdTriageRow.jsx')).default;
  const row = makeThreads(1, 'watch')[0];
  const container = document.getElementById('root');
  const root = createRoot(container);
  const calls = [];
  try {
    await React.act(async () => root.render(React.createElement(GtdTriageRow, {
      thread: row, sectionKey: 'watch', variant: 'sidebar', compact: true, t: key => key,
      onOpen() {}, rowActions: { ...triage, openMenu: data => calls.push(['menu', data.doneStates]), done: (_row, states) => calls.push(['done', states]) },
    })));
    const element = container.querySelector('.gmail-gtd-row');
    await React.act(async () => element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true })));
    await React.act(async () => element.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })));
    const state = { enabledPlugins: ['gtd'], accounts: [{ id: 'account-1', gtd_enabled: true }], gtdSections: { watch: { threads: [row] }, delegated: { threads: [{ ...row, id: 'other-copy' }] } }, messages: [] };
    assert.equal(dispatchHoveredGtdShortcut('archive', state), true);
    assert.deepEqual(calls, [['menu', ['watch']], ['done', ['watch']]]);
  } finally { await React.act(async () => root.unmount()); }
});
