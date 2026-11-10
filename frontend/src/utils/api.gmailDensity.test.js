import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, CSRF_HEADER, CSRF_VALUE } from './api.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('density read/write use their dedicated endpoint and preserve revision/conflict details', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ gmailDensity: 'compact', gmailDensityRevision: 8 }) };
  };
  assert.deepEqual(await api.getGmailDensity(), { gmailDensity: 'compact', gmailDensityRevision: 8 });
  await api.saveGmailDensity({ gmailDensity: 'compact', expectedRevision: 7 });
  assert.equal(calls[0].url, '/api/auth/preferences/gmail-density');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[1].options.keepalive, true);
  assert.equal(calls[1].options.credentials, 'include');
  assert.equal(calls[1].options.headers[CSRF_HEADER], CSRF_VALUE);
  assert.deepEqual(JSON.parse(calls[1].options.body), { gmailDensity: 'compact', expectedRevision: 7 });
  globalThis.fetch = async () => ({ ok: false, status: 409,
    json: async () => ({ error: 'Gmail density changed', gmailDensity: 'comfortable', gmailDensityRevision: 9 }),
  });
  await assert.rejects(api.saveGmailDensity({ gmailDensity: 'compact', expectedRevision: 7 }),
    error => error.status === 409 && error.gmailDensity === 'comfortable' && error.gmailDensityRevision === 9);
});

test('density transports do not dispatch global lock events before their caller fences the response', async () => {
  const previous = globalThis.window;
  let events = 0;
  globalThis.window = { dispatchEvent: () => { events++; } };
  try {
    globalThis.fetch = async () => ({ ok: false, status: 423, json: async () => ({ error: 'Locked' }) });
    await assert.rejects(api.getGmailDensity(), error => error.status === 423);
    await assert.rejects(api.saveGmailDensity({ gmailDensity: 'compact', expectedRevision: 0 }), error => error.status === 423);
    assert.equal(events, 0);
  } finally { globalThis.window = previous; }
});
