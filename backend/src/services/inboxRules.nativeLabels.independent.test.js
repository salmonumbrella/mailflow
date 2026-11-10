import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ query: vi.fn(), mutate: vi.fn(), rules: [], order: [], body: null }));
vi.mock('./db.js', () => ({ query: h.query }));
vi.mock('./nativeLabelMemberships.js', () => ({ mutateRuleMemberships: h.mutate }));
vi.mock('./messageIdentity.js', () => ({ captureMessageSource: async (_account, _folder, _uid, source) => ({ expectedSource: source }) }));
vi.mock('./messageMoveCache.js', () => ({ applyConfirmedMoveCache: async (_account, source, folder, uid) => ({ applied: true, sync: false, destination: { ...source, folder, uid } }) }));
import { applyInboxRules } from './inboxRules.js';
const account = { id: 'account', user_id: 'owner', storage_generation: 'generation' };
const label = '00000000-0000-4000-8000-000000000001';
const source = { id: 'message', entity_id: 'entity', canonicalEntityId: 'entity', account_id: 'account', storage_generation: 'generation', folder: 'INBOX', uid_validity: '10', uid: '1' };
const message = () => ({ ...source, subject: 'invoice', _nativeLabelProof: { source: { ...source }, expectedMetadataVersion: '17' } });
const labelAction = { type: 'apply_native_label', value: label };
const moveAction = { type: 'move', value: 'Archive' };
const rule = (id, actions, extra = {}) => ({ id, user_id: 'owner', account_id: 'account', storage_generation: 'generation', enabled: true, rule_revision: '2026-11-10 12:00:00.123456+00', condition_logic: 'AND', conditions: [{ field: 'subject', operator: 'contains', value: 'invoice' }], actions, ...extra });
let imap;
beforeEach(() => {
  h.rules = []; h.order = []; h.body = null;
  h.query.mockReset().mockImplementation(async sql => sql.includes('FROM inbox_rules') ? { rows: h.rules } : h.body ? h.body() : { rows: [] });
  h.mutate.mockReset().mockImplementation(async (_owner, input) => { h.order.push(`label:${input.ruleId}:${input.expectedMetadataVersion}`); return { result: { targets: [{ entityId: 'entity', metadataVersion: String(BigInt(input.expectedMetadataVersion) + 1n) }] } }; });
  imap = { bulkMoveMessages: vi.fn(async () => { h.order.push('move'); return { uidMap: new Map([[1, 2]]) }; }), _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn() };
});
describe('independent native rule execution ordering', () => {
  it('applies grouped labels before same-rule and prior-rule MOVE, using only confirmed own versions', async () => {
    h.rules = [rule('earlier', [moveAction]), rule('first-label', [labelAction]), rule('second-label', [moveAction, labelAction])];
    await applyInboxRules([message()], account, imap);
    expect(h.order).toEqual(['label:first-label:17', 'label:second-label:18', 'move']);
    expect(h.mutate).toHaveBeenCalledTimes(2);
    const [first, second] = h.mutate.mock.calls.map(([, input]) => input);
    expect(first.mutationId).not.toBe(second.mutationId);
    expect(first.source).toEqual(source); expect(second.source).toEqual(source);
  });
  it('suppresses dependent moves after a metadata conflict without refreshing or retrying the attempt', async () => {
    h.rules = [rule('earlier', [moveAction]), rule('labels', [moveAction, labelAction])];
    h.mutate.mockRejectedValue(Object.assign(new Error('Concurrent user decision'), { code: 'stale_metadata_version' }));
    const result = await applyInboxRules([message()], account, imap);
    expect(h.mutate).toHaveBeenCalledOnce(); expect(imap.bulkMoveMessages).not.toHaveBeenCalled();
    expect(result.remaining).toHaveLength(1);
  });
  it('does not repair a missing proof by looking up whichever UID now occupies the source', async () => {
    h.rules = [rule('labels', [labelAction, moveAction])];
    const msg = message(); delete msg._nativeLabelProof;
    const result = await applyInboxRules([msg], account, imap, { rule: h.rules[0] });
    expect(h.mutate).not.toHaveBeenCalled(); expect(imap.bulkMoveMessages).not.toHaveBeenCalled();
    expect(result.failedCount).toBe(1);
  });
  it('freezes original metadata version before asynchronous body lookup', async () => {
    h.rules = [rule('body-label', [labelAction], { conditions: [{ field: 'body', operator: 'contains', value: 'invoice' }] })];
    const msg = message();
    h.body = async () => { msg._nativeLabelProof.expectedMetadataVersion = '999'; msg._nativeLabelProof.source.uid = '99'; return { rows: [{ id: msg.id, body_text: 'invoice' }] }; };
    await applyInboxRules([msg], account, imap);
    expect(h.mutate.mock.calls[0][1]).toMatchObject({ expectedMetadataVersion: '17', source: { uid: '1' } });
  });
  it('refuses an explicit prior-generation rule before body lookup or mutation', async () => {
    const old = rule('old', [labelAction], { storage_generation: 'previous' });
    await expect(applyInboxRules([message()], account, imap, { rule: old })).rejects.toThrow('previous mailbox generation');
    expect(h.query).not.toHaveBeenCalled(); expect(h.mutate).not.toHaveBeenCalled();
  });
});
