// Render test for the sidebar's folder unread badges (#536).
//
// A collapsed folder showed only its own count, so new mail in its subfolders was invisible
// until it was expanded. The harness mirrors MessageList.render.test.js: node --test cannot
// parse JSX, so the loader hook transforms .jsx with sucrase, and react-i18next is stubbed.

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
        'export const useTranslation = () => ({ t: (k, d, values = {}) => Object.entries(values).reduce((text, [key, value]) => text.replaceAll("{{" + key + "}}", String(value)), typeof d === "string" ? d : d?.defaultValue ?? k), i18n: { language: "en", changeLanguage: () => {} } });',
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
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.matchMedia = dom.window.matchMedia;
dom.window.Element.prototype.scrollIntoView = () => {};
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}), text: async () => '{}' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const NativeLabelNavigation = (await import('./NativeLabelNavigation.jsx')).default;
const { api } = await import('../utils/api.js');
const { installLabelHistory } = await import('../utils/nativeLabelNavigation.js');
const labels = [
  { id: 'work', name: 'Work', path: 'Work', visibility: 'show', color: '#abcdef' },
  { id: 'child', name: 'Child', path: 'Work/Child', parentId: 'work', visibility: 'show' },
  { id: 'hidden', name: 'Hidden', path: 'Hidden', visibility: 'hide' },
  { id: 'unread', name: 'Unread', path: 'Unread', visibility: 'unread' },
];
let definitions = labels;
api.getNativeLabels = async accountId => ({ accountId, storageGeneration: 'g', labels: definitions });
api.getNativeLabelCounts = async accountId => ({ accountId, storageGeneration: 'g', counts: labels.map(label => ({ labelId: label.id, unread: label.id === 'work' ? 2 : 0, total: 4, unresolvedMemberships: label.id === 'child' ? 1 : 0 })) });
let root;
async function mount(more = false) {
  if (root) await React.act(async () => root.unmount());
  definitions = labels;
  useStore.setState({ user: { id: 'u' }, accounts: [{ id: 'a', enabled: true, storage_generation: 'g' }], accountsReady: true, selectedAccountId: 'a', selectedFolder: 'INBOX', activeLabel: null, nativeLabelSnapshots: {}, isLocked: false });
  await React.act(async () => { root = createRoot(document.getElementById('root')); root.render(React.createElement(NativeLabelNavigation, { accountId: 'a', more })); });
}
const row = id => document.querySelector(`[data-native-label-id="${id}"]`);
test('native tree uses direct cache counts, hidden/unread visibility, colors and nesting', async () => {
  await mount();
  assert.ok(row('work')); assert.ok(row('child')); assert.equal(row('hidden'), null); assert.equal(row('unread'), null);
  assert.equal(row('work').querySelector('svg').getAttribute('fill'), '#abcdef');
  assert.equal(row('child').title, 'Work/Child · Synchronized messages: 4; unread: 0 · Memberships awaiting verified locations: 1');
  await React.act(async () => document.querySelector('[aria-label="Collapse Work"]').click());
  assert.equal(row('child'), null);
  await mount(true); assert.ok(row('hidden')); assert.ok(row('unread'));
});
test('navigation is a real label discriminator, and stale-generation invalidation is ignored', async () => {
  await mount();
  await React.act(async () => row('work').click());
  assert.deepEqual(useStore.getState().activeLabel, { accountId: 'a', storageGeneration: 'g', labelId: 'work' });
  assert.equal(useStore.getState().selectedFolder, null);
  const revision = useStore.getState().nativeLabelsRevision;
  await React.act(async () => useStore.getState().invalidateNativeLabels({ accountId: 'a', storageGeneration: 'old' }));
  assert.equal(useStore.getState().nativeLabelsRevision, revision);
  await React.act(async () => useStore.getState().setSelectedAccount('a', 'Archive'));
  assert.equal(useStore.getState().activeLabel, null);
});
test('live rename retains label identity and deletion falls back to a real Inbox', async () => {
  await mount(); await React.act(async () => row('work').click());
  definitions = labels.map(label => label.id === 'work' ? { ...label, name: 'Renamed', path: 'Renamed' } : label);
  await React.act(async () => useStore.getState().invalidateNativeLabels({ accountId: 'a', storageGeneration: 'g' }));
  assert.match(row('work').textContent, /Renamed/);
  definitions = labels.filter(label => label.id !== 'work');
  await React.act(async () => useStore.getState().invalidateNativeLabels({ accountId: 'a', storageGeneration: 'g' }));
  assert.equal(useStore.getState().activeLabel, null); assert.equal(useStore.getState().selectedFolder, 'INBOX');
});
test('history/deep links retain generation and Back/Forward restore folder versus label', async () => {
  await mount();
  window.history.replaceState(null, '', '/');
  const stop = installLabelHistory(useStore);
  await React.act(async () => row('work').click());
  assert.equal(window.location.hash, '#label/a/g/work');
  const labelState = window.history.state;
  await React.act(async () => useStore.getState().setSelectedAccount('a', 'Archive'));
  assert.equal(window.location.hash, '');
  await React.act(async () => { window.history.replaceState(labelState, '', '/#label/a/g/work'); window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: labelState })); });
  assert.equal(useStore.getState().activeLabel.labelId, 'work');
  const folderState = { nativeMailView: { kind: 'folder', accountId: 'a', folder: 'Archive' } };
  await React.act(async () => { window.history.replaceState(folderState, '', '/'); window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: folderState })); });
  assert.equal(useStore.getState().activeLabel, null); assert.equal(useStore.getState().selectedFolder, 'Archive');
  stop();
  await React.act(async () => root.unmount()); root = null;
});
