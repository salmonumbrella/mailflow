import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { muteEligible, mutePath, selectedMuteMessage, toggleThreadMute } from '../utils/mutedThreads.js';
import { shortcutBus } from '../utils/shortcutBus.js';

export function ThreadMuteRuntime() {
  const { t } = useTranslation();
  useEffect(() => {
    let live = true;
    const toggle = () => {
      const message = selectedMuteMessage(useStore.getState());
      if (!message) return;
      const owner = useStore.getState().user?.id;
      void toggleThreadMute(message, { store: useStore, api, t, stillMounted: () => live }).catch(error => {
        if (!live || useStore.getState().user?.id !== owner || useStore.getState().isLocked) return;
        useStore.getState().addNotification({ type: 'error', title: t('mutedThreads.failed', 'Could not update mute state.'), body: error.message });
      });
    };
    shortcutBus.on('toggleThreadMute', toggle);
    return () => { live = false; shortcutBus.off('toggleThreadMute', toggle); };
  }, [t]);
  return null;
}

export default function MessageMuteAction({ message }) {
  const state = useStore();
  return muteEligible(message, state) ? <OwnedMute key={`${state.user.id}:${message.account_id}:${message.id}`} owner={state.user.id} message={message} /> : null;
}

function OwnedMute({ owner, message }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const live = useRef(false);
  const version = useRef(0);
  const reload = useRef(() => {});
  const current = () => live.current && useStore.getState().user?.id === owner && muteEligible(message, useStore.getState());
  useEffect(() => {
    live.current = true;
    const load = async () => {
      const request = ++version.current;
      try {
        const result = await api.get(mutePath(message.id));
        if (typeof result.muted !== 'boolean') throw new Error(t('mutedThreads.failed', 'Could not update mute state.'));
        if (current() && request === version.current) { setStatus(result); setError(''); }
      } catch (err) { if (current() && request === version.current) setError(err.message); }
    };
    reload.current = load;
    load();
    window.addEventListener('mailflow:mute_changed', load);
    return () => { live.current = false; window.removeEventListener('mailflow:mute_changed', load); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- identity is keyed by owner/account/message
  const toggle = async () => {
    if (busy || !current()) return;
    setBusy(true); setError('');
    try {
      const next = await toggleThreadMute(message, { store: useStore, api, t, stillMounted: current, onChanged: next => { version.current++; setStatus(next); } });
      if (next && current()) setStatus(next);
    } catch (err) { if (current()) setError(err.message); }
    finally { if (current()) setBusy(false); }
  };
  return <div style={{ padding: '10px 0', fontSize: 12, color: 'var(--text-secondary)' }}>
    <button type="button" data-mute-message-id={message.id} disabled={busy || !status} onClick={toggle} title={t('mutedThreads.description', 'Muted conversations stay in MailFlow. New-mail alerts for matching messages are silenced. Muting archives the current inbox conversation; unmuting does not move it back.')}
      style={{ padding: '7px 11px', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', background: 'var(--bg-secondary)', cursor: 'pointer' }}>
      {busy || !status ? t('common.loading', 'Loading…') : status?.muted ? t('mutedThreads.unmute', 'Unmute conversation') : t('mutedThreads.mute', 'Mute conversation')}
    </button>
    {status?.muted && <span style={{ marginLeft: 10 }}>{t('mutedThreads.status', 'Muted in MailFlow')}</span>}
    {error && <p role="alert">{error} <button type="button" disabled={busy} onClick={() => reload.current()}>{t('scheduled.refresh', 'Refresh')}</button></p>}
  </div>;
}
