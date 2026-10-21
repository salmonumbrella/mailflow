import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

// Existing frontend render-test tooling; no new dependency or execution. Tests
// catch stale account/session responses, false complete labels and unsafe controls.
registerHooks({ load(url, context, next) {
  if (url.endsWith('/react-i18next') || url.endsWith('react-i18next/dist/es/index.js')) {
    return { format: 'module', shortCircuit: true,
      source: 'export const useTranslation=()=>({t:(_key,opts)=>opts.defaultValue});' };
  }
  if (url.endsWith('.jsx')) return { format: 'module', shortCircuit: true,
    source: transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic' }).code };
  return next(url, context);
} });
const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.test' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: SearchCoverage } = await import('./SearchCoverage.jsx');
const account = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const host = document.getElementById('root');
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const state = (accountId = account, extra = {}) => ({ accountId, enabled: true, paused: false,
  complete: false, status: 'catching-up', body: { sources: 4, verified: 1, pending: 2, failed: 0, unsupported: 1 },
  identity: { mode: 'physical', bootstrapComplete: false }, budget: { chargedBytes: '264193' }, ...extra });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
let root, calls, response;
const flush = () => act(async () => { await new Promise(done => setTimeout(done, 0)); });
const render = async (id = account, generation = 'session-1') => {
  await act(async () => { root.render(React.createElement(SearchCoverage, { accountId: id, sessionGeneration: generation })); });
  await flush();
};
const click = async text => {
  const button = [...host.querySelectorAll('button')].find(node => node.textContent === text);
  assert.ok(button, text);
  await act(async () => { button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  await flush();
};
beforeEach(() => {
  calls = []; response = async () => json(state());
  globalThis.fetch = async (url, options) => { calls.push({ url: String(url), ...options }); return response(String(url), options); };
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); });

test('shows verified/pending/unsupported separately and does not promise exhaustive results', async () => {
  await render();
  assert.match(host.textContent, /1 of 4 cached message bodies verified/);
  assert.match(host.textContent, /2 pending/); assert.match(host.textContent, /1 unsupported/);
  assert.match(host.textContent, /may be incomplete/);
  assert.doesNotMatch(host.textContent, /indexing complete/i);
  assert.equal(calls.length, 1); // no timer/polling or provider/body request
});

test('even all cached pointers verified does not imply full provider coverage', async () => {
  response = async () => json(state(account, { status: 'cached-bodies-verified',
    body: { sources: 4, verified: 4, pending: 0, failed: 0, unsupported: 0 } }));
  await render();
  assert.match(host.textContent, /4 of 4/); assert.match(host.textContent, /may be incomplete/);
  assert.doesNotMatch(host.textContent, /indexing complete/i);
});

test('pause/resume/retry use the shared authenticated API and refresh only current coverage', async () => {
  let paused = false;
  response = async (_url, options) => {
    if (options.method === 'POST') { const action = JSON.parse(options.body).action;
      paused = action === 'pause' ? true : action === 'resume' ? false : paused;
      return json({ paused }); }
    return json(state(account, { paused }));
  };
  await render(); await click('Pause'); await click('Resume'); await click('Retry failed');
  assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => JSON.parse(call.body).action), ['pause', 'resume', 'retry']);
  for (const call of calls) {
    assert.equal(call.credentials, 'include'); assert.equal(call.headers['X-Requested-With'], 'MailFlow');
    assert.equal(call.url, `/api/accounts/${account}/search-coverage`);
  }
});

test('an old account load cannot replace the new account coverage', async () => {
  const old = gate(); response = async url => url.includes(account) ? old.promise : json(state(other, { body: { sources: 2, verified: 2 } }));
  await render(); await render(other);
  assert.match(host.textContent, /2 of 2/);
  old.resolve(json(state(account))); await flush();
  assert.match(host.textContent, /2 of 2/); assert.doesNotMatch(host.textContent, /1 of 4/);
});

test('logout/session replacement discards a pending control response and its refresh', async () => {
  const held = gate();
  response = async (_url, options) => options.method === 'POST' ? held.promise : json(state());
  await render(); await click('Pause');
  await render(account, 'session-2'); const before = calls.length;
  held.resolve(json({ paused: true })); await flush();
  assert.equal(calls.length, before); assert.ok([...host.querySelectorAll('button')].some(node => node.textContent === 'Pause'));
});

test('a load error stays incomplete and requires explicit refresh instead of polling', async () => {
  response = async () => json({ error: 'Synthetic status unavailable' }, 503);
  await render(); assert.match(host.textContent, /Synthetic status unavailable/);
  assert.doesNotMatch(host.textContent, /of .*cached message bodies verified/);
  assert.equal(calls.length, 1);
  response = async () => json(state()); await click('Refresh');
  assert.match(host.textContent, /1 of 4/); assert.equal(calls.length, 2);
});
