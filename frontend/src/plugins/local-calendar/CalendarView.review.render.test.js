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
const CalendarView = (await import('./CalendarView.jsx')).default;
const { api } = await import('../../utils/api.js');
const ORIGINAL = { ...api };
const CAL = { id: '22222222-2222-4222-8222-222222222222', name: 'Personal', color: '#aabbcc', visible: true };
let catalog, events, calls, root, backs;
beforeEach(async () => {
  catalog = { calendars: [CAL], templates: [], timezone: 'UTC', weekStart: 1, revision: 'catalog-r1' };
  events = []; calls = []; backs = 0;
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

test('negative control: editing calendar settings preserves the version opened', async () => {
  await click('[aria-label="Edit Personal"]');
  await input(labeled('Name'), 'My edit');
  await submit();
  assert.equal(calls.find(([method]) => method === 'put')[2].revision, 'catalog-r1');
});

test('background focus reload must not bless stale calendar edits with a newer revision', async () => {
  await click('[aria-label="Edit Personal"]');
  await input(labeled('Name'), 'My old-tab edit');
  catalog = { ...catalog, calendars: [{ ...CAL, name: 'Newer edit elsewhere' }], revision: 'catalog-r2' };
  await React.act(async () => window.dispatchEvent(new window.Event('focus')));
  assert.equal(labeled('Name').value, 'My old-tab edit');
  await submit();
  const write = calls.find(([method]) => method === 'put')[2];
  assert.equal(write.revision, 'catalog-r1', 'The stale form must use its original revision so the API returns 409');
});
