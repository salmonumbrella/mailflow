import { describe, expect, it, vi } from 'vitest';
import { lexSearchExpression } from './searchExpression.js';
import { parseNativeLabelRuleSearch, convertNativeLabelRuleSearchInTransaction } from './nativeLabelRuleConversion.js';
import { captureSearchRuleFields, evaluateSearchRuleConditions, validateSearchRuleCondition } from './searchRuleSemantics.js';

const accountId = '00000000-0000-0000-0000-000000000001';
const generation = '00000000-0000-0000-0000-000000000002';
const request = { userId: 'owner', sourceSearch: { query: 'label:work', accountId, expectedStorageGeneration: generation, expectedTreeRevision: '0' }, displayedScope: { accountId, folder: 'INBOX' } };
describe('server saved native-search grammar', () => {
  it.each(['(label:work)', '{label:work}', 'label:work OR from:x', '-(label:work)', 'label:work subject:(x)',
    'label:work word', 'label:work to:x', 'label:work -size:2k', 'label:work is:starred', 'label:work in:inbox',
    'label:work --subject:x', 'label:work - -subject:x', 'label:work after:2026-01-01'])('rejects the complete unsupported query %s', query => {
    expect(() => parseNativeLabelRuleSearch(query)).toThrow();
  });
  it('uses the shared quote-aware lexer for lexical group detection', () => {
    expect(lexSearchExpression('label:"Work (Q1) {OR}" -subject:"x(y)"').hasGroups).toBe(false);
    expect(parseNativeLabelRuleSearch('label:"Work (Q1) {OR}" -subject:"x(y)"').leaves).toHaveLength(2);
    expect(lexSearchExpression('(label:"Work (Q1)")').hasGroups).toBe(true);
  });
  it.each(['', 'label:"unclosed', 'label:x ' + 'from:a '.repeat(50), 'label:' + 'a'.repeat(500)])('enforces parser bounds: %s', query => {
    expect(() => parseNativeLabelRuleSearch(query)).toThrow();
    try { parseNativeLabelRuleSearch(query); } catch (error) { expect(error.status).toBe(400); }
  });
  it.each([[], [{ field: 'subject', operator: 'contains', value: 'safe' }], null])('rejects any supplied client conditions without querying', async clientConditions => {
    const client = { query: vi.fn() };
    await expect(convertNativeLabelRuleSearchInTransaction(client, { ...request, clientConditions })).rejects.toMatchObject({ code: 'ambiguous_source_search' });
    expect(client.query).not.toHaveBeenCalled();
  });
  it.each([{ accountId: null, folder: 'Archive' }, { folder: 'INBOX' }, { accountId: generation, folder: 'INBOX' }])('requires explicit displayed scope', async displayedScope => {
    const client = { query: vi.fn() };
    await expect(convertNativeLabelRuleSearchInTransaction(client, { ...request, displayedScope })).rejects.toMatchObject({ code: 'search_scope_conflict' });
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe('bounded captured exact search evidence', () => {
  const raw = { from_email: null, from_name: ' Alice ', subject: '100%_done', has_attachments: null, is_read: false };
  it('retains NULL and whitespace and rejects missing presentation-only input', () => {
    expect(captureSearchRuleFields(raw)).toEqual(raw);
    expect(Object.isFrozen(captureSearchRuleFields(raw))).toBe(true);
    expect(captureSearchRuleFields({ fromEmail: '', subject: '' })).toBe(null);
  });
  it('rejects arbitrary annotations and evaluates only captured VALUES', async () => {
    const condition = { field: 'subject', operator: 'not_contains', value: '100%_', semantics: 'search_v1' };
    expect(validateSearchRuleCondition(condition)).toBe(true);
    expect(validateSearchRuleCondition({ ...condition, query: 'true' })).toBe(false);
    expect(validateSearchRuleCondition({ ...condition, semantics: 'search_v2' })).toBe(false);
    const execute = vi.fn(async () => ({ rows: [{ condition_0: true }] }));
    expect(await evaluateSearchRuleConditions(execute, [condition], raw)).toEqual([true]);
    expect(execute.mock.calls[0][0]).toContain('NOT COALESCE');
    expect(execute.mock.calls[0][0]).toContain('VALUES');
    expect(execute.mock.calls[0][0]).not.toContain('messages');
    expect(execute.mock.calls[0][1]).toEqual([null, ' Alice ', '100%_done', null, false, '%100\\%\\_%']);
    await expect(evaluateSearchRuleConditions(execute, [condition], {})).rejects.toMatchObject({ code: 'search_evidence_unavailable' });
    await expect(evaluateSearchRuleConditions(execute, Array(201).fill(condition), raw)).rejects.toMatchObject({ code: 'invalid_search_condition' });
  });
});
