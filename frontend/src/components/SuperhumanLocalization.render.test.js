import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    if (url.endsWith('.json')) return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    const env = code => code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
    if (url.endsWith('.jsx')) return { format: 'module', shortCircuit: true, source: env(transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url }).code) };
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: env(code) };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid/', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Event: dom.window.Event,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle,
  requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
  IS_REACT_ACT_ENVIRONMENT: true, __VITE_ENV__: { MODE: 'test', DEV: false, PROD: true },
});
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.matchMedia = window.matchMedia;
globalThis.fetch = async () => { throw new Error('Unexpected network request in localization test'); };
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: i18n, i18nReady } = await import('../i18n.js');
await i18nReady;
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const { availabilityText } = await import('../utils/composeAvailability.js');
const { openActivityStatus } = await import('../utils/openActivity.js');
const { toInstant } = await import('../plugins/local-calendar/dates.js');
const SplitDialog = (await import('./SavedSplitsDialog.jsx')).default;
const Availability = (await import('./ComposeAvailability.jsx')).default;
const Activity = (await import('./OpenActivityPanel.jsx')).default;
const Calendar = (await import('../plugins/local-calendar/CalendarView.jsx')).default;
const originalApi = { ...api };
let root;
beforeEach(async () => {
  await i18n.changeLanguage('en');
  document.body.innerHTML = '<button id="opener">Open</button><div id="root"></div>';
  document.getElementById('opener').focus();
  useStore.setState({ ...useStore.getInitialState(), user: { id: 'owner' }, savedSplits: [], savedSplitsLoaded: true, accounts: [{ id: 'account' }] });
  root = createRoot(document.getElementById('root'));
});
afterEach(async () => { await React.act(async () => root.unmount()); Object.assign(api, originalApi); });
after(() => dom.window.close());
const render = async (Component, props = {}) => React.act(async () => root.render(React.createElement(Component, props)));
const button = text => [...document.querySelectorAll('button')].find(node => node.textContent.trim() === text);
const input = async (label, value) => React.act(async () => {
  const node = document.querySelector(`[aria-label="${label}"]`);
  assert.ok(node, label);
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(node, value);
  node.dispatchEvent(new window.Event('input', { bubbles: true }));
});

test('real English resources interpolate availability, activity and calendar helper text', async () => {
  const result = availabilityText('2030-11-20', '14:30', 'UTC', new Date('2026-01-01'), i18n.t.bind(i18n), 'en');
  assert.match(result.text, /^I’m available Wednesday, November 20, 2030 at 2:30 PM \(UTC\)\. Would that work for you\?$/);
  assert.equal(openActivityStatus({ status: 'sent', loadCount: 2 }, i18n.t.bind(i18n)), '2 image loads recorded');
  assert.throws(() => toInstant('2030-11-20T14:30', 'not-a-zone', i18n.t.bind(i18n)), /Enter a valid time zone/);
  await render(Availability, { onInsert() {}, onClose() {} });
  assert.equal(document.querySelector('[role="dialog"]').getAttribute('aria-label'), 'Share availability');
  await input('Available date', '2030-11-20'); await input('Available time', '14:30'); await input('Availability time zone', 'UTC');
  assert.match(document.querySelector('[role="status"]').textContent, /I’m available/);
  assert.doesNotMatch(document.body.textContent, /\{\{|compose\.availability\./);
});

test('translated split name labels do not control new-row autofocus or Escape restoration', async () => {
  i18n.addResourceBundle('test-locale', 'translation', { savedSplits: { title: 'Postfach aufteilen', add: 'Ansicht hinzufügen', nameLabel: 'Name der Ansicht {{number}}' } }, true, true);
  await i18n.changeLanguage('test-locale');
  let closed = 0;
  function Harness() {
    const [open, setOpen] = React.useState(true);
    return open ? React.createElement(SplitDialog, { onClose: () => { closed++; setOpen(false); } }) : null;
  }
  await render(Harness);
  await React.act(async () => button('Ansicht hinzufügen').click());
  await React.act(async () => new Promise(resolve => setTimeout(resolve, 10)));
  const field = document.querySelector('[data-split-name]');
  assert.equal(field.getAttribute('aria-label'), 'Name der Ansicht 1');
  assert.equal(document.activeElement === field, true, 'the new split name field receives focus regardless of language');
  await React.act(async () => field.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  assert.equal(closed, 1); assert.equal(document.activeElement.id, 'opener');
});

test('MailFlow locale aliases render calendar and activity dates without invalid Intl tags', async () => {
  for (const locale of ['ptBR', 'zhCN']) {
    await React.act(async () => i18n.changeLanguage(locale));
    api.get = async path => path.includes('/catalog') ? { calendars: [], templates: [], timezone: 'UTC', weekStart: 1, revision: 'r1' }
      : path.startsWith('/local-calendar/events') ? { items: [], nextCursor: null }
        : { activity: [{ id: 'activity', subject: 'Outgoing', status: 'sent', loadCount: 1, sentAt: '2030-11-20T14:30:00Z', expiresAt: '2030-12-20T14:30:00Z' }] };
    await render(Calendar, { onBack() {} });
    assert.ok(document.querySelector('.mf-calendar-datebar h2').textContent);
    await render(Activity);
    assert.ok(document.querySelector('ol small').textContent);
    await render(Availability, { onInsert() {}, onClose() {} });
    const labels = { date: i18n.t('compose.availability.date'), time: i18n.t('compose.availability.time'), zone: i18n.t('compose.availability.zone') };
    await input(labels.date, '2030-11-20'); await input(labels.time, '14:30'); await input(labels.zone, 'UTC');
    assert.ok(document.querySelector('[role="status"]').textContent);
    assert.doesNotMatch(document.body.textContent, /\{\{|compose\.availability\./);
  }
});
