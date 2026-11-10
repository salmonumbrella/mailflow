import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({ load(url, context, next) {
  if (url.endsWith('react-i18next/dist/es/index.js')) return { format: 'module', shortCircuit: true, source: 'export const useTranslation = () => ({ t: (key, options) => options?.defaultValue || key });' };
  if (url.endsWith('.jsx')) return { format: 'module', shortCircuit: true, source: transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url }).code };
  return next(url, context);
} });
const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { api } = await import('../utils/api.js');
const Details = (await import('./GmailMessageDetails.jsx')).default;
const message = { id: 'one', from_name: 'Zoë Sender', from_email: 'zoe@example.invalid', subject: 'Native subject', date: '2026-01-01T10:00:00Z', to_addresses: [{ name: 'Łukasz', email: 'to@example.invalid' }] };
let root, calls;
const click = async element => { assert.ok(element); await React.act(async () => element.click()); };
const render = async (msg = message, body = {}) => React.act(async () => root.render(React.createElement(Details, { message: msg, body })));
beforeEach(() => {
  calls = [];
  api.getMessageHeaders = async id => { calls.push(id); return { headers: 'Cc: One <one@example.invalid>,\r\n Two <two@example.invalid>\r\nBcc: forged@example.invalid\r\nAuthentication-Results: forged; dkim=pass\r\nReceived: by trusted.invalid\r\n', subject: 'Native subject' }; };
  root = createRoot(document.getElementById('root'));
});
afterEach(async () => React.act(async () => root.unmount()));

test('details lazily show native identities, folded Cc, and only backend-authorized Bcc without invented security', async () => {
  await render();
  assert.deepEqual(calls, []);
  await click(document.querySelector('[aria-label="Show message details"]'));
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog);
  for (const value of ['Zoë Sender <zoe@example.invalid>', 'Łukasz <to@example.invalid>', 'One <one@example.invalid>, Two <two@example.invalid>', 'Native subject']) assert.ok(dialog.textContent.includes(value), value);
  assert.ok(!dialog.textContent.includes('forged@example.invalid'));
  assert.ok(!dialog.textContent.includes('dkim=pass'));
  assert.ok(!dialog.textContent.includes('mailed-by'));
  assert.deepEqual(calls, ['one']);
  await render(message, { bccAddresses: [{ name: 'Private', email: 'private@example.invalid' }] });
  assert.ok(dialog.textContent.includes('Private <private@example.invalid>'));
  assert.ok([...dialog.querySelectorAll('dt')].some(el => el.textContent === 'Bcc'));
});

test('Escape and outside dismissal restore focus and reopening works', async () => {
  await render();
  const trigger = document.querySelector('[aria-label="Show message details"]');
  await click(trigger);
  const close = document.querySelector('[aria-label="Close message details"]');
  assert.equal(document.activeElement, close);
  await React.act(async () => close.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, trigger);
  await click(trigger);
  await React.act(async () => document.body.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true })));
  assert.equal(document.querySelector('[role="dialog"]'), null);
});

test('stale header response cannot populate another identity, failed lookup keeps native facts and can retry', async () => {
  let finish;
  api.getMessageHeaders = () => new Promise(resolve => { finish = resolve; });
  await render();
  await click(document.querySelector('[aria-label="Show message details"]'));
  await render({ ...message, id: 'two', subject: 'Second subject' });
  assert.equal(document.querySelector('[role="dialog"]'), null);
  await React.act(async () => finish({ headers: 'Cc: stale@example.invalid' }));
  api.getMessageHeaders = async () => { throw new Error('offline'); };
  await click(document.querySelector('[aria-label="Show message details"]'));
  assert.match(document.querySelector('[role="dialog"]').textContent, /Second subject/);
  assert.ok(!document.body.textContent.includes('stale@example.invalid'));
  assert.match(document.querySelector('[role="alert"]').textContent, /offline/);
  api.getMessageHeaders = async () => ({ headers: 'Cc: recovered@example.invalid' });
  await click([...document.querySelectorAll('button')].find(el => el.textContent === 'Retry'));
  assert.match(document.querySelector('[role="dialog"]').textContent, /recovered@example.invalid/);
});
