import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { canonicalMembershipTargets, definitiveMembershipFailure, membershipDelta, membershipRequests, membershipStates, readPendingMembership, savePendingMembership, verifiedMembershipSnapshot } from '../utils/nativeLabelMemberships.js';

export function useNativeLabelMemberships(scope, { initialRemove, onSaved, isCurrent = () => true } = {}) {
  const { t } = useTranslation();
  const translate = useRef(t);
  translate.current = t;
  const [snapshot, setSnapshot] = useState(null);
  const [labels, setLabels] = useState([]);
  const [staged, setStaged] = useState({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(() => scope.accountId ? readPendingMembership(scope.accountId) : null);
  const sequence = useRef(0);
  const live = useRef(false);
  const refs = useRef({ scope, onSaved, isCurrent }); refs.current = { scope, onSaved, isCurrent };
  const key = JSON.stringify(scope);
  const refresh = useCallback(async (removeId) => {
    const current = refs.current.scope;
    if (current.error) { ++sequence.current; setSnapshot(null); setLabels([]); setLoading(false); return; }
    const version = ++sequence.current;
    setLoading(true); setSnapshot(null);
    try {
      const [definitions, data] = await Promise.all([api.getNativeLabels(current.accountId), api.queryNativeLabelMemberships(current)]);
      if (!live.current || version !== sequence.current) return;
      if (!refs.current.isCurrent(current) || definitions.accountId !== current.accountId || definitions.storageGeneration !== current.storageGeneration || !Array.isArray(definitions.labels) || !verifiedMembershipSnapshot(data, current)) throw new Error(translate.current('gmail.memberships.unverifiedSelection', "The selected message identities could not be verified. Refresh the mailbox after sync."));
      canonicalMembershipTargets(data.targets, translate.current);
      setLabels(definitions.labels); setSnapshot(data);
      const values = membershipStates(definitions.labels, data.targets);
      setStaged(removeId && Object.hasOwn(values, removeId) ? { ...values, [removeId]: false } : values);
    } catch (err) { if (live.current && version === sequence.current) { setSnapshot(null); setError(err.message || translate.current('gmail.memberships.loadFailed', "Labels could not be loaded.")); } }
    finally { if (live.current && version === sequence.current) setLoading(false); }
  }, []);
  useEffect(() => {
    const requestSequence = sequence;
    live.current = true; setError(''); setNotice(''); setStaged({}); setSnapshot(null); setLabels([]);
    setPending(refs.current.scope.accountId ? readPendingMembership(refs.current.scope.accountId) : null);
    setBusy(membershipRequests.has(refs.current.scope.accountId));
    refresh(initialRemove);
    const recoveryChanged = event => {
      if (event.detail?.accountId !== refs.current.scope.accountId) return;
      const operation = readPendingMembership(event.detail.accountId);
      setPending(operation); setBusy(membershipRequests.has(event.detail.accountId));
      if (!operation) refresh();
    };
    const labelsChanged = event => {
      const detail = event.detail || {}, current = refs.current.scope;
      if ((detail.accountId && detail.accountId !== current.accountId) || (detail.storageGeneration && detail.storageGeneration !== current.storageGeneration)
        || membershipRequests.has(current.accountId) || readPendingMembership(current.accountId)) return;
      setNotice(translate.current('gmail.memberships.selectionChanged', "Labels changed. Review the refreshed selection before applying.")); refresh();
    };
    window.addEventListener('mailflow:native-membership-recovery', recoveryChanged);
    window.addEventListener('mailflow:native-labels-changed', labelsChanged);
    return () => { live.current = false; ++requestSequence.current; window.removeEventListener('mailflow:native-membership-recovery', recoveryChanged); window.removeEventListener('mailflow:native-labels-changed', labelsChanged); };
  }, [key, initialRemove, refresh]);
  const initial = membershipStates(labels, snapshot?.targets || []);
  const delta = membershipDelta(initial, staged);
  async function mutate(payload, recovering) {
    const accountId = payload.accountId;
    const operationScope = JSON.stringify(refs.current.scope);
    if (membershipRequests.has(accountId)) return;
    // Read the journal again: another reader/window may have acquired this account since render.
    const recorded = readPendingMembership(accountId);
    if (recorded && recorded.mutationId !== payload.mutationId) { setPending(recorded); setError(translate.current('gmail.memberships.verifyEarlier', "An earlier label change needs verification first.")); return; }
    if (!recovering && (refs.current.scope.error || !refs.current.isCurrent(refs.current.scope))) { setError(translate.current('gmail.memberships.refreshAccount', "The account changed. Refresh before editing labels.")); return; }
    if (!savePendingMembership(accountId, payload)) { setError(translate.current('gmail.memberships.journalFailed', "The request was not sent. Browser session storage is required to recover an uncertain label change safely.")); return; }
    membershipRequests.add(accountId); ++sequence.current;
    const version = sequence.current;
    setPending(payload); setBusy(true); setLoading(false); setError(''); setNotice('');
    const active = () => live.current && version === sequence.current;
    try {
      const result = await (payload.originalMutationId ? api.undoNativeLabelMemberships(payload) : api.mutateNativeLabelMemberships(payload));
      savePendingMembership(accountId, null);
      // A replay body is historical evidence, never a current cache patch.
      if (refs.current.isCurrent(payload)) {
        try { refs.current.onSaved?.(payload, result, { active: active() }); } catch { /* A UI notification failure cannot undo committed server success. */ }
      }
      if (!active()) return;
      setPending(null); setNotice(recovering ? translate.current('gmail.memberships.verified', "The pending label change was verified. The current selection has been refreshed.") : translate.current('gmail.memberships.saved', "Message labels saved in MailFlow."));
      await refresh();
    } catch (err) {
      if (definitiveMembershipFailure(err, recovering)) {
        savePendingMembership(accountId, null);
        if (!active()) return;
        setPending(null);
        await refresh();
        if (live.current && JSON.stringify(refs.current.scope) === operationScope) setError(err.status === 409 ? translate.current('gmail.memberships.conflict', "The labels or message identity changed. Review the refreshed selection before applying again. Nothing was retried automatically.") : err.message || translate.current('gmail.memberships.refused', "The label change was refused."));
      } else if (active()) setError(translate.current('gmail.memberships.uncertain', "The save outcome is unknown. Retry the exact pending request to verify it before making another change. Keep browser storage until verification completes."));
    } finally {
      membershipRequests.delete(accountId);
      if (live.current) setBusy(membershipRequests.has(refs.current.scope.accountId));
      window.dispatchEvent(new CustomEvent('mailflow:native-membership-recovery', { detail: { accountId } }));
    }
  }
  function apply() {
    if (scope.error || !snapshot || busy || pending || loading || !(delta.addLabelIds.length || delta.removeLabelIds.length)) return;
    if (delta.addLabelIds.length > 100 || delta.removeLabelIds.length > 100) { setError(translate.current('gmail.memberships.changeLimit', "Change at most 100 labels at a time.")); return; }
    mutate({ accountId: scope.accountId, storageGeneration: scope.storageGeneration,
      targets: canonicalMembershipTargets(snapshot.targets, translate.current),
      ...delta, mutationId: crypto.randomUUID() }, false);
  }
  return { labels, notice, staged, setStaged, loading, busy, error: scope.error || error, pending, snapshot, delta, apply,
    refresh: () => { setError(''); refresh(); }, retry: () => pending && mutate(pending, true) };
}
