import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
    return { format: 'module', shortCircuit: true, source: [
      'export const useTranslation = () => ({ t: (k, o) => k === "commandPalette.labelPicker.copyTo" ? `Translated to ${o.folder}` : k === "commandPalette.labelPicker.placeholder" ? "Translated picker" : k === "commandPalette.labelPicker.error" ? "Translated error" : o?.defaultValue ?? k, i18n: { language: "en", changeLanguage() {} } });',
      'export const initReactI18next = { type: "3rdParty", init() {} };',
      'export const Trans = ({ children }) => children ?? null;',
      'export const I18nextProvider = ({ children }) => children ?? null;',
      'export default { useTranslation, initReactI18next };',
    ].join('\n') };
  }
  if (url.endsWith('.json')) {
    return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
  }
  if (url.endsWith('.jsx')) {
    const code = readFileSync(new URL(url), 'utf8');
    return { format: 'module', source: transform(code, { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url }).code, shortCircuit: true };
  }
  return nextLoad(url, context);
} });

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
dom.window.Element.prototype.scrollIntoView = () => {};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const CommandPalette = (await import('./CommandPalette.jsx')).default;
const { shortcutBus } = await import('../utils/shortcutBus.js');
after(() => dom.window.close());

test('repeated label choice activation copies only once while the request is pending', async () => {
  const originalCopy = api.copyMessage;
  const originalAddNotification = useStore.getState().addNotification;
  const root = createRoot(document.getElementById('root'));
  const calls = [];
  const notifications = [];
  let release;
  api.copyMessage = (...args) => {
    calls.push(args);
    return new Promise(resolve => { release = resolve; });
  };
  useStore.setState({
    accounts: [{ id: 'a', enabled: true }],
    folders: { a: [{ path: 'Projects', name: 'Projects' }] },
    addNotification: notification => notifications.push(notification),
  });
  let closes = 0;
  try {
    await React.act(async () => {
      root.render(React.createElement(CommandPalette, {
        open: true, onClose: () => { closes++; },
        labelPickerMessage: { id: 'm', account_id: 'a', folder: 'INBOX' },
      }));
    });
    assert.equal(document.querySelector('input').placeholder, 'Translated picker');
    const choice = [...document.querySelectorAll('div')]
      .find(el => el.style.cursor === 'pointer' && el.textContent.includes('Translated to Projects'));
    assert.ok(choice);
    await React.act(async () => { choice.click(); choice.click(); });
    assert.deepEqual(calls, [['m', 'Projects']]);
    assert.equal(closes, 0);
    await React.act(async () => { release({ copied: true }); });
    assert.equal(closes, 1);
    api.copyMessage = async () => { throw new Error('Copy failed'); };
    await React.act(async () => { choice.click(); });
    assert.deepEqual(notifications, [{ title: 'Translated error', body: 'Copy failed' }]);
  } finally {
    await React.act(async () => root.unmount());
    api.copyMessage = originalCopy;
    useStore.setState({ addNotification: originalAddNotification });
  }
});


const seedState = () => useStore.setState({
  layout: 'superhuman', theme: 'superhuman', composing: false, showAdmin: false, showContacts: false,
  selectedMessageId: 'm', listFocusedMessageId: null, messageWindows: [], searchQuery: '', searchResults: [],
  threadMessages: {}, messages: [{ id: 'm', account_id: 'a', folder: 'INBOX', is_read: true }],
  accounts: [{ id: 'a', name: 'Work', enabled: true }], folders: { a: [{ path: 'Projects' }] },
  shortcuts: {}, notifications: [],
});

function paletteHarness(root, extras = {}) {
  let setOpen;
  function Harness() {
    const [open, update] = React.useState(false);
    setOpen = update;
    return React.createElement(CommandPalette, { open, onClose: () => update(false), ...extras });
  }
  return {
    async mount() { await React.act(async () => root.render(React.createElement(Harness))); },
    async open() { await React.act(async () => setOpen(true)); },
    async close() { await React.act(async () => setOpen(false)); },
  };
}

