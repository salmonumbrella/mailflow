import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftSourceFromRow, draftSourceForPointer, draftPointerFromCompose, draftPointerFromReceipt, draftPointerData } from './draftSource.js';
import { savedDraftToComposeData } from './openSavedDraft.js';
import { api } from './api.js';

const row = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', account_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  storage_generation: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', entity_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  folder: 'Drafts', uid: 5, uid_validity: '42', message_id: '<not-physical-row@example.test>' };
const expected = { messageId: row.id, accountId: row.account_id, storageGeneration: row.storage_generation,
  entityId: row.entity_id, folder: row.folder, uidValidity: '42', uid: '5' };

test('saved draft conversion freezes the complete opened row without trusting RFC Message-ID', () => {
  const opening = { ...row };
  const data = savedDraftToComposeData(opening, { text: 'Saved text' });
  assert.deepEqual(data.draftSource, expected);
  assert.equal(Object.isFrozen(data.draftSource), true);
  opening.id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'; opening.uid_validity = '43';
  assert.deepEqual(data.draftSource, expected);
  assert.notDeepEqual(savedDraftToComposeData(opening, { text: 'New draft' }).persistedKey, data.persistedKey);
  assert.deepEqual(draftPointerFromCompose(data).source, expected);
});

test('legacy or malformed opened rows never acquire source proof', () => {
  for (const change of [{ id: '<rfc@example.test>' }, { uid_validity: null }, { storage_generation: undefined }, { entity_id: '' }, { uid: '05' }]) {
    assert.equal(draftSourceFromRow({ ...row, ...change }), null);
    assert.equal(savedDraftToComposeData({ ...row, ...change }, { text: 'Keep editable text' }).draftSource, null);
  }
});

test('receipt source must agree with its immutable locator, without fallback to RFC IDs or old epoch', () => {
  const result = { uid: 5, folder: 'Drafts', draftSource: expected, messageId: row.message_id };
  assert.deepEqual(draftPointerFromReceipt(result, row.account_id).source, expected);
  for (const change of [{ uid: 6 }, { folder: 'Other' }, { draftSource: null }, { draftSource: { ...expected, messageId: row.message_id } }])
    assert.equal(draftPointerFromReceipt({ ...result, ...change }, row.account_id), null);
  assert.equal(draftPointerFromReceipt(result, row.id), null);
  assert.equal(draftSourceForPointer({ accountId: row.account_id, uid: '05', folder: row.folder, source: expected }), null);
  assert.deepEqual(draftPointerData(null), { draftAccountId: null, draftFolder: null, draftUid: null,
    draftMessageId: null, draftSource: null, draftUidValidity: null, persistedKey: null });
});

test('DELETE sends only validated exact proof in its header and never falls back without it', async () => {
  const original = globalThis.fetch; const requests = [];
  globalThis.fetch = async (...args) => { requests.push(args); return { ok: true, json: async () => ({ ok: true, cleanup: { status: 'deleted' } }) }; };
  try {
    await api.deleteDraft(row.account_id, row.uid, row.folder, expected);
    assert.equal(requests.length, 1);
    assert.deepEqual(JSON.parse(decodeURIComponent(requests[0][1].headers['X-Mailflow-Message-Source'])), expected);
    for (const proof of [undefined, null, {}, { ...expected, uid: '6' }, { ...expected, accountId: row.id }])
      await assert.rejects(api.deleteDraft(row.account_id, row.uid, row.folder, proof));
    assert.equal(requests.length, 1);
  } finally { globalThis.fetch = original; }
});
