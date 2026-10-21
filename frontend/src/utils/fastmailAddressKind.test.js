import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFastmailAddress } from './fastmailAddressKind.js';

const account = {
  id: 'account-a', enabled: true, email_address: 'primary@synthetic.test',
  fastmail_config_revision: 'revision-a', aliases: [{ email: 'alias@synthetic.test' }],
};
const inventory = {
  accountId: account.id, configRevision: 'revision-a', provider: 'fastmail',
  identityStatus: 'ready', maskedStatus: 'ready',
  identities: [{ email: 'identity@synthetic.test' }],
  maskedEmails: [{ email: 'mask@synthetic.test', state: 'enabled' }],
};
const classify = (email, changes = {}) => classifyFastmailAddress({ account, inventory, email, ...changes });

test('primary, configured alias, provider identity, explicit mask and unknown stay distinct', () => {
  for (const [email, kind] of Object.entries({ primary: 'primary', alias: 'alias', identity: 'alias', mask: 'masked', external: 'unknown' })) {
    assert.equal(classify(`${email}@synthetic.test`), kind);
  }
  assert.equal(classify('primary@synthetic.test', { inventory: { ...inventory, maskedEmails: [{ email: account.email_address }] } }), 'primary');
});

test('partial masked evidence never promotes a configured alias to ordinary', () => {
  for (const maskedStatus of ['unknown', 'unsupported', undefined]) {
    for (const email of ['alias', 'identity', 'mask']) {
      assert.equal(classify(`${email}@synthetic.test`, { inventory: { ...inventory, maskedStatus } }), 'unknown');
    }
  }
  assert.equal(classify('identity@synthetic.test', { inventory: { ...inventory, identityStatus: 'unknown' } }), 'unknown');
  assert.equal(classify('alias@synthetic.test', { inventory: { ...inventory, identityStatus: 'unknown' } }), 'alias');
});

test('known masks do not imply active delivery or permission', () => {
  for (const state of ['enabled', 'disabled', 'deleted', 'pending']) {
    assert.equal(classify('mask@synthetic.test', { inventory: { ...inventory, identityStatus: 'unknown', maskedEmails: [{ email: 'mask@synthetic.test', state }] } }), 'masked');
  }
});

test('missing, disabled, foreign and obsolete inventory is ineligible', () => {
  for (const changes of [
    { account: undefined }, { account: { ...account, enabled: false } },
    { account: { ...account, enabled: undefined } }, { inventory: undefined },
    { account: { ...account, id: 'account-b' } },
    { account: { ...account, fastmail_config_revision: null } },
    ...[{ accountId: 'account-b' }, { provider: 'other' }, { configRevision: 'old' }, { configRevision: null }]
      .map(patch => ({ inventory: { ...inventory, ...patch } })),
  ]) assert.equal(classify('mask@synthetic.test', changes), 'unknown');
});

test('malformed addresses and lookalikes never become owned recipients', () => {
  for (const email of [null, undefined, 1, {}, '', 'invalid', '*@synthetic.test', 'alias+tag@synthetic.test', 'a.lias@synthetic.test', 'alias@sub.synthetic.test', 'alias@synthetic.test.evil', 'Name <alias@synthetic.test>', 'alias@synthetic.test\r\nother']) {
    assert.equal(classify(email), 'unknown');
  }
  assert.equal(classify('external@synthetic.test', { inventory: { ...inventory, identities: [{ email: '*@synthetic.test' }] } }), 'unknown');
  assert.equal(classify('external@synthetic.test', { account: { ...account, aliases: [{ name: 'external@synthetic.test', email: 'alias@synthetic.test' }] } }), 'unknown');
});

test('generated exact addresses retain classification under casing and whitespace changes', () => {
  let seed = 7321;
  for (let i = 0; i < 128; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const email = `a${seed.toString(36)}.${i}+tag@d${i}.synthetic.test`;
    const variant = [...email].map((c, index) => ((seed >>> (index % 31)) & 1) ? c.toUpperCase() : c).join('');
    for (const expected of ['alias', 'masked']) {
      const own = { ...account, aliases: [{ email }] };
      const evidence = { ...inventory, maskedEmails: expected === 'masked' ? [{ email }] : [] };
      assert.equal(classify(` ${variant} `, { account: own, inventory: evidence }), expected, `${seed}: ${variant}`);
    }
  }
});

test('unrelated identities and ordering cannot change a recipient classification', () => {
  for (let i = 0; i < 32; i++) {
    const other = { email: `unrelated-${i}@synthetic.test` };
    const expanded = { ...inventory, identities: [other, ...inventory.identities].reverse(), maskedEmails: [other, ...inventory.maskedEmails].reverse() };
    for (const email of ['alias', 'mask', 'primary', 'external']) {
      assert.equal(classify(`${email}@synthetic.test`, { inventory: expanded }), classify(`${email}@synthetic.test`));
    }
  }
});

test('changing ownership always rejects another account inventory', () => {
  for (let i = 0; i < 64; i++) {
    for (const email of ['alias', 'mask', 'identity']) {
      assert.equal(classify(`${email}@synthetic.test`, { account: { ...account, id: `other-${i}` } }), 'unknown');
    }
  }
});