const keydown = (target, key, options = {}) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }));

test('palette focuses, traps Tab, closes with Escape, and restores focus on repeated opens', async () => {
  seedState();
  const root = createRoot(document.getElementById('root'));
  const trigger = document.createElement('button');
  document.body.append(trigger);
  const harness = paletteHarness(root);
  try {
    await harness.mount();
    for (let i = 0; i < 2; i++) {
      trigger.focus();
      await harness.open();
      const input = document.querySelector('[role="combobox"]');
      assert.ok(document.querySelector('[role="dialog"][aria-modal="true"]'));
      assert.equal(document.activeElement, input);
      await React.act(async () => keydown(input, 'Tab'));
      assert.equal(document.activeElement, input);
      await React.act(async () => keydown(input, 'Escape'));
      assert.equal(document.querySelector('[role="dialog"]'), null);
      assert.equal(document.activeElement, trigger);
    }
  } finally {
    await React.act(async () => root.unmount());
    trigger.remove();
  }
});

test('palette dispatches native actions after closing and does not steal destination focus', async () => {
  seedState();
  const root = createRoot(document.getElementById('root'));
  const target = document.createElement('input');
  document.body.append(target);
  const events = [];
  const search = () => { events.push(document.querySelector('[role="dialog"]')); target.focus(); };
  const archive = () => events.push('archive');
  shortcutBus.on('focusSearch', search);
  shortcutBus.on('archive', archive);
  const harness = paletteHarness(root);
  try {
    await harness.mount();
    await harness.open();
    await React.act(async () => document.querySelector('[data-command-id="mail:archive"]').click());
    assert.deepEqual(events, ['archive']);
    await harness.open();
    await React.act(async () => document.querySelector('[data-command-id="mail:focusSearch"]').click());
    assert.deepEqual(events, ['archive', null]);
    assert.equal(document.activeElement, target);
  } finally {
    await React.act(async () => root.unmount());
    shortcutBus.off('focusSearch', search);
    shortcutBus.off('archive', archive);
    target.remove();
  }
});

test('missing selection and editor context disable mail commands without dispatch', async () => {
  seedState();
  useStore.setState({ selectedMessageId: null });
  const root = createRoot(document.getElementById('root'));
  const calls = [];
  const archive = () => calls.push('archive');
  shortcutBus.on('archive', archive);
  const harness = paletteHarness(root);
  try {
    await harness.mount();
    await harness.open();
    const done = document.querySelector('[data-command-id="mail:archive"]');
    assert.equal(done.getAttribute('aria-disabled'), 'true');
    await React.act(async () => done.click());
    assert.deepEqual(calls, []);
    await React.act(async () => useStore.setState({ selectedMessageId: 'm', composing: true }));
    assert.equal(done.getAttribute('aria-disabled'), 'true');
    await React.act(async () => done.click());
    assert.deepEqual(calls, []);
  } finally {
    await React.act(async () => root.unmount());
    shortcutBus.off('archive', archive);
  }
});

test('layout choices preserve the independently selected theme', async () => {
  seedState();
  const original = useStore.getState();
  const changes = [];
  useStore.setState({ setTheme: value => changes.push(['theme', value]), setLayout: value => changes.push(['layout', value]) });
  const root = createRoot(document.getElementById('root'));
  const harness = paletteHarness(root);
  try {
    await harness.mount();
    await harness.open();
    await React.act(async () => document.querySelector('[data-command-id="layout:superhuman"]').click());
    assert.deepEqual(changes, [['layout', 'superhuman']]);
    await harness.open();
    await React.act(async () => document.querySelector('[data-command-id="layout:comfortable"]').click());
    assert.deepEqual(changes.at(-1), ['layout', 'comfortable']);
    assert.equal(changes.length, 2);
  } finally {
    await React.act(async () => root.unmount());
    useStore.setState({ setTheme: original.setTheme, setLayout: original.setLayout });
  }
});

