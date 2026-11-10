import { test } from 'node:test';
import assert from 'node:assert/strict';
import { introRecipients, isInstantIntroShortcut, replyArchiveContext, captureReplyArchive, finishReplyArchive } from './composeActions.js';

test('intro merges existing Bcc and current To without case-insensitive duplicates, preserving display names', () => {
  assert.deepEqual(introRecipients(['Ann <A@example.test>', 'b@example.test', 'B@example.test'], ['a@example.test', 'C@example.test']), ['a@example.test', 'C@example.test', 'b@example.test']);
});
test('intro keyboard is Superhuman opt-in, composition-safe, exact, and yields to custom bindings', () => {
  const event = { key: 'I', ctrlKey: true, shiftKey: true };
  assert.equal(isInstantIntroShortcut(event, 'superhuman', {}), true);
  assert.equal(isInstantIntroShortcut({ ...event, ctrlKey: false, metaKey: true }, 'superhuman'), true);
  for (const patch of [{ repeat: true }, { isComposing: true }, { nativeEvent: { isComposing: true } }, { keyCode: 229 }, { altKey: true }, { metaKey: true }, { defaultPrevented: true }]) assert.equal(isInstantIntroShortcut({ ...event, ...patch }, 'superhuman'), false);
  assert.equal(isInstantIntroShortcut(event, 'classic'), false);
  assert.equal(isInstantIntroShortcut(event, 'superhuman', { compose: 'ctrl+shift+i' }), false);
});
const context = { accountId: 'account-original', threadId: 'thread-original', inReplyTo: '<original@example.test>' };
const original = { id: 'm1', account_id: context.accountId, thread_id: context.threadId, message_id: context.inReplyTo, folder: 'INBOX' };
test('only identifiable original replies offer archive; restored sender changes preserve the original account', () => {
  assert.deepEqual(replyArchiveContext({ ...context, isReply: true }), context);
  assert.equal(replyArchiveContext({ ...context }), null);
  assert.equal(replyArchiveContext({ ...context, isReply: true, isForward: true }), null);
  assert.equal(replyArchiveContext({ ...context, isReply: true, inReplyTo: null }), null);
  assert.deepEqual(replyArchiveContext({ ...context, accountId: 'changed-sender', isReply: true, replyArchiveContext: context }), context);
});
test('capture pins only original inbox members, excludes other accounts/folders, and verifies reply parent', async () => {
  const messages = [original, { ...original, id: 'm2', message_id: '<second>', folder: 'INBOX' }, { ...original, id: 'other-account', account_id: 'other' }, { ...original, id: 'sent', folder: 'Sent' }];
  assert.deepEqual(await captureReplyArchive(context, async id => { assert.equal(id, context.threadId); return { messages }; }), ['m1', 'm2']);
  await assert.rejects(captureReplyArchive(context, async () => ({ messages: [{ ...original, message_id: '<unrelated>' }] })));
});
test('archive waits for durable held-send confirmation and never mutates on uncertain/partial/no-copy results', async () => {
  const archived = [];
  const deps = { stillOwner: () => true, archive: async (...args) => { archived.push(args); return { archived: ['m1'] }; } };
  const request = { context, ids: ['m1'], pendingId: 'held-id' };
  assert.equal((await finishReplyArchive({ ...request, result: { ok: true } }, deps)).status, 'archived');
  assert.deepEqual(archived, [[['m1'], { ...context, pendingId: 'held-id' }]]);
  for (const change of [{ pendingId: null }, { result: { ok: true, rejected: ['missing'] } }, { result: { ok: true, sentCopySaved: false } }, { result: { pending: true } }, { result: null }]) {
    assert.equal((await finishReplyArchive({ ...request, result: { ok: true }, ...change }, deps)).status, 'unavailable');
  }
  await finishReplyArchive({ ...request, result: { ok: true } }, { ...deps, stillOwner: () => false });
  assert.equal(archived.length, 1);
});
test('archive partial and uncertain failures do not retry or claim success', async () => {
  const request = { context, ids: ['m1', 'm2'], pendingId: 'held-id', result: { ok: true } };
  assert.equal((await finishReplyArchive(request, { stillOwner: () => true, archive: async () => ({ archived: ['m1'] }) })).status, 'incomplete');
  let calls = 0;
  assert.equal((await finishReplyArchive(request, { stillOwner: () => true, archive: async () => { calls++; throw new Error('offline'); } })).status, 'unconfirmed');
  assert.equal(calls, 1);
});
