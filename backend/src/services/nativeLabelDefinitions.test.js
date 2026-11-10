import { describe, expect, it, vi } from 'vitest';
vi.mock('./db.js', () => ({ withTransaction: vi.fn(), query: vi.fn() }));
import { normalizeName, validateDefinition, derivePaths, validateRequest } from './nativeLabelDefinitions.js';

describe('native label validation', () => {
  it('normalizes Unicode and trims consistently without treating a path as a component', () => {
    expect(normalizeName('  Cafe\u0301  ')).toEqual({ name: 'Café', normalizedName: 'café' });
    expect(normalizeName('😀'.repeat(100)).name).toHaveLength(200);
  });
  it.each(['', '   ', 'a/b', 'a\nb', '\u0000hi', 'x\u202ey', 'x'.repeat(101), '\ud800'])('rejects invalid name %j', name => {
    expect(() => normalizeName(name)).toThrow();
  });
  it('validates independent colors and visibility, including resets', () => {
    expect(validateDefinition({ name: 'A', color: '#ABCDEF', textColor: null, visibility: 'unread', messageVisible: false }))
      .toMatchObject({ color: '#abcdef', textColor: null, visibility: 'unread', messageVisible: false });
    for (const invalid of [{ color: 'red' }, { textColor: 'url(x)' }, { visibility: 'maybe' }, { messageVisible: 0 }]) {
      expect(() => validateDefinition(invalid)).toThrow();
    }
  });
  it('rejects unknown fields and unsafe or malformed revisions before SQL', () => {
    const base = { accountId: '11111111-1111-4111-8111-111111111111', mutationId: '22222222-2222-4222-8222-222222222222', expectedRevision: '2' };
    expect(() => validateRequest('patch', { ...base, name: 'OK' })).not.toThrow();
    for (const extra of [{ unknown: true }, { expectedRevision: 1e20 }, { expectedRevision: '-1' }, { expectedRevision: null }]) {
      expect(() => validateRequest('patch', { ...base, ...extra })).toThrow();
    }
  });
});

describe('native label tree validation', () => {
  const label = (id, parentId, name = id) => ({ id, parentId, name, normalizedName: name.toLowerCase() });
  it('derives descendant paths after a move without mutating preferences', () => {
    const nodes = [label('a', null), label('b', 'a'), { ...label('c', 'b'), color: '#ffffff' }];
    expect(derivePaths(nodes).get('c')).toBe('a/b/c');
    expect(nodes[2].color).toBe('#ffffff');
  });
  it('rejects cycles, missing parents, sibling collisions and excessive depth', () => {
    for (const nodes of [[label('a', 'a')], [label('a', 'b'), label('b', 'a')], [label('a', 'missing')], [label('a', null, 'Same'), label('b', null, 'same')], Array.from({ length: 21 }, (_, i) => label(String(i), i ? String(i - 1) : null))]) {
      expect(() => derivePaths(nodes)).toThrow();
    }
  });
});
