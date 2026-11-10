import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gmailAttachmentMetadata } from './gmailAttachmentMetadata.js';

const source = { messageId: '11111111-1111-4111-8111-111111111111', accountId: '22222222-2222-4222-8222-222222222222',
  storageGeneration: '33333333-3333-4333-8333-333333333333', entityId: '44444444-4444-4444-8444-444444444444',
  folder: 'INBOX', uidValidity: '9', uid: '3' };
const file = { part: '2', filename: 'Actual report.pdf', type: 'application/pdf', size: 2048 };
const row = (items = [file], metadata = {}) => ({
  id: source.messageId, account_id: source.accountId, storage_generation: source.storageGeneration,
  entity_id: source.entityId, folder: source.folder, uid_validity: source.uidValidity, uid: 3,
  has_attachments: true, message_id: '<same-rfc-id@example.test>',
  attachmentMetadata: { state: 'partial', scope: 'message', source, items, omittedCount: 0,
    providerComplete: false, inlineClassification: 'partial', sizeIsExact: false, ...metadata },
});

test('reads only bounded cached attachment metadata, not flags or body-reader attachments', () => {
  const original = row();
  const snapshot = structuredClone(original);
  assert.deepEqual(gmailAttachmentMetadata(original), { source, items: [file], hasMore: false });
  assert.deepEqual(original, snapshot, 'normalization does not mutate cached rows');
  for (const input of [null, {}, { has_attachments: true }, { ...row(), attachmentMetadata: undefined, attachments: [file] }]) {
    assert.equal(gmailAttachmentMetadata(input), null);
  }
});

test('rejects unavailable, unknown, malformed or differently scoped envelopes', () => {
  for (const metadata of [null, [], { state: undefined }, { state: 'unknown' }, { state: 'unavailable' }, { scope: 'thread' },
    { providerComplete: true }, { inlineClassification: 'complete' }, { items: {} }, { source: null }]) {
    const input = metadata === null || Array.isArray(metadata) ? { ...row(), attachmentMetadata: metadata } : row([file], metadata);
    assert.equal(gmailAttachmentMetadata(input), null, JSON.stringify(metadata));
  }
});

test('binds chips to the physical row, never RFC Message-ID, thread or sibling aliases', () => {
  for (const [field, value] of Object.entries({ id: 'other-row', account_id: 'other-account', folder: 'Archive',
    uid: 4, uid_validity: '10', storage_generation: 'other-generation', entity_id: 'other-entity' })) {
    assert.equal(gmailAttachmentMetadata({ ...row(), [field]: value }), null, field);
  }
  for (const field of Object.keys(source)) {
    assert.equal(gmailAttachmentMetadata(row([file], { source: { ...source, [field]: null } })), null, field);
  }
  const logicalAliases = { ...row(), storageGeneration: 'current-account-generation',
    entityId: 'canonical-label-entity', uidValidity: 'label-alias' };
  assert.deepEqual(gmailAttachmentMetadata(logicalAliases).items, [file],
    'native-label aliases are not the physical message identity');
});

test('requires bounded canonical protocol identity and treats missing row identity as unavailable', () => {
  for (const uid of [0, -1, 1.5, 4294967296, '3junk', {}, null]) {
    assert.equal(gmailAttachmentMetadata({ ...row(), uid }), null);
  }
  for (const field of ['id', 'account_id', 'entity_id', 'storage_generation', 'uid_validity', 'folder']) {
    const input = row(); delete input[field];
    assert.equal(gmailAttachmentMetadata(input), null, field);
  }
  assert.equal(gmailAttachmentMetadata(row([file], { source: { ...source, uid: 3 } })), null);
});

