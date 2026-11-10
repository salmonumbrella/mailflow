import test from 'node:test';
import assert from 'node:assert/strict';
import { initialOpenActivityChoice, openActivityStatus, outgoingActivityCandidate } from './openActivity.js';
import { composeDataFromScheduled } from './scheduledView.js';

test('consent defaults off, resets for drafts/Undo, retains only explicitly opted-in scheduled edit', () => {
  for (const data of [null, {}, { trackOpens: true }, { trackOpens: true, draftUid: 1 }, { trackOpens: true, restored: true }, { scheduled: { id: 's' } }, { scheduled: { id: 's' }, trackOpens: 'true' }]) assert.equal(initialOpenActivityChoice(data), false);
  const scheduled = composeDataFromScheduled({ id: 's', accountId: 'a', spec: { trackOpens: true } });
  assert.equal(initialOpenActivityChoice(scheduled), true);
});
test('activity copy never equates an image load or pending delivery with a read', () => {
  assert.equal(openActivityStatus({ status: 'sent', loadCount: 0 }), 'No image loads recorded');
  assert.equal(openActivityStatus({ status: 'sent', loadCount: 1 }), '1 image load recorded');
  assert.equal(openActivityStatus({ status: 'sent', loadCount: 1000 }), '1000+ image loads recorded');
  for (const status of ['prepared', 'sending', 'failed', 'cancelled', 'uncertain']) assert.doesNotMatch(openActivityStatus({ status, loadCount: 5 }), /read|image load/);
});
test('reader lookup only considers mail in an owned account plausibly sent by its owner', () => {
  const accounts = [{ id: 'a', email_address: 'me@mail.example', aliases: [{ email: 'alias@mail.example' }], folder_mappings: { sent: 'Sent custom' } }];
  const message = { id: 'm', account_id: 'a', from_address: 'you@mail.example', folder: 'INBOX' };
  assert.equal(outgoingActivityCandidate(message, accounts), false);
  assert.equal(outgoingActivityCandidate({ ...message, from_address: 'alias@mail.example' }, accounts), true);
  assert.equal(outgoingActivityCandidate({ ...message, folder: 'Sent custom' }, accounts), true);
  assert.equal(outgoingActivityCandidate({ ...message, account_id: 'other', folder: 'Sent' }, accounts), false);
});
