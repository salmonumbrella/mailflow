import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inboxReadMembers } from './readCountScope.js';
const row = (id, folder = 'INBOX', account_id = 'a') => ({ id, account_id, folder, is_read: false });

test('physical INBOX membership excludes archive, Google labels and unknown folders', () => {
  const inbox = row('inbox');
  const other = ['All Mail', '[Gmail]/All Mail', 'Label', 'Archive', '', undefined, null, 'inbox']
    .map((folder, i) => ({ ...row(`outside-${i}`), folder, message_id: '<same@synthetic.test>', imap_host: 'imap.gmail.com' }));
  assert.deepEqual(inboxReadMembers([inbox, ...other]), [inbox]);
});
test('physical identity is deduplicated within an account, never across accounts', () => {
  const a = row('same'), duplicate = { ...a }, b = row('same', 'INBOX', 'b');
  assert.deepEqual(inboxReadMembers([a, duplicate, b]), [a, b]);
});
test('deleted or identity-less rows do not create a count member', () => {
  assert.deepEqual(inboxReadMembers([null, { ...row('gone'), is_deleted: true }, row(''), { ...row('x'), account_id: '' }]), []);
});
test('count selection preserves first physical rows and input order without mutating provider targets', () => {
  const a = Object.freeze(row('a')), archive = Object.freeze(row('outside', 'Archive')), b = Object.freeze(row('b'));
  const input = Object.freeze([archive, a, b, a]);
  const selected = inboxReadMembers(input);
  assert.deepEqual(selected, [a, b]);
  assert.equal(selected[0], a); assert.equal(selected[1], b);
  assert.deepEqual(input, [archive, a, b, a]);
});
test('adding non-INBOX copies cannot widen the physical count subset', () => {
  const fixed = [row('a'), row('b')];
  for (const folder of ['All Mail', 'Label', 'Archive', undefined]) {
    for (const account of ['a', 'b']) {
      const noise = Array.from({ length: 20 }, (_, i) => ({ ...row(`copy-${i}`, folder, account), folder }));
      assert.deepEqual(inboxReadMembers([...noise, ...fixed, ...noise]), fixed);
    }
  }
});
