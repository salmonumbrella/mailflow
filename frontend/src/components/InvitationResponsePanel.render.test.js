import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) return {
      format: 'module', shortCircuit: true,
      source: 'export const useTranslation = () => ({ t: (key, options = {}) => (options.defaultValue || key).replace(/{{(\\w+)}}/g, (_, name) => options[name] ?? name) });',
    };
    if (url.endsWith('.jsx')) return { format: 'module', shortCircuit: true, source: transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url }).code };
    return nextLoad(url, context);
  },
});
const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.test', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { api } = await import('../utils/api.js');
const Panel = (await import('./InvitationResponsePanel.jsx')).default;
const body = { text: 'Calendar invitation', attachments: [{ type: 'text/calendar', filename: 'invite.ics' }] };
const message = { id: 'message-one', account_id: 'account-one' };
const invitation = { organizer: 'lead@example.test', attendee: 'me@example.test', summary: 'Planning', revision: 'a'.repeat(64) };
const result = (response = null) => ({ invitation, response });
const sent = { status: 'sent', response: 'ACCEPTED', attemptId: 'attempt-one' };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
let root, gets, posts, archived;
const text = () => document.getElementById('root').textContent;
const button = label => [...document.querySelectorAll('button')].find(el => el.textContent === label);
const click = async element => {
  assert.ok(element, 'button should exist');
  await React.act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
};
async function render(props = {}) {
  await React.act(async () => {
    root ||= createRoot(document.getElementById('root'));
    root.render(React.createElement(Panel, { message, body, onArchive: async () => { archived++; }, ...props }));
  });
}
async function flush() { await React.act(async () => {}); }
beforeEach(async () => {
  if (root) await React.act(async () => root.unmount()); root = null;
  gets = []; posts = []; archived = 0;
  api.getInvitation = async id => { gets.push(id); return result(); };
  api.respondToInvitation = async (id, input) => { posts.push({ id, input }); return result(sent); };
});
after(async () => { if (root) await React.act(async () => root.unmount()); dom.window.close(); });

describe('native invitation panel', () => {
  test('ordinary mail does not fetch or render invitation controls', async () => {
    await render({ body: { text: 'Hello', attachments: [{ type: 'image/png', filename: 'photo.png' }] } });
    assert.equal(text(), ''); assert.deepEqual(gets, []);
  });
  test('shows organizer and owned sender, and selecting or cancelling does not send', async () => {
    await render(); assert.ok(text().includes('lead@example.test')); assert.ok(text().includes('me@example.test'));
    await click(button('Accept')); assert.ok(button('Send accepted response')); assert.equal(posts.length, 0);
    await click(button('Cancel')); assert.equal(button('Send accepted response'), undefined); assert.equal(posts.length, 0);
  });
  test('sends only the confirmed selection and enables archive only after durable success', async () => {
    const pending = deferred();
    api.respondToInvitation = async (id, input) => { posts.push({ id, input }); return pending.promise; };
    await render(); await click(button('Accept')); await click(button('Send accepted response'));
    assert.equal(posts.length, 1); assert.equal(posts[0].input.response, 'ACCEPTED'); assert.equal(posts[0].input.revision, invitation.revision);
    assert.equal('to' in posts[0].input, false); assert.equal('ics' in posts[0].input, false);
    assert.equal(archived, 0); assert.equal(button('Archive invitation'), undefined); assert.ok(!text().includes('response sent.'));
    await click(button('Sending…')); assert.equal(posts.length, 1);
    await React.act(async () => pending.resolve(result(sent)));
    assert.ok(text().includes('Accepted response sent.')); assert.equal(archived, 0);
    await click(button('Archive invitation')); assert.equal(archived, 1); assert.equal(posts.length, 1);
  });
  test('shows durable sent status on reopen without sending again', async () => {
    api.getInvitation = async () => result(sent);
    await render(); assert.ok(text().includes('Accepted response sent.')); assert.equal(button('Accept').disabled, true); assert.equal(posts.length, 0);
    await click(button('Decline')); await click(button('Send declined response'));
    assert.equal(posts[0].input.expectedAttemptId, 'attempt-one');
  });
  test('supports explicit safe retry of a failed send', async () => {
    api.getInvitation = async () => result({ ...sent, status: 'failed' });
    await render(); assert.ok(text().includes('was not sent')); await click(button('Tentative')); await click(button('Send tentative response'));
    assert.equal(posts[0].input.retry, true); assert.equal(posts[0].input.expectedAttemptId, sent.attemptId);
  });
  test('never offers resend or archive when SMTP outcome is uncertain', async () => {
    api.getInvitation = async () => result({ ...sent, status: 'uncertain' });
    await render(); assert.ok(text().includes('Delivery is uncertain')); assert.equal(button('Accept').disabled, true);
    assert.equal(button('Decline').disabled, true); assert.equal(button('Archive invitation'), undefined); assert.equal(posts.length, 0);
  });
  test('a network failure is not treated as a known send failure and requires status refresh', async () => {
    api.respondToInvitation = async () => { throw new Error('Connection lost'); };
    await render(); await click(button('Accept')); await click(button('Send accepted response'));
    assert.ok(text().includes('Delivery has not been confirmed')); assert.equal(button('Accept').disabled, true);
    assert.equal(button('Archive invitation'), undefined);
    api.getInvitation = async () => result(sent);
    await click(button('Check response status')); assert.ok(text().includes('Accepted response sent.'));
    assert.equal(button('Archive invitation').disabled, false);
  });
  test('a late send completion cannot update a newly selected message or archive it', async () => {
    const pending = deferred();
    api.respondToInvitation = async () => pending.promise;
    await render(); await click(button('Accept')); await click(button('Send accepted response'));
    api.getInvitation = async () => ({ invitation: { ...invitation, organizer: 'next@example.test' }, response: null });
    await render({ message: { ...message, id: 'message-two' } });
    await React.act(async () => pending.resolve(result(sent)));
    assert.ok(text().includes('next@example.test')); assert.ok(!text().includes('response sent.')); assert.equal(archived, 0);
    assert.equal(button('Archive invitation'), undefined);
  });
  test('late metadata from a closed message cannot overwrite the next message', async () => {
    const first = deferred(); api.getInvitation = async id => id === message.id ? first.promise : result(sent);
    await render(); assert.ok(text().includes('Checking invitation'));
    await render({ message: { ...message, id: 'message-two' } });
    await React.act(async () => first.resolve(result())); await flush();
    assert.ok(text().includes('Accepted response sent.'));
  });
  test('metadata read failure is visible and can be retried without sending', async () => {
    api.getInvitation = async () => { throw new Error('Forwarded invitations cannot be answered here.'); };
    await render(); assert.ok(text().includes('Forwarded invitations')); assert.equal(button('Accept'), undefined);
    api.getInvitation = async () => result(); await click(button('Check response status')); assert.ok(button('Accept')); assert.equal(posts.length, 0);
  });
  test('a failed archive preserves the sent response and reports its separate failure', async () => {
    api.getInvitation = async () => result(sent);
    await render({ onArchive: async () => { throw new Error('Archive failed'); } });
    await click(button('Archive invitation')); assert.ok(text().includes('Accepted response sent.')); assert.ok(text().includes('Archive failed')); assert.equal(posts.length, 0);
  });
  test('recurrence scope is explicit for this and future instances', async () => {
    api.getInvitation = async () => ({ invitation: { ...invitation, recurringInstance: true, recurrenceRange: 'THISANDFUTURE' }, response: null });
    await render(); assert.ok(text().includes('this and future recurring event instances'));
  });
});
