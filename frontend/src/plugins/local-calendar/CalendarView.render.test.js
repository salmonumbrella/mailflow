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
        'const t = (key, fallback, values = {}) => { const options = typeof fallback === "object" ? fallback : values; const text = typeof fallback === "string" ? fallback : fallback?.defaultValue ?? (options?.message ? `${key} ${options.message}` : key); return text.replace(/\\{\\{(\\w+)\\}\\}/g, (_, name) => String(options?.[name] ?? "")); }; export const useTranslation = () => ({ t, i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export const Trans = ({ children }) => children ?? null;',
        'export const I18nextProvider = ({ children }) => children ?? null;',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
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
const { useStore } = await import('../../store/index.js');
const CalendarView = (await import('./CalendarView.jsx')).default;
const { api } = await import('../../utils/api.js');
const ORIGINAL = { ...api };
const CAL = { id: '22222222-2222-4222-8222-222222222222', name: 'Personal', color: '#aabbcc', visible: true };
let catalog, events, calls, root, backs;
beforeEach(async () => {
  catalog = { calendars: [CAL], templates: [], timezone: 'UTC', weekStart: 1, revision: 'catalog-r1' };
  events = []; calls = []; backs = 0;
  useStore.setState({ ...useStore.getInitialState(), user: { id: 'calendar-owner' }, accounts: [{ id: 'mail-account', enabled: true }] });
  api.get = async path => { calls.push(['get', path]); return path.startsWith('/local-calendar/catalog') ? structuredClone(catalog) : { items: structuredClone(events), nextCursor: null }; };
  api.post = async (path, body) => { calls.push(['post', path, body]); const event = { ...body, id: 'event-1', revision: 'r1' }; events.push(event); return event; };
  api.put = async (path, body) => { calls.push(['put', path, body]); if (path.endsWith('/catalog')) { catalog = { ...body, revision: 'r2' }; return catalog; } const event = { ...body, revision: 'r2' }; events = [event]; return event; };
  api.delete = async path => { calls.push(['delete', path]); events = []; return { ok: true }; };
  window.confirm = () => true;
  root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(CalendarView, { onBack: () => backs++ })));
});
afterEach(async () => { await React.act(async () => root.unmount()); Object.assign(api, ORIGINAL); });
const click = async selector => React.act(async () => { const node = document.querySelector(selector); assert.ok(node, selector); node.click(); });
const input = async (node, value) => React.act(async () => {
  assert.ok(node);
  const proto = node.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : node.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, value);
  node.dispatchEvent(new window.Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
});
const labeled = text => [...document.querySelectorAll('label')].find(label => label.firstChild?.textContent === text)?.querySelector('input, select, textarea');
const submit = async () => React.act(async () => document.querySelector('[role="dialog"] form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
const key = async (name, target = document.querySelector('.mf-calendar')) => React.act(async () => target.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })));

