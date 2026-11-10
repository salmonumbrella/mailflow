import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchQueryToFields, searchFieldsToQuery, searchQueryToRule, rememberSearch, emptySearchFields } from './gmailSearch.js';

test('advanced builder preserves repeated, negated and unfamiliar operators', () => {
  const query = 'from:"Alice Smith" from:bob -from:spam subject:"Quarterly report" has:attachment is:starred filename:pdf invoice -draft';
  const fields = searchQueryToFields(query);
  assert.equal(fields.from, 'Alice Smith');
  assert.equal(fields.subject, 'Quarterly report');
  assert.equal(fields.without, 'draft');
  const rebuilt = searchFieldsToQuery(fields);
  for (const token of ['from:"Alice Smith"', 'from:bob', '-from:spam', 'is:starred', 'filename:pdf', '-draft']) assert.ok(rebuilt.includes(token), token);
});
test('grouped queries remain intact rather than having their boolean order changed', () => {
  const query = '(from:alice OR from:bob) subject:invoice';
  assert.equal(searchFieldsToQuery(searchQueryToFields(query)), query);
});
test('date window emits real native date operators and preserves exact bounds on reopening', () => {
  const fields = searchQueryToFields('subject:invoice');
  fields.date = '2026-11-10'; fields.dateWithin = '1';
  const query = searchFieldsToQuery(fields);
  assert.equal(query, 'subject:invoice after:2026-11-09 before:2026-11-12');
  assert.equal(searchFieldsToQuery(searchQueryToFields(query)), query);
});
test('native rule conversion has no ignored criteria or different recipient semantics', () => {
  assert.deepEqual(searchQueryToRule('from:alice -subject:spam has:attachment is:unread'), [
    { field: 'from', operator: 'contains', value: 'alice' },
    { field: 'subject', operator: 'not_contains', value: 'spam' },
    { field: 'has_attachment', operator: 'contains', value: '' },
    { field: 'read_status', operator: 'equals', value: 'unread' },
  ]);
  for (const query of ['invoice', 'to:alice', 'from:alice after:2026-01-01', 'from:alice OR from:bob', 'from:alice_%', '']) assert.throws(() => searchQueryToRule(query), /condition|rule|From/i);
});
test('history is deduplicated, bounded, and does not store empty queries', () => {
  assert.deepEqual(rememberSearch(['alice', 'bob'], ' bob '), ['bob', 'alice']);
  assert.equal(rememberSearch(Array.from({ length: 10 }, (_, i) => `${i}`), 'new').length, 10);
  assert.deepEqual(rememberSearch(['alice'], '  '), ['alice']);
});

test('refinements filter the complete Boolean result without rewriting grouped leaves', async () => {
  const { refineSearchQuery, hasSearchRefinement } = await import('./gmailSearch.js');
  assert.equal(refineSearchQuery('from:alice OR from:bob', 'has', 'attachment'), '(from:alice OR from:bob) has:attachment');
  assert.equal(refineSearchQuery('(from:alice OR from:bob) has:attachment', 'has', ''), '(from:alice OR from:bob)');
  assert.equal(refineSearchQuery('(from:alice after:2025-01-01) OR from:bob', 'after', '2026-01-01'), '((from:alice after:2025-01-01) OR from:bob) after:2026-01-01');
  assert.equal(hasSearchRefinement('from:alice OR has:attachment', 'has', 'attachment'), false);
  assert.equal(hasSearchRefinement('(from:alice OR from:bob) has:attachment', 'has', 'attachment'), true);
  const original = 'from:alice AND subject:invoice';
  assert.equal(searchFieldsToQuery(searchQueryToFields(original)), original);
});

test('size fields use decimal form units while reopening binary suffixes as exact bytes', () => {
  for (const token of ['larger:2M', 'larger:2MB']) {
    const fields = searchQueryToFields(token);
    assert.equal(fields.sizeValue, '2097152');
    assert.equal(fields.sizeUnit, 'B');
    assert.equal(searchFieldsToQuery(fields), 'larger:2097152');
  }
  const fields = { ...searchQueryToFields('from:alice'), sizeComparison: 'smaller', sizeValue: '1.25', sizeUnit: 'MB' };
  assert.equal(searchFieldsToQuery(fields), 'from:alice smaller:1250000');
  assert.equal(searchFieldsToQuery({ ...fields, sizeValue: '' }), 'from:alice');
});

test('size edits preserve repeated bounds, negation, grouping, and invalid typed tokens', () => {
  const fields = searchQueryToFields('larger:2M smaller:3M -size:1K subject:invoice');
  assert.equal(fields.extra, 'smaller:3M -size:1K');
  assert.equal(searchFieldsToQuery(fields), 'subject:invoice larger:2097152 smaller:3M -size:1K');
  for (const original of ['-(larger:2M OR subject:invoice)', '{larger:2M smaller:1M}', 'larger:garbage']) {
    assert.equal(searchFieldsToQuery(searchQueryToFields(original)), original);
  }
  for (const token of ['size:2M', 'larger:100', '-smaller:20', 'from:alice smaller:100']) assert.throws(() => searchQueryToRule(token), /cannot yet save/);
});

test('invalid size form values never disappear or round silently', () => {
  for (const sizeValue of ['-1', '1e6', 'NaN', 'Infinity', '9007199254740992', '1.0000001', ' ']) {
    assert.throws(() => searchFieldsToQuery({ ...searchQueryToFields(''), sizeValue, sizeUnit: 'MB' }), /size|bytes/i);
  }
  assert.throws(() => searchFieldsToQuery({ ...searchQueryToFields(''), sizeValue: '1', sizeComparison: 'equals' }), /comparison/i);
  assert.throws(() => searchFieldsToQuery({ ...searchQueryToFields(''), sizeValue: '1', sizeUnit: 'PB' }), /unit/i);
});

test('adding a size restriction constrains every branch of a preserved Boolean query', () => {
  const fields = { ...searchQueryToFields('from:alice OR from:bob'), sizeValue: '2', sizeUnit: 'MB' };
  assert.equal(searchFieldsToQuery(fields), 'larger:2000000 (from:alice OR from:bob)');
});

test('label criteria round-trip intact and unsupported native conditions never broaden saved filters', () => {
  for (const query of ['label:00000000-0000-4000-8000-000000000001', 'label:"Parent/Child"', '-label:"Child"', 'from:alice OR label:one', 'from:alice label:one']) {
    assert.equal(searchFieldsToQuery(searchQueryToFields(query)), query);
    assert.throws(() => searchQueryToRule(query));
  }
  assert.equal(searchFieldsToQuery({ ...emptySearchFields(), label: '00000000-0000-4000-8000-000000000001' }), 'label:00000000-0000-4000-8000-000000000001');
});