test('filters known inline and calendar entries without claiming full inline classification', () => {
  const hidden = [
    { shownInline: true }, { shownInline: 'true' }, { inline: true }, { disposition: ' INLINE; filename=x' },
    { type: 'Text/Calendar; charset=UTF-8' }, { type: 'application/ics' }, { type: 'application/x-vcalendar' },
    { filename: 'Invite.ICS  ' }, { filename: 'meeting.vcs' }, { filename: 'calendar.icalendar.' },
  ].map((fields, index) => ({ ...file, part: String(index + 3), ...fields }));
  const result = gmailAttachmentMetadata(row([file, ...hidden]));
  assert.deepEqual(result.items, [file]);
  assert.equal(result.hasMore, true, 'hidden or invalid cache entries are not an extra-file count');
  assert.equal(gmailAttachmentMetadata(row(hidden)), null, 'no empty chip strip');
});

test('keeps equal filenames on distinct parts and drops every ambiguous duplicate part', () => {
  const result = gmailAttachmentMetadata(row([
    file, { ...file, part: '3' }, { ...file, part: '4' }, { ...file, part: '4', filename: 'renamed.exe' },
  ]));
  assert.deepEqual(result.items.map(item => item.part), ['2', '3']);
  assert.equal(result.hasMore, true);
});

test('rejects malformed and excessive fields, strips control/bidi text and never invents a filename', () => {
  const bad = [null, {}, [], 'x', { ...file, filename: '' }, { ...file, filename: {} },
    { ...file, filename: 'x'.repeat(513) }, { ...file, filename: '\u0000\u202E' },
    { ...file, part: '../../2' }, { ...file, part: '1.HEADER' }, { ...file, part: '01' },
    { ...file, part: '2'.repeat(129) },
  ];
  assert.equal(gmailAttachmentMetadata(row(bad)), null);
  const result = gmailAttachmentMetadata(row([{ ...file, filename: '  invoice\u202E\u0000.pdf  ',
    type: 'APPLICATION/PDF; charset=utf8', content: 'SECRET', url: 'https://remote.test/a', source: {} }]));
  assert.deepEqual(result.items, [{ ...file, filename: 'invoice.pdf' }]);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  for (const type of [{}, 'x'.repeat(129), 'malformed']) {
    assert.equal(gmailAttachmentMetadata(row([{ ...file, type }])).items[0].type, null);
  }
});

test('does not present advisory or invalid sizes as exact downloaded byte counts', () => {
  for (const size of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '2048', {}, null]) {
    assert.equal(gmailAttachmentMetadata(row([{ ...file, size }])).items[0].size, null);
  }
});

test('bounds processing and visible files without turning omitted cache entries into a file count', () => {
  const items = Array.from({ length: 1000 }, (_, i) => ({ ...file, part: String(i + 1) }));
  const result = gmailAttachmentMetadata(row(items));
  assert.equal(result.items.length, 3);
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.items.map(item => item.part), ['1', '2', '3']);
  for (const omittedCount of [1, 1000, null, -1, '3']) {
    assert.equal(gmailAttachmentMetadata(row([file], { omittedCount })).hasMore, true);
  }
  assert.equal(gmailAttachmentMetadata(row([file], { omittedCount: 0 })).hasMore, false);
  assert.equal(gmailAttachmentMetadata(row([{ ...file, filename: '<img src=x onerror=alert(1)>.pdf' }])).items[0].filename,
    '<img src=x onerror=alert(1)>.pdf', 'escape as text at rendering, not HTML');
});


test('action metadata rejects unencoded or extra-key proofs and freezes the exact source', () => {
  const input = row();
  const result = gmailAttachmentMetadata(input);
  assert.ok(Object.isFrozen(result.source));
  assert.notEqual(result.source, source);
  assert.deepEqual(result.source, source);
  for (const proof of [
    { ...source, extra: 'not part of the proof' },
    { ...source, folder: 'INBOX\u0000' },
    { ...source, folder: '\ud800' },
    { ...source, uid: '03' }, { ...source, uidValidity: '09' },
  ]) {
    const input = row([file], { source: proof });
    input.folder = proof.folder;
    input.uid = proof.uid;
    input.uid_validity = proof.uidValidity;
    assert.equal(gmailAttachmentMetadata(input), null);
  }
});
