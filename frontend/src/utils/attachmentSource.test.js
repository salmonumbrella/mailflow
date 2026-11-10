import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyAttachmentSource, encodeAttachmentSource, attachmentSourceMatchesRow, attachmentSourceKey } from './attachmentSource.js';

export const source = Object.freeze({ messageId: '11111111-1111-4111-8111-111111111111', accountId: '22222222-2222-4222-8222-222222222222', storageGeneration: '33333333-3333-4333-8333-333333333333', entityId: '44444444-4444-4444-8444-444444444444', folder: '收件箱/À vérifier', uidValidity: '4294967295', uid: '42' });
const row = { id: source.messageId, account_id: source.accountId, storage_generation: source.storageGeneration, entity_id: source.entityId, folder: source.folder, uid_validity: 4294967295, uid: 42 };

test('copies exact proof, freezes it and percent-encodes Unicode without changing the path', () => {
  const copy = copyAttachmentSource(source);
  assert.notEqual(copy, source); assert.deepEqual(copy, source); assert.ok(Object.isFrozen(copy));
  const header = encodeAttachmentSource(source);
  assert.match(header, /^[\x20-\x7e]+$/); assert.deepEqual(JSON.parse(decodeURIComponent(header)), source);
  assert.equal(attachmentSourceKey(source), attachmentSourceKey({ ...source }));
});
for (const [label, invalid] of [
  ['extra field', { ...source, extra: true }], ['numeric uid', { ...source, uid: 42 }],
  ['zero uid', { ...source, uid: '0' }], ['leading zero', { ...source, uid: '042' }],
  ['too large uid', { ...source, uid: '4294967296' }], ['negative', { ...source, uid: '-1' }],
  ['decimal', { ...source, uid: '1.0' }], ['space', { ...source, uid: '1 ' }],
  ['invalid UUID', { ...source, entityId: 'uuid' }], ['null', null], ['array', []],
  ['empty folder', { ...source, folder: '' }], ['long folder', { ...source, folder: 'a'.repeat(501) }],
  ['control folder', { ...source, folder: 'Inbox\n' }], ['delete folder', { ...source, folder: 'Inbox\x7f' }],
  ['unpaired surrogate', { ...source, folder: '\ud800' }],
  ['inherited keys', Object.create(source)], ['symbol key', { ...source, [Symbol('extra')]: 1 }],
  ['missing key', Object.fromEntries(Object.entries(source).filter(([key]) => key !== 'entityId'))],
]) test(`rejects invalid source without repair: ${label}`, () => {
  assert.equal(copyAttachmentSource(invalid), null); assert.equal(encodeAttachmentSource(invalid), null);
  assert.equal(attachmentSourceMatchesRow(invalid, row), false);
});

test('physical snake fields win over distinct native canonical aliases', () => {
  assert.equal(attachmentSourceMatchesRow(source, { ...row, entityId: '99999999-9999-4999-8999-999999999999', storageGeneration: 'alias' }), true);
  assert.equal(attachmentSourceMatchesRow(source, { ...row, entity_id: '99999999-9999-4999-8999-999999999999', entityId: source.entityId }), false);
  assert.equal(attachmentSourceMatchesRow(source, { ...row, entity_id: undefined, entityId: source.entityId }), false);
  assert.equal(attachmentSourceMatchesRow(source, { ...row, uid_validity: undefined, uidValidity: source.uidValidity }), false);
  assert.equal(attachmentSourceMatchesRow(source, { ...row, uid: '042' }), false);
});
test('rejects getters and non-enumerable proof fields rather than repairing the wire object', () => {
  const accessor = { ...source }; Object.defineProperty(accessor, 'uid', { get() { throw new Error('must not read'); }, enumerable: true });
  assert.equal(copyAttachmentSource(accessor), null);
  const hidden = { ...source }; Object.defineProperty(hidden, 'uid', { value: '42', enumerable: false });
  assert.equal(copyAttachmentSource(hidden), null);
});