test('keyboard navigation skips disabled commands, filters by meaning, and toggles closed with Ctrl K', async () => {
  seedState();
  useStore.setState({ selectedMessageId: null });
  const root = createRoot(document.getElementById('root'));
  const harness = paletteHarness(root);
  try {
    await harness.mount();
    await harness.open();
    const input = document.querySelector('[role="combobox"]');
    const active = () => document.getElementById(input.getAttribute('aria-activedescendant'));
    assert.equal(active().getAttribute('data-command-id'), 'mail:focusSearch');
    await React.act(async () => keydown(input, 'ArrowDown'));
    assert.equal(active().getAttribute('data-command-id'), 'mail:showHelp');
    await React.act(async () => keydown(input, 'ArrowUp'));
    assert.equal(active().getAttribute('data-command-id'), 'mail:focusSearch');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, 'archive');
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    assert.equal(document.querySelectorAll('[role="option"]').length, 1);
    assert.equal(document.querySelector('[role="option"]').getAttribute('data-command-id'), 'mail:archive');
    assert.equal(input.hasAttribute('aria-activedescendant'), false);
    await React.act(async () => keydown(input, 'Enter'));
    assert.ok(document.querySelector('[role="dialog"]'), 'disabled result does not execute or close');
    await React.act(async () => keydown(input, 'k', { ctrlKey: true }));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await harness.open();
    assert.equal(document.querySelector('[role="combobox"]').value, '', 'new opening clears old query');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('finishing a dismissed label request cannot close a newer palette session', async () => {
  seedState();
  const originalCopy = api.copyMessage;
  let release;
  api.copyMessage = () => new Promise(resolve => { release = resolve; });
  const root = createRoot(document.getElementById('root'));
  const harness = paletteHarness(root, { labelPickerMessage: { id: 'm', account_id: 'a', folder: 'INBOX' } });
  try {
    await harness.mount();
    await harness.open();
    await React.act(async () => document.querySelector('[data-command-id="label:Projects"]').click());
    await harness.close();
    await harness.open();
    await React.act(async () => release({ copied: true }));
    assert.ok(document.querySelector('[role="dialog"]'));
  } finally {
    await React.act(async () => root.unmount());
    api.copyMessage = originalCopy;
  }
});

test('label command transitions into the native picker instead of immediately closing it', async () => {
  seedState();
  const root = createRoot(document.getElementById('root'));
  let openPicker;
  const handler = () => openPicker({ id: 'm', account_id: 'a', folder: 'INBOX' });
  shortcutBus.on('openLabelPicker', handler);
  function Harness() {
    const [open, setOpen] = React.useState(true);
    const [message, setMessage] = React.useState(null);
    openPicker = value => { setMessage(value); setOpen(true); };
    return React.createElement(CommandPalette, { open, labelPickerMessage: message, onClose: () => { setOpen(false); setMessage(null); } });
  }
  try {
    await React.act(async () => root.render(React.createElement(Harness)));
    await React.act(async () => document.querySelector('[data-command-id="mail:openLabelPicker"]').click());
    assert.ok(document.querySelector('[role="dialog"]'));
    assert.ok(document.querySelector('[data-command-id="label:Projects"]'));
    assert.equal(document.activeElement.getAttribute('role'), 'combobox');
  } finally {
    await React.act(async () => root.unmount());
    shortcutBus.off('openLabelPicker', handler);
  }
});

test('IME candidate confirmation and already-handled Enter never execute mail commands', async () => {
  seedState();
  const root = createRoot(document.getElementById('root'));
  const harness = paletteHarness(root);
  let calls = 0;
  const archive = () => { calls++; };
  shortcutBus.on('archive', archive);
  try {
    await harness.mount();
    await harness.open();
    const input = document.querySelector('[role="combobox"]');
    await React.act(async () => keydown(input, 'Enter', { isComposing: true }));
    await React.act(async () => keydown(input, 'Enter', { keyCode: 229 }));
    await React.act(async () => {
      const event = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      event.preventDefault();
      input.dispatchEvent(event);
    });
    assert.equal(calls, 0);
    assert.ok(document.querySelector('[role="dialog"]'));
    await React.act(async () => keydown(input, 'Enter'));
    assert.equal(calls, 1);
  } finally {
    await React.act(async () => root.unmount());
    shortcutBus.off('archive', archive);
  }
});

test('singular mail commands clear checked-list scope before dispatch', async () => {
  seedState();
  const root = createRoot(document.getElementById('root'));
  const harness = paletteHarness(root);
  const order = [];
  const clear = () => order.push('clear');
  const archive = () => order.push('archive');
  shortcutBus.on('clearBulkSelection', clear);
  shortcutBus.on('archive', archive);
  try {
    await harness.mount();
    await harness.open();
    await React.act(async () => document.querySelector('[data-command-id="mail:archive"]').click());
    assert.deepEqual(order, ['clear', 'archive']);
  } finally {
    await React.act(async () => root.unmount());
    shortcutBus.off('clearBulkSelection', clear);
    shortcutBus.off('archive', archive);
  }
});

test('mobile palette omits desktop-only shortcut help', async () => {
  seedState();
  const previousWidth = window.innerWidth;
  window.innerWidth = 500;
  const root = createRoot(document.getElementById('root'));
  const harness = paletteHarness(root);
  try {
    await harness.mount();
    await harness.open();
    assert.equal(document.querySelector('[data-command-id="mail:showHelp"]'), null);
    assert.ok(document.querySelector('[data-command-id="compose"]'));
  } finally {
    await React.act(async () => root.unmount());
    window.innerWidth = previousWidth;
  }
});

test('Contacts keeps baseline static palette navigation and compose in every layout while mail mutations stay blocked', async () => {
  for (const layout of ['comfortable', 'superhuman']) {
    seedState();
    useStore.setState({ layout, showContacts: true });
    const root = createRoot(document.getElementById('root'));
    const harness = paletteHarness(root);
    try {
      await harness.mount(); await harness.open();
      for (const id of ['compose', 'inbox', 'settings', 'themes', 'layout:comfortable', 'account:a', 'theme:dark']) {
        const action = document.querySelector(`[data-command-id="${id}"]`);
        assert.ok(action, id);
        assert.equal(action.getAttribute('aria-disabled'), 'false', `${layout}: ${id} is safe from Contacts`);
      }
      if (layout === 'superhuman') assert.equal(document.querySelector('[data-command-id="mail:archive"]').getAttribute('aria-disabled'), 'true');
      else assert.equal(document.querySelector('[data-command-id="mail:archive"]'), null);
      await React.act(async () => document.querySelector('[data-command-id="inbox"]').click());
      assert.equal(useStore.getState().showContacts, false);
      assert.equal(useStore.getState().selectedFolder, 'INBOX');
      await React.act(async () => useStore.setState({ showContacts: true }));
      await harness.open();
      await React.act(async () => document.querySelector('[data-command-id="compose"]').click());
      assert.equal(useStore.getState().composing, true, `${layout}: native compose opens from Contacts`);
    } finally {
      await React.act(async () => root.unmount());
      useStore.setState({ composing: false, showContacts: false });
    }
  }
});

test('a persisted Superhuman layout keeps the native palette on phones', async () => {
  seedState();
  const width = window.innerWidth;
  window.innerWidth = 390;
  const root = createRoot(document.getElementById('root'));
  const harness = paletteHarness(root);
  try {
    await harness.mount(); await harness.open();
    assert.equal(document.querySelectorAll('[data-command-id^="mail:"]').length, 0);
    assert.equal(document.querySelector('[role="dialog"]').style.maxWidth, '520px');
    assert.ok(document.querySelector('[data-command-id="compose"]'));
  } finally {
    await React.act(async () => root.unmount());
    window.innerWidth = width;
  }
});
