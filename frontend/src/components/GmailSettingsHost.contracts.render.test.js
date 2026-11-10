import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) return { format: 'module', shortCircuit: true, source: 'export const useTranslation = () => ({ t: (key, fallback) => typeof fallback === "string" ? fallback : fallback?.defaultValue?.replace(/{{(\\w+)}}/g, (_, name) => fallback[name]) || key }); export const initReactI18next = {type: "3rdParty", init() {}};' };
    if (url.endsWith('/components/ProfileModal.jsx')) return { format: 'module', shortCircuit: true, source: 'import React from "react"; export default function ProfileModal({onClose}) { return React.createElement("div", {role:"dialog", "aria-label":"Native profile"}, React.createElement("button", {onClick:onClose}, "Close profile")); }' };
    if (url.endsWith('/components/GmailSettings.jsx')) return { format: 'module', shortCircuit: true, source: 'import React from "react"; export default function GmailSettings({onClose, initialAccountId, initialTab, initialCreateLabel}) { return React.createElement("div", {role:"dialog", "aria-label":"Settings", "data-account":initialAccountId, "data-tab":initialTab, "data-create":String(!!initialCreateLabel)}, React.createElement("input", {defaultValue:"unsaved draft", "aria-label":"Draft"}), React.createElement("button", {onClick:onClose}, "Close settings")); }' };
    if (url.endsWith('.json')) return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    if (url.endsWith('.jsx')) return { format: 'module', shortCircuit: true, source: transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url }).code };
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
    }
    return nextLoad(url, context);
  },
});
const dom = new JSDOM('<div id="root"></div><button id="outside">Outside</button>', { url: 'https://mail.example.invalid/', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, CustomEvent: dom.window.CustomEvent, Event: dom.window.Event, Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const GmailHeader = (await import('./GmailHeader.jsx')).default;

const GmailSettingsHost = (await import('./GmailSettingsHost.jsx')).default;
let root;
const signal = (accountId = 'a1', create = false) => React.act(async () => {
  window.dispatchEvent(new CustomEvent('mailflow:manage-native-labels', { detail: { accountId, create } }));
  await new Promise(resolve => setTimeout(resolve, 0));
});
beforeEach(() => {
  useStore.setState({ user: { id: 'u1', username: 'Owner' }, accounts: [{ id: 'a1', enabled: true }, { id: 'a2', enabled: true }], layout: 'gmail', isLocked: false, selectedAccountId: 'a1' });
  root = createRoot(document.getElementById('root'));
});
afterEach(async () => { await React.act(async () => root.unmount()); });

test('mobile host opens targeted Create and preserves an already open settings draft', async () => {
  await React.act(async () => root.render(React.createElement(GmailSettingsHost)));
  await signal('a2', true);
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.equal(dialog.dataset.account, 'a2'); assert.equal(dialog.dataset.tab, 'labels'); assert.equal(dialog.dataset.create, 'true');
  const draft = dialog.querySelector('input'); draft.value = 'Still editing';
  await signal('a1', false);
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
  assert.equal(document.querySelector('[role="dialog"]'), dialog);
  assert.equal(dialog.dataset.account, 'a2'); assert.equal(draft.value, 'Still editing');
});

test('desktop hosted header and shared mobile host open exactly one manager and survive header removal', async () => {
  const render = desktop => React.createElement(React.Fragment, null,
    React.createElement(GmailSettingsHost, { key: 'settings' }), desktop && React.createElement(GmailHeader, { key: 'header', settingsHosted: true }));
  await React.act(async () => root.render(render(true)));
  await signal();
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
  const dialog = document.querySelector('[role="dialog"]');
  await React.act(async () => root.render(render(false)));
  assert.equal(document.querySelector('[role="dialog"]'), dialog, 'rotation preserves the same manager instance');
  await signal('a2', true);
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
  assert.equal(dialog.dataset.account, 'a1');
});

test('unowned account event does not open any manager', async () => {
  await React.act(async () => root.render(React.createElement(GmailSettingsHost)));
  await signal('foreign-account', true);
  assert.equal(document.querySelector('[role="dialog"]'), null);
});

test('gear opens quick settings first, toggles and restores focus without navigating mail', async () => {
  const { api } = await import('../utils/api.js');
  const original = api.getRules; api.getRules = async () => [];
  try {
    useStore.setState({ selectedMessageId: 'keep-message', composing: true, isLocked: false });
    await React.act(async () => root.render(React.createElement(GmailHeader)));
    const gear = document.querySelector('button[aria-label="Settings"]');
    await React.act(async () => { gear.focus(); gear.click(); });
    const drawer = document.getElementById('mailflow-gmail-quick-settings');
    assert.ok(drawer, 'gear must open the quick drawer before full settings');
    assert.equal(gear.getAttribute('aria-expanded'), 'true');
    assert.equal(useStore.getState().selectedMessageId, 'keep-message');
    assert.equal(useStore.getState().composing, true);
    await React.act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.equal(document.getElementById('mailflow-gmail-quick-settings'), null);
    assert.equal(document.activeElement, gear);
    assert.equal(gear.getAttribute('aria-expanded'), 'false');
  } finally { api.getRules = original; }
});

test('full settings events validate tab and replace quick settings without replacing an active editor', async () => {
  const { api } = await import('../utils/api.js'); const original = api.getRules; api.getRules = async () => [];
  try {
    await React.act(async () => root.render(React.createElement(GmailSettingsHost)));
    await React.act(async () => window.dispatchEvent(new CustomEvent('mailflow:toggle-gmail-quick-settings')));
    assert.ok(document.getElementById('mailflow-gmail-quick-settings'));
    await React.act(async () => { window.dispatchEvent(new CustomEvent('mailflow:open-gmail-settings', { detail: { tab: 'filters' } })); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(document.getElementById('mailflow-gmail-quick-settings'), null);
    const dialog = document.querySelector('[role="dialog"]'); assert.equal(dialog.dataset.tab, 'filters');
    await signal('a2', true);
    assert.equal(document.querySelector('[role="dialog"]'), dialog);
    await React.act(async () => window.dispatchEvent(new CustomEvent('mailflow:toggle-gmail-quick-settings')));
    assert.equal(document.getElementById('mailflow-gmail-quick-settings'), null);
  } finally { api.getRules = original; }
});

test('same-tick toggles and all-settings events never overlap or replace the full editor', async () => {
  const { api } = await import('../utils/api.js'); const original = api.getRules; api.getRules = async () => [];
  try {
    await React.act(async () => root.render(React.createElement(GmailHeader)));
    const gear = document.querySelector('button[aria-label="Settings"]');
    await React.act(async () => { gear.focus(); gear.click(); gear.click(); });
    assert.equal(document.getElementById('mailflow-gmail-quick-settings'), null);
    assert.equal(document.activeElement, gear);
    await React.act(async () => { gear.click(); window.dispatchEvent(new CustomEvent('mailflow:open-gmail-settings', { detail: { tab: 'filters' } })); gear.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(document.getElementById('mailflow-gmail-quick-settings'), null);
    const dialog = document.querySelector('[role="dialog"]');
    assert.equal(dialog.dataset.tab, 'filters');
    await React.act(async () => { window.dispatchEvent(new CustomEvent('mailflow:open-gmail-settings')); gear.click(); });
    assert.equal(document.querySelector('[role="dialog"]'), dialog);
    assert.equal(gear.getAttribute('aria-expanded'), 'false');
  } finally { api.getRules = original; }
});

test('invalid full-settings tabs fall back to General and targeted labels bypass the drawer', async () => {
  const { api } = await import('../utils/api.js'); const original = api.getRules; api.getRules = async () => [];
  try {
    await React.act(async () => root.render(React.createElement(GmailSettingsHost)));
    await React.act(async () => { window.dispatchEvent(new CustomEvent('mailflow:open-gmail-settings', { detail: { tab: 'untrusted-tab' } })); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(document.querySelector('[role="dialog"]').dataset.tab, 'general');
    await React.act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Close settings').click());
    await React.act(async () => window.dispatchEvent(new CustomEvent('mailflow:toggle-gmail-quick-settings')));
    await signal('a2', true);
    assert.equal(document.getElementById('mailflow-gmail-quick-settings'), null);
    const dialog = document.querySelector('[role="dialog"]');
    assert.equal(dialog.dataset.tab, 'labels'); assert.equal(dialog.dataset.account, 'a2'); assert.equal(dialog.dataset.create, 'true');
  } finally { api.getRules = original; }
});

test('drawer survives header removal and reappearing gear reports its current state', async () => {
  const { api } = await import('../utils/api.js'); const original = api.getRules; api.getRules = async () => [];
  try {
    const render = desktop => React.createElement(React.Fragment, null, React.createElement(GmailSettingsHost, { key: 'host' }), desktop && React.createElement(GmailHeader, { key: 'header', settingsHosted: true }));
    await React.act(async () => root.render(render(true)));
    await React.act(async () => document.querySelector('button[aria-label="Settings"]').click());
    const drawer = document.getElementById('mailflow-gmail-quick-settings');
    await React.act(async () => root.render(render(false)));
    assert.equal(document.getElementById('mailflow-gmail-quick-settings'), drawer);
    await React.act(async () => root.render(render(true)));
    assert.equal(document.getElementById('mailflow-gmail-quick-settings'), drawer);
    assert.equal(document.querySelector('button[aria-label="Settings"]').getAttribute('aria-expanded'), 'true');
  } finally { api.getRules = original; }
});

test('shortcut callback closes drawer and restores the connected gear before opening help', async () => {
  const { api } = await import('../utils/api.js'); const original = api.getRules; api.getRules = async () => [];
  let calls = 0, helpOpener;
  try {
    await React.act(async () => root.render(React.createElement(GmailHeader, { onShowShortcutHelp: () => { calls++; helpOpener = document.activeElement; } })));
    const gear = document.querySelector('button[aria-label="Settings"]');
    await React.act(async () => { gear.focus(); gear.click(); });
    await React.act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'View shortcuts').click());
    assert.equal(calls, 1); assert.equal(helpOpener, gear);
    assert.equal(document.getElementById('mailflow-gmail-quick-settings'), null);
  } finally { api.getRules = original; }
});

test('lock, user transition and layout exit close surfaces without restoring background focus', async () => {
  const { api } = await import('../utils/api.js'); const original = api.getRules; api.getRules = async () => [];
  try {
    await React.act(async () => root.render(React.createElement(GmailHeader)));
    const gear = document.querySelector('button[aria-label="Settings"]');
    for (const patch of [{ isLocked: true }, { user: { id: 'u2' } }, { layout: 'comfortable' }]) {
      await React.act(async () => useStore.setState({ user: { id: 'u1' }, isLocked: false, layout: 'gmail' }));
      await React.act(async () => { gear.focus(); gear.click(); });
      assert.ok(document.getElementById('mailflow-gmail-quick-settings'));
      document.getElementById('outside').focus();
      await React.act(async () => useStore.setState(patch));
      assert.equal(document.getElementById('mailflow-gmail-quick-settings'), null);
      assert.equal(document.activeElement, document.getElementById('outside'));
    }
  } finally { api.getRules = original; }
});
