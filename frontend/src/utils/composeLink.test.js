import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeComposeLink } from './composeLink.js';

test('compose links support web and email targets', () => {
  assert.equal(normalizeComposeLink('example.com/docs'), 'https://example.com/docs');
  assert.equal(normalizeComposeLink(' https://example.com '), 'https://example.com/');
  assert.equal(normalizeComposeLink('mailto:person@example.com'), 'mailto:person@example.com');
  assert.equal(normalizeComposeLink(''), '');
});

test('compose links reject malformed and executable schemes', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,x', 'file:///tmp/x', 'http://', 'mailto:']) assert.equal(normalizeComposeLink(value), null);
});
