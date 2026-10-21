import { describe, expect, it, vi } from 'vitest';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
import { freeTextTermCondition, trashFolderExclusionCondition } from './search.js';

// Exact default SQL from released 6b18c147, with placeholders 3 and 4.
const historicalFreeText = "(\n        m.from_name ILIKE $3\n        OR m.from_email ILIKE $3\n        OR m.subject ILIKE $3\n        OR m.search_vector @@ plainto_tsquery('english', $4)\n        OR CASE WHEN m.search_generation_id IS NOT NULL THEN\n          CASE WHEN numnode(plainto_tsquery('english', $4)) > 0\n            THEN (numnode(plainto_tsquery('english', $4)) > 0\n            AND NOT EXISTS (\n              SELECT 1 FROM unnest(tsvector_to_array(to_tsvector('english', $4))) AS q(lexeme)\n              WHERE NOT EXISTS (SELECT 1 FROM search_text_chunks c WHERE c.generation_id=m.search_generation_id\n                AND c.en_tsv @@ quote_literal(q.lexeme)::tsquery)))\n            ELSE (numnode(plainto_tsquery('simple', $4)) > 0\n            AND NOT EXISTS (\n              SELECT 1 FROM unnest(tsvector_to_array(to_tsvector('simple', $4))) AS q(lexeme)\n              WHERE NOT EXISTS (SELECT 1 FROM search_text_chunks c WHERE c.generation_id=m.search_generation_id\n                AND c.simple_tsv @@ quote_literal(q.lexeme)::tsquery)))\n          END\n        ELSE CASE WHEN numnode(plainto_tsquery('english', $4)) > 0\n          THEN to_tsvector('english', LEFT(coalesce(m.body_text,''), 600000)) @@ plainto_tsquery('english', $4)\n          ELSE to_tsvector('simple', LEFT(coalesce(m.body_text,''), 600000)) @@ plainto_tsquery('simple', $4)\n        END END\n      )";
const historicalTrash = "NOT EXISTS (\n        SELECT 1\n        FROM folders f\n        WHERE f.account_id = m.account_id\n          AND f.path = m.folder\n          AND (f.special_use = '\\Trash'\n               OR lower(f.name) LIKE '%trash%'\n               OR lower(f.name) LIKE '%deleted%')\n      )";

describe('released search predicate aliases', () => {
  it('preserves historical default SQL and parameter numbering byte for byte', () => {
    expect(freeTextTermCondition(3, 4)).toBe(historicalFreeText);
    expect(freeTextTermCondition(3, 4, 'm')).toBe(historicalFreeText);
    expect(trashFolderExclusionCondition()).toBe(historicalTrash);
    expect(trashFolderExclusionCondition('m')).toBe(historicalTrash);
  });
  it('correlates every sibling message reference, including both live-generation probes', () => {
    const sql = freeTextTermCondition(3, 4, 's');
    expect(sql).not.toMatch(/\bm\./);
    for (const field of ['from_name', 'from_email', 'subject', 'search_vector', 'search_generation_id', 'body_text']) {
      expect(sql).toContain(`s.${field}`);
    }
    expect(sql.match(/c\.generation_id=s\.search_generation_id/g)).toHaveLength(2);
    expect(sql).toContain('c.en_tsv');
    expect(sql).toContain('c.simple_tsv');
    expect(sql).toContain('q.lexeme');
    expect(sql.match(/\$\d+/g)).toEqual(historicalFreeText.match(/\$\d+/g));
  });
  it('changes only the message correlations in the trash sibling probe', () => {
    expect(trashFolderExclusionCondition('s')).toBe(historicalTrash.replaceAll('m.account_id', 's.account_id').replaceAll('m.folder', 's.folder'));
  });
  it.each(['', 'head', 'M', 's.other', 's; SELECT 1', null])('rejects non-internal alias %s', alias => {
    expect(() => freeTextTermCondition(3, 4, alias)).toThrow(/^Invalid search message alias$/);
    expect(() => trashFolderExclusionCondition(alias)).toThrow(/^Invalid search message alias$/);
  });
});
