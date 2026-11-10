import { describe, it, expect } from 'vitest';
import { parseSearchQuery } from './searchQuery.js';
describe('advanced search quoted free-text phrases', () => {
  it('keeps quoted inclusion and exclusion as single literal phrases', () => {
    expect(parseSearchQuery('"annual report" -"draft copy" from:alice')).toEqual({
      filters: [{ key: 'from', value: 'alice', negate: false }],
      terms: [{ value: 'annual report', negate: false, phrase: true }, { value: 'draft copy', negate: true, phrase: true }],
    });
  });
  it('does not steal operators from quoted text', () => {
    expect(parseSearchQuery('"from:alice invoice"')).toEqual({ filters: [], terms: [{ value: 'from:alice invoice', negate: false, phrase: true }] });
  });
  it('preserves repeated operators and unquoted terms', () => {
    expect(parseSearchQuery('from:"John Smith" -from:bob invoice -draft')).toEqual({
      filters: [{ key: 'from', value: 'john smith', negate: false }, { key: 'from', value: 'bob', negate: true }],
      terms: [{ value: 'invoice', negate: false }, { value: 'draft', negate: true }],
    });
  });
});
