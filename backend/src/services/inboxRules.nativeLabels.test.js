import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ query: vi.fn(), mutate: vi.fn(), rules: [], order: [], body: null, pendingCache: false }));
vi.mock('./db.js', () => ({ query: h.query }));
vi.mock('./ruleForwarder.js', () => ({ forwardRuleMessage: async () => { h.order.push('forward'); } }));
vi.mock('./nativeLabelRulePersistence.js', () => ({ validateNativeRuleForRun: async () => {} }));
vi.mock('./nativeLabelRuleDecisions.js', () => ({
  createNativeRuleExecution: proof => structuredClone(proof),
  getNativeRuleExecutionProof: token => structuredClone(token),
  commitNativeRuleDecision: async (user, token, request) => {
    const outcome = await h.mutate(user, { ...request, ...structuredClone(token), accountId:token.source.account_id, storageGeneration:token.source.storage_generation });
    token.expectedMetadataVersion=outcome.result.targets[0].metadataVersion;
    token.labelIds=outcome.result.targets[0].labelIds || token.labelIds;
    return { ...outcome, changed:true, result:{...outcome.result,receipt:{decisionId:request.mutationId}} };
  },
  claimNativeRuleAction: async () => ({claimed:true}), completeNativeRuleAction: async () => ({recorded:true}),
}));
vi.mock('./messageIdentity.js', () => ({ captureMessageSource: async (_account, _folder, _uid, source) => ({ expectedSource: source }) }));
vi.mock('./messageMoveCache.js', () => ({ applyConfirmedMoveCache: async (_account, source, folder, uid) => (h.pendingCache ? { applied: false, sync: true } : { applied: true, sync: false, destination: { ...source, folder, uid } }) }));
import { applyInboxRules } from './inboxRules.js';
const account = { id: 'account', user_id: 'owner', storage_generation: 'generation' };
const label = '00000000-0000-4000-8000-000000000001';
const source = { id: 'message', entity_id: 'entity', canonicalEntityId: 'entity', account_id: 'account', storage_generation: 'generation', folder: 'INBOX', uid_validity: '10', uid: '1' };
const message = () => ({ ...source, subject: 'invoice', _nativeLabelProof: { source: { ...source }, expectedMetadataVersion: '17', availability:'known', labelIds:[] } });
const labelAction = { type: 'apply_native_label', value: label };
const moveAction = { type: 'move', value: 'Archive' };
const rule = (id, actions, extra = {}) => ({ id, user_id: 'owner', account_id: 'account', storage_generation: 'generation', enabled: true, rule_revision: '2026-11-10 12:00:00.123456+00', condition_logic: 'AND', conditions: [{ field: 'subject', operator: 'contains', value: 'invoice' }], actions, ...extra });
let imap;
beforeEach(() => {
  h.rules = []; h.order = []; h.body = null; h.pendingCache = false;
  h.query.mockReset().mockImplementation(async sql => sql.includes('FROM inbox_rules') ? { rows: h.rules } : h.body ? h.body() : { rows: [] });
  h.mutate.mockReset().mockImplementation(async (_owner, input) => { h.order.push(`label:${input.ruleId}:${input.expectedMetadataVersion}`); return { result: { targets: [{ entityId: 'entity', metadataVersion: String(BigInt(input.expectedMetadataVersion) + 1n) }] } }; });
  imap = { bulkMoveMessages: vi.fn(async (_account,_uids,_from,_to,options) => { if(options.beforeDispatch)await options.beforeDispatch(); h.order.push('move'); return { uidMap: new Map([[1, 2]]) }; }), _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(), syncFolderOnDemand: vi.fn(async () => {}) };
});
describe('native rule stop and pending boundaries', () => {
  it('honors stop processing after labeling and does not wait for unreachable later labels', async () => {
    h.rules = [rule('stop', [moveAction,labelAction], {stop_processing:true}), rule('unreachable',[labelAction])];
    await applyInboxRules([message()],account,imap);
    expect(h.order).toEqual(['label:stop:17','move']);
    expect(h.mutate).toHaveBeenCalledOnce();
  });
  it('finishes native metadata before forwarding and filing while preserving the forward barrier', async () => {
    h.rules = [rule('earlier',[moveAction]),rule('label',[labelAction]),rule('forward',[{type:'forward',value:'me@example.test'}])];
    await applyInboxRules([message()],account,imap);
    expect(h.order).toEqual(['label:label:17','forward','move']);
  });
  it('retains the exact uncertain request and never attempts later labels or dependent filing', async () => {
    h.rules = [rule('first',[labelAction,moveAction]),rule('second',[labelAction])];
    h.mutate.mockRejectedValue(Object.assign(new Error('Connection ended while committing'),{code:'ECONNRESET'}));
    const result = await applyInboxRules([message()],account,imap);
    expect(h.mutate).toHaveBeenCalledOnce();
    expect(result).toMatchObject({identityPending:true,pendingIds:['message']});
    expect(result.nativeLabelRecovery).toEqual([expect.objectContaining({mutationId:h.mutate.mock.calls[0][1].mutationId,ruleId:'first',accountId:account.id})]);
    expect(imap.bulkMoveMessages).not.toHaveBeenCalled();
  });
  it('does not replay committed metadata after MOVE leaves identity recovery pending', async () => {
    h.rules=[rule('label',[labelAction,moveAction])];
    h.pendingCache = true;
    imap.bulkMoveMessages.mockImplementation(async (_account,_uids,_from,_to,options)=>{if(options.beforeDispatch)await options.beforeDispatch();return {succeeded:[1],uidMap:new Map()};});
    const result = await applyInboxRules([message()],account,imap,{rule:h.rules[0]});
    expect(h.mutate).toHaveBeenCalledOnce();
    expect(imap.bulkMoveMessages).toHaveBeenCalledOnce();
    expect(result).toMatchObject({failedCount:0,identityPending:true,pendingIds:['message']});
  });
});
