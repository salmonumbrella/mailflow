import { describe, expect, it, vi } from 'vitest';
import { validateNativeLabelRuleReferences } from './nativeLabelRuleReferences.js';
const account = { id: '00000000-0000-4000-8000-000000000001', user_id: 'owner', storage_generation: '00000000-0000-4000-8000-000000000002' };
const label = '00000000-0000-4000-8000-000000000003';
const client = { query: vi.fn(async () => ({ rows: [{ id: label, full_path: 'Work' }] })) };
const rule = extra => ({ account_id: account.id, storage_generation: account.storage_generation, condition_logic: 'AND', conditions: [{ field: 'subject', operator: 'contains', value: 'invoice' }], actions: [{ type: 'apply_native_label', value: label }], ...extra });
const validate = value => validateNativeLabelRuleReferences(client, { userId: account.user_id, account, rule: value });
describe('independent native rule shape boundary', () => {
  it('refuses unsupported condition fields before their meaning can silently change', async () => {
    await expect(validate(rule({ conditions: [{ field: 'future_condition', operator: 'equals', value: 'x' }] }))).rejects.toBeTruthy();
  });
  it('refuses contradictory attachment operators that the runtime ignores', async () => {
    await expect(validate(rule({ conditions: [{ field: 'has_attachment', operator: 'not_equals', value: false }] }))).rejects.toBeTruthy();
  });
  it('refuses unsupported actions rather than saving an apparently complete native rule', async () => {
    await expect(validate(rule({ actions: [{ type: 'apply_native_label', value: label }, { type: 'future_action' }] }))).rejects.toBeTruthy();
  });
});
