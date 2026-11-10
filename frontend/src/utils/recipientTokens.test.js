import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitRecipientTokens, mergeRecipientTokens } from './recipientTokens.js';

test('recipient delimiters preserve quoted display names', () => {
  assert.deepEqual(splitRecipientTokens('"Doe, Jane" <jane@example.com>; Pat <pat@example.com>\nthird@example.com,'), ['"Doe, Jane" <jane@example.com>', 'Pat <pat@example.com>', 'third@example.com']);
});

test('recipient merge deduplicates addresses without replacing display names', () => {
  assert.deepEqual(mergeRecipientTokens(['Jane <Jane@example.com>'], ['jane@example.com', 'Pat <pat@example.com>', 'PAT@example.com']), ['Jane <Jane@example.com>', 'Pat <pat@example.com>']);
});

test('empty recipient tokens are ignored', () => {
  assert.deepEqual(splitRecipientTokens(' ; , \n'), []);
});