test('loads an empty owner calendar without seeding or writing and switches day/week/month with keys', async () => {
  assert.match(document.body.textContent, /No events in this range/);
  assert.equal(calls.some(([method]) => method !== 'get'), false);
  await key('0'); assert.equal(document.querySelectorAll('.mf-calendar-timed').length, 1);
  await key('2'); assert.equal(document.querySelectorAll('.mf-calendar-timed').length, 7);
  await key('m'); assert.ok(document.querySelector('.mf-calendar-month'));
  const before = document.querySelector('[aria-label="Go to date"]').value;
  await key('ArrowRight'); assert.notEqual(document.querySelector('[aria-label="Go to date"]').value, before);
  await key('Escape'); assert.equal(backs, 1);
});
test('timed event CRUD preserves calendar identity, revision, timezone and native API routes', async () => {
  await click('[data-new-event]');
  await input(labeled('Title'), 'Team review');
  await input(labeled('Start'), '2026-11-10T10:30');
  await input(labeled('End'), '2026-11-10T11:30');
  await submit();
  assert.equal(document.querySelector('[role="dialog"]'), null);
  const created = calls.find(([method]) => method === 'post')[2];
  assert.equal(created.title, 'Team review'); assert.equal(created.calendarId, CAL.id);
  assert.equal(created.start, '2026-11-10T10:30:00.000Z');
  await input(document.querySelector('[aria-label="Go to date"]'), '2026-11-10');
  await click('.mf-calendar-event');
  await input(labeled('Title'), 'Revised review');
  await submit();
  assert.equal(calls.find(([method, path]) => method === 'put' && path.includes('/events/'))[2].revision, 'r1');
  await click('.mf-calendar-event');
  await React.act(async () => [...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent === 'Delete event').click());
  assert.equal(calls.find(([method]) => method === 'delete')[1], '/local-calendar/events/event-1?revision=r2');
  assert.match(document.body.textContent, /No events in this range/);
});
test('conflicts preserve unsaved edits and repeated clicks do not send duplicate writes', async () => {
  await click('[data-new-event]'); await input(labeled('Title'), 'Keep this draft');
  let reject;
  api.post = (path, body) => { calls.push(['post', path, body]); return new Promise((resolve, fail) => { reject = fail; }); };
  await submit(); await submit();
  assert.equal(calls.filter(([method]) => method === 'post').length, 1);
  await React.act(async () => reject(Object.assign(new Error('Changed on another device.'), { status: 409 })));
  assert.equal(labeled('Title').value, 'Keep this draft');
  assert.match(document.querySelector('[role="dialog"]').textContent, /unsaved edits are still here/);
  await key('Escape', labeled('Title'));
  assert.equal(document.querySelector('[role="dialog"]'), null); assert.equal(backs, 0);
});
test('calendar and template creation persist, templates prefill a new event, cancellation does not write', async () => {
  await click('[aria-label="Add calendar"]'); await input(labeled('Name'), 'Projects'); await submit();
  assert.equal(catalog.calendars.length, 2);
  await click('[aria-label="Add event template"]'); await input(labeled('Title'), 'Focus time'); await input(labeled('Duration (minutes)'), '45'); await submit();
  assert.equal(catalog.templates[0].duration, 45);
  await React.act(async () => [...document.querySelectorAll('.mf-calendar-source button')].find(b => b.textContent.startsWith('Focus time')).click());
  assert.equal(labeled('Title').value, 'Focus time');
  assert.equal((Date.parse(labeled('End').value) - Date.parse(labeled('Start').value)) / 60000, 45);
  const writes = calls.filter(([method]) => method !== 'get').length;
  await key('Escape', labeled('Title'));
  assert.equal(calls.filter(([method]) => method !== 'get').length, writes);
});
test('all-day multi-day events and settings save independent wall dates and week starts', async () => {
  await click('[data-new-event]'); await input(labeled('Title'), 'Away');
  await click('[role="dialog"] input[type="checkbox"]');
  await input(labeled('Start'), '2026-11-10'); await input(labeled('End (exclusive)'), '2026-11-13'); await submit();
  const created = calls.find(([method]) => method === 'post')[2];
  assert.equal(created.allDay, true); assert.equal(created.start, '2026-11-10'); assert.equal(created.end, '2026-11-13');
  await React.act(async () => [...document.querySelectorAll('.mf-calendar-toolbar button')].find(b => b.textContent === 'Settings').click());
  await input(labeled('Time zone'), 'Asia/Tokyo'); await input(labeled('Start week on'), '6'); await submit();
  assert.equal(catalog.timezone, 'Asia/Tokyo'); assert.equal(catalog.weekStart, 6);
});
test('stale date-range responses cannot replace a newer navigation', async () => {
  let release;
  api.get = path => path.endsWith('/catalog') ? Promise.resolve(catalog) : new Promise(resolve => { release = resolve; });
  await click('[aria-label="Next period"]'); const oldRelease = release;
  await click('[aria-label="Next period"]');
  await React.act(async () => release({ items: [], nextCursor: null }));
  await React.act(async () => oldRelease({ items: [{ id: 'stale', title: 'Stale event', calendarId: CAL.id }], nextCursor: null }));
  assert.doesNotMatch(document.body.textContent, /Stale event/);
});


