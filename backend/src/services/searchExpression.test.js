import { describe, expect, it } from 'vitest';
import { parseSearchExpression, SearchQueryError } from './searchExpression.js';
import { buildSearchConditions } from './searchConditions.js';

describe('bounded Boolean search', () => {
  it('retains AND precedence within OR and explicit groups', () => {
    const tree = parseSearchExpression('from:alice OR (from:bob subject:invoice)');
    expect(tree.type).toBe('or');
    expect(tree.children[1].type).toBe('and');
    expect(tree.children[1].children.map(n => n.key)).toEqual(['from', 'subject']);
  });
  it('supports field-scoped groups without losing the sender or subject restriction', () => {
    const result = buildSearchConditions('from:(alice OR bob) -subject:{invoice receipt}');
    expect(result.params).toEqual(['%alice%', '%bob%', '%invoice%', '%receipt%']);
    expect(result.conditions[0]).toContain('(m.from_email ILIKE $2 OR m.from_name ILIKE $2) OR (m.from_email ILIKE $3 OR m.from_name ILIKE $3)');
    expect(result.conditions[0]).toContain('NOT COALESCE(((m.subject ILIKE $4 OR m.subject ILIKE $5)), false)');
  });
  it('supports braces, explicit AND, group negation and quoted operator-like phrases', () => {
    const tree = parseSearchExpression('{from:alice from:bob} AND -(is:read OR "from:carol invoice")');
    expect(tree.type).toBe('and');
    expect(tree.children[0].type).toBe('or');
    expect(tree.children[1].type).toBe('not');
    expect(tree.children[1].child.children[1]).toEqual({ type: 'term', value: 'from:carol invoice', phrase: true });
  });
  it.each(['from:alice OR', 'OR bob', '()', '{alice)', '(alice', 'alice)', '"alice', 'alice AND OR bob'])('rejects malformed expressions without dropping restrictions: %s', query => {
    expect(() => parseSearchExpression(query)).toThrow(SearchQueryError);
  });
  it('rejects excessive complexity rather than truncating terms', () => {
    expect(() => parseSearchExpression('ab '.repeat(51))).toThrow(/50 search terms/);
    expect(() => parseSearchExpression('('.repeat(17) + 'ab' + ')'.repeat(17))).toThrow(/deeply/);
  });
  it('parameterizes SQL and escapes wildcard characters in all text operators', () => {
    const { conditions, params } = buildSearchConditions('subject:"100%_done" OR from:"x\' OR true --"');
    expect(conditions.join(' ')).not.toContain("x' OR");
    expect(params).toEqual(['%100\\%\\_done%', "%x' or true --%"]);
    expect(conditions[0]).toContain(' OR ');
  });
  it('keeps negated null fields intuitive and compiles all terms, not only the first ten', () => {
    const result = buildSearchConditions('-subject:invoice ' + 'word '.repeat(12));
    expect(result.conditions[0]).toContain('NOT COALESCE');
    expect(result.params).toHaveLength(25);
  });
  it('keeps folder branches within Boolean expressions and respects default scope', () => {
    expect(buildSearchConditions('from:alice', { folder: 'INBOX' })).toMatchObject({ excludeTrash: false, params: ['%alice%', 'INBOX'] });
    const result = buildSearchConditions('(in:trash from:alice) OR (in:inbox from:bob)', { folder: 'Archive' });
    expect(result.excludeTrash).toBe(false);
    expect(result.params).not.toContain('Archive');
    expect(result.conditions).toHaveLength(1);
    expect(result.conditions[0]).toContain(' OR ');
    expect(buildSearchConditions('-in:trash from:alice').excludeTrash).toBe(true);
    expect(buildSearchConditions('in:all from:alice').excludeTrash).toBe(true);
    expect(buildSearchConditions('in:anywhere from:alice').excludeTrash).toBe(false);
  });
  it('resolves standard folder aliases through account-scoped flags/mappings, not guessed names', () => {
    const result = buildSearchConditions('in:sent from:alice');
    expect(result.conditions[0]).toContain('search_folder.account_id = m.account_id');
    expect(result.conditions[0]).toContain('search_folder.path = m.folder');
    expect(result.conditions[0]).toContain('a.folder_mappings->>');
    expect(result.params).toEqual(['sent', '%/sent', '\\Sent', 'sent', '%alice%']);
    const explicit = buildSearchConditions('in:"[Gmail]/Sent Mail"');
    expect(explicit.conditions[0]).not.toContain('special_use');
    expect(explicit.params).toEqual(['[gmail]/sent mail', '%/[gmail]/sent mail']);
  });
  it('uses actual indexed filenames and native categories', () => {
    const result = buildSearchConditions('filename:report.pdf category:newsletter');
    expect(result.conditions[0]).toContain("attachment->>'filename'");
    expect(result.conditions[0]).toContain("COALESCE(m.category, 'primary')");
    expect(result.params).toEqual(['%report.pdf%', 'newsletter']);
  });
  it('uses UTC relative dates with calendar month boundaries', () => {
    const now = Date.parse('2026-03-31T12:00:00Z');
    expect(buildSearchConditions('newer_than:1m older_than:7d', { now }).params).toEqual(['2026-02-28T12:00:00.000Z', '2026-03-24T12:00:00.000Z']);
  });
  it.each(['is:important', 'label:work', 'category:forums', 'has:drive', 'after:2026-02-31', 'older_than:forever'])('fails loudly for unavailable or invalid metadata: %s', q => {
    expect(() => buildSearchConditions(q)).toThrow(SearchQueryError);
  });
});
