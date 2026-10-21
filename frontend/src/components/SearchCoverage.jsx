import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';

// Account-area consumer only. The caller supplies the current session generation
// and may request a refresh after an existing progress event; there is no poller.
export default function SearchCoverage({ accountId, sessionGeneration, refreshRevision = 0 }) {
  const { t } = useTranslation();
  const scope = JSON.stringify([accountId, sessionGeneration]);
  const current = useRef(scope);
  current.current = scope;
  const sequence = useRef(0);
  const [state, setState] = useState({ scope, pending: true, value: null, error: null });
  const load = useCallback(async () => {
    const ticket = ++sequence.current;
    setState({ scope, pending: true, value: null, error: null });
    try {
      const value = await api.getSearchCoverage(accountId);
      if (current.current !== scope || sequence.current !== ticket) return;
      if (value.accountId !== accountId) throw new Error('Search coverage account changed');
      setState({ scope, pending: false, value, error: null });
    } catch (error) {
      if (current.current === scope && sequence.current === ticket) {
        setState({ scope, pending: false, value: null, error: error.message });
      }
    }
  }, [accountId, scope]);
  useEffect(() => {
    // Capture the stable counter object, not its current numeric ticket: cleanup
    // must invalidate whichever request is latest when this scope is disposed.
    const requestSequence = sequence;
    if (accountId && sessionGeneration != null) void load();
    return () => { requestSequence.current++; };
  }, [accountId, sessionGeneration, refreshRevision, load]);

  const action = async kind => {
    if (current.current !== scope) return;
    const ticket = ++sequence.current;
    setState(previous => ({ ...previous, scope, pending: true, error: null }));
    try {
      await api.setSearchCoverageAction(accountId, kind);
      if (current.current === scope && sequence.current === ticket) await load();
    } catch (error) {
      if (current.current === scope && sequence.current === ticket) {
        setState({ scope, pending: false, value: null, error: error.message });
      }
    }
  };
  const visible = state.scope === scope ? state : { pending: true, value: null, error: null };
  const value = visible.value;
  if (!accountId || sessionGeneration == null) return null;
  return (
    <section aria-label={t('searchCoverage.title', { defaultValue: 'Body search coverage' })}
      style={{ marginTop: 12, padding: 12, border: '1px solid var(--border)', borderRadius: 7 }}>
      <strong>{t('searchCoverage.title', { defaultValue: 'Body search coverage' })}</strong>
      <p>{t('searchCoverage.partial', { defaultValue: 'Search results may be incomplete while mail and message bodies are still being indexed.' })}</p>
      {visible.error && <p role="alert">{visible.error}</p>}
      {visible.pending && <p role="status">{t('searchCoverage.loading', { defaultValue: 'Updating coverage…' })}</p>}
      {value && <>
        <p>{t('searchCoverage.progress', { defaultValue: `${value.body.verified} of ${value.body.sources} cached message bodies verified` })}</p>
        <p>{value.body.pending || 0} {t('searchCoverage.pending', { defaultValue: 'pending' })}, {' '}
          {value.body.failed || 0} {t('searchCoverage.failed', { defaultValue: 'failed' })}, {' '}
          {value.body.unsupported || 0} {t('searchCoverage.unsupported', { defaultValue: 'unsupported' })}</p>
        {value.paused && <p>{t('searchCoverage.paused', { defaultValue: 'Background indexing is paused.' })}</p>}
        {value.identity.bootstrapComplete === false && <p>{t('searchCoverage.identities', {
          defaultValue: 'Message identities are still being verified. Copies may be counted separately.',
        })}</p>}
        {value.body.unsupported > 0 && <p>{t('searchCoverage.unsupportedHelp', {
          defaultValue: 'Some messages cannot be indexed with the current limits. Retrying failed messages does not change these limits.',
        })}</p>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button disabled={visible.pending || !value.enabled} onClick={() => { void action(value.paused ? 'resume' : 'pause'); }}>
            {value.paused ? t('searchCoverage.resume', { defaultValue: 'Resume' }) : t('searchCoverage.pause', { defaultValue: 'Pause' })}
          </button>
          <button disabled={visible.pending || !value.enabled} onClick={() => { void action('retry'); }}>
            {t('searchCoverage.retry', { defaultValue: 'Retry failed' })}
          </button>
        </div>
      </>}
      <button disabled={visible.pending} onClick={() => { void load(); }} style={{ marginTop: 8 }}>
        {t('searchCoverage.refresh', { defaultValue: 'Refresh' })}
      </button>
    </section>
  );
}
