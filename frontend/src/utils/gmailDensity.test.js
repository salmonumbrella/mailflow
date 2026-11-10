import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GMAIL_DENSITIES, isGmailDensity, normalizeGmailDensity } from './gmailDensity.js';

test('density is a bounded independent enum with a safe stored-value default', () => {
  assert.deepEqual(GMAIL_DENSITIES, ['default', 'comfortable', 'compact']);
  assert.equal(Object.isFrozen(GMAIL_DENSITIES), true);
  for (const value of GMAIL_DENSITIES) {
    assert.equal(isGmailDensity(value), true);
    assert.equal(normalizeGmailDensity(value), value);
  }
  for (const value of [null, undefined, '', 'wide', 'gmail', 'COMPACT', {}, ['compact'], 0]) {
    assert.equal(isGmailDensity(value), false);
    assert.equal(normalizeGmailDensity(value), 'default');
  }
});