test('the first user-created calendar saves the browser time zone without write-on-read', async () => {
  catalog = { ...catalog, calendars: [], timezone: 'UTC', revision: null };
  await React.act(async () => [...document.querySelectorAll('.mf-calendar-datebar button')].find(b => b.textContent === 'Reload').click());
  assert.equal(calls.some(([method]) => method !== 'get'), false);
  await click('[aria-label="Add calendar"]');
  await input(labeled('Name'), 'First calendar'); await submit();
  assert.equal(catalog.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
});


test('unfinished calendar deletion shows a durable cleanup action and retains the failure notice', async () => {
  catalog = { ...catalog, pendingCleanupIds: [CAL.id] };
  await React.act(async () => [...document.querySelectorAll('.mf-calendar-datebar button')].find(b => b.textContent === 'Reload').click());
  assert.match(document.body.textContent, /saved event data awaiting deletion/);
  api.post = async path => { assert.equal(path, '/local-calendar/cleanup'); return { cleanupError: 'Could not finish deletion. Retry later.' }; };
  await React.act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === 'Finish cleanup').click());
  assert.match(document.body.textContent, /Could not finish deletion/);
  api.post = async () => { catalog = { ...catalog, pendingCleanupIds: [] }; return catalog; };
  await React.act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === 'Finish cleanup').click());
  assert.doesNotMatch(document.body.textContent, /saved event data awaiting deletion/);
});


test('saved 12/24-hour preference formats timeline, event and accessible slot labels while inputs stay native', async () => {
  events = [{ id: 'clock-event', title: 'Afternoon', calendarId: CAL.id, start: '2026-11-10T15:30:00.000Z', end: '2026-11-10T16:30:00.000Z', allDay: false, timezone: 'UTC', revision: 'clock-r1', location: '', description: '' }];
  await input(document.querySelector('[aria-label="Go to date"]'), '2026-11-10');
  await React.act(async () => [...document.querySelectorAll('.mf-calendar-datebar button')].find(b => b.textContent === 'Reload').click());
  assert.equal(document.querySelector('.mf-calendar-event time').textContent, '15:30');
  await React.act(async () => [...document.querySelectorAll('.mf-calendar-toolbar button')].find(b => b.textContent === 'Settings').click());
  assert.equal(labeled('Time format').value, '24h');
  await input(labeled('Time format'), '12h'); await submit();
  assert.equal(catalog.timeFormat, '12h');
  assert.equal(document.querySelector('.mf-calendar-hours').children[0].textContent, '12:00 AM');
  assert.equal(document.querySelector('.mf-calendar-hours').children[12].textContent, '12:00 PM');
  assert.equal(document.querySelector('.mf-calendar-hours').children[15].textContent, '3:00 PM');
  assert.equal(document.querySelector('.mf-calendar-event time').textContent, '3:30 PM');
  assert.ok(document.querySelector('[aria-label="New event on 2026-11-10 at 3:00 PM"]'));
  await click('.mf-calendar-event');
  assert.equal(labeled('Start').type, 'datetime-local');
  assert.equal(labeled('Start').value, '2026-11-10T15:30');
  await key('Escape', labeled('Start'));
  await key('m');
  assert.equal(document.querySelector('.mf-calendar-event time').textContent, '3:30 PM');
  await React.act(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(CalendarView, { onBack: () => backs++ })));
  assert.equal(document.querySelector('.mf-calendar-hours').children[15].textContent, '3:00 PM');
  await React.act(async () => [...document.querySelectorAll('.mf-calendar-toolbar button')].find(b => b.textContent === 'Settings').click());
  assert.equal(labeled('Time format').value, '12h');
  await input(labeled('Time format'), '24h'); await submit();
  assert.equal(catalog.timeFormat, '24h');
  assert.equal(document.querySelector('.mf-calendar-hours').children[15].textContent, '15:00');
  assert.equal(calls.filter(([method, path]) => method !== 'get' && path.includes('/events')).length, 0);
});

