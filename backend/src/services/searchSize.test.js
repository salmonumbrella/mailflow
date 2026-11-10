import { describe, expect, it } from 'vitest';
import { buildSearchConditions } from './searchConditions.js';
import { SearchQueryError } from './searchExpression.js';

describe('indexed RFC822 size search', () => {
  it.each([
    ['larger:0', '>', '0'], ['smaller:1', '<', '1'], ['size:1000', '>', '1000'],
    ['larger:2M', '>', '2097152'], ['size:2MB', '>', '2097152'],
    ['smaller:1.5KB', '<', '1536'], ['larger:0.25G', '>', '268435456'],
    ['size:9007199254740991B', '>', '9007199254740991'],
  ])('compiles exact strict byte thresholds: %s', (raw, op, bytes) => {
    const result = buildSearchConditions(raw);
    expect(result.conditions).toEqual([`m.rfc822_size_bytes ${op} $2::bigint`]);
    expect(result.params).toEqual([bytes]);
    expect(result.requiresSize).toBe(true);
  });
  it.each(['size:', 'size:-1', 'size:NaN', 'larger:1e6', 'smaller:Infinity', 'size:2MiB', 'size:0.1B', 'size:0.0001K', 'size:9007199254740992', 'size:9007199254740991.1', 'size:999999999G', 'size:1..2M'])('rejects invalid or unsupported precision without widening: %s', raw => {
    expect(() => buildSearchConditions(raw)).toThrow(SearchQueryError);
  });
  it('preserves NULL through every size-dependent negation', () => {
    const result = buildSearchConditions('-(larger:2M OR subject:invoice)');
    expect(result.conditions[0]).toContain('NOT (');
    expect(result.conditions[0]).not.toContain('NOT COALESCE');
    expect(result.conditions[0]).toContain('COALESCE((m.subject ILIKE $3), false)');
  });
  it('retains ordinary null-field negation and records metadata dependencies', () => {
    expect(buildSearchConditions('-subject:invoice').conditions[0]).toContain('NOT COALESCE');
    expect(buildSearchConditions('subject:invoice').requiresSize).toBe(false);
    expect(buildSearchConditions('subject:invoice OR -(larger:2M smaller:3M)').requiresSize).toBe(true);
  });
});
