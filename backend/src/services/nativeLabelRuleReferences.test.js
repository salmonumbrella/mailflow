import { describe, it, expect } from 'vitest';
import { extractNativeLabelReferences, nativeLabelDelta, validateNativeLabelRuleShape } from './nativeLabelRuleReferences.js';
const id = '11111111-1111-4111-8111-111111111111';
const rule = actions => ({ conditions: [{ field: 'subject', operator: 'contains', value: 'invoice' }], actions });
describe('native rule reference language', () => {
  it('groups identical decisions and rejects conflicting decisions', () => {
    const apply = { type: 'apply_native_label', value: id };
    expect(nativeLabelDelta([apply, apply])).toEqual({ addLabelIds: [id], removeLabelIds: [] });
    expect(() => nativeLabelDelta([apply, { type: 'remove_native_label', value: id }])).toThrow(/same native label/);
    expect(extractNativeLabelReferences(rule([apply, apply]))).toEqual([id]);
  });
  it('rejects names, malformed identifiers and unbounded rule arrays', () => {
    for (const value of ['Projects', '', null, 42]) expect(() => nativeLabelDelta([{ type: 'apply_native_label', value }])).toThrow();
    expect(() => extractNativeLabelReferences({ actions: Array(201).fill({ type: 'star' }) })).toThrow();
  });
  it('rejects grouped conditions, future actions, malformed entries and misleading operators', () => {
    const valid = rule([{ type: 'apply_native_label', value: id }]);
    expect(() => validateNativeLabelRuleShape(valid)).not.toThrow();
    for (const c of [{ field: 'has_attachment', operator: 'not_equals', value: false }, { field: 'native_label', operator: 'contains', value: id }, { type: 'or', children: [] }]) {
      expect(() => validateNativeLabelRuleShape({ ...valid, conditions: [c] })).toThrow();
    }
    for (const action of [null, { type: 'future_action' }, { type: 'archive', unsafe: true }]) {
      expect(() => validateNativeLabelRuleShape({ ...valid, actions: [...valid.actions, action] })).toThrow();
    }
  });
  it.each(['has','not_has'])('accepts direct UUID %s conditions without native actions', operator => {
    const conditional = { conditions:[{field:'native_label',operator,value:id}], actions:[{type:'star'}] };
    expect(() => validateNativeLabelRuleShape(conditional)).not.toThrow();
    expect(extractNativeLabelReferences(conditional)).toEqual([id]);
  });

});