test('calendar availability action opens only a guarded draft with selected date and zone', async () => {
  catalog = { ...catalog, timezone: 'Asia/Tokyo' };
  await input(document.querySelector('[aria-label="Go to date"]'), '2030-07-02');
  await React.act(async () => [...document.querySelectorAll('.mf-calendar-toolbar button')].find(b => b.textContent === 'Share availability (manual)').click());
  assert.deepEqual(useStore.getState().composeData, { availability: { date: '2030-07-02', time: '09:00', timeZone: 'Asia/Tokyo' } });
  assert.equal(useStore.getState().composing, true);
  assert.equal(calls.filter(([method]) => method !== 'get').length, 0);
  assert.equal(backs, 0);
});

test('availability draft guard survives denied or repeated switches and shortcut ignores editing', async () => {
  useStore.setState({ composing: true, composeSession: 11, composeData: { subject: 'Keep draft' }, prepareComposeSwitch: async () => false });
  const button = [...document.querySelectorAll('.mf-calendar-toolbar button')].find(b => b.textContent === 'Share availability (manual)');
  await React.act(async () => button.click());
  assert.deepEqual(useStore.getState().composeData, { subject: 'Keep draft' });
  assert.match(document.body.textContent, /draft could not be safely saved/);
  let release, attempts = 0;
  useStore.setState({ prepareComposeSwitch: () => { attempts++; return new Promise(resolve => { release = resolve; }); } });
  await React.act(async () => { button.click(); button.click(); });
  assert.equal(attempts, 1);
  await React.act(async () => release(true));
  assert.ok(useStore.getState().composeData.availability);
  useStore.getState().closeCompose();
  await React.act(async () => document.querySelector('[aria-label="Go to date"]').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'A', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })));
  assert.equal(useStore.getState().composing, false);
  await React.act(async () => document.querySelector('.mf-calendar').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'A', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })));
  assert.equal(useStore.getState().composing, true);
  assert.equal(calls.filter(([method]) => method !== 'get').length, 0);
});

test('availability form prefills calendar context but inserts nothing until explicitly requested', async () => {
  const ComposeAvailability = (await import('../../components/ComposeAvailability.jsx')).default;
  const date = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const inserted = [];
  await React.act(async () => root.render(React.createElement(ComposeAvailability, { initial: { date, time: '09:00', timeZone: 'Asia/Tokyo' }, onInsert: text => inserted.push(text), onClose() {} })));
  assert.equal(document.querySelector('[aria-label="Available date"]').value, date);
  assert.equal(document.querySelector('[aria-label="Available time"]').value, '09:00');
  assert.equal(document.querySelector('[aria-label="Availability time zone"]').value, 'Asia/Tokyo');
  assert.match(document.body.textContent, /Your calendar has not been checked/);
  assert.equal(inserted.length, 0);
  await input(document.querySelector('[aria-label="Available time"]'), '15:45');
  await React.act(async () => root.render(React.createElement(ComposeAvailability, { initial: { date, time: '10:00', timeZone: 'UTC' }, onInsert: text => inserted.push(text), onClose() {} })));
  assert.equal(document.querySelector('[aria-label="Available time"]').value, '15:45');
  await React.act(async () => document.querySelector('form[role="dialog"]').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  assert.equal(inserted.length, 1);
  assert.match(inserted[0], /Asia\/Tokyo/);
  assert.equal(calls.filter(([method]) => method !== 'get').length, 0);
});


test('availability prefill rejects malformed dates, times and zones instead of changing the proposed instant', async () => {
  const ComposeAvailability = (await import('../../components/ComposeAvailability.jsx')).default;
  await React.act(async () => root.render(React.createElement(ComposeAvailability, { initial: { date: '2026-02-30', time: '25:99', timeZone: 'Mars/Base' }, onInsert() { assert.fail('Must not insert'); }, onClose() {} })));
  assert.equal(document.querySelector('[aria-label="Available date"]').value, '');
  assert.equal(document.querySelector('[aria-label="Available time"]').value, '');
  assert.notEqual(document.querySelector('[aria-label="Availability time zone"]').value, 'Mars/Base');
  assert.equal(document.querySelector('button[type="submit"]').disabled, true);
});
